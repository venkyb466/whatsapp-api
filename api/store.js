// /api/store
//   GET  ?go=<eventId>.<c|o|t>        -> short link used in template URL buttons (counts the click, redirects)
//   POST ?c=<connectionId>[&k=secret] -> incoming store webhook (Shopify / WooCommerce / custom JSON)
//   POST { action, ... }              -> dashboard actions (signed-in admin):
//        recommended | install_recommended | test_event | run_jobs
import { db, json, requireAuth, readBody, wa } from './_lib.js';
import { normaliseShopify, normaliseWoo, normaliseCustom, ingest, hmacBase64, safeEqual, recommendedTemplates, runDueJobs } from './_store.js';

export const config = { api: { bodyParser: false } };

function rawBody(req) {
  // Safety net: if the platform already consumed the stream, fall back to its parsed body.
  if (req.readableEnded) { const b = req.body; return Promise.resolve(Buffer.isBuffer(b) ? b : Buffer.from(typeof b === 'string' ? b : JSON.stringify(b || {}))); }
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(c)));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

export default async function handler(req, res) {
  if (req.method === 'OPTIONS') return json(res, 200, {});

  // ---- short links ----
  if (req.method === 'GET' && req.query.go) {
    const [id, t] = String(req.query.go).split('.');
    const { data: se } = /^[0-9a-f-]{36}$/i.test(id || '') ? await db.from('store_events').select('id,clicks,checkout_url,order_url,tracking_url').eq('id', id).maybeSingle() : { data: null };
    if (!se) return res.status(404).send('Link expired');
    await db.from('store_events').update({ clicks: (se.clicks || 0) + 1 }).eq('id', se.id);
    const target = t === 'c' ? se.checkout_url : t === 't' ? (se.tracking_url || se.order_url) : se.order_url;
    if (!target || !/^https?:\/\//i.test(target)) return res.status(404).send('Link not available yet');
    res.setHeader('Location', target);
    return res.status(302).end();
  }

  // ---- incoming store webhooks ----
  if (req.method === 'POST' && req.query.c) {
    const raw = await rawBody(req);
    const { data: conn } = /^[0-9a-f-]{36}$/i.test(String(req.query.c)) ? await db.from('store_connections').select('*').eq('id', req.query.c).maybeSingle() : { data: null };
    if (!conn || !conn.active) return json(res, 404, { error: 'Unknown or disabled store connection' });

    const shopifySig = req.headers['x-shopify-hmac-sha256'];
    const wooSig = req.headers['x-wc-webhook-signature'];
    let ok = false;
    if (shopifySig) ok = safeEqual(hmacBase64(conn.webhook_secret, raw), shopifySig);
    else if (wooSig) ok = safeEqual(hmacBase64(conn.webhook_secret, raw), wooSig);
    else ok = safeEqual(req.query.k, conn.webhook_secret) || safeEqual(req.headers['x-webhook-secret'], conn.webhook_secret);
    if (!ok) return json(res, 401, { error: 'Invalid signature — check the webhook secret in Store settings' });

    let payload = {};
    try { payload = JSON.parse(raw.toString('utf8') || '{}'); } catch {
      return json(res, 200, { ok: true, note: 'Non-JSON ping accepted' }); // WooCommerce sends a form-encoded ping when the webhook is created
    }
    let events = [];
    if (shopifySig) events = normaliseShopify(req.headers['x-shopify-topic'], payload);
    else if (wooSig) events = normaliseWoo(req.headers['x-wc-webhook-topic'], payload);
    else events = normaliseCustom(payload);
    events = events.map((e) => ({ ...e, raw: payload }));
    try {
      const results = await ingest(conn, conn.platform, events);
      return json(res, 200, { ok: true, results });
    } catch (err) {
      console.error('store ingest failed', err);
      return json(res, 200, { ok: false, error: err.message }); // 200 so the store doesn't disable the webhook
    }
  }

  // ---- dashboard actions ----
  if (req.method !== 'POST') return json(res, 405, { error: 'Method not allowed' });
  let b = {};
  try { b = JSON.parse((await rawBody(req)).toString('utf8') || '{}'); } catch { b = {}; }
  const auth = await requireAuth(req, res, { admin: true }); if (!auth) return;
  const host = req.headers['x-forwarded-host'] || req.headers.host;

  try {
    if (auth.via === 'secret') return b.action === 'run_jobs' ? json(res, 200, await runDueJobs(50)) : json(res, 400, { error: 'Sign in to use this action' });
    const ws = auth.ws;
    switch (b.action) {
      case 'recommended':
        return json(res, 200, { templates: recommendedTemplates(host) });

      case 'install_recommended': {
        // Submit chosen templates to Meta and create (inactive) automations wired to them.
        const keys = Array.isArray(b.keys) && b.keys.length ? b.keys : recommendedTemplates(host).map((t) => t.key);
        const client = wa(ws);
        const out = [];
        for (const t of recommendedTemplates(host).filter((x) => keys.includes(x.key))) {
          const components = [{ type: 'BODY', text: t.body, example: { body_text: [t.example] } }];
          if (t.footer) components.push({ type: 'FOOTER', text: t.footer });
          if (t.buttons?.length) components.push({ type: 'BUTTONS', buttons: t.buttons });
          let status = null, error = null;
          try {
            const r = await client.graph(`${ws.waba_id}/message_templates`, { method: 'POST', body: { name: t.name, category: t.category, language: 'en', components } });
            status = r.status;
          } catch (e) { error = e.message; if (/already exists|duplicate/i.test(e.message)) { error = null; status = 'EXISTS'; } }
          if (!error) {
            const { data: existing } = await db.from('automations').select('id').eq('workspace_id', ws.id).eq('template_name', t.name).maybeSingle();
            if (!existing) await db.from('automations').insert({ workspace_id: ws.id, event: t.event, name: t.name.replace(/_\d+$/, '').replace(/_/g, ' '), template_name: t.name, template_language: 'en', params: t.params, url_button_param: t.url_param || null, delay_minutes: t.delay, active: false });
          }
          out.push({ key: t.key, name: t.name, status, error });
        }
        return json(res, 200, { ok: true, results: out });
      }

      case 'test_event': {
        // Simulate a cart or order for a connection so the user can see the flow end to end.
        const { data: conn } = await db.from('store_connections').select('*').eq('id', b.connection_id).eq('workspace_id', ws.id).maybeSingle();
        if (!conn) return json(res, 404, { error: 'Store connection not found' });
        if (!b.phone) return json(res, 400, { error: 'phone required' });
        const id = `test-${Date.now()}`;
        const kind = b.kind || 'order';
        const ev = kind === 'cart'
          ? { kind: 'cart', action: 'cart', external_id: id, customer_name: b.name || 'Test Customer', phone: b.phone, total: 1299, currency: 'INR', items: 'Test product x1', checkout_url: b.url || `https://${host}/` }
          : { kind: 'order', action: kind === 'shipped' ? 'shipped' : 'order', external_id: id, order_number: `#T${String(Date.now()).slice(-4)}`, customer_name: b.name || 'Test Customer', phone: b.phone, total: 1299, currency: 'INR', items: 'Test product x1', is_cod: !!b.cod, order_url: b.url || `https://${host}/`, courier: 'Test Courier', tracking_number: 'TEST123', tracking_url: b.url || `https://${host}/` };
        const results = await ingest(conn, conn.platform, [ev]);
        // Test events skip the delay so the user sees the message within a minute.
        const { data: se } = await db.from('store_events').select('id').eq('workspace_id', ws.id).eq('external_id', id).maybeSingle();
        if (se) await db.from('automation_jobs').update({ run_at: new Date().toISOString() }).eq('store_event_id', se.id).eq('status', 'pending');
        const run = await runDueJobs(10);
        return json(res, 200, { ok: true, results, run });
      }

      default:
        return json(res, 400, { error: 'Unknown action' });
    }
  } catch (err) {
    return json(res, 502, { error: err.message, details: err.meta || null });
  }
}
