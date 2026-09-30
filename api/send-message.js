// POST /api/send-message  { contact_id, text }                                   -> free-form reply (only within 24h of their last message)
// POST /api/send-message  { contact_id, media_url, media_mime, media_name, text } -> image / video / audio / document by public URL (24h window)
// POST /api/send-message  { contact_id, template, language }                     -> template message (works any time)
import { db, json, requireAuth, readBody, sendText, sendTemplate, sendMedia } from './_lib.js';

function kindOf(mime = '') {
  if (mime.startsWith('image/')) return 'image';
  if (mime.startsWith('video/')) return 'video';
  if (mime.startsWith('audio/')) return 'audio';
  return 'document';
}

export default async function handler(req, res) {
  if (req.method === 'OPTIONS') return json(res, 200, {});
  if (req.method !== 'POST') return json(res, 405, { error: 'Method not allowed' });
  const auth = await requireAuth(req, res); if (!auth) return;
  const b = await readBody(req);
  if (!b.contact_id) return json(res, 400, { error: 'contact_id required' });

  const { data: contact } = await db.from('contacts').select('id,name,phone,last_inbound_at').eq('id', b.contact_id).single();
  if (!contact) return json(res, 404, { error: 'Contact not found' });

  try {
    let msgId, bodyText, msgType;
    const row = {};
    if (b.template) {
      msgId = await sendTemplate(contact.phone, b.template, b.language || 'en', [contact.name || 'there']);
      bodyText = `[template: ${b.template}]`; msgType = 'template';
    } else {
      const windowOpen = contact.last_inbound_at && (Date.now() - new Date(contact.last_inbound_at).getTime()) < 24 * 3600 * 1000;
      if (!windowOpen) return json(res, 400, { error: 'The 24-hour reply window is closed for this contact. Send a template instead.' });
      const text = String(b.text || '').trim();
      if (b.media_url) {
        const kind = kindOf(b.media_mime || '');
        msgId = await sendMedia(contact.phone, kind, b.media_url, { caption: text, filename: b.media_name });
        bodyText = text; msgType = kind;
        row.media_url = b.media_url; row.media_mime = b.media_mime || null; row.media_name = b.media_name || null;
      } else {
        if (!text) return json(res, 400, { error: 'text required' });
        msgId = await sendText(contact.phone, text);
        bodyText = text; msgType = 'text';
      }
    }
    const now = new Date().toISOString();
    const { data: msg } = await db.from('messages').insert({
      contact_id: contact.id, direction: 'out', wa_message_id: msgId, msg_type: msgType, body: bodyText, status: 'sent', sent_at: now, ...row,
    }).select().single();
    await db.from('contacts').update({ last_message_at: now }).eq('id', contact.id);
    return json(res, 200, { ok: true, message: msg });
  } catch (err) {
    return json(res, 502, { error: err.message, details: err.meta || null });
  }
}
