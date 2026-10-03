// Store automations: Shopify / WooCommerce / custom webhooks -> carts & orders -> scheduled WhatsApp templates.
import crypto from 'node:crypto';
import { db, wa, getWorkspace, logOutbound, upsertContact, normalisePhone } from './_lib.js';

// ---------- signature checks ----------
export function hmacBase64(secret, raw) { return crypto.createHmac('sha256', secret).update(raw).digest('base64'); }
export function safeEqual(a, b) {
  const x = Buffer.from(String(a || '')), y = Buffer.from(String(b || ''));
  return x.length === y.length && x.length > 0 && crypto.timingSafeEqual(x, y);
}

// ---------- payload normalisation ----------
const fullName = (o) => [o?.first_name, o?.last_name].filter(Boolean).join(' ').trim();
const itemsText = (lines, key = 'title') => (lines || []).map((l) => `${l[key] || l.name || l.title}${l.quantity > 1 ? ` x${l.quantity}` : ''}`).join(', ').slice(0, 300);

// Returns a list of normalised events: { kind, action, external_id, ... }
// action: cart | cart_completed | order | shipped | delivered | cancelled
export function normaliseShopify(topic, p) {
  const t = String(topic || '').toLowerCase();
  if (t.startsWith('checkouts/')) {
    const cust = p.customer || {};
    return [{
      kind: 'cart', action: p.completed_at ? 'cart_completed' : 'cart', external_id: String(p.id || p.token),
      checkout_token: p.token || null, customer_name: fullName(p.shipping_address) || fullName(p.billing_address) || fullName(cust) || null,
      phone: p.phone || p.shipping_address?.phone || p.billing_address?.phone || cust.phone || null, email: p.email || cust.email || null,
      total: p.total_price != null ? Number(p.total_price) : null, currency: p.currency || p.presentment_currency || null,
      items: itemsText(p.line_items), checkout_url: p.abandoned_checkout_url || null,
    }];
  }
  if (t === 'orders/create' || t === 'orders/paid' || t === 'orders/updated' || t === 'orders/fulfilled' || t === 'orders/cancelled') {
    const cust = p.customer || {};
    const gateways = (p.payment_gateway_names || []).join(' ').toLowerCase() + ' ' + String(p.gateway || '').toLowerCase();
    const base = {
      kind: 'order', external_id: String(p.id), checkout_token: p.checkout_token || null, order_number: p.name || (p.order_number ? `#${p.order_number}` : null),
      customer_name: fullName(p.shipping_address) || fullName(p.billing_address) || fullName(cust) || null,
      phone: p.phone || p.shipping_address?.phone || p.billing_address?.phone || cust.phone || null, email: p.email || cust.email || null,
      total: p.total_price != null ? Number(p.total_price) : null, currency: p.currency || null, items: itemsText(p.line_items),
      order_url: p.order_status_url || null,
      is_cod: /cash on delivery|\bcod\b/.test(gateways) && p.financial_status !== 'paid',
    };
    const out = [{ ...base, action: t === 'orders/cancelled' || p.cancelled_at ? 'cancelled' : 'order' }];
    const f = (p.fulfillments || []).slice(-1)[0];
    if (f && (t === 'orders/fulfilled' || t === 'orders/updated')) {
      out.push({ ...base, action: f.shipment_status === 'delivered' ? 'delivered' : 'shipped', tracking_number: f.tracking_number || null, tracking_url: f.tracking_url || null, courier: f.tracking_company || null });
    }
    return out;
  }
  if (t === 'fulfillments/create' || t === 'fulfillments/update') {
    return [{ kind: 'order', external_id: String(p.order_id), action: p.shipment_status === 'delivered' ? 'delivered' : 'shipped', tracking_number: p.tracking_number || null, tracking_url: p.tracking_url || null, courier: p.tracking_company || null, partial: true }];
  }
  return [];
}

