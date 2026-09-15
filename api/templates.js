// GET  /api/templates          -> list message templates from Meta (with approval status)
// POST /api/templates          -> create a simple text template { name, category, language, body, footer }
import { json, requireAuth, readBody, graph } from './_lib.js';

export default async function handler(req, res) {
  if (req.method === 'OPTIONS') return json(res, 200, {});
  const auth = await requireAuth(req, res); if (!auth) return;
  const waba = process.env.META_WABA_ID;
  if (!waba || !process.env.META_ACCESS_TOKEN) return json(res, 500, { error: 'META_WABA_ID / META_ACCESS_TOKEN not set in Vercel.' });

  try {
    if (req.method === 'GET') {
      const data = await graph(`${waba}/message_templates?fields=name,status,category,language,components,quality_score,rejected_reason&limit=100`);
      const templates = (data.data || []).map((t) => ({
        id: t.id, name: t.name, status: t.status, category: t.category, language: t.language,
        quality: t.quality_score?.score || null, rejected_reason: t.rejected_reason || null,
        header: t.components?.find((c) => c.type === 'HEADER')?.text || null,
        body: t.components?.find((c) => c.type === 'BODY')?.text || '',
        footer: t.components?.find((c) => c.type === 'FOOTER')?.text || null,
        buttons: (t.components?.find((c) => c.type === 'BUTTONS')?.buttons || []).map((b) => b.text),
        body_params: ((t.components?.find((c) => c.type === 'BODY')?.text || '').match(/\{\{\d+\}\}/g) || []).length,
      }));
      return json(res, 200, { templates });
    }

    if (req.method === 'POST') {
      const b = await readBody(req);
      const name = String(b.name || '').trim().toLowerCase().replace(/[^a-z0-9_]/g, '_');
      if (!name || !b.body) return json(res, 400, { error: 'name and body are required' });
      const components = [];
      if (b.header) components.push({ type: 'HEADER', format: 'TEXT', text: b.header });
      const bodyComp = { type: 'BODY', text: b.body };
      const params = (b.body.match(/\{\{\d+\}\}/g) || []).length;
      if (params) bodyComp.example = { body_text: [Array.from({ length: params }, (_, i) => b.examples?.[i] || (i === 0 ? 'Rahul' : `Sample ${i + 1}`))] };
      components.push(bodyComp);
      if (b.footer) components.push({ type: 'FOOTER', text: b.footer });
      if (b.quick_replies?.length) components.push({ type: 'BUTTONS', buttons: b.quick_replies.slice(0, 3).map((t) => ({ type: 'QUICK_REPLY', text: t })) });
      const data = await graph(`${waba}/message_templates`, {
        method: 'POST',
        body: { name, category: b.category || 'MARKETING', language: b.language || 'en', components },
      });
      return json(res, 200, { ok: true, id: data.id, status: data.status, name });
    }
    return json(res, 405, { error: 'Method not allowed' });
  } catch (err) {
    return json(res, 502, { error: err.message, details: err.meta || null });
  }
}
