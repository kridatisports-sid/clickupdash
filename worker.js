/**
 * Cloudflare Worker — Anthropic API proxy for ClickUp Dashboard
 *
 * Deploy steps:
 *  1. Go to https://dash.cloudflare.com → Workers & Pages → Create Worker
 *  2. Paste this file
 *  3. Settings → Variables → Add secret: ANTHROPIC_API_KEY = sk-ant-...
 *  4. Note your worker URL: https://your-worker.your-subdomain.workers.dev
 *  5. Paste that URL into index.html as WORKER_URL
 *
 * CORS: only accepts requests from your GitHub Pages domain.
 * Change ALLOWED_ORIGIN below to match yours.
 */

const ALLOWED_ORIGIN = '*'; // tighten to e.g. 'https://yourname.github.io' after testing

export default {
  async fetch(request, env) {
    // Handle preflight
    if (request.method === 'OPTIONS') {
      return new Response(null, {
        headers: {
          'Access-Control-Allow-Origin': ALLOWED_ORIGIN,
          'Access-Control-Allow-Methods': 'POST, OPTIONS',
          'Access-Control-Allow-Headers': 'Content-Type',
          'Access-Control-Max-Age': '86400',
        },
      });
    }

    if (request.method !== 'POST') {
      return new Response('Method not allowed', { status: 405 });
    }

    let body;
    try {
      body = await request.json();
    } catch {
      return jsonError('Invalid JSON body', 400);
    }

    // Forward to Anthropic with the secret key
    const anthropicRes = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': env.ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01',
        'anthropic-beta': 'mcp-client-2025-04-04',
      },
      body: JSON.stringify(body),
    });

    const data = await anthropicRes.json();

    return new Response(JSON.stringify(data), {
      status: anthropicRes.status,
      headers: {
        'Content-Type': 'application/json',
        'Access-Control-Allow-Origin': ALLOWED_ORIGIN,
      },
    });
  },
};

function jsonError(msg, status) {
  return new Response(JSON.stringify({ error: { message: msg } }), {
    status,
    headers: {
      'Content-Type': 'application/json',
      'Access-Control-Allow-Origin': ALLOWED_ORIGIN,
    },
  });
}