export function normaliseWoo(topic, p) {
  const t = String(topic || '').toLowerCase();
  if (!t.startsWith('order.')) return [];
  const status = String(p.status || '');
  const track = (p.meta_data || []).find((m) => m.key === '_wc_shipment_tracking_items')?.value?.[0] || {};
  const base = {
    kind: 'order', external_id: String(p.id), order_number: p.number ? `#${p.number}` : `#${p.id}`,
    customer_name: fullName(p.shipping) || fullName(p.billing) || null, phone: p.billing?.phone || p.shipping?.phone || null, email: p.billing?.email || null,
    total: p.total != null ? Number(p.total) : null, currency: p.currency || null, items: itemsText(p.line_items, 'name'),
    is_cod: p.payment_method === 'cod', country: p.billing?.country || null,
    tracking_number: track.tracking_number || null, tracking_url: track.custom_tracking_link || null, courier: track.tracking_provider || track.custom_tracking_provider || null,
  };
  if (status === 'cancelled' || status === 'failed' || status === 'refunded') return [{ ...base, action: 'cancelled' }];
  if (status === 'completed') return [{ ...base, action: 'order' }, { ...base, action: 'shipped' }];
  if (status === 'delivered') return [{ ...base, action: 'order' }, { ...base, action: 'delivered' }];
  if (['pending', 'processing', 'on-hold'].includes(status) || t === 'order.created') return [{ ...base, action: 'order' }];
  return [];
}

// Custom / CartFlows "Cart Abandonment Recovery" plugin / any site posting JSON
export function normaliseCustom(p) {
  const ev = String(p.event || p.order_status || '').toLowerCase();
  const phone = p.phone || p.phone_number || p.billing_phone || null;
  const name = p.name || p.customer_name || [p.first_name, p.last_name].filter(Boolean).join(' ') || null;
  const common = { customer_name: name, phone, email: p.email || null, total: p.total ?? p.cart_total ?? null, currency: p.currency || null,
    items: Array.isArray(p.items) ? p.items.join(', ') : (p.items || p.product_names || null), checkout_url: p.checkout_url || null };
  if (['cart', 'abandoned', 'abandoned_cart'].includes(ev)) return [{ kind: 'cart', action: 'cart', external_id: String(p.id || p.session_id || p.checkout_id || phone || p.email), ...common }];
  if (['completed', 'cart_completed', 'converted'].includes(ev)) return [{ kind: 'cart', action: 'cart_completed', external_id: String(p.id || p.session_id || p.checkout_id || phone || p.email), ...common }];
  const order = { kind: 'order', external_id: String(p.order_id || p.id), order_number: p.order_number ? String(p.order_number) : null, is_cod: !!(p.cod || /cod|cash/i.test(p.payment_method || '')),
    order_url: p.order_url || null, tracking_number: p.tracking_number || null, tracking_url: p.tracking_url || null, courier: p.courier || null, ...common };
  if (['order', 'order_created', 'order.created'].includes(ev)) return [{ ...order, action: 'order' }];
  if (['shipped', 'order_shipped', 'fulfilled'].includes(ev)) return [{ ...order, action: 'shipped' }];
  if (['delivered', 'order_delivered'].includes(ev)) return [{ ...order, action: 'delivered' }];
  if (['cancelled', 'canceled', 'order_cancelled'].includes(ev)) return [{ ...order, action: 'cancelled' }];
  return [];
}

// ---------- ingest ----------
const ACTION_EVENTS = { cart: ['abandoned_cart'], order: ['order_created'], shipped: ['order_shipped'], delivered: ['order_delivered'], cancelled: ['order_cancelled'] };
const STATUS_RANK = { created: 0, cart: 0, abandoned: 0, completed: 1, paid: 1, shipped: 2, delivered: 3, cancelled: 9 };

