// GET  /api/setup  -> health check: which env vars are set, phone number info, webhook subscription state
// POST /api/setup  -> subscribe this app to the WhatsApp Business Account so webhooks flow
import { json, requireAuth, graph } from './_lib.js';

export default async function handler(req, res) {
  if (req.method === 'OPTIONS') return json(res, 200, {});
  const auth = await requireAuth(req, res); if (!auth) return;
  const waba = process.env.META_WABA_ID;
  const env = {
    META_ACCESS_TOKEN: !!process.env.META_ACCESS_TOKEN,
    META_PHONE_NUMBER_ID: !!process.env.META_PHONE_NUMBER_ID,
    META_WABA_ID: !!waba,
    META_WEBHOOK_VERIFY_TOKEN: !!process.env.META_WEBHOOK_VERIFY_TOKEN,
    SUPABASE_URL: !!process.env.SUPABASE_URL,
    SUPABASE_SERVICE_ROLE_KEY: !!process.env.SUPABASE_SERVICE_ROLE_KEY,
  };
  const host = req.headers['x-forwarded-host'] || req.headers.host;
  const webhookUrl = `https://${host}/api/webhook`;

  try {
    if (req.method === 'POST') {
      if (!waba) return json(res, 400, { error: 'META_WABA_ID not set' });
      const r = await graph(`${waba}/subscribed_apps`, { method: 'POST' });
      return json(res, 200, { ok: true, result: r });
    }
    // The verify token is shown to logged-in users because they must paste it into Meta's webhook form.
    const out = { env, webhookUrl, verifyToken: process.env.META_WEBHOOK_VERIFY_TOKEN || null, wabaId: waba || null, phoneNumberId: process.env.META_PHONE_NUMBER_ID || null };
    if (env.META_ACCESS_TOKEN && env.META_PHONE_NUMBER_ID) {
      try {
        const p = await graph(`${process.env.META_PHONE_NUMBER_ID}?fields=display_phone_number,verified_name,quality_rating,messaging_limit_tier,code_verification_status`);
        out.phone = p;
      } catch (e) { out.phoneError = e.message; }
    }
    if (env.META_ACCESS_TOKEN && waba) {
      try {
        const s = await graph(`${waba}/subscribed_apps`);
        out.subscribedApps = (s.data || []).map((a) => a.whatsapp_business_api_data?.name || a.whatsapp_business_api_data?.id || 'app');
      } catch (e) { out.subscribeError = e.message; }
    }
    return json(res, 200, out);
  } catch (err) {
    return json(res, 502, { error: err.message, details: err.meta || null, env, webhookUrl });
  }
}
