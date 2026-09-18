// POST /api/run-campaign  { campaign_id }
// Sends one batch for a campaign and reports progress. The dashboard (or the cron
// runner in send-campaign.js) calls this repeatedly until `done` is true.
import { db, json, requireAuth, readBody, sendTemplate, sleep } from './_lib.js';

const BATCH_SIZE = 10;
const DELAY_MS = 250;
const LIMIT_RETRY_HOURS = 6; // when Meta's daily messaging limit is hit, auto-resume after this long

// Errors that mean "stop, something is wrong with the account" (every send would fail)
const CONFIG_ERR = /Missing environment|Invalid OAuth|access token|Unsupported post request|payment issue|eligibility|131042|not registered|132000/i;
// Errors that mean "daily/throughput limit reached" (try again later, don't mark contacts failed)
const LIMIT_ERR = /limit|throughput|too many|130429|131056|131048|131049|80007/i;

export async function runBatch(campaignId) {
  const { data: campaign, error: cErr } = await db.from('campaigns').select('*').eq('id', campaignId).single();
  if (cErr || !campaign) return { error: 'Campaign not found', status: 404 };
  if (campaign.status === 'paused') return { done: false, paused: true, sent: 0, failed: 0 };
  if (campaign.status === 'completed') return { done: true, sent: 0, failed: 0 };
  if (campaign.status === 'scheduled' && campaign.scheduled_at && new Date(campaign.scheduled_at) > new Date()) {
    return { done: false, scheduled: true, scheduled_at: campaign.scheduled_at, sent: 0, failed: 0 };
  }
  if (campaign.status !== 'running') {
    await db.from('campaigns').update({ status: 'running', started_at: campaign.started_at || new Date().toISOString(), last_error: null }).eq('id', campaignId);
  }

  // Daily cap (drip): count everything sent from this number in the trailing 24h, across all campaigns.
  let batchLimit = BATCH_SIZE;
  if (campaign.daily_limit && campaign.daily_limit > 0) {
    const { data: win } = await db.rpc('sends_last_24h');
    const used = win?.[0]?.sent_count || 0;
    const remaining = campaign.daily_limit - used;
    if (remaining <= 0) {
      const oldest = win?.[0]?.oldest_sent_at ? new Date(win[0].oldest_sent_at) : new Date();
      const resumeAt = new Date(oldest.getTime() + 24 * 3600 * 1000 + 60 * 1000).toISOString();
      await db.from('campaigns').update({ status: 'scheduled', scheduled_at: resumeAt, last_error: `Daily limit of ${campaign.daily_limit} reached — resumes ${resumeAt}` }).eq('id', campaignId);
      return { done: false, scheduled: true, scheduled_at: resumeAt, sent: 0, failed: 0, limit: true, daily: true };
    }
    batchLimit = Math.min(BATCH_SIZE, remaining);
  }

  const { data: contacts, error: pErr } = await db.rpc('get_campaign_pending', { p_campaign_id: campaignId, p_limit: batchLimit });
  if (pErr) return { error: pErr.message, status: 500 };
  if (!contacts || contacts.length === 0) {
    await db.from('campaigns').update({ status: 'completed', completed_at: new Date().toISOString() }).eq('id', campaignId);
    return { done: true, sent: 0, failed: 0 };
  }

  let sent = 0, failed = 0, lastError = null;
  for (const c of contacts) {
    try {
      const msgId = await sendTemplate(c.phone, campaign.template_name, campaign.template_language, [c.name || 'there']);
      const now = new Date().toISOString();
      await db.from('campaign_log').insert({ contact_id: c.id, campaign_id: campaignId, campaign_name: campaign.name, status: 'sent', meta_message_id: msgId, sent_at: now });
      await db.from('messages').insert({ contact_id: c.id, direction: 'out', wa_message_id: msgId, msg_type: 'template', body: `[template: ${campaign.template_name}]`, status: 'sent', campaign_id: campaignId, sent_at: now });
      await db.from('contacts').update({ last_message_at: now }).eq('id', c.id);
      sent++;
    } catch (err) {
      lastError = err.message;
      if (LIMIT_ERR.test(err.message) && !CONFIG_ERR.test(err.message)) {
        // Don't log this contact as failed — leave them pending and come back later.
        const resumeAt = new Date(Date.now() + LIMIT_RETRY_HOURS * 3600 * 1000).toISOString();
        await db.from('campaigns').update({ status: 'scheduled', scheduled_at: resumeAt, last_error: `Messaging limit reached — auto-resumes ${resumeAt}` }).eq('id', campaignId);
        return { done: false, scheduled: true, scheduled_at: resumeAt, sent, failed, error: err.message, limit: true };
      }
      await db.from('campaign_log').insert({ contact_id: c.id, campaign_id: campaignId, campaign_name: campaign.name, status: 'failed', error_message: err.message });
      failed++;
      if (CONFIG_ERR.test(err.message)) {
        await db.from('campaigns').update({ status: 'paused', last_error: err.message }).eq('id', campaignId);
        return { done: false, paused: true, sent, failed, error: err.message };
      }
    }
    await sleep(DELAY_MS);
  }
  return { done: false, sent, failed, error: lastError };
}

export default async function handler(req, res) {
  if (req.method === 'OPTIONS') return json(res, 200, {});
  const auth = await requireAuth(req, res); if (!auth) return;
  const body = req.method === 'POST' ? await readBody(req) : req.query;
  if (!body.campaign_id) return json(res, 400, { error: 'campaign_id required' });
  const r = await runBatch(body.campaign_id);
  return json(res, r.status || 200, r);
}
