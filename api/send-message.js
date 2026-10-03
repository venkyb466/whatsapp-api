// POST /api/send-message  { contact_id, text }                                   -> free-form reply (only within 24h of their last message)
// POST /api/send-message  { contact_id, media_url, media_mime, media_name, text } -> image / video / audio / document by public URL (24h window)
// POST /api/send-message  { contact_id, template, language }                     -> template message (works any time)
import { db, json, requireAuth, readBody, wa, logOutbound, mediaKind } from './_lib.js';
import { botSettings } from './_bot.js';

export default async function handler(req, res) {
  if (req.method === 'OPTIONS') return json(res, 200, {});
  if (req.method !== 'POST') return json(res, 405, { error: 'Method not allowed' });
  const auth = await requireAuth(req, res); if (!auth) return;
  if (auth.via !== 'user') return json(res, 403, { error: 'Sign in to send messages' });
  const ws = auth.ws;
  const b = await readBody(req);
  if (!b.contact_id) return json(res, 400, { error: 'contact_id required' });

  const { data: contact } = await db.from('contacts').select('*').eq('id', b.contact_id).eq('workspace_id', ws.id).maybeSingle();
  if (!contact) return json(res, 404, { error: 'Contact not found' });

  try {
    const client = wa(ws);
    let msgId, bodyText, msgType, media = null;
    if (b.template) {
      msgId = await client.sendTemplate(contact.phone, b.template, b.language || 'en', b.params || [contact.name || 'there']);
      bodyText = `[template: ${b.template}]`; msgType = 'template';
    } else {
      const windowOpen = contact.last_inbound_at && (Date.now() - new Date(contact.last_inbound_at).getTime()) < 24 * 3600 * 1000;
      if (!windowOpen) return json(res, 400, { error: 'The 24-hour reply window is closed for this contact. Send a template instead.' });
      const text = String(b.text || '').trim();
      if (b.media_url) {
        const kind = mediaKind(b.media_mime || '');
        msgId = await client.sendMedia(contact.phone, kind, b.media_url, { caption: text, filename: b.media_name });
        bodyText = text; msgType = kind;
        media = { url: b.media_url, mime: b.media_mime || null, name: b.media_name || null };
      } else {
        if (!text) return json(res, 400, { error: 'text required' });
        msgId = await client.sendText(contact.phone, text);
        bodyText = text; msgType = 'text';
      }
    }
    const msg = await logOutbound(ws, contact.id, msgId, { type: msgType, body: bodyText, source: 'manual', authorId: auth.user.id, media });
    // A human is now handling this chat: pause the bot, and claim the chat if nobody owns it.
    const cfg = botSettings(ws);
    const patch = { bot_state: { ...(contact.bot_state || {}), paused_until: new Date(Date.now() + cfg.handoff_minutes * 60000).toISOString() } };
    if (!contact.assigned_to) patch.assigned_to = auth.user.id;
    if (contact.conv_status === 'closed') patch.conv_status = 'open';
    await db.from('contacts').update(patch).eq('id', contact.id);
    return json(res, 200, { ok: true, message: msg });
  } catch (err) {
    return json(res, 502, { error: err.message, details: err.meta || null });
  }
}
