// Meta WhatsApp webhook.
//   GET  -> verification handshake (Meta calls this once when you save the callback URL)
//   POST -> incoming messages + delivery status updates, routed to the workspace that owns the phone number
import { db, json, storeInboundMedia, workspaceByPhoneId, getWorkspace, DEFAULT_WS, upsertContact } from './_lib.js';
import { handleInboundBot, inboundPayload } from './_bot.js';
import { handleCodReply } from './_store.js';
import crypto from 'node:crypto';

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
  if (req.method === 'GET') {
    const mode = req.query['hub.mode'], token = req.query['hub.verify_token'], challenge = req.query['hub.challenge'];
    if (mode === 'subscribe' && token && token === process.env.META_WEBHOOK_VERIFY_TOKEN) {
      return res.status(200).send(challenge);
    }
    return res.status(403).send('Verification failed');
  }
  if (req.method !== 'POST') return json(res, 405, { error: 'Method not allowed' });

  const raw = await rawBody(req);
  // Verify the request really comes from Meta (enabled once META_APP_SECRET is set in Vercel).
  if (process.env.META_APP_SECRET) {
    const expected = 'sha256=' + crypto.createHmac('sha256', process.env.META_APP_SECRET).update(raw).digest('hex');
    const got = String(req.headers['x-hub-signature-256'] || '');
    if (got.length !== expected.length || !crypto.timingSafeEqual(Buffer.from(got), Buffer.from(expected))) {
      console.warn('webhook signature mismatch'); return json(res, 401, { error: 'Bad signature' });
    }
  }
  try {
    const body = JSON.parse(raw.toString('utf8') || '{}');
    for (const entry of body.entry || []) {
      for (const change of entry.changes || []) {
        const v = change.value || {};
        const ws = (await workspaceByPhoneId(v.metadata?.phone_number_id))
          || (v.metadata?.phone_number_id === process.env.META_PHONE_NUMBER_ID ? await getWorkspace(DEFAULT_WS) : null);
        if (!ws) { console.warn('webhook for unknown phone_number_id', v.metadata?.phone_number_id); continue; }
        for (const m of v.messages || []) {
          try { await handleInbound(ws, m, v.contacts || []); } catch (err) { console.error('inbound error', err); }
        }
        for (const s of v.statuses || []) {
          try { await handleStatus(s); } catch (err) { console.error('status error', err); }
        }
        // ---- Coexistence (number also used in the WhatsApp Business app on the phone) ----
        for (const m of v.message_echoes || []) {
          try { await handleEcho(ws, m); } catch (err) { console.error('echo error', err); }
        }
        if (v.history) { try { await handleHistory(ws, v); } catch (err) { console.error('history error', err); } }
        if (v.state_sync) { try { await handleStateSync(ws, v.state_sync); } catch (err) { console.error('state sync error', err); } }
      }
    }
  } catch (err) {
    console.error('webhook error', err);
  }
  return json(res, 200, { ok: true });
}

function describe(m) {
  switch (m.type) {
    case 'text': return m.text?.body || '';
    case 'button': return m.button?.text || '[button]';
    case 'interactive': return m.interactive?.button_reply?.title || m.interactive?.list_reply?.title || '[interactive]';
    case 'image': return m.image?.caption ? `[image] ${m.image.caption}` : '[image]';
    case 'video': return m.video?.caption ? `[video] ${m.video.caption}` : '[video]';
    case 'audio': return '[audio]';
    case 'document': return `[document] ${m.document?.filename || ''}`;
    case 'sticker': return '[sticker]';
    case 'location': return `[location] ${m.location?.name ? m.location.name + ' ' : ''}${m.location?.latitude},${m.location?.longitude}`;
    case 'reaction': return `[reaction] ${m.reaction?.emoji || ''}`;
    case 'contacts': return '[contact card] ' + (m.contacts || []).map((c) => c.name?.formatted_name || '').filter(Boolean).join(', ');
    case 'order': return `[order] ${(m.order?.product_items || []).length} item(s)`;
    case 'unsupported': {
      const e = m.errors?.[0];
      return `⚠️ Message type not supported by WhatsApp API${e?.error_data?.details ? ' — ' + e.error_data.details : e?.title ? ' — ' + e.title : ''}. (Usually a poll, view-once photo/video, disappearing message, live location or event.) Ask the contact to resend as a normal message.`;
    }
    default: return `[${m.type}]`;
  }
}

