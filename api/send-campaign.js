// GET /api/send-campaign?secret=...            -> sends one batch of the oldest *running* campaign
// GET /api/send-campaign?secret=...&campaign_id=... -> sends one batch of that campaign
// Kept for manual/cron triggering. The dashboard uses /api/run-campaign directly.
import { db, json, requireAuth } from './_lib.js';
import run from './run-campaign.js';

export default async function handler(req, res) {
  const auth = await requireAuth(req, res); if (!auth) return;
  let campaignId = req.query.campaign_id;
  if (!campaignId) {
    const { data } = await db.from('campaigns').select('id').eq('status', 'running').order('started_at').limit(1);
    if (!data || !data.length) return json(res, 200, { message: 'No running campaign. Create and start one from the dashboard.' });
    campaignId = data[0].id;
  }
  req.query = { ...req.query, campaign_id: campaignId };
  req.method = 'GET';
  return run(req, res);
}