export async function ingest(conn, platform, events) {
  const ws = await getWorkspace(conn.workspace_id);
  const results = [];
  for (const ev of events) {
    if (!ev.external_id || ev.external_id === 'undefined' || ev.external_id === 'null') continue;
    const { data: existing } = await db.from('store_events').select('*').eq('workspace_id', ws.id).eq('kind', ev.kind).eq('external_id', ev.external_id).maybeSingle();
    const phone = normalisePhone(ev.phone || existing?.phone, ev.country === 'IN' || !ev.country ? conn.default_country_code : '');
    const status = ev.action === 'cart' ? 'abandoned' : ev.action === 'cart_completed' ? 'completed' : ev.action === 'order' ? (existing?.status && STATUS_RANK[existing.status] > 1 ? existing.status : 'created') : ev.action;
    const row = {
      workspace_id: ws.id, connection_id: conn.id, kind: ev.kind, external_id: ev.external_id, updated_at: new Date().toISOString(), last_activity_at: new Date().toISOString(),
      status: existing && STATUS_RANK[existing.status] > STATUS_RANK[status] && status !== 'cancelled' ? existing.status : status,
    };
    for (const k of ['checkout_token', 'order_number', 'customer_name', 'email', 'total', 'currency', 'items', 'checkout_url', 'order_url', 'tracking_number', 'tracking_url', 'courier']) {
      if (ev[k] != null && ev[k] !== '') row[k] = ev[k];
    }
    if (phone) row.phone = phone;
    if (ev.kind === 'order' && ev.is_cod != null && !existing) { row.is_cod = !!ev.is_cod; if (ev.is_cod) row.cod_status = 'pending'; }
    if (ev.raw) row.raw = ev.raw;

    let contact = null;
    if (row.phone || existing?.phone) {
      try { contact = await upsertContact(ws.id, row.phone || existing.phone, { name: row.customer_name || existing?.customer_name, tags: [platform], email: row.email }); } catch { contact = null; }
      if (contact) row.contact_id = contact.id;
    }
    const { data: saved, error } = await db.from('store_events').upsert(row, { onConflict: 'workspace_id,kind,external_id' }).select().single();
    if (error) { results.push({ external_id: ev.external_id, error: error.message }); continue; }

    // A completed cart or a new order stops abandoned-cart reminders and counts as recovered if we nudged them.
    if (ev.action === 'cart_completed' || ev.action === 'order') await closeCarts(ws.id, saved);

    const toSchedule = [...(ACTION_EVENTS[ev.action] || [])];
    if (ev.action === 'order' && saved.is_cod && saved.cod_status === 'pending') toSchedule.push('cod_confirmation');
    let scheduled = 0;
    for (const evt of toSchedule) scheduled += await schedule(ws.id, evt, saved);
    if (ev.action === 'cancelled') await db.from('automation_jobs').update({ status: 'cancelled', error: 'Order cancelled' }).eq('store_event_id', saved.id).eq('status', 'pending');
    results.push({ external_id: ev.external_id, action: ev.action, scheduled });
  }
  await db.from('store_connections').update({ last_event_at: new Date().toISOString() }).eq('id', conn.id);
  return results;
}

async function schedule(wsId, event, se) {
  const { data: autos } = await db.from('automations').select('*').eq('workspace_id', wsId).eq('event', event).eq('active', true);
  let n = 0;
  for (const a of autos || []) {
    const base = event === 'abandoned_cart' ? new Date(se.last_activity_at || Date.now()) : new Date();
    const runAt = new Date(base.getTime() + (a.delay_minutes || 0) * 60000).toISOString();
    const { data: job } = await db.from('automation_jobs').select('id,status').eq('automation_id', a.id).eq('store_event_id', se.id).maybeSingle();
    if (job) {
      // Cart still being edited -> push the reminder back so it fires X minutes after the LAST activity.
      if (job.status === 'pending' && event === 'abandoned_cart') await db.from('automation_jobs').update({ run_at: runAt }).eq('id', job.id);
      continue;
    }
    const { error } = await db.from('automation_jobs').insert({ workspace_id: wsId, automation_id: a.id, store_event_id: se.id, contact_id: se.contact_id, run_at: runAt });
    if (!error) n++;
  }
  return n;
}

