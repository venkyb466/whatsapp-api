// GET /api/send-campaign?secret=...   -> the scheduler tick (called every minute by Supabase cron)
//   1. Promotes any campaign whose scheduled time has arrived (scheduled -> running)
//   2. Sends one batch for every running campaign (all workspaces)
//   3. Sends due store-automation messages (abandoned cart, order updates, COD)
// GET /api/send-campaign?secret=...&campaign_id=...  -> one batch for that campaign only
import { db, json, requireAuth } from './_lib.js';
import { runBatch } from './run-campaign.js';
import { runDueJobs } from './_store.js';

export default async function handler(req, res) {
  const auth = await requireAuth(req, res); if (!auth) return;

  if (req.query.campaign_id) {
    if (auth.via === 'user') {
      const { data: c } = await db.from('campaigns').select('workspace_id').eq('id', req.query.campaign_id).maybeSingle();
      if (!c || c.workspace_id !== auth.ws.id) return json(res, 404, { error: 'Campaign not found' });
    }
    const r = await runBatch(req.query.campaign_id);
    return json(res, r.status || 200, r);
  }
  if (auth.via !== 'secret') return json(res, 403, { error: 'Scheduler tick requires the trigger secret' });

  const nowIso = new Date().toISOString();
  const started = Date.now();
  // 1. Due scheduled campaigns -> running
  const { data: due } = await db.from('campaigns').select('id,name').eq('status', 'scheduled').lte('scheduled_at', nowIso);
  for (const c of due || []) {
    await db.from('campaigns').update({ status: 'running', started_at: nowIso, last_error: null }).eq('id', c.id);
  }

  // 2. Automations first (they're time-sensitive: COD and order confirmations)
  let automations = null;
  try { automations = await runDueJobs(40); } catch (err) { automations = { error: err.message }; }

  // 3. One batch per running campaign (oldest first), stopping before the function time limit
  const { data: running } = await db.from('campaigns').select('id,name').eq('status', 'running').order('started_at');
  const results = [];
  for (const c of running || []) {
    if (Date.now() - started > 45000) { results.push({ campaign: c.name, deferred: true }); continue; }
    const r = await runBatch(c.id);
    results.push({ campaign: c.name, ...r });
  }
  return json(res, 200, { promoted: (due || []).length, automations, results, checked_at: nowIso });
}
