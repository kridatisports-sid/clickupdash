/**
 * Cloudflare Worker — Daily ClickUp Status Email via Resend
 *
 * ── SETUP ──────────────────────────────────────────────────────────────
 * 1. Deploy this as a Worker (Workers & Pages → Create → Hello World → paste this code)
 *
 * 2. Get a free Resend account: https://resend.com
 *    - Sign up (free tier: 100 emails/day, no credit card)
 *    - Verify a sending domain, OR use their test address onboarding@resend.dev
 *      for initial testing (only works sending TO your own verified email
 *      until you verify a domain — for full team delivery, verify your domain)
 *    - Get your API key: Resend dashboard → API Keys → Create
 *
 * 3. Add SECRETS (Settings → Variables and Secrets → Encrypt):
 *    CLICKUP_TOKEN     : your ClickUp API token (pk_...)
 *    RESEND_API_KEY    : your Resend API key (re_...)
 *    DASH_SECRET       : any random string you choose — used to authorize
 *                        the dashboard's "Send Email" button and the
 *                        automation on/off toggle.
 *
 * 4. Add VARIABLES (plain, not secret):
 *    SPACE_IDS   : comma-separated ClickUp space/list IDs.
 *                  Space: "90166936041"   List: prefix with l: → "l:901615134011"
 *                  Mix freely: "90166936041,l:901615134011"
 *    EMAIL_TO    : shekhar@tecsolex.com
 *    EMAIL_CC    : bhumika@tecsolex.in,dheeraj@tecsolex.in,ejaj@tecsolex.in,farheen@tecsolex.in,jay@tecsolex.com,kamleshram@tecsolex.in,pawan@tecsolex.com,roy@tecsolex.com,shubham@tecsolex.in
 *    EMAIL_FROM  : the verified sender, e.g. "reports@tecsolex.com" (must match
 *                  your verified domain in Resend) — or "onboarding@resend.dev"
 *                  for quick testing
 *
 * 5. Cron trigger (Settings → Triggers → Cron Triggers):
 *    Add: "30 3 * * *"   → 3:30 AM UTC = 9:00 AM IST every day
 *
 * 6. Bind a KV namespace named AUTOMATION_KV (Settings → Bindings → KV Namespace)
 *    — this stores the on/off toggle state so it persists across requests.
 *
 * ── ENDPOINTS ──────────────────────────────────────────────────────────
 * GET  /send-now?key=DASH_SECRET        → builds report + sends email immediately
 * GET  /status?key=DASH_SECRET          → returns {automationEnabled: true/false}
 * POST /toggle?key=DASH_SECRET&on=true  → turns automation on
 * POST /toggle?key=DASH_SECRET&on=false → turns automation off
 * ────────────────────────────────────────────────────────────────────────
 */

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const cors = {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
    };
    if (request.method === 'OPTIONS') return new Response(null, { headers: cors });

    const key = url.searchParams.get('key');
    if (key !== env.DASH_SECRET) {
      return new Response(JSON.stringify({ error: 'Unauthorized' }), {
        status: 401, headers: { 'Content-Type': 'application/json', ...cors }
      });
    }

    try {
      if (url.pathname === '/send-now') {
        const report = await buildAndSend(env);
        return json({ ok: true, subject: report.subject }, cors);
      }

      if (url.pathname === '/status') {
        const enabled = await env.AUTOMATION_KV.get('automation_enabled');
        return json({ automationEnabled: enabled !== 'false' }, cors); // default ON
      }

      if (url.pathname === '/toggle' && request.method === 'POST') {
        const on = url.searchParams.get('on') === 'true';
        await env.AUTOMATION_KV.put('automation_enabled', on ? 'true' : 'false');
        return json({ ok: true, automationEnabled: on }, cors);
      }

      return json({ error: 'Unknown endpoint' }, cors, 404);
    } catch (e) {
      return json({ error: e.message }, cors, 500);
    }
  },

  // Scheduled trigger — runs daily per cron, but checks the KV toggle first
  async scheduled(event, env, ctx) {
    ctx.waitUntil((async () => {
      const enabled = await env.AUTOMATION_KV.get('automation_enabled');
      if (enabled === 'false') return; // automation paused
      await buildAndSend(env);
    })());
  }
};

function json(obj, cors, status) {
  return new Response(JSON.stringify(obj), {
    status: status || 200,
    headers: { 'Content-Type': 'application/json', ...cors }
  });
}