async function closeCarts(wsId, se) {
  let q = db.from('store_events').select('id, status').eq('workspace_id', wsId).eq('kind', 'cart').neq('status', 'completed');
  if (se.kind === 'cart') q = q.eq('id', se.id);
  else if (se.checkout_token) q = q.eq('checkout_token', se.checkout_token);
  else if (se.phone) q = q.eq('phone', se.phone).gte('created_at', new Date(Date.now() - 3 * 86400000).toISOString());
  else return;
  const { data: carts } = await q;
  for (const c of carts || []) {
    const { data: sentJobs } = await db.from('automation_jobs').select('id').eq('store_event_id', c.id).eq('status', 'sent').limit(1);
    await db.from('store_events').update({ status: 'completed', recovered: !!sentJobs?.length, updated_at: new Date().toISOString() }).eq('id', c.id);
    await db.from('automation_jobs').update({ status: 'cancelled', error: 'Customer completed the purchase' }).eq('store_event_id', c.id).eq('status', 'pending');
  }
}

// ---------- template variables ----------
export const VARIABLES = {
  customer_name: 'Customer name', first_name: 'First name', order_number: 'Order number', total: 'Order/cart total (₹1,299)',
  items: 'Items', store_name: 'Store / business name', courier: 'Courier', tracking_number: 'Tracking number',
  checkout_url: 'Checkout link (full URL)', order_url: 'Order status link', tracking_url: 'Tracking link',
  link_checkout: 'Short link id → checkout (for URL buttons)', link_order: 'Short link id → order page', link_tracking: 'Short link id → tracking',
};
export function money(total, currency) {
  if (total == null || total === '') return '';
  try { return new Intl.NumberFormat('en-IN', { style: 'currency', currency: currency || 'INR', maximumFractionDigits: 2 }).format(Number(total)); }
  catch { return `${currency || ''} ${total}`.trim(); }
}
export function varValue(key, se, ws) {
  const first = String(se.customer_name || '').trim().split(/\s+/)[0];
  switch (key) {
    case 'customer_name': return se.customer_name || 'there';
    case 'first_name': return first || 'there';
    case 'order_number': return se.order_number || se.external_id;
    case 'total': return money(se.total, se.currency) || '-';
    case 'items': return se.items || 'your items';
    case 'store_name': return ws.settings?.store_name || ws.name;
    case 'courier': return se.courier || 'our courier partner';
    case 'tracking_number': return se.tracking_number || '-';
    case 'checkout_url': return se.checkout_url || '-';
    case 'order_url': return se.order_url || '-';
    case 'tracking_url': return se.tracking_url || se.order_url || '-';
    case 'link_checkout': return `${se.id}.c`;
    case 'link_order': return `${se.id}.o`;
    case 'link_tracking': return `${se.id}.t`;
    default: return '-';
  }
}

