// /api/workspace — workspaces, team members, WhatsApp connection, plans
//   GET                          -> my workspaces + roles (+ platform admin flag)
//   POST { action, ... }:
//     create            { name }                                   any signed-in user
//     update            { name?, settings? }                       admin
//     invite            { email, role }                            admin
//     set_role          { user_id, role }                          admin
//     remove_member     { user_id }                                admin
//     connect_manual    { waba_id, phone_number_id, access_token } admin
//     es_exchange       { code, waba_id, phone_number_id, pin? }   admin (Meta Embedded Signup)
//     disconnect        {}                                         owner
//     all_workspaces    {}                                         platform admin
//     set_plan          { workspace_id, plan, status? }            platform admin
import { db, json, requireAuth, readBody, graph, invalidateWorkspace, getWorkspace } from './_lib.js';

const ROLES = ['owner', 'admin', 'agent'];

export default async function handler(req, res) {
  if (req.method === 'OPTIONS') return json(res, 200, {});
  const auth = await requireAuth(req, res, { noWorkspace: true }); if (!auth) return;
  if (auth.via !== 'user') return json(res, 403, { error: 'Sign in required' });
  const user = auth.user;
  const { data: pa } = await db.from('platform_admins').select('user_id').eq('user_id', user.id).maybeSingle();
  const isPlatformAdmin = !!pa;

  if (req.method === 'GET') {
    const ids = auth.memberships.map((m) => m.workspace_id);
    const { data: wss } = ids.length ? await db.from('workspaces').select('id,name,plan,status,trial_ends_at,display_phone,verified_name,phone_number_id,waba_id,settings,created_at').in('id', ids) : { data: [] };
    const list = (wss || []).map((w) => ({ ...w, connected: !!w.phone_number_id, role: auth.memberships.find((m) => m.workspace_id === w.id)?.role }))
      .sort((a, b) => String(a.created_at).localeCompare(String(b.created_at)));
    return json(res, 200, { user: { id: user.id, email: user.email }, workspaces: list, isPlatformAdmin });
  }
  if (req.method !== 'POST') return json(res, 405, { error: 'Method not allowed' });
  const b = await readBody(req);

  // ---- actions that don't need an active workspace ----
  if (b.action === 'create') {
    // Public self-serve workspaces are switched off for now — only the platform owner can create one.
    if (!isPlatformAdmin) return json(res, 403, { error: 'New workspaces are not open yet' });
    const name = String(b.name || '').trim();
    if (!name) return json(res, 400, { error: 'Business name is required' });
    const owned = auth.memberships.filter((m) => m.role === 'owner').length;
    if (owned >= 5 && !isPlatformAdmin) return json(res, 400, { error: 'You already own 5 workspaces' });
    const { data: ws, error } = await db.from('workspaces').insert({ name, created_by: user.id, settings: { store_name: name } }).select().single();
    if (error) return json(res, 500, { error: error.message });
    const { error: mErr } = await db.from('workspace_members').insert({ workspace_id: ws.id, user_id: user.id, role: 'owner', email: user.email });
    if (mErr) { await db.from('workspaces').delete().eq('id', ws.id); return json(res, 500, { error: mErr.message }); }
    return json(res, 200, { ok: true, workspace: ws });
  }
  if (b.action === 'all_workspaces' || b.action === 'set_plan') {
    if (!isPlatformAdmin) return json(res, 403, { error: 'Platform admins only' });
    if (b.action === 'set_plan') {
      const patch = {};
      if (b.plan) patch.plan = b.plan;
      if (b.status) patch.status = b.status;
      if (b.trial_days) patch.trial_ends_at = new Date(Date.now() + Number(b.trial_days) * 86400000).toISOString();
      const { error } = await db.from('workspaces').update(patch).eq('id', b.workspace_id);
      if (error) return json(res, 400, { error: error.message });
      invalidateWorkspace(b.workspace_id);
      return json(res, 200, { ok: true });
    }
    const { data: wss } = await db.from('workspaces').select('id,name,plan,status,trial_ends_at,display_phone,created_at').order('created_at', { ascending: false });
    const { data: mem } = await db.from('workspace_members').select('workspace_id,email,role');
    const counts = {};
    for (const w of wss || []) {
      const { count } = await db.from('contacts').select('id', { count: 'exact', head: true }).eq('workspace_id', w.id);
      counts[w.id] = count || 0;
    }
    return json(res, 200, { workspaces: (wss || []).map((w) => ({ ...w, contacts: counts[w.id], owner: (mem || []).find((m) => m.workspace_id === w.id && m.role === 'owner')?.email, members: (mem || []).filter((m) => m.workspace_id === w.id).length })) });
  }

  // ---- workspace-scoped actions ----
  const wanted = req.headers['x-workspace-id'];
  const m = auth.memberships.find((x) => x.workspace_id === wanted);
  if (!m) return json(res, 403, { error: 'Choose a workspace first' });
  const isAdmin = ['owner', 'admin'].includes(m.role);
  if (!isAdmin) return json(res, 403, { error: 'Only owners and admins can do this' });
  const wsId = m.workspace_id;
  const ws = await getWorkspace(wsId, { fresh: true });

  try {
    switch (b.action) {
      case 'update': {
        const patch = {};
        if (b.name) patch.name = String(b.name).trim();
        if (b.settings && typeof b.settings === 'object') {
          // merge one level deep so saving the bot settings doesn't wipe store settings, etc.
          const next = { ...(ws.settings || {}) };
          for (const [k, v] of Object.entries(b.settings)) next[k] = v && typeof v === 'object' && !Array.isArray(v) ? { ...(next[k] || {}), ...v } : v;
          patch.settings = next;
        }
        const { error } = await db.from('workspaces').update(patch).eq('id', wsId);
        if (error) return json(res, 400, { error: error.message });
        invalidateWorkspace(wsId);
        return json(res, 200, { ok: true });
      }

      case 'invite': {
        const email = String(b.email || '').trim().toLowerCase();
        const role = ROLES.includes(b.role) && b.role !== 'owner' ? b.role : 'agent';
        if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return json(res, 400, { error: 'Enter a valid email' });
        let { data: userId } = await db.rpc('find_user_by_email', { p_email: email });
        let invited = false;
        if (!userId) {
          const origin = `https://${req.headers['x-forwarded-host'] || req.headers.host}`;
          const { data, error } = await db.auth.admin.inviteUserByEmail(email, { redirectTo: origin });
          if (error) return json(res, 400, { error: `Could not send invite: ${error.message}` });
          userId = data.user.id; invited = true;
        }
        const { error } = await db.from('workspace_members').insert({ workspace_id: wsId, user_id: userId, role, email });
        if (error) return json(res, 400, { error: /duplicate/.test(error.message) ? 'Already a member' : error.message });
        return json(res, 200, { ok: true, invited, note: invited ? 'An invitation email was sent. They set a password from the link and land in this workspace.' : 'They already have an account — the workspace now appears in their workspace switcher.' });
      }

      case 'set_role': {
        if (!ROLES.includes(b.role) || b.role === 'owner') return json(res, 400, { error: 'Role must be admin or agent' });
        const { data: target } = await db.from('workspace_members').select('role').eq('workspace_id', wsId).eq('user_id', b.user_id).maybeSingle();
        if (!target) return json(res, 404, { error: 'Member not found' });
        if (target.role === 'owner') return json(res, 400, { error: "The owner's role can't be changed" });
        await db.from('workspace_members').update({ role: b.role }).eq('workspace_id', wsId).eq('user_id', b.user_id);
        return json(res, 200, { ok: true });
      }

      case 'remove_member': {
        const { data: target } = await db.from('workspace_members').select('role').eq('workspace_id', wsId).eq('user_id', b.user_id).maybeSingle();
        if (!target) return json(res, 404, { error: 'Member not found' });
        if (target.role === 'owner') return json(res, 400, { error: "The owner can't be removed" });
        await db.from('workspace_members').delete().eq('workspace_id', wsId).eq('user_id', b.user_id);
        await db.from('contacts').update({ assigned_to: null }).eq('workspace_id', wsId).eq('assigned_to', b.user_id);
        return json(res, 200, { ok: true });
      }

      case 'connect_manual': {
        const wabaId = String(b.waba_id || '').trim(), phoneId = String(b.phone_number_id || '').trim(), token = String(b.access_token || '').trim();
        if (!wabaId || !phoneId || !token) return json(res, 400, { error: 'WABA ID, phone number ID and access token are all required' });
        return json(res, 200, await connect(wsId, { wabaId, phoneId, token }));
      }

      case 'es_exchange': {
        const appId = process.env.META_APP_ID, secret = process.env.META_APP_SECRET;
        if (!appId || !secret) return json(res, 400, { error: 'Embedded Signup is not configured on the server yet (META_APP_ID / META_APP_SECRET).' });
        if (!b.code || !b.waba_id || !b.phone_number_id) return json(res, 400, { error: 'Missing code, WABA or phone number from Meta' });
        const tok = await fetch(`https://graph.facebook.com/v21.0/oauth/access_token?client_id=${appId}&client_secret=${encodeURIComponent(secret)}&code=${encodeURIComponent(b.code)}`).then((r) => r.json());
        if (!tok.access_token) return json(res, 400, { error: tok.error?.message || 'Could not exchange the code with Meta' });
        const out = await connect(wsId, { wabaId: String(b.waba_id), phoneId: String(b.phone_number_id), token: tok.access_token, register: !b.coexistence, pin: b.pin });
        if (b.coexistence) {
          // Number stays on the WhatsApp Business app: ask Meta to send contacts + chat history (must happen within 24h of onboarding).
          for (const sync_type of ['smb_app_state_sync', 'history']) {
            try { await graph(`${b.phone_number_id}/smb_app_data`, { method: 'POST', token: tok.access_token, body: { messaging_product: 'whatsapp', sync_type } }); out.steps.push(`${sync_type === 'history' ? 'chat history' : 'contacts'} sync requested`); }
            catch (e) { out.steps.push(`${sync_type} sync failed: ${e.message}`); }
          }
          await db.from('workspaces').update({ settings: { ...(ws.settings || {}), coexistence: true, coexistence_since: new Date().toISOString() } }).eq('id', wsId);
          // The Embedded Signup token expires in 60 days. If the platform's permanent token can reach this number, use that instead.
          if (ws.uses_env_token && process.env.META_ACCESS_TOKEN) {
            try {
              await graph(`${b.phone_number_id}?fields=id`, { token: process.env.META_ACCESS_TOKEN });
              await db.from('workspace_secrets').delete().eq('workspace_id', wsId);
              out.steps.push('using the permanent platform token');
            } catch (e) { out.steps.push('kept the 60-day signup token (permanent token has no access to this number yet): ' + e.message); }
          }
          invalidateWorkspace(wsId);
        }
        return json(res, 200, out);
      }

      case 'relink_env': {
        // Platform owner workspace: re-attach the number after it was re-added in WhatsApp Manager (new phone number ID).
        if (m.role !== 'owner') return json(res, 403, { error: 'Only the owner can do this' });
        if (!ws.uses_env_token || !process.env.META_ACCESS_TOKEN) return json(res, 400, { error: 'Only for the platform owner workspace' });
        const token = process.env.META_ACCESS_TOKEN, wabaId = ws.waba_id || process.env.META_WABA_ID;
        const list = await graph(`${wabaId}/phone_numbers?fields=id,display_phone_number,verified_name,code_verification_status,platform_type,status,name_status`, { token });
        const want = String(b.phone || ws.display_phone || '').replace(/\D/g, '');
        const nums = list.data || [];
        const n = nums.find((x) => String(x.display_phone_number).replace(/\D/g, '') === want) || (nums.length === 1 ? nums[0] : null);
        if (!n) return json(res, 404, { error: 'Number not found on the WhatsApp Business Account', numbers: nums });
        if (b.dry) return json(res, 200, { number: n });
        const steps = [];
        let pin = null;
        if (n.platform_type !== 'CLOUD_API') {
          pin = /^\d{6}$/.test(String(b.pin || '')) ? String(b.pin) : String(Math.floor(100000 + Math.random() * 900000));
          try { await graph(`${n.id}/register`, { method: 'POST', token, body: { messaging_product: 'whatsapp', pin } }); steps.push('registered'); }
          catch (e) { steps.push(`register failed: ${e.message}`); }
        } else steps.push('already on Cloud API');
        try { await graph(`${wabaId}/subscribed_apps`, { method: 'POST', token }); steps.push('webhooks subscribed'); }
        catch (e) { steps.push(`subscribe failed: ${e.message}`); }
        await db.from('workspace_secrets').delete().eq('workspace_id', wsId);
        const settings = { ...(ws.settings || {}) }; delete settings.coexistence; delete settings.coexistence_since;
        await db.from('workspaces').update({ waba_id: wabaId, phone_number_id: n.id, display_phone: n.display_phone_number, verified_name: n.verified_name, settings }).eq('id', wsId);
        invalidateWorkspace(wsId);
        return json(res, 200, { ok: true, number: n, pin, steps });
      }

      case 'disconnect': {
        if (m.role !== 'owner') return json(res, 403, { error: 'Only the owner can disconnect WhatsApp' });
        if (ws.uses_env_token) return json(res, 400, { error: 'The platform owner workspace is connected through server settings' });
        await db.from('workspace_secrets').delete().eq('workspace_id', wsId);
        await db.from('workspaces').update({ waba_id: null, phone_number_id: null, display_phone: null, verified_name: null }).eq('id', wsId);
        invalidateWorkspace(wsId);
        return json(res, 200, { ok: true });
      }

      default:
        return json(res, 400, { error: 'Unknown action' });
    }
  } catch (err) {
    return json(res, 502, { error: err.message, details: err.meta || null });
  }
}

