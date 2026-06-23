# Daily Status Email — Setup Guide

Sends the **Overall Snapshot** + **Team Workload Summary** (no task details) to your team via Zoho SMTP, automatically every day at **9:00 AM IST**, with manual send + on/off toggle from the dashboard.

---

## 1. Generate a Zoho App Password

Regular Zoho login passwords don't work for SMTP. You need an **App Password**:

1. Log into Zoho Mail with the sending account (e.g. `shekhar@tecsolex.com`)
2. Go to **zoho.com/mail → My Account → Security → App Passwords**
3. Generate a new app password, name it `tecsolex-dashboard`
4. Copy it — you'll paste it into the Worker secrets below

---

## 2. Deploy the Email Worker

1. [dash.cloudflare.com](https://dash.cloudflare.com) → **Workers & Pages → Create → Start with Hello World**
2. Name it `clickup-email-reporter` → **Deploy**
3. Click **Edit code** → delete everything → paste `email-worker.js` → **Deploy**

---

## 3. Create a KV Namespace (stores the automation on/off toggle)

1. In the worker → **Settings → Bindings → Add → KV Namespace**
2. Create new namespace: `AUTOMATION_KV`
3. Variable name (binding): `AUTOMATION_KV`
4. Save

---

## 4. Add Secrets

Worker → **Settings → Variables and Secrets → Add → Encrypt**

| Secret | Value |
|---|---|
| `CLICKUP_TOKEN` | your ClickUp API token (`pk_...`) |
| `ZOHO_EMAIL` | the sending mailbox, e.g. `shekhar@tecsolex.com` |
| `ZOHO_APP_PASSWORD` | the app password from Step 1 |
| `DASH_SECRET` | any random string you make up — this protects the worker so only your dashboard can trigger it. Example: a 20+ character random string. |

---

## 5. Add Variables (plain, not secret)

| Variable | Value |
|---|---|
| `SPACE_IDS` | comma-separated space/list IDs. Space: `90166936041` · List: prefix with `l:` → `l:901615134011`. Mix freely: `90166936041,l:901615134011` |
| `EMAIL_TO` | `shekhar@tecsolex.com` |
| `EMAIL_CC` | `bhumika@tecsolex.in,dheeraj@tecsolex.in,ejaj@tecsolex.in,farheen@tecsolex.in,jay@tecsolex.com,kamleshram@tecsolex.in,pawan@tecsolex.com,roy@tecsolex.com,shubham@tecsolex.in` |

---

## 6. Add the Cron Trigger

Worker → **Settings → Triggers → Cron Triggers → Add**

```
30 3 * * *
```

This is 3:30 AM UTC = **9:00 AM IST** every day.

---

## 7. Connect the Dashboard

1. Copy your worker URL — looks like `https://clickup-email-reporter.yoursubdomain.workers.dev`
2. Open your dashboard → scroll to **Daily Status Report** section
3. Click the **⚙** icon next to "Send email"
4. Paste:
   - **Worker URL**: your worker URL from step 1
   - **Dashboard Secret Key**: the same value you set as `DASH_SECRET`
5. Click **Save connection**

---

## Using It

- **✉ Send email** — sends the report right now, on demand
- **Daily auto-send (9 AM IST)** toggle — turn the automation on/off anytime. State is stored in Cloudflare KV and persists even if you close the dashboard.
- The cron always fires at 9 AM IST, but the worker checks the toggle first — if OFF, it does nothing that day.

## What's in the email

- Overall Snapshot (Completed, In Progress, UAT, To Do, On Hold)
- Team Workload Summary (per-person in progress / UAT / on hold / completed)
- **No task-level detail** — just the two summary sections, as requested

## Notes

- Zoho SMTP runs over a raw TCP socket using Cloudflare's Sockets API — this requires the Workers **paid plan is NOT required**, TCP sockets are available on the free tier, but double check current Cloudflare docs if you hit limits.
- If `AUTH LOGIN` fails, double-check the app password was copied without extra spaces.
- CC list has 9 addresses — Zoho's standard sending limits should comfortably cover one daily email.