// ── ClickUp fetch helpers ────────────────────────────────────────────────────
async function cuFetch(token, path) {
  const res = await fetch('https://api.clickup.com/api/v2' + path, {
    headers: { 'Authorization': token }
  });
  if (!res.ok) {
    const e = await res.json().catch(() => ({}));
    throw new Error(e.err || e.error || 'ClickUp error ' + res.status);
  }
  return res.json();
}

async function fetchListData(token, listId) {
  const listData = await cuFetch(token, '/list/' + listId);
  const lName = listData.name || ('List ' + listId);
  const sName = listData.space?.name || lName;
  const tasks = [];
  let page = 0;
  while (true) {
    const td = await cuFetch(token, '/list/' + listId + '/task?include_closed=true&subtasks=true&page=' + page);
    const tks = td.tasks || [];
    for (const t of tks) {
      const prioMap = { 1: 'urgent', 2: 'high', 3: 'normal', 4: 'low' };
      tasks.push({
        name: t.name,
        status: (t.status?.status || '').toLowerCase(),
        priority: prioMap[t.priority?.priority] || null,
        list: lName, space: sName,
        assignees: (t.assignees || []).map(a => a.username || a.email || '').filter(Boolean)
      });
    }
    if (tks.length < 100) break;
    page++;
  }
  return { spaceName: lName, tasks };
}

async function fetchSpaceData(token, spaceId) {
  const [spaceData, listsRes, foldersRes] = await Promise.all([
    cuFetch(token, '/space/' + spaceId),
    cuFetch(token, '/space/' + spaceId + '/list?archived=false'),
    cuFetch(token, '/space/' + spaceId + '/folder?archived=false'),
  ]);

  const spaceName = spaceData.name || ('Space ' + spaceId);
  const lists = listsRes.lists || [];

  for (const folder of foldersRes.folders || []) {
    const fl = await cuFetch(token, '/folder/' + folder.id + '/list?archived=false');
    if (fl.lists) lists.push(...fl.lists);
  }

  const tasks = [];
  for (const list of lists) {
    let page = 0;
    while (true) {
      const td = await cuFetch(token, '/list/' + list.id + '/task?include_closed=true&subtasks=true&page=' + page);
      const tks = td.tasks || [];
      for (const t of tks) {
        const prioMap = { 1: 'urgent', 2: 'high', 3: 'normal', 4: 'low' };
        tasks.push({
          name: t.name,
          status: (t.status?.status || '').toLowerCase(),
          priority: prioMap[t.priority?.priority] || null,
          list: list.name,
          space: spaceName,
          assignees: (t.assignees || []).map(a => a.username || a.email || '').filter(Boolean)
        });
      }
      if (tks.length < 100) break;
      page++;
    }
  }

  return { spaceName, tasks };
}

