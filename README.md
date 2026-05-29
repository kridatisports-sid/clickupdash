# ClickUp Dashboard Generator

Paste a ClickUp space URL → instant dashboard. No API key exposed in the browser.

## Architecture

```
Browser (GitHub Pages)
  └─ index.html
       └─ POST to Cloudflare Worker (your WORKER_URL)
              └─ Anthropic API + ClickUp MCP
```

Your Anthropic API key lives only in the Cloudflare Worker as an encrypted secret — never in the browser or in this repo.

---

## Setup (5 minutes)

### Step 1 — Deploy the Cloudflare Worker

1. Sign up free at [cloudflare.com](https://dash.cloudflare.com)
2. Go to **Workers & Pages → Create → Create Worker**
3. Click **Edit code**, paste the contents of `worker.js`, click **Deploy**
4. Go to **Settings → Variables and Secrets**
5. Add a secret named exactly `ANTHROPIC_API_KEY` with your key from [console.anthropic.com](https://console.anthropic.com)
6. Note your worker URL — looks like: `https://clickup-dash.yourname.workers.dev`

### Step 2 — Configure index.html

Open `index.html` and replace line near the top:

```js
const WORKER_URL = 'https://YOUR_WORKER.YOUR_SUBDOMAIN.workers.dev';
```

with your actual worker URL from Step 1.

### Step 3 — Deploy to GitHub Pages

1. Create a GitHub repo (public or private)
2. Push both files (`index.html`, `worker.js`)
3. Go to repo **Settings → Pages → Source: Deploy from branch**
4. Pick `main` branch, root `/`, save
5. Your app is live at `https://<username>.github.io/<repo>/`

### Step 4 — Tighten CORS (recommended)

In `worker.js`, change:

```js
const ALLOWED_ORIGIN = '*';
```

to:

```js
const ALLOWED_ORIGIN = 'https://yourname.github.io';
```

Redeploy the worker. Now only your GitHub Pages site can call it.

---

## Connect ClickUp MCP

The app uses Claude's ClickUp MCP integration to fetch your tasks.

Your ClickUp account must be connected in Claude's integrations settings:
👉 [claude.ai/settings/integrations](https://claude.ai/settings/integrations)

The MCP auth is tied to the Anthropic account that owns the API key in your Worker secret.

---

## Usage

1. Open your GitHub Pages URL
2. Paste a ClickUp space URL — format: `https://app.clickup.com/{workspaceId}/v/s/{spaceId}`
3. Click **Generate Dashboard**

The URL is saved to `localStorage` so you don't have to paste it again.

---

## Files

```
index.html   Frontend — hosted on GitHub Pages
worker.js    API proxy — hosted on Cloudflare Workers (holds the API key)
README.md    This file
```

No build step. No npm. No framework. Just two files.