async function handleInbound(ws, m, waContacts) {
  const phone = String(m.from || '').replace(/\D/g, '');
  if (!phone) return;
  const profileName = waContacts.find((c) => c.wa_id === m.from)?.profile?.name;
  const ts = new Date(Number(m.timestamp) * 1000).toISOString();

  // Duplicate delivery from Meta? Then do nothing (prevents double bot replies).
  const { data: dup } = await db.from('messages').select('id').eq('wa_message_id', m.id).maybeSingle();
  if (dup) return;

  let { data: contact } = await db.from('contacts').select('*').eq('workspace_id', ws.id).eq('phone', phone).maybeSingle();
  const isNew = !contact;
  if (!contact) {
    const { data: created, error } = await db.from('contacts')
      .insert({ workspace_id: ws.id, phone, name: profileName || phone, tags: ['inbound'] }).select('*').single();
    if (error) console.error('contact create failed', error.message);
    contact = created;
  }
  if (!contact) return;
  const prevInboundAt = contact.last_inbound_at;

  const row = { workspace_id: ws.id, contact_id: contact.id, direction: 'in', wa_message_id: m.id, msg_type: m.type || 'text', body: describe(m), status: 'received', sent_at: ts, source: 'customer' };
  if (m.type === 'unsupported' || !['text', 'image', 'video', 'audio', 'document', 'sticker', 'button', 'interactive', 'reaction', 'location', 'contacts'].includes(m.type)) row.raw = m;
  if (m.context?.forwarded || m.context?.frequently_forwarded) row.body = `↪ Forwarded${m.context.frequently_forwarded ? ' many times' : ''}\n${row.body}`;
  const media = m.image || m.video || m.audio || m.document || m.sticker;
  if (media?.id && ws.token) {
    try {
      const stored = await storeInboundMedia(ws, media.id, { contactId: contact.id, messageId: m.id, filename: m.document?.filename });
      row.media_url = stored.url; row.media_mime = stored.mime; row.media_name = stored.name;
      row.body = media.caption || (m.type === 'document' ? (m.document?.filename || '') : '');
    } catch (err) { console.error('media store failed', err); row.body = describe(m) + ' (could not download)'; }
  }
  const { error: insErr } = await db.from('messages').insert(row);
  if (insErr) { if (/duplicate/i.test(insErr.message)) return; console.error('message insert failed', insErr.message); }

  const patch = { last_inbound_at: ts, last_message_at: ts, unread_count: (contact.unread_count || 0) + 1 };
  if (contact.conv_status === 'closed') patch.conv_status = 'open';
  if (profileName && (contact.name === contact.phone || !contact.name)) patch.name = profileName;
  await db.from('contacts').update(patch).eq('id', contact.id);
  Object.assign(contact, patch);

  if (!ws.token) return; // can't reply without a connected number
  const payload = inboundPayload(m);
  if (payload.startsWith('cod:')) { await handleCodReply(ws, contact, payload); return; }
  if (m.type === 'reaction') return;
  try { await handleInboundBot(ws, contact, m, { isNew, prevInboundAt }); } catch (err) { console.error('bot error', err.message); }
}

async function handleStatus(s) {
  const status = s.status; // sent | delivered | read | failed
  if (!s.id || !status) return;
  const ts = new Date(Number(s.timestamp) * 1000).toISOString();
  const errMsg = s.errors?.[0] ? `${s.errors[0].code}: ${s.errors[0].title}${s.errors[0].message ? ' - ' + s.errors[0].message : ''}` : null;

  // Only move forward: sent -> delivered -> read. Never downgrade a read to delivered.
  const rank = { sent: 1, delivered: 2, read: 3, failed: 9 };
  const { data: rows } = await db.from('campaign_log').select('id,status,delivered_at').eq('meta_message_id', s.id);
  for (const row of rows || []) {
    if ((rank[status] || 0) <= (rank[row.status] || 0) && status !== 'failed') continue;
    const patch = { status };
    if (status === 'delivered') patch.delivered_at = ts;
    if (status === 'read') { patch.read_at = ts; if (!row.delivered_at) patch.delivered_at = ts; }
    if (status === 'failed' && errMsg) patch.error_message = errMsg;
    await db.from('campaign_log').update(patch).eq('id', row.id);
  }
  const { data: msgs } = await db.from('messages').select('id,status').eq('wa_message_id', s.id);
  for (const msg of msgs || []) {
    if ((rank[status] || 0) <= (rank[msg.status] || 0) && status !== 'failed') continue;
    await db.from('messages').update({ status }).eq('id', msg.id);
  }
  if (status === 'failed' && errMsg) await db.from('automation_jobs').update({ status: 'failed', error: errMsg }).eq('wa_message_id', s.id);
}