// ── Report building ──────────────────────────────────────────────────────────
function buildReport(spaceNames, tasks) {
  const total = tasks.length;
  const sCounts = {};
  const acm = {};

  for (const t of tasks) {
    const s = t.status || 'unknown';
    sCounts[s] = (sCounts[s] || 0) + 1;
    for (const a of t.assignees) {
      if (!acm[a]) acm[a] = { total: 0, open: 0, done: 0, inprog: 0, uat: 0, onhold: 0 };
      acm[a].total++;
      if (s === 'live') acm[a].done++;
      if (['in progress', 'pending for testing', 'release to uat'].includes(s)) acm[a].inprog++;
      if (s === 'uat') acm[a].uat++;
      if (s === 'on hold') acm[a].onhold++;
      if (s !== 'live') acm[a].open++;
    }
  }

  const now = new Date();
  const dateStr = now.toLocaleDateString('en-GB', {
    weekday: 'long', day: '2-digit', month: 'long', year: 'numeric',
    timeZone: 'Asia/Kolkata'
  });

  // Reporting rules: Completed=Live, InProgress=IP+PFT+RUAT, UAT=separate, On Hold=separate
  const completed = sCounts['live'] || 0;
  const uat = sCounts['uat'] || 0;
  const ip = (sCounts['in progress'] || 0) + (sCounts['pending for testing'] || 0) + (sCounts['release to uat'] || 0);
  const todo = sCounts['to do'] || 0;
  const onhold = sCounts['on hold'] || 0;

  const teamRows = Object.entries(acm)
    .sort((a, b) => b[1].inprog - a[1].inprog)
    .map(([name, d]) => ({ name, ...d }));

  const lines = [
    'DAILY STATUS REPORT — ' + spaceNames.join(' & ').toUpperCase(),
    dateStr,
    '',
    '─────────────────────────────────',
    'OVERALL SNAPSHOT',
    '─────────────────────────────────',
    'Total tasks tracked : ' + total,
    'Completed / Live    : ' + completed,
    'In Progress         : ' + ip + '  (incl. Pending Test & Release to UAT)',
    'UAT                 : ' + uat,
    'To Do               : ' + todo,
    ...(onhold ? ['On Hold             : ' + onhold] : []),
    '',
    'Note: Completed = Live only. In Progress incl. Pending Test & Release to UAT. UAT & On Hold tracked separately.',
    '',
    '─────────────────────────────────',
    'TEAM WORKLOAD SUMMARY',
    '─────────────────────────────────',
    ...teamRows.map(m => {
      const oh = m.onhold || 0;
      return m.name.padEnd(24) + '— ' + m.inprog + ' in progress, ' + (m.uat || 0) + ' UAT' + (oh ? ' (' + oh + ' on hold)' : '') + ', ' + m.done + ' completed';
    }),
  ];

  const html = `<!DOCTYPE html>
<html>
<head><meta charset="UTF-8"><style>
  body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;background:#f4f4f5;margin:0;padding:24px}
  .card{background:#fff;border-radius:12px;padding:28px 32px;max-width:640px;margin:0 auto;border:1px solid #e4e4e7}
  .header{border-bottom:2px solid #c9a84c;padding-bottom:16px;margin-bottom:24px}
  .eyebrow{font-size:10px;letter-spacing:.15em;text-transform:uppercase;color:#c9a84c;font-weight:600;margin-bottom:4px}
  h1{font-size:22px;font-weight:700;color:#111;margin:0 0 4px}
  .date{font-size:12px;color:#71717a;font-family:monospace}
  .section-title{font-size:10px;font-weight:700;letter-spacing:.12em;text-transform:uppercase;color:#71717a;margin:24px 0 12px;border-bottom:1px solid #f4f4f5;padding-bottom:6px}
  .snapshot-row{display:flex;align-items:center;padding:8px 0;border-bottom:1px solid #f4f4f5}
  .snapshot-row:last-child{border-bottom:none}
  .dot{width:8px;height:8px;border-radius:2px;flex-shrink:0;margin-right:10px}
  .snap-label{flex:1;font-size:13px;color:#374151}
  .snap-bar-wrap{width:80px;height:4px;background:#f4f4f5;border-radius:2px;margin-right:12px}
  .snap-bar{height:100%;border-radius:2px}
  .snap-pct{font-size:11px;color:#9ca3af;width:32px;text-align:right;margin-right:8px;font-family:monospace}
  .snap-val{font-size:16px;font-weight:700;color:#111;width:28px;text-align:right;font-family:monospace}
  .total-row{display:flex;justify-content:space-between;align-items:center;padding:10px 0 14px;border-bottom:2px solid #f4f4f5;margin-bottom:4px}
  .total-lbl{font-size:12px;font-weight:600;color:#374151;text-transform:uppercase;letter-spacing:.06em}
  .total-val{font-size:28px;font-weight:800;color:#c9a84c;font-family:monospace}
  .team-row{display:flex;align-items:center;padding:9px 0;border-bottom:1px solid #f4f4f5}
  .team-row:last-child{border-bottom:none}
  .av{width:32px;height:32px;border-radius:8px;display:flex;align-items:center;justify-content:center;font-size:11px;font-weight:700;flex-shrink:0;margin-right:10px}
  .team-name{flex:1;font-size:13px;font-weight:600;color:#111}
  .team-sub{font-size:10px;color:#9ca3af;font-family:monospace;margin-top:1px}
  .tag{display:inline-block;font-size:10px;font-weight:600;padding:2px 7px;border-radius:20px;margin-left:4px;font-family:monospace}
  .tag-ip{background:#ede9fe;color:#5b21b6}
  .tag-done{background:#d1fae5;color:#065f46}
  .note{font-size:11px;color:#9ca3af;margin-top:20px;padding:10px 12px;background:#f9fafb;border-radius:6px;border-left:3px solid #c9a84c}
  .footer{text-align:center;font-size:11px;color:#9ca3af;margin-top:20px}
</style></head>
<body>
<div class="card">
  <div class="header">
    <div class="eyebrow">Tecsolex · Daily Status Report</div>
    <h1>${spaceNames.join(' &amp; ')}</h1>
    <div class="date">${dateStr}</div>
  </div>

  <div class="section-title">Overall Snapshot</div>
  <div class="total-row">
    <span class="total-lbl">Total tasks tracked</span>
    <span class="total-val">${total}</span>
  </div>
  ${[
    { label: 'Completed / Live', val: completed, color: '#10b981' },
    { label: 'In Progress', val: ip, color: '#8b5cf6' },
    { label: 'UAT', val: uat, color: '#14b8a6' },
    { label: 'To Do', val: todo, color: '#64748b' },
    ...(onhold ? [{ label: 'On Hold', val: onhold, color: '#dc2626' }] : []),
  ].map(r => {
    const pct = total ? Math.round(r.val / total * 100) : 0;
    return `<div class="snapshot-row">
      <div class="dot" style="background:${r.color}"></div>
      <span class="snap-label">${r.label}</span>
      <div class="snap-bar-wrap"><div class="snap-bar" style="width:${pct}%;background:${r.color}"></div></div>
      <span class="snap-pct">${pct}%</span>
      <span class="snap-val">${r.val}</span>
    </div>`;
  }).join('')}

  <div class="section-title">Team Workload Summary</div>
  ${teamRows.map((m, i) => {
    const colors = ['#c9a84c','#8b5cf6','#10b981','#3b82f6','#ef4444','#14b8a6','#f59e0b','#e879f9'];
    const color = colors[i % colors.length];
    const initials = m.name.split(' ').map(w => w[0] || '').join('').toUpperCase().slice(0, 2);
    const pct = m.total ? Math.round(m.done / m.total * 100) : 0;
    return `<div class="team-row">
      <div class="av" style="background:${color}22;color:${color}">${initials}</div>
      <div style="flex:1">
        <div class="team-name">${m.name}</div>
        <div class="team-sub">${pct}% complete</div>
      </div>
      <div>
        <span class="tag tag-ip">${m.inprog} in progress</span>
        <span class="tag" style="background:#ccfbf1;color:#0d7561">${m.uat || 0} UAT</span>
        ${m.onhold ? `<span class="tag" style="background:#fee2e2;color:#991b1b">${m.onhold} on hold</span>` : ''}
        <span class="tag tag-done">${m.done} completed</span>
      </div>
    </div>`;
  }).join('')}

  <div class="note">Completed = Live only. In Progress includes Pending Test &amp; Release to UAT. UAT and On Hold tracked separately.</div>
  <div class="footer">Tecsolex Project Intelligence · Daily Status Report</div>
</div>
</body></html>`;

  return { text: lines.join('\n'), html, subject: `[${dateStr}] Daily Status — ${spaceNames.join(' & ')}` };
}

