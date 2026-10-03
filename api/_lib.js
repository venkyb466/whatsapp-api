// Shared helpers for all API functions. Files starting with "_" are not exposed as routes.
import { createClient } from '@supabase/supabase-js';

export const GRAPH = 'https://graph.facebook.com/v21.0';
export const DEFAULT_WS = 'a0000000-0000-4000-8000-000000000001';

export const db = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, {
  auth: { persistSession: false },
});

export function json(res, status, body) {
  res.setHeader('Content-Type', 'application/json');
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', 'authorization, content-type, x-workspace-id');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  return res.status(status).json(body);
}

// ---------- workspaces ----------
const wsCache = new Map(); // short-lived per warm instance
export async function getWorkspace(id, { fresh = false } = {}) {
  if (!id) return null;
  const hit = wsCache.get(id);
  if (!fresh && hit && hit.at > Date.now() - 30_000) return hit.ws;
  const { data: ws } = await db.from('workspaces').select('*').eq('id', id).maybeSingle();
  if (!ws) return null;
  const { data: sec } = await db.from('workspace_secrets').select('access_token').eq('workspace_id', id).maybeSingle();
  ws.token = sec?.access_token || (ws.uses_env_token ? process.env.META_ACCESS_TOKEN : null);
  wsCache.set(id, { ws, at: Date.now() });
  return ws;
}
export async function workspaceByPhoneId(phoneNumberId) {
  if (!phoneNumberId) return null;
  const { data } = await db.from('workspaces').select('id').eq('phone_number_id', String(phoneNumberId)).maybeSingle();
  return data ? getWorkspace(data.id) : null;
}
export function invalidateWorkspace(id) { wsCache.delete(id); }

// Accepts either a logged-in dashboard user (Supabase JWT) or the trigger secret.
// For users, resolves the active workspace (x-workspace-id header or ?ws=) and their role in it.
//   opts.admin  -> require owner/admin role
//   opts.noWorkspace -> don't require a workspace (e.g. signing up)
export async function requireAuth(req, res, opts = {}) {
  const auth = req.headers['authorization'] || '';
  const bearer = auth.startsWith('Bearer ') ? auth.slice(7) : null;
  const secret = req.query?.secret || req.headers['x-campaign-secret'];
  if (secret && secret === process.env.CAMPAIGN_TRIGGER_SECRET) return { via: 'secret' };
  if (!bearer) { json(res, 401, { error: 'Unauthorized' }); return null; }
  const { data, error } = await db.auth.getUser(bearer);
  if (error || !data?.user) { json(res, 401, { error: 'Unauthorized' }); return null; }
  const user = data.user;
  const { data: memberships } = await db.from('workspace_members').select('workspace_id, role').eq('user_id', user.id);
  const wanted = req.headers['x-workspace-id'] || req.query?.ws;
  const m = (memberships || []).find((x) => x.workspace_id === wanted) || (!wanted ? (memberships || [])[0] : null);
  if (!m) {
    if (opts.noWorkspace) return { via: 'user', user, memberships: memberships || [] };
    json(res, 403, { error: wanted ? 'You are not a member of this workspace' : 'No workspace yet — create one first' });
    return null;
  }
  if (opts.admin && !['owner', 'admin'].includes(m.role)) { json(res, 403, { error: 'Only workspace owners and admins can do this' }); return null; }
  const ws = await getWorkspace(m.workspace_id);
  if (ws?.status === 'suspended') { json(res, 403, { error: 'This workspace is suspended' }); return null; }
  return { via: 'user', user, ws, role: m.role, memberships: memberships || [] };
}

export async function readBody(req) {
  if (req.body && typeof req.body === 'object') return req.body;
  if (typeof req.body === 'string') { try { return JSON.parse(req.body); } catch { return {}; } }
  return await new Promise((resolve) => {
    let raw = '';
    req.on('data', (c) => (raw += c));
    req.on('end', () => { try { resolve(JSON.parse(raw || '{}')); } catch { resolve({}); } });
  });
}