// ---------- job runner (called every minute by the cron tick) ----------
export async function runDueJobs(limit = 25) {
  const { data: jobs } = await db.from('automation_jobs').select('*').eq('status', 'pending').lte('run_at', new Date().toISOString()).order('run_at').limit(limit);
  const out = { sent: 0, skipped: 0, failed: 0 };
  for (const job of jobs || []) {
    // claim it so two overlapping ticks never double-send
    const { data: claimed } = await db.from('automation_jobs').update({ status: 'sending' }).eq('id', job.id).eq('status', 'pending').select('id');
    if (!claimed?.length) continue;
    const finish = (status, extra = {}) => db.from('automation_jobs').update({ status, ...extra }).eq('id', job.id);
    try {
      const [{ data: a }, { data: se }] = await Promise.all([
        db.from('automations').select('*').eq('id', job.automation_id).maybeSingle(),
        db.from('store_events').select('*').eq('id', job.store_event_id).maybeSingle(),
      ]);
      const ws = await getWorkspace(job.workspace_id);
      if (!a || !a.active || !se || !ws) { await finish('skipped', { error: 'Automation disabled or event removed' }); out.skipped++; continue; }
      if (!se.phone) { await finish('skipped', { error: 'No phone number on this cart/order' }); out.skipped++; continue; }
      if (a.event === 'abandoned_cart' && se.status !== 'abandoned') { await finish('cancelled', { error: 'Cart already completed' }); out.skipped++; continue; }
      if (a.event === 'cod_confirmation' && se.cod_status !== 'pending') { await finish('skipped', { error: `COD already ${se.cod_status}` }); out.skipped++; continue; }
      if (se.status === 'cancelled' && a.event !== 'order_cancelled') { await finish('cancelled', { error: 'Order cancelled' }); out.skipped++; continue; }
      const contact = se.contact_id ? (await db.from('contacts').select('*').eq('id', se.contact_id).maybeSingle()).data : await upsertContact(ws.id, se.phone, { name: se.customer_name });
      if (a.event === 'abandoned_cart' && contact?.opted_out) { await finish('skipped', { error: 'Customer opted out of marketing' }); out.skipped++; continue; }

      const params = (a.params || []).map((k) => varValue(k, se, ws));
      const opts = {};
      if (a.url_button_param) opts.urlButton = varValue(a.url_button_param, se, ws);
      if (a.event === 'cod_confirmation') opts.quickReplies = [`cod:yes:${se.id}`, `cod:no:${se.id}`];
      const msgId = await wa(ws).sendTemplate(se.phone, a.template_name, a.template_language, params, opts);
      await finish('sent', { wa_message_id: msgId, sent_at: new Date().toISOString(), error: null });
      if (contact) await logOutbound(ws, contact.id, msgId, { type: 'template', body: `[${a.name}: ${a.template_name}]`, source: 'automation' });
      out.sent++;
    } catch (err) {
      await finish('failed', { error: String(err.message || err).slice(0, 500) });
      out.failed++;
    }
  }
  return out;
}

// ---------- COD confirm / cancel buttons ----------
export async function handleCodReply(ws, contact, payload) {
  const [, answer, eventId] = String(payload).split(':');
  const { data: se } = await db.from('store_events').select('*').eq('id', eventId).eq('workspace_id', ws.id).maybeSingle();
  if (!se) return false;
  const client = wa(ws);
  if (se.cod_status !== 'pending') {
    const t = `Your order ${se.order_number || ''} is already ${se.cod_status}. Reply here if you need help.`;
    const id = await client.sendText(contact.phone, t).catch(() => null);
    if (id) await logOutbound(ws, contact.id, id, { body: t, source: 'automation' });
    return true;
  }
  const confirmed = answer === 'yes';
  await db.from('store_events').update({ cod_status: confirmed ? 'confirmed' : 'cancelled', updated_at: new Date().toISOString() }).eq('id', se.id);
  const tag = confirmed ? 'cod-confirmed' : 'cod-cancelled';
  await db.from('contacts').update({ tags: [...new Set([...(contact.tags || []), tag])] }).eq('id', contact.id);
  const reply = confirmed
    ? `Thank you! Your order ${se.order_number || ''} is confirmed and will be shipped soon.`
    : `Your order ${se.order_number || ''} has been marked for cancellation. Our team will take care of it — reply here if this was a mistake.`;
  const id = await client.sendText(contact.phone, reply).catch(() => null);
  if (id) await logOutbound(ws, contact.id, id, { body: reply, source: 'automation' });
  // Best-effort: tell the store
  try { await pushCodStatus(se, confirmed); } catch (e) { console.error('push cod status failed', e.message); }
  return true;
}

