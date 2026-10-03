// Chatbot / auto-reply engine. Called by the webhook for every inbound message.
import { db, wa, logOutbound, mediaKind } from './_lib.js';

const DEFAULTS = {
  enabled: true,
  welcome_cooldown_hours: 24,   // don't re-send the welcome within this window
  away_cooldown_hours: 12,
  fallback_cooldown_hours: 6,
  handoff_minutes: 60,          // after an agent replies, the bot stays quiet this long
  optout_keywords: ['STOP', 'UNSUBSCRIBE'],
  optin_keywords: ['START', 'SUBSCRIBE'],
  optout_reply: "You've been unsubscribed and won't receive promotional messages from us. Reply START to subscribe again.",
  optin_reply: "You're subscribed again. Thank you!",
  business_hours: { tz: 'Asia/Kolkata', days: { 1: [['09:30', '18:30']], 2: [['09:30', '18:30']], 3: [['09:30', '18:30']], 4: [['09:30', '18:30']], 5: [['09:30', '18:30']], 6: [['10:00', '14:00']] } },
};
export function botSettings(ws) { return { ...DEFAULTS, ...(ws.settings?.bot || {}), business_hours: { ...DEFAULTS.business_hours, ...(ws.settings?.bot?.business_hours || {}) } }; }

// Is `date` inside business hours? days: {0..6 (Sun..Sat): [[start,end],...]}
export function isOpen(hours, date = new Date()) {
  const tz = hours.tz || 'Asia/Kolkata';
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-US', { timeZone: tz, weekday: 'short', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(date).map((p) => [p.type, p.value]));
  const dow = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 }[parts.weekday];
  const now = `${parts.hour}:${parts.minute}`;
  return (hours.days?.[dow] || hours.days?.[String(dow)] || []).some(([s, e]) => now >= s && now < e);
}

// Text the customer typed or the button they tapped.
export function inboundText(m) {
  if (m.type === 'text') return m.text?.body || '';
  if (m.type === 'button') return m.button?.text || m.button?.payload || '';
  if (m.type === 'interactive') return m.interactive?.button_reply?.title || m.interactive?.list_reply?.title || '';
  return '';
}
export function inboundPayload(m) {
  if (m.type === 'button') return m.button?.payload || '';
  if (m.type === 'interactive') return m.interactive?.button_reply?.id || m.interactive?.list_reply?.id || '';
  return '';
}

export function keywordMatches(rule, text) {
  const t = String(text || '').trim().toLowerCase();
  if (!t) return false;
  return (rule.keywords || []).some((k) => {
    const kw = String(k || '').trim().toLowerCase();
    if (!kw) return false;
    if (rule.match === 'exact') return t === kw;
    if (rule.match === 'starts') return t.startsWith(kw);
    // contains = whole-word match so "hi" doesn't fire on "this"
    return new RegExp(`(^|[^\\p{L}\\p{N}])${kw.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}($|[^\\p{L}\\p{N}])`, 'iu').test(t);
  });
}

const hoursAgo = (iso) => (iso ? (Date.now() - new Date(iso).getTime()) / 3600000 : Infinity);

// Choose which rule (if any) should answer this message.
export function pickRule(rules, { text, payload, isNew, prevInboundAt, open, state, cfg }) {
  if (payload && payload.startsWith('r:')) {
    const r = rules.find((x) => x.id === payload.slice(2));
    if (r) return { rule: r, why: 'button' };
  }
  const active = rules.filter((r) => r.active).sort((a, b) => (a.priority - b.priority) || String(a.created_at).localeCompare(String(b.created_at)));
  const kw = active.find((r) => r.trigger === 'keyword' && keywordMatches(r, text));
  if (kw) return { rule: kw, why: 'keyword' };
  const away = active.find((r) => r.trigger === 'away');
  if (away && !open && hoursAgo(state.away_at) >= cfg.away_cooldown_hours) return { rule: away, why: 'away' };
  const welcome = active.find((r) => r.trigger === 'welcome');
  if (welcome && (isNew || hoursAgo(prevInboundAt) >= cfg.welcome_cooldown_hours) && hoursAgo(state.welcome_at) >= cfg.welcome_cooldown_hours) return { rule: welcome, why: 'welcome' };
  const fb = active.find((r) => r.trigger === 'fallback');
  if (fb && hoursAgo(state.fallback_at) >= cfg.fallback_cooldown_hours) return { rule: fb, why: 'fallback' };
  return null;
}