// Validate credentials against Meta, store them, and subscribe our app to the WABA's webhooks.
async function connect(wsId, { wabaId, phoneId, token, register = false, pin }) {
  const { data: taken } = await db.from('workspaces').select('id').eq('phone_number_id', phoneId).neq('id', wsId).maybeSingle();
  if (taken) throw new Error('This phone number is already connected to another workspace');
  const phone = await graph(`${phoneId}?fields=display_phone_number,verified_name,quality_rating,code_verification_status,platform_type`, { token });
  const numbers = await graph(`${wabaId}/phone_numbers?fields=id`, { token });
  if (!(numbers.data || []).some((n) => n.id === phoneId)) throw new Error('That phone number ID does not belong to that WhatsApp Business Account');
  const steps = [];
  if (register && phone.platform_type !== 'CLOUD_API') {
    const p = /^\d{6}$/.test(String(pin || '')) ? String(pin) : String(Math.floor(100000 + Math.random() * 900000));
    try { await graph(`${phoneId}/register`, { method: 'POST', token, body: { messaging_product: 'whatsapp', pin: p } }); steps.push('registered'); }
    catch (e) { steps.push(`register skipped: ${e.message}`); }
  }
  try { await graph(`${wabaId}/subscribed_apps`, { method: 'POST', token }); steps.push('webhooks subscribed'); }
  catch (e) { steps.push(`subscribe failed: ${e.message}`); }
  await db.from('workspace_secrets').upsert({ workspace_id: wsId, access_token: token, updated_at: new Date().toISOString() });
  await db.from('workspaces').update({ waba_id: wabaId, phone_number_id: phoneId, display_phone: phone.display_phone_number, verified_name: phone.verified_name }).eq('id', wsId);
  invalidateWorkspace(wsId);
  return { ok: true, phone, steps };
}
