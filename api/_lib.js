// Shared helpers for all API functions. Files starting with "_" are not exposed as routes.
import { createClient } from '@supabase/supabase-js';

export const GRAPH = 'https://graph.facebook.com/v21.0';

export const db = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, {
  auth: { persistSession: false },
});

export function json(res, status, body) {
  res.setHeader('Content-Type', 'application/json');
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', 'authorization, content-type');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  return res.status(status).json(body);
}

// Accepts either a logged-in dashboard user (Supabase JWT) or the trigger secret.
export async function requireAuth(req, res) {
  const auth = req.headers['authorization'] || '';
  const bearer = auth.startsWith('Bearer ') ? auth.slice(7) : null;
  const secret = req.query?.secret || req.headers['x-campaign-secret'];
  if (secret && secret === process.env.CAMPAIGN_TRIGGER_SECRET) return { via: 'secret' };
  if (bearer) {
    const { data, error } = await db.auth.getUser(bearer);
    if (!error && data?.user) return { via: 'user', user: data.user };
  }
  json(res, 401, { error: 'Unauthorized' });
  return null;
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

export async function graph(path, { method = 'GET', body } = {}) {
  const res = await fetch(`${GRAPH}/${path}`, {
    method,
    headers: { Authorization: `Bearer ${process.env.META_ACCESS_TOKEN}`, 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const e = new Error(data?.error?.message || `Meta API error ${res.status}`);
    e.meta = data?.error; throw e;
  }
  return data;
}

export function requireMetaConfig() {
  const missing = ['META_ACCESS_TOKEN', 'META_PHONE_NUMBER_ID'].filter((k) => !process.env[k]);
  if (missing.length) throw new Error(`Missing environment variables: ${missing.join(', ')}. Add them in Vercel and redeploy.`);
}

export async function sendTemplate(phone, templateName, language, bodyParams = []) {
  requireMetaConfig();
  const template = { name: templateName, language: { code: language || 'en' } };
  if (bodyParams.length) template.components = [{ type: 'body', parameters: bodyParams.map((t) => ({ type: 'text', text: String(t) })) }];
  const data = await graph(`${process.env.META_PHONE_NUMBER_ID}/messages`, {
    method: 'POST',
    body: { messaging_product: 'whatsapp', to: phone, type: 'template', template },
  });
  return data.messages?.[0]?.id || null;
}

export async function sendText(phone, text) {
  requireMetaConfig();
  const data = await graph(`${process.env.META_PHONE_NUMBER_ID}/messages`, {
    method: 'POST',
    body: { messaging_product: 'whatsapp', to: phone, type: 'text', text: { body: text, preview_url: false } },
  });
  return data.messages?.[0]?.id || null;
}

// Send an image / video / audio / document by public URL (the file must be reachable by Meta's servers).
export async function sendMedia(phone, kind, link, { caption, filename } = {}) {
  requireMetaConfig();
  const obj = { link };
  if (caption && (kind === 'image' || kind === 'video' || kind === 'document')) obj.caption = caption;
  if (filename && kind === 'document') obj.filename = filename;
  const data = await graph(`${process.env.META_PHONE_NUMBER_ID}/messages`, {
    method: 'POST',
    body: { messaging_product: 'whatsapp', to: phone, type: kind, [kind]: obj },
  });
  return data.messages?.[0]?.id || null;
}

// Download an inbound media file from Meta and store it in the public "media" bucket. Returns { url, mime, name }.
export async function storeInboundMedia(mediaId, { contactId, messageId, filename } = {}) {
  const meta = await graph(`${mediaId}`); // { url, mime_type, file_size, ... }
  const r = await fetch(meta.url, { headers: { Authorization: `Bearer ${process.env.META_ACCESS_TOKEN}` } });
  if (!r.ok) throw new Error(`Media download failed (${r.status})`);
  const buf = Buffer.from(await r.arrayBuffer());
  const mime = meta.mime_type || r.headers.get('content-type') || 'application/octet-stream';
  const ext = (filename && filename.includes('.')) ? filename.split('.').pop() : (mimeExt[mime.split(';')[0]] || 'bin');
  const path = `in/${contactId || 'unknown'}/${(messageId || mediaId).replace(/[^\w.-]/g, '_')}.${ext}`;
  const { error } = await db.storage.from('media').upload(path, buf, { contentType: mime, upsert: true });
  if (error) throw new Error(error.message);
  const { data } = db.storage.from('media').getPublicUrl(path);
  return { url: data.publicUrl, mime, name: filename || null };
}
const mimeExt = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp', 'image/gif': 'gif', 'video/mp4': 'mp4', 'video/3gpp': '3gp', 'audio/ogg': 'ogg', 'audio/mpeg': 'mp3', 'audio/mp4': 'm4a', 'audio/aac': 'aac', 'audio/amr': 'amr', 'application/pdf': 'pdf', 'text/plain': 'txt', 'application/msword': 'doc', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document': 'docx', 'application/vnd.ms-excel': 'xls', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': 'xlsx', 'application/vnd.ms-powerpoint': 'ppt', 'application/vnd.openxmlformats-officedocument.presentationml.presentation': 'pptx' };

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