export function fillVars(text, contact, ws) {
  const first = String(contact.name || '').trim().split(/\s+/)[0] || 'there';
  return String(text || '')
    .replace(/\{\{\s*name\s*\}\}/gi, contact.name && contact.name !== contact.phone ? contact.name : 'there')
    .replace(/\{\{\s*first_name\s*\}\}/gi, contact.name && contact.name !== contact.phone ? first : 'there')
    .replace(/\{\{\s*business\s*\}\}/gi, ws.name || '')
    .replace(/\{\{\s*phone\s*\}\}/gi, contact.phone || '');
}

// Send the rule's reply and apply its side effects.
export async function runRule(ws, contact, rule, why) {
  const client = wa(ws);
  const r = rule.reply || {};
  const text = fillVars(r.text, contact, ws);
  let msgId, logType = 'text', media = null;
  const buttons = (r.buttons || []).filter((b) => b && b.title);
  if (r.type === 'media' && r.media_url) {
    const kind = mediaKind(r.media_mime || '');
    msgId = await client.sendMedia(contact.phone, kind, r.media_url, { caption: text, filename: r.media_name });
    logType = kind; media = { url: r.media_url, mime: r.media_mime, name: r.media_name };
  } else if (buttons.length) {
    msgId = await client.sendChoices(contact.phone, text || 'Please choose an option', buttons.map((b, i) => ({ id: b.next_rule_id ? `r:${b.next_rule_id}` : `t:${i}:${b.title}`, title: b.title })), { footer: r.footer, listButton: r.list_button || 'Options' });
    logType = 'interactive';
  } else if (text) {
    msgId = await client.sendText(contact.phone, text);
  } else return null;

  const body = buttons.length ? `${text}\n${buttons.map((b) => `[${b.title}]`).join(' ')}` : text;
  await logOutbound(ws, contact.id, msgId, { type: logType, body, source: 'bot', media });

  const patch = { bot_state: { ...(contact.bot_state || {}), [`${why === 'button' || why === 'keyword' ? 'last_rule' : why}_at`]: new Date().toISOString(), last_rule_id: rule.id } };
  if (rule.add_tag) patch.tags = [...new Set([...(contact.tags || []), rule.add_tag])];
  if (rule.assign_to && !contact.assigned_to) patch.assigned_to = rule.assign_to;
  await db.from('contacts').update(patch).eq('id', contact.id);
  return msgId;
}

// Entry point from the webhook.
export async function handleInboundBot(ws, contact, m, { isNew, prevInboundAt }) {
  const cfg = botSettings(ws);
  const text = inboundText(m);
  const payload = inboundPayload(m);
  const upper = text.trim().toUpperCase();

  // Opt-out / opt-in always work, even with the bot switched off.
  if (cfg.optout_keywords.map((k) => k.toUpperCase()).includes(upper)) {
    await db.from('contacts').update({ opted_out: true, tags: [...new Set([...(contact.tags || []), 'opted-out'])] }).eq('id', contact.id);
    const id = await wa(ws).sendText(contact.phone, cfg.optout_reply).catch(() => null);
    if (id) await logOutbound(ws, contact.id, id, { body: cfg.optout_reply, source: 'bot' });
    return 'optout';
  }
  if (cfg.optin_keywords.map((k) => k.toUpperCase()).includes(upper) && contact.opted_out) {
    await db.from('contacts').update({ opted_out: false, tags: (contact.tags || []).filter((t) => t !== 'opted-out') }).eq('id', contact.id);
    const id = await wa(ws).sendText(contact.phone, cfg.optin_reply).catch(() => null);
    if (id) await logOutbound(ws, contact.id, id, { body: cfg.optin_reply, source: 'bot' });
    return 'optin';
  }

  if (!cfg.enabled) return null;
  const state = contact.bot_state || {};
  // An agent is handling this chat — stay quiet (but still follow button taps from a bot menu).
  if (state.paused_until && new Date(state.paused_until) > new Date() && !payload.startsWith('r:')) return null;

  const { data: rules } = await db.from('bot_rules').select('*').eq('workspace_id', ws.id).eq('active', true);
  if (!rules?.length) return null;
  const pick = pickRule(rules, { text, payload, isNew, prevInboundAt, open: isOpen(cfg.business_hours), state, cfg });
  if (!pick) return null;
  await runRule(ws, contact, pick.rule, pick.why);
  return pick.why;
}
