// Meta WhatsApp webhook.
//   GET  -> verification handshake (Meta calls this once when you save the callback URL)
//   POST -> incoming messages + delivery status updates
import { db, json } from './_lib.js';

export default async function handler(req, res) {
  if (req.method === 'GET') {
    const mode = req.query['hub.mode'], token = req.query['hub.verify_token'], challenge = req.query['hub.challenge'];
    if (mode === 'subscribe' && token && token === process.env.META_WEBHOOK_VERIFY_TOKEN) {
      return res.status(200).send(challenge);
    }
    return res.status(403).send('Verification failed');
  }
  if (req.method !== 'POST') return json(res, 405, { error: 'Method not allowed' });

  // Always answer 200 quickly; Meta retries otherwise.
  try {
    const body = typeof req.body === 'string' ? JSON.parse(req.body) : req.body || {};
    for (const entry of body.entry || []) {
      for (const change of entry.changes || []) {
        const v = change.value || {};
        for (const m of v.messages || []) await handleInbound(m, v.contacts || []);
        for (const s of v.statuses || []) await handleStatus(s);
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
    case 'location': return `[location] ${m.location?.latitude},${m.location?.longitude}`;
    case 'reaction': return `[reaction] ${m.reaction?.emoji || ''}`;
    default: return `[${m.type}]`;
  }
}

async function handleInbound(m, waContacts) {
  const phone = String(m.from || '').replace(/\D/g, '');
  if (!phone) return;
  const profileName = waContacts.find((c) => c.wa_id === m.from)?.profile?.name;
  const ts = new Date(Number(m.timestamp) * 1000).toISOString();

  // Find or create the contact
  let { data: contact } = await db.from('contacts').select('id,unread_count,name').eq('phone', phone).maybeSingle();
  if (!contact) {
    const { data: created } = await db.from('contacts')
      .insert({ phone, name: profileName || phone, tags: ['inbound'] }).select('id,unread_count,name').single();
    contact = created;
  }
  if (!contact) return;

  await db.from('messages').upsert({
    contact_id: contact.id, direction: 'in', wa_message_id: m.id, msg_type: m.type || 'text', body: describe(m), status: 'received', sent_at: ts,
  }, { onConflict: 'wa_message_id', ignoreDuplicates: true });

  await db.from('contacts').update({
    last_inbound_at: ts, last_message_at: ts, unread_count: (contact.unread_count || 0) + 1,
  }).eq('id', contact.id);
}

async function handleStatus(s) {
  const status = s.status; // sent | delivered | read | failed
  if (!s.id || !status) return;
  const ts = new Date(Number(s.timestamp) * 1000).toISOString();
  const errMsg = s.errors?.[0] ? `${s.errors[0].code}: ${s.errors[0].title}${s.errors[0].message ? ' - ' + s.errors[0].message : ''}` : null;

  // Only move forward: sent -> delivered -> read. Never downgrade a read to delivered.
  const rank = { sent: 1, delivered: 2, read: 3, failed: 9 };
  const { data: rows } = await db.from('campaign_log').select('id,status').eq('meta_message_id', s.id);
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
}
