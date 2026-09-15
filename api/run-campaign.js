// POST /api/run-campaign  { campaign_id }
// Sends one batch for a running campaign and reports progress. The dashboard calls
// this repeatedly until `done` is true (keeps each call well under Vercel's time limit).
import { db, json, requireAuth, readBody, sendTemplate, sleep } from './_lib.js';

const BATCH_SIZE = 10;
const DELAY_MS = 250;

export default async function handler(req, res) {
  if (req.method === 'OPTIONS') return json(res, 200, {});
  const auth = await requireAuth(req, res); if (!auth) return;
  const body = req.method === 'POST' ? await readBody(req) : req.query;
  const campaignId = body.campaign_id;
  if (!campaignId) return json(res, 400, { error: 'campaign_id required' });

  const { data: campaign, error: cErr } = await db.from('campaigns').select('*').eq('id', campaignId).single();
  if (cErr || !campaign) return json(res, 404, { error: 'Campaign not found' });
  if (campaign.status === 'paused') return json(res, 200, { done: false, paused: true, sent: 0, failed: 0 });
  if (campaign.status === 'completed') return json(res, 200, { done: true, sent: 0, failed: 0 });

  if (campaign.status === 'draft') {
    await db.from('campaigns').update({ status: 'running', started_at: new Date().toISOString() }).eq('id', campaignId);
  }

  const { data: contacts, error: pErr } = await db.rpc('get_campaign_pending', { p_campaign_id: campaignId, p_limit: BATCH_SIZE });
  if (pErr) return json(res, 500, { error: pErr.message });

  if (!contacts || contacts.length === 0) {
    await db.from('campaigns').update({ status: 'completed', completed_at: new Date().toISOString() }).eq('id', campaignId);
    return json(res, 200, { done: true, sent: 0, failed: 0 });
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
      await db.from('campaign_log').insert({ contact_id: c.id, campaign_id: campaignId, campaign_name: campaign.name, status: 'failed', error_message: err.message });
      failed++;
      // If credentials/config are broken, every send will fail — stop instead of burning through the list.
      if (/Missing environment|Invalid OAuth|access token|Unsupported post request/i.test(err.message)) {
        await db.from('campaigns').update({ status: 'paused' }).eq('id', campaignId);
        return json(res, 200, { done: false, paused: true, sent, failed, error: err.message });
      }
    }
    await sleep(DELAY_MS);
  }
  return json(res, 200, { done: false, sent, failed, error: lastError });
}