// ---------- Coexistence helpers ----------
const digits = (x) => String(x || '').replace(/\D/g, '');

async function contactFor(ws, phone, name) {
  phone = digits(phone); if (!phone) return null;
  const { data: c } = await db.from('contacts').select('*').eq('workspace_id', ws.id).eq('phone', phone).maybeSingle();
  if (c) return c;
  const { data: created } = await db.from('contacts').insert({ workspace_id: ws.id, phone, name: name || phone, tags: ['whatsapp-app'] }).select('*').single();
  if (created) return created;
  const { data: again } = await db.from('contacts').select('*').eq('workspace_id', ws.id).eq('phone', phone).maybeSingle();
  return again;
}

// A message the business sent from the WhatsApp Business app on the phone -> show it in the inbox as outgoing.
async function handleEcho(ws, m) {
  const { data: dup } = await db.from('messages').select('id').eq('wa_message_id', m.id).maybeSingle();
  if (dup) return;
  const contact = await contactFor(ws, m.to);
  if (!contact) return;
  const ts = new Date(Number(m.timestamp) * 1000).toISOString();
  const row = { workspace_id: ws.id, contact_id: contact.id, direction: 'out', wa_message_id: m.id, msg_type: m.type || 'text', body: describe(m), status: 'sent', sent_at: ts, source: 'phone' };
  const media = m.image || m.video || m.audio || m.document || m.sticker;
  if (media?.id && ws.token) {
    try {
      const stored = await storeInboundMedia(ws, media.id, { contactId: contact.id, messageId: m.id, filename: m.document?.filename });
      row.media_url = stored.url; row.media_mime = stored.mime; row.media_name = stored.name;
      row.body = media.caption || (m.type === 'document' ? (m.document?.filename || '') : '');
    } catch (err) { console.error('echo media failed', err.message); }
  }
  const { error } = await db.from('messages').insert(row);
  if (error && !/duplicate/i.test(error.message)) console.error('echo insert failed', error.message);
  await db.from('contacts').update({ last_message_at: ts }).eq('id', contact.id);
}

// Chat history shared from the phone app (up to 180 days), delivered in chunks right after onboarding.
async function handleHistory(ws, v) {
  const bizNumber = digits(v.metadata?.display_phone_number);
  for (const chunk of v.history || []) {
    for (const thread of chunk.threads || []) {
      const contact = await contactFor(ws, thread.id);
      if (!contact) continue;
      const rows = []; let last = null;
      for (const m of thread.messages || []) {
        const ts = new Date(Number(m.timestamp) * 1000).toISOString();
        const out = bizNumber ? digits(m.from) === bizNumber : digits(m.from) !== digits(thread.id);
        const st = m.history_context?.status;
        rows.push({ workspace_id: ws.id, contact_id: contact.id, direction: out ? 'out' : 'in', wa_message_id: m.id, msg_type: m.type || 'text',
          body: describe(m), status: out ? (st === 'READ' ? 'read' : st === 'DELIVERED' ? 'delivered' : 'sent') : 'received', sent_at: ts, source: out ? 'phone' : 'customer' });
        if (!last || ts > last) last = ts;
      }
      for (let i = 0; i < rows.length; i += 200) {
        const { error } = await db.from('messages').upsert(rows.slice(i, i + 200), { onConflict: 'wa_message_id', ignoreDuplicates: true });
        if (error) console.error('history insert failed', error.message);
      }
      if (last && (!contact.last_message_at || last > contact.last_message_at)) await db.from('contacts').update({ last_message_at: last }).eq('id', contact.id);
    }
  }
}

// Contacts saved in the phone app -> add them to Contacts.
async function handleStateSync(ws, items) {
  for (const it of items || []) {
    if (it.type !== 'contact' || !it.contact?.phone_number) continue;
    if (it.action === 'remove') continue;
    try { await upsertContact(ws.id, it.contact.phone_number, { name: it.contact.full_name || it.contact.first_name, tags: ['phone-contact'] }); }
    catch (err) { console.error('contact sync failed', err.message); }
  }
}
