// api/send-campaign.js
//
// This is a Vercel Serverless Function. Once deployed, hitting its URL
// (with the right secret key) will:
//   1. Pull all contacts from Supabase that haven't been messaged for this campaign yet
//   2. Send each one a WhatsApp template message via Meta's Cloud API
//   3. Log the result (sent / failed) back into Supabase
//
// You do NOT need to run this locally. Just deploy it to Vercel and trigger
// it by visiting the URL once your Meta credentials are ready.

import { createClient } from '@supabase/supabase-js';

// ---- CONFIG (set these as Environment Variables in Vercel, not here) ----
// SUPABASE_URL
// SUPABASE_SERVICE_ROLE_KEY   <-- server-side only, never expose publicly
// META_ACCESS_TOKEN           <-- from Meta for Developers
// META_PHONE_NUMBER_ID        <-- from your WhatsApp Business API setup
// META_TEMPLATE_NAME          <-- e.g. "outreach1" (the template name you created)
// CAMPAIGN_TRIGGER_SECRET     <-- a password you invent, so random people can't trigger sends
// ---------------------------------------------------------------------

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

const CAMPAIGN_NAME = 'outreach1'; // change this per campaign run
const BATCH_DELAY_MS = 1100; // ~1 message/sec to stay well under Meta's rate limits
const BATCH_SIZE = 20; // how many contacts to message per invocation

// IMPORTANT: Vercel serverless functions have a time limit (10s on the free
// Hobby plan, longer on Pro). Sending 3,000 messages one-by-one in a single
// request would time out long before finishing. Instead, this function only
// sends a small BATCH_SIZE each time it's called, and is meant to be
// triggered repeatedly (e.g. by a Vercel Cron Job every minute) until all
// contacts are done. See vercel.json for the cron setup, and the README for
// how to trigger it manually while testing.

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function sendWhatsAppTemplate(phone, name) {
  const url = `https://graph.facebook.com/v21.0/${process.env.META_PHONE_NUMBER_ID}/messages`;

  const body = {
    messaging_product: 'whatsapp',
    to: phone,
    type: 'template',
    template: {
      name: process.env.META_TEMPLATE_NAME,
      language: { code: 'en' },
      components: [
        {
          type: 'body',
          parameters: [{ type: 'text', text: name }],
        },
      ],
    },
  };

  const res = await fetch(url, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${process.env.META_ACCESS_TOKEN}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  });

  const data = await res.json();

  if (!res.ok) {
    throw new Error(data?.error?.message || 'Unknown Meta API error');
  }

  return data.messages?.[0]?.id || null;
}

export default async function handler(req, res) {
  // Simple protection so random visitors can't trigger your campaign
  const secret = req.query.secret || req.headers['x-campaign-secret'];
  if (secret !== process.env.CAMPAIGN_TRIGGER_SECRET) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  // 1. Get contacts who haven't been sent this campaign yet
  //    (uses the get_pending_contacts() database function in Supabase,
  //     which excludes anyone already marked sent/delivered/read for this campaign)
  const { data: contacts, error: fetchError } = await supabase.rpc(
    'get_pending_contacts',
    { p_campaign_name: CAMPAIGN_NAME, p_limit: BATCH_SIZE }
    );

  if (fetchError) {
    return res.status(500).json({ error: fetchError.message });
  }

  if (!contacts || contacts.length === 0) {
    return res.status(200).json({ message: 'No contacts left to send to.' });
  }

  const results = { sent: 0, failed: 0 };

  for (const contact of contacts) {
    try {
      const messageId = await sendWhatsAppTemplate(contact.phone, contact.name);

      await supabase.from('campaign_log').insert({
        contact_id: contact.id,
        campaign_name: CAMPAIGN_NAME,
        status: 'sent',
        meta_message_id: messageId,
        sent_at: new Date().toISOString(),
      });

      results.sent++;
    } catch (err) {
      await supabase.from('campaign_log').insert({
        contact_id: contact.id,
        campaign_name: CAMPAIGN_NAME,
        status: 'failed',
        error_message: err.message,
      });

      results.failed++;
    }

    // Pace the sends so we don't hit Meta's rate limits
    await sleep(BATCH_DELAY_MS);
  }

  return res.status(200).json({
    message: `Campaign run complete.`,
    total_contacts: contacts.length,
    ...results,
  });
}
