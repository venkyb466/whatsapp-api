// GET  /api/setup  -> connection health for the active workspace: number info, webhook subscription state
// POST /api/setup  -> subscribe this app to the workspace's WhatsApp Business Account so webhooks flow
import { db, json, requireAuth } from './_lib.js';

export default async function handler(req, res) {
  if (req.method === 'OPTIONS') return json(res, 200, {});
  const auth = await requireAuth(req, res, { admin: req.method === 'POST' }); if (!auth) return;
  if (auth.via !== 'user') return json(res, 403, { error: 'Sign in required' });
  const ws = auth.ws;
  const host = req.headers['x-forwarded-host'] || req.headers.host;
  const { data: pa } = await db.from('platform_admins').select('user_id').eq('user_id', auth.user.id).maybeSingle();
  const isPlatformAdmin = !!pa;
  const connected = !!(ws.phone_number_id && ws.waba_id && ws.token);
  const g = (path, o = {}) => fetchGraph(path, ws.token, o);

  try {
    if (req.method === 'POST') {
      if (!connected) return json(res, 400, { error: 'Connect WhatsApp first' });
      const r = await g(`${ws.waba_id}/subscribed_apps`, { method: 'POST' });
      return json(res, 200, { ok: true, result: r });
    }
    const out = {
      workspace: { id: ws.id, name: ws.name, plan: ws.plan, trial_ends_at: ws.trial_ends_at, uses_env_token: ws.uses_env_token },
      connected, wabaId: ws.waba_id, phoneNumberId: ws.phone_number_id, isPlatformAdmin, role: auth.role,
      webhookUrl: `https://${host}/api/webhook`,
      // The verify token is only needed by whoever configures the Meta app (the platform owner).
      verifyToken: isPlatformAdmin ? (process.env.META_WEBHOOK_VERIFY_TOKEN || null) : undefined,
      embeddedSignup: { appId: process.env.META_APP_ID || null, configId: process.env.META_ES_CONFIG_ID || null, ready: !!(process.env.META_APP_ID && process.env.META_APP_SECRET && process.env.META_ES_CONFIG_ID) },
    };
    if (connected) {
      try { out.phone = await g(`${ws.phone_number_id}?fields=display_phone_number,verified_name,quality_rating,messaging_limit_tier,code_verification_status,name_status`); }
      catch (e) { out.phoneError = e.message; }
      try {
        const s = await g(`${ws.waba_id}/subscribed_apps`);
        out.subscribedApps = (s.data || []).map((a) => a.whatsapp_business_api_data?.name || a.whatsapp_business_api_data?.id || 'app');
      } catch (e) { out.subscribeError = e.message; }
    }
    return json(res, 200, out);
  } catch (err) {
    return json(res, 502, { error: err.message, details: err.meta || null });
  }
}

async function fetchGraph(path, token, { method = 'GET', body } = {}) {
  const r = await fetch(`https://graph.facebook.com/v21.0/${path}`, { method, headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
  const d = await r.json().catch(() => ({}));
  if (!r.ok) { const e = new Error(d?.error?.message || `Meta API error ${r.status}`); e.meta = d?.error; throw e; }
  return d;
}
