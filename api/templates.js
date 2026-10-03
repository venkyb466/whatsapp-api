// GET  /api/templates          -> list message templates of the workspace's WhatsApp account (with approval status)
// POST /api/templates          -> create a template { name, category, language, header, body, footer, quick_replies[], url_button:{text,url,example} }
import { json, requireAuth, readBody, wa } from './_lib.js';

export default async function handler(req, res) {
  if (req.method === 'OPTIONS') return json(res, 200, {});
  const auth = await requireAuth(req, res, { admin: req.method === 'POST' }); if (!auth) return;
  if (auth.via !== 'user') return json(res, 403, { error: 'Sign in required' });
  const ws = auth.ws;
  if (!ws.waba_id) return json(res, 400, { error: 'Connect your WhatsApp account first (Settings → Connect WhatsApp).' });

  try {
    const client = wa(ws);
    if (req.method === 'GET') {
      const data = await client.graph(`${ws.waba_id}/message_templates?fields=name,status,category,language,components,quality_score,rejected_reason&limit=200`);
      const templates = (data.data || []).map((t) => {
        const btns = t.components?.find((c) => c.type === 'BUTTONS')?.buttons || [];
        return {
          id: t.id, name: t.name, status: t.status, category: t.category, language: t.language,
          quality: t.quality_score?.score || null, rejected_reason: t.rejected_reason || null,
          header: t.components?.find((c) => c.type === 'HEADER')?.text || null,
          body: t.components?.find((c) => c.type === 'BODY')?.text || '',
          footer: t.components?.find((c) => c.type === 'FOOTER')?.text || null,
          buttons: btns.map((b) => b.text),
          url_button_dynamic: btns.some((b) => b.type === 'URL' && /\{\{1\}\}/.test(b.url || '')),
          quick_replies: btns.filter((b) => b.type === 'QUICK_REPLY').length,
          body_params: ((t.components?.find((c) => c.type === 'BODY')?.text || '').match(/\{\{\d+\}\}/g) || []).length,
        };
      });
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
      const buttons = [];
      if (b.url_button?.text && b.url_button?.url) {
        const btn = { type: 'URL', text: b.url_button.text.slice(0, 25), url: b.url_button.url };
        if (/\{\{1\}\}/.test(b.url_button.url)) btn.example = [b.url_button.example || b.url_button.url.replace('{{1}}', 'sample')];
        buttons.push(btn);
      }
      (b.quick_replies || []).slice(0, 3).forEach((t) => buttons.push({ type: 'QUICK_REPLY', text: String(t).slice(0, 25) }));
      if (buttons.length) components.push({ type: 'BUTTONS', buttons });
      const data = await client.graph(`${ws.waba_id}/message_templates`, {
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
