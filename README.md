# WhatsApp Campaign Sender

A minimal script that sends your approved WhatsApp template message to all
contacts stored in Supabase, using Meta's official Cloud API directly (no
AiSensy/Interakt fees — just Meta's raw per-message rate).

## How it works

1. Your contacts live in the `contacts` table in Supabase.
2. `api/send-campaign.js` picks up to 20 contacts who haven't been messaged
   yet for this campaign, sends each one a WhatsApp template message, and
   logs the result in `campaign_log`.
3. It only sends 20 at a time (not all 3,000 at once) because Vercel
   functions have a short time limit. Run it repeatedly until everyone's
   been messaged — either automatically (cron) or manually (see below).

## One-time setup

### 1. Add your contacts to Supabase
Go to your Supabase project (`whatsapp-campaign`) → Table Editor → `contacts`
table → Insert rows, or use the CSV import button to upload all 3,000 at
once (columns: `name`, `phone`). Phone numbers should include the country
code with no `+` or spaces, e.g. `919642125856`.

### 2. Get your Supabase Service Role Key
Supabase dashboard → Project Settings → API → copy the `service_role` key
(NOT the `anon` key — service_role is required here since it runs server-side).

### 3. Get your Meta credentials (once your WhatsApp API access is approved)
From Meta for Developers → your app → WhatsApp → API Setup:
- `META_ACCESS_TOKEN` — a permanent access token (temporary ones expire in 24h)
- `META_PHONE_NUMBER_ID` — shown on the same page
- `META_TEMPLATE_NAME` — the exact template name you created (e.g. `outreach1`)

### 4. Deploy to Vercel
1. Push this folder to a GitHub repo.
2. Go to vercel.com → New Project → import that repo.
3. In Project Settings → Environment Variables, add everything from
   `.env.example` with your real values.
4. Deploy.

## Sending the campaign

### Option A — Manual trigger (recommended to start)
Visit this URL in your browser (replace with your real domain and secret):
```
https://your-project.vercel.app/api/send-campaign?secret=YOUR_SECRET_HERE
```
Each visit sends the next 20 contacts. Refresh every minute or so until the
response says "No contacts left to send to."

### Option B — Automatic (cron)
`vercel.json` is set up to call the function every minute automatically.
**Note:** Vercel's free Hobby plan has restrictions on cron frequency —
check your current plan's limits in the Vercel dashboard before relying on
this, since these change over time. If your plan doesn't allow
minute-level crons, Option A (manual refresh) works fine for a one-off
3,000-contact campaign — it just takes about 150 refreshes (3,000 ÷ 20),
or you can space them out over a few hours.

## Testing before the real send
**Strongly recommended:** add just 2-3 of your own phone numbers to the
`contacts` table first, trigger the function, and confirm you receive the
WhatsApp message correctly before uploading all 3,000 contacts.

## Costs
- Vercel: free (Hobby plan)
- Supabase: free (current tier)
- Meta: pay-per-message only, no platform fee. Marketing messages are
  roughly ₹0.86 each in India (rates change — check Meta's current rate
  card). For 3,000 marketing messages, budget roughly ₹2,500-3,000 total,
  charged directly by Meta to your business account.
