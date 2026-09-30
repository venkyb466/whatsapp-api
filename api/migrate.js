// POST /api/migrate  { action, ... }   (dashboard user or trigger secret)
// Moves a phone number from one WhatsApp Business Account to another using Meta's migration API.
//   action: 'migrate'      { waba_id, cc, phone }        -> adds the number to waba_id with migrate_phone_number=true; returns phone_number_id
//   action: 'request_code' { phone_number_id, method }   -> SMS or VOICE
//   action: 'verify_code'  { phone_number_id, code }
//   action: 'register'     { phone_number_id, pin }      -> registers for Cloud API and sets the 6-digit two-step PIN
//   action: 'subscribe'    { waba_id }                   -> subscribes our app to the WABA's webhooks
//   action: 'status'       { phone_number_id }
import { json, requireAuth, readBody, graph } from './_lib.js';

export default async function handler(req, res) {
  if (req.method === 'OPTIONS') return json(res, 200, {});
  if (req.method !== 'POST') return json(res, 405, { error: 'Method not allowed' });
  const auth = await requireAuth(req, res); if (!auth) return;
  const b = await readBody(req);
  try {
    switch (b.action) {
      case 'migrate': {
        if (!b.waba_id || !b.phone) return json(res, 400, { error: 'waba_id and phone required' });
        const r = await graph(`${b.waba_id}/phone_numbers`, { method: 'POST', body: { cc: String(b.cc || '91'), phone_number: String(b.phone).replace(/\D/g, ''), migrate_phone_number: true } });
        return json(res, 200, { ok: true, phone_number_id: r.id, result: r });
      }
      case 'request_code': {
        if (!b.phone_number_id) return json(res, 400, { error: 'phone_number_id required' });
        const r = await graph(`${b.phone_number_id}/request_code`, { method: 'POST', body: { code_method: (b.method || 'SMS').toUpperCase(), language: 'en' } });
        return json(res, 200, { ok: true, result: r });
      }
      case 'verify_code': {
        if (!b.phone_number_id || !b.code) return json(res, 400, { error: 'phone_number_id and code required' });
        const r = await graph(`${b.phone_number_id}/verify_code`, { method: 'POST', body: { code: String(b.code).replace(/\D/g, '') } });
        return json(res, 200, { ok: true, result: r });
      }
      case 'register': {
        if (!b.phone_number_id || !/^\d{6}$/.test(String(b.pin || ''))) return json(res, 400, { error: 'phone_number_id and a 6-digit pin required' });
        const r = await graph(`${b.phone_number_id}/register`, { method: 'POST', body: { messaging_product: 'whatsapp', pin: String(b.pin) } });
        return json(res, 200, { ok: true, result: r });
      }
      case 'subscribe': {
        if (!b.waba_id) return json(res, 400, { error: 'waba_id required' });
        const r = await graph(`${b.waba_id}/subscribed_apps`, { method: 'POST' });
        return json(res, 200, { ok: true, result: r });
      }
      case 'list_numbers': {
        if (!b.waba_id) return json(res, 400, { error: 'waba_id required' });
        const r = await graph(`${b.waba_id}/phone_numbers?fields=id,display_phone_number,verified_name,status,platform_type,quality_rating`);
        return json(res, 200, { ok: true, numbers: r.data || [] });
      }
      case 'delete_number': {
        if (!b.phone_number_id) return json(res, 400, { error: 'phone_number_id required' });
        const r = await graph(`${b.phone_number_id}`, { method: 'DELETE' });
        return json(res, 200, { ok: true, result: r });
      }
      case 'status': {
        if (!b.phone_number_id) return json(res, 400, { error: 'phone_number_id required' });
        const r = await graph(`${b.phone_number_id}?fields=id,display_phone_number,verified_name,status,code_verification_status,quality_rating,messaging_limit_tier,name_status,platform_type`);
        return json(res, 200, { ok: true, phone: r });
      }
      default:
        return json(res, 400, { error: 'Unknown action' });
    }
  } catch (err) {
    return json(res, 502, { error: err.message, details: err.meta || null });
  }
}