async function pushCodStatus(se, confirmed) {
  if (!se.connection_id) return;
  const { data: conn } = await db.from('store_connections').select('*').eq('id', se.connection_id).maybeSingle();
  if (!conn?.api_key || !conn.shop_domain) return;
  const label = confirmed ? 'COD Confirmed (WhatsApp)' : 'COD Cancel Requested (WhatsApp)';
  const domain = conn.shop_domain.replace(/^https?:\/\//, '').replace(/\/$/, '');
  if (conn.platform === 'shopify') {
    await fetch(`https://${domain}/admin/api/2024-07/graphql.json`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Shopify-Access-Token': conn.api_key },
      body: JSON.stringify({ query: 'mutation($id:ID!,$tags:[String!]!){tagsAdd(id:$id,tags:$tags){userErrors{message}}}', variables: { id: `gid://shopify/Order/${se.external_id}`, tags: [label] } }),
    });
  } else if (conn.platform === 'woocommerce' && conn.api_secret) {
    const auth = 'Basic ' + Buffer.from(`${conn.api_key}:${conn.api_secret}`).toString('base64');
    await fetch(`https://${domain}/wp-json/wc/v3/orders/${se.external_id}/notes`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: auth }, body: JSON.stringify({ note: label }),
    });
  }
}

// ---------- recommended templates ----------
export function recommendedTemplates(host) {
  const go = `https://${host}/api/store?go={{1}}`;
  const ex = `https://${host}/api/store?go=demo.c`;
  return [
    { key: 'abandoned_cart', name: 'cart_reminder_1', category: 'MARKETING', event: 'abandoned_cart', delay: 60, params: ['first_name', 'items', 'store_name'], url_param: 'link_checkout',
      body: 'Hi {{1}}, you left {{2}} in your cart at {{3}}. Your items are still waiting — complete your order before they sell out!',
      example: ['Riya', 'Silk saree x1', 'Namo Store'], footer: 'Reply STOP to opt out', buttons: [{ type: 'URL', text: 'Complete my order', url: go, example: [ex] }] },
    { key: 'order_created', name: 'order_confirmation_1', category: 'UTILITY', event: 'order_created', delay: 0, params: ['first_name', 'order_number', 'store_name', 'total'], url_param: 'link_order',
      body: 'Hi {{1}}, thank you for your order {{2}} at {{3}}. Order total: {{4}}. We will notify you here as soon as it ships.',
      example: ['Riya', '#1001', 'Namo Store', '₹1,299.00'], buttons: [{ type: 'URL', text: 'View order', url: go, example: [ex.replace('.c', '.o')] }] },
    { key: 'cod_confirmation', name: 'cod_confirmation_1', category: 'UTILITY', event: 'cod_confirmation', delay: 0, params: ['first_name', 'order_number', 'total', 'store_name'],
      body: 'Hi {{1}}, please confirm your Cash on Delivery order {{2}} for {{3}} from {{4}} so we can ship it.',
      example: ['Riya', '#1001', '₹1,299.00', 'Namo Store'], buttons: [{ type: 'QUICK_REPLY', text: 'Confirm order' }, { type: 'QUICK_REPLY', text: 'Cancel order' }] },
    { key: 'order_shipped', name: 'shipping_update_1', category: 'UTILITY', event: 'order_shipped', delay: 0, params: ['first_name', 'order_number', 'courier', 'tracking_number'], url_param: 'link_tracking',
      body: 'Hi {{1}}, your order {{2}} has been shipped via {{3}}. Tracking number: {{4}}.',
      example: ['Riya', '#1001', 'Delhivery', 'DL123456789'], buttons: [{ type: 'URL', text: 'Track order', url: go, example: [ex.replace('.c', '.t')] }] },
    { key: 'order_delivered', name: 'delivery_update_1', category: 'UTILITY', event: 'order_delivered', delay: 0, params: ['first_name', 'order_number', 'store_name'],
      body: 'Hi {{1}}, your order {{2}} has been delivered. Thank you for shopping with {{3}}!',
      example: ['Riya', '#1001', 'Namo Store'] },
  ];
}