// ── Send via Resend (https://resend.com) — simple HTTP API, no SMTP needed ──
async function sendViaResend(env, { to, cc, subject, text, html }) {
  const apiKey = env.RESEND_API_KEY;
  const from = env.EMAIL_FROM || 'onboarding@resend.dev';

  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      'Authorization': 'Bearer ' + apiKey,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      from,
      to: [to],
      cc: cc.length ? cc : undefined,
      subject,
      text,
      html,
    }),
  });

  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error('Resend error: ' + (err.message || JSON.stringify(err)));
  }

  return true;
}

// ── Orchestration ─────────────────────────────────────────────────────────
async function buildAndSend(env) {
  const token = env.CLICKUP_TOKEN;
  const spaceIds = (env.SPACE_IDS || '').split(',').map(s => s.trim()).filter(Boolean);
  const emailTo = env.EMAIL_TO;
  const emailCc = (env.EMAIL_CC || '').split(',').map(s => s.trim()).filter(Boolean);

  if (!token) throw new Error('CLICKUP_TOKEN not set');
  if (!env.RESEND_API_KEY) throw new Error('RESEND_API_KEY not set');
  if (!spaceIds.length) throw new Error('SPACE_IDS not set');
  if (!emailTo) throw new Error('EMAIL_TO not set');

  let allTasks = [];
  const spaceNames = [];
  for (const id of spaceIds) {
    let result;
    if (id.startsWith('l:')) {
      result = await fetchListData(token, id.slice(2));
    } else {
      result = await fetchSpaceData(token, id);
    }
    allTasks = allTasks.concat(result.tasks);
    spaceNames.push(result.spaceName);
  }

  const report = buildReport(spaceNames, allTasks);

  await sendViaResend(env, {
    to: emailTo,
    cc: emailCc,
    subject: report.subject,
    text: report.text,
    html: report.html,
  });

  return report;
}