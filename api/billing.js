// GET /api/billing -> WhatsApp account billing state + spend analytics (from Meta) + per-campaign send counts
import { db, json, requireAuth, graph } from './_lib.js';

export default async function handler(req, res) {
  if (req.method === 'OPTIONS') return json(res, 200, {});
  const auth = await requireAuth(req, res); if (!auth) return;
  const waba = process.env.META_WABA_ID;
  if (!waba || !process.env.META_ACCESS_TOKEN) return json(res, 500, { error: 'META_WABA_ID / META_ACCESS_TOKEN not set.' });

  const out = { wabaId: waba };
  // 1. Account + funding state
  try {
    out.account = await graph(`${waba}?fields=name,currency,timezone_id,account_review_status,ownership_type,primary_funding_id,on_behalf_of_business_info,business_verification_status,is_enabled_for_insights`);
    out.hasPaymentMethod = !!out.account.primary_funding_id;
  } catch (e) { out.accountError = e.message; }

  // 2. Spend analytics: try per-message pricing analytics first (current Meta model), then legacy conversation analytics
  const end = Math.floor(Date.now() / 1000);
  const start = end - 30 * 86400;
  try {
    const p = await graph(`${waba}?fields=pricing_analytics.start(${start}).end(${end}).granularity(DAILY).dimensions(PRICING_CATEGORY,PRICING_TYPE).metric_types(COST,VOLUME)`);
    const pts = p.pricing_analytics?.data?.[0]?.data_points || [];
    const byCat = {};
    for (const d of pts) { const k = d.pricing_category || 'UNKNOWN'; byCat[k] = byCat[k] || { volume: 0, cost: 0 }; byCat[k].volume += d.volume || 0; byCat[k].cost += d.cost || 0; }
    out.spend30d = { model: 'per_message', byCategory: byCat, total: Object.values(byCat).reduce((a, b) => a + b.cost, 0), volume: Object.values(byCat).reduce((a, b) => a + b.volume, 0) };
  } catch (e1) {
    try {
      const c = await graph(`${waba}?fields=conversation_analytics.start(${start}).end(${end}).granularity(DAILY).dimensions(CONVERSATION_CATEGORY).metric_types(COST,CONVERSATION)`);
      const pts = c.conversation_analytics?.data?.[0]?.data_points || [];
      const byCat = {};
      for (const d of pts) { const k = d.conversation_category || 'UNKNOWN'; byCat[k] = byCat[k] || { volume: 0, cost: 0 }; byCat[k].volume += d.conversation || 0; byCat[k].cost += d.cost || 0; }
      out.spend30d = { model: 'per_conversation', byCategory: byCat, total: Object.values(byCat).reduce((a, b) => a + b.cost, 0), volume: Object.values(byCat).reduce((a, b) => a + b.volume, 0) };
    } catch (e2) { out.spendError = e1.message + ' / ' + e2.message; }
  }

  // 3. Phone limits
  try {
    out.phone = await graph(`${process.env.META_PHONE_NUMBER_ID}?fields=display_phone_number,quality_rating,messaging_limit_tier,status,name_status`);
  } catch (e) { out.phoneError = e.message; }

  // 4. Per-campaign counts from our DB (for cost estimates)
  const { data: campaigns } = await db.from('campaigns').select('id,name,status,created_at,total_targeted');
  const { data: stats } = await db.from('campaign_stats').select('*');
  const byId = Object.fromEntries((stats || []).map((s) => [s.campaign_id, s]));
  out.campaigns = (campaigns || []).map((c) => ({ ...c, sent: Number(byId[c.id]?.sent || 0), failed: Number(byId[c.id]?.failed || 0) }));
  const { count: totalSent } = await db.from('campaign_log').select('id', { count: 'exact', head: true }).in('status', ['sent', 'delivered', 'read']);
  out.totalSentAllTime = totalSent || 0;

  return json(res, 200, out);
}
