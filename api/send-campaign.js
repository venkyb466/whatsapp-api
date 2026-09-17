// GET /api/send-campaign?secret=...   -> the scheduler tick (called every minute by Supabase cron)
//   1. Promotes any campaign whose scheduled time has arrived (scheduled -> running)
//   2. Sends one batch for every running campaign
// GET /api/send-campaign?secret=...&campaign_id=...  -> one batch for that campaign only
import { db, json, requireAuth } from './_lib.js';
import { runBatch } from './run-campaign.js';

export default async function handler(req, res) {
  const auth = await requireAuth(req, res); if (!auth) return;

  if (req.query.campaign_id) {
    const r = await runBatch(req.query.campaign_id);
    return json(res, r.status || 200, r);
  }

  const nowIso = new Date().toISOString();
  // 1. Due scheduled campaigns -> running
  const { data: due } = await db.from('campaigns').select('id,name').eq('status', 'scheduled').lte('scheduled_at', nowIso);
  for (const c of due || []) {
    await db.from('campaigns').update({ status: 'running', started_at: nowIso, last_error: null }).eq('id', c.id);
  }

  // 2. One batch per running campaign (oldest first)
  const { data: running } = await db.from('campaigns').select('id,name').eq('status', 'running').order('started_at');
  if (!running || !running.length) {
    return json(res, 200, { message: 'No running campaign.', promoted: (due || []).length, checked_at: nowIso });
  }
  const results = [];
  for (const c of running) {
    const r = await runBatch(c.id);
    results.push({ campaign: c.name, ...r });
  }
  return json(res, 200, { promoted: (due || []).length, results, checked_at: nowIso });
}