// ---------- Meta Graph API ----------
export async function graph(path, { method = 'GET', body, token } = {}) {
  const res = await fetch(`${GRAPH}/${path}`, {
    method,
    headers: { Authorization: `Bearer ${token || process.env.META_ACCESS_TOKEN}`, 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const e = new Error(data?.error?.error_user_msg || data?.error?.message || `Meta API error ${res.status}`);
    e.meta = data?.error; throw e;
  }
  return data;
}

// A WhatsApp client bound to one workspace's number and token.
export function wa(ws) {
  if (!ws) throw new Error('Workspace not found');
  if (!ws.phone_number_id || !ws.token) throw new Error('WhatsApp is not connected for this workspace yet (Settings → Connect WhatsApp).');
  const g = (path, o = {}) => graph(path, { ...o, token: ws.token });
  const send = async (payload) => {
    const data = await g(`${ws.phone_number_id}/messages`, { method: 'POST', body: { messaging_product: 'whatsapp', recipient_type: 'individual', ...payload } });
    return data.messages?.[0]?.id || null;
  };
  return {
    graph: g,
    // params: array of strings for body {{1}}..; opts.urlButton: dynamic URL suffix; opts.quickReplies: payload strings per quick-reply button
    sendTemplate(phone, name, language, params = [], opts = {}) {
      const template = { name, language: { code: language || 'en' } };
      const components = [];
      if (params.length) components.push({ type: 'body', parameters: params.map((t) => ({ type: 'text', text: String(t ?? '').slice(0, 1024) || '-' })) });
      if (opts.urlButton) components.push({ type: 'button', sub_type: 'url', index: String(opts.urlButtonIndex || 0), parameters: [{ type: 'text', text: String(opts.urlButton) }] });
      (opts.quickReplies || []).forEach((payload, i) => {
        if (payload) components.push({ type: 'button', sub_type: 'quick_reply', index: String(i), parameters: [{ type: 'payload', payload: String(payload) }] });
      });
      if (components.length) template.components = components;
      return send({ to: phone, type: 'template', template });
    },
    sendText(phone, text) { return send({ to: phone, type: 'text', text: { body: text, preview_url: true } }); },
    sendMedia(phone, kind, link, { caption, filename } = {}) {
      const obj = { link };
      if (caption && ['image', 'video', 'document'].includes(kind)) obj.caption = caption;
      if (filename && kind === 'document') obj.filename = filename;
      return send({ to: phone, type: kind, [kind]: obj });
    },
    // buttons: [{id, title}] — up to 3 become reply buttons, more become a list
    sendChoices(phone, text, buttons, { header, footer, listButton = 'Choose' } = {}) {
      const b = buttons.slice(0, 10).map((x) => ({ id: String(x.id).slice(0, 256), title: String(x.title).slice(0, buttons.length <= 3 ? 20 : 24) }));
      const interactive = b.length <= 3
        ? { type: 'button', body: { text }, action: { buttons: b.map((x) => ({ type: 'reply', reply: x })) } }
        : { type: 'list', body: { text }, action: { button: listButton.slice(0, 20), sections: [{ title: 'Options', rows: b }] } };
      if (header) interactive.header = { type: 'text', text: header.slice(0, 60) };
      if (footer) interactive.footer = { text: footer.slice(0, 60) };
      return send({ to: phone, type: 'interactive', interactive });
    },
  };
}

export function mediaKind(mime = '') {
  if (mime.startsWith('image/')) return 'image';
  if (mime.startsWith('video/')) return 'video';
  if (mime.startsWith('audio/')) return 'audio';
  return 'document';
}

// Download an inbound media file from Meta and store it in the public "media" bucket. Returns { url, mime, name }.
export async function storeInboundMedia(ws, mediaId, { contactId, messageId, filename } = {}) {
  const meta = await graph(`${mediaId}`, { token: ws.token });
  const r = await fetch(meta.url, { headers: { Authorization: `Bearer ${ws.token}` } });
  if (!r.ok) throw new Error(`Media download failed (${r.status})`);
  const buf = Buffer.from(await r.arrayBuffer());
  const mime = meta.mime_type || r.headers.get('content-type') || 'application/octet-stream';
  const ext = (filename && filename.includes('.')) ? filename.split('.').pop() : (mimeExt[mime.split(';')[0]] || 'bin');
  const path = `in/${ws.id}/${contactId || 'unknown'}/${(messageId || mediaId).replace(/[^\w.-]/g, '_')}.${ext}`;
  const { error } = await db.storage.from('media').upload(path, buf, { contentType: mime, upsert: true });
  if (error) throw new Error(error.message);
  const { data } = db.storage.from('media').getPublicUrl(path);
  return { url: data.publicUrl, mime, name: filename || null };
}
const mimeExt = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp', 'image/gif': 'gif', 'video/mp4': 'mp4', 'video/3gpp': '3gp', 'audio/ogg': 'ogg', 'audio/mpeg': 'mp3', 'audio/mp4': 'm4a', 'audio/aac': 'aac', 'audio/amr': 'amr', 'application/pdf': 'pdf', 'text/plain': 'txt', 'application/msword': 'doc', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document': 'docx', 'application/vnd.ms-excel': 'xls', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': 'xlsx', 'application/vnd.ms-powerpoint': 'ppt', 'application/vnd.openxmlformats-officedocument.presentationml.presentation': 'pptx' };

// Record an outbound message in the inbox and bump the contact.
export async function logOutbound(ws, contactId, msgId, { type = 'text', body = '', source = 'manual', authorId = null, campaignId = null, media = null } = {}) {
  const now = new Date().toISOString();
  const row = { workspace_id: ws.id, contact_id: contactId, direction: 'out', wa_message_id: msgId, msg_type: type, body, status: 'sent', sent_at: now, source, author_id: authorId, campaign_id: campaignId };
  if (media) Object.assign(row, { media_url: media.url, media_mime: media.mime || null, media_name: media.name || null });
  const { data } = await db.from('messages').insert(row).select().single();
  await db.from('contacts').update({ last_message_at: now }).eq('id', contactId);
  return data;
}

// Find or create a contact in a workspace by phone number.
export async function upsertContact(wsId, phone, { name, tags = [], email } = {}) {
  phone = String(phone || '').replace(/\D/g, '');
  if (!phone) return null;
  const { data: existing } = await db.from('contacts').select('*').eq('workspace_id', wsId).eq('phone', phone).maybeSingle();
  if (existing) {
    const patch = {};
    if (tags.length) patch.tags = [...new Set([...(existing.tags || []), ...tags])];
    if (email && !existing.email) patch.email = email;
    if (name && (!existing.name || existing.name === existing.phone || existing.name === 'Customer')) patch.name = name;
    if (Object.keys(patch).length) { await db.from('contacts').update(patch).eq('id', existing.id); Object.assign(existing, patch); }
    return existing;
  }
  const { data: created, error } = await db.from('contacts').insert({ workspace_id: wsId, phone, name: name || phone, tags, email: email || null }).select().single();
  if (error) {
    // Race with another insert, or plan limit — try reading again
    const { data: again } = await db.from('contacts').select('*').eq('workspace_id', wsId).eq('phone', phone).maybeSingle();
    if (again) return again;
    throw new Error(error.message);
  }
  return created;
}

// Normalise a phone number to E.164 digits, adding the default country code for 10-digit local numbers.
export function normalisePhone(raw, defaultCc = '91') {
  let p = String(raw || '').replace(/[^\d+]/g, '');
  if (!p) return null;
  if (p.startsWith('+')) return p.slice(1);
  p = p.replace(/^0+/, '');
  if (defaultCc && p.length === 10) return defaultCc + p;
  return p.length >= 10 ? p : null;
}

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
