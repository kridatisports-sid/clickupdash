/**
 * Cloudflare Worker — Daily ClickUp Status Email
 * 
 * Setup:
 * 1. Deploy this as a NEW worker (separate from your proxy worker)
 * 2. Add these secrets in Worker Settings → Variables and Secrets:
 *    - CLICKUP_TOKEN   : your ClickUp API token (pk_...)
 *    - RESEND_API_KEY  : from resend.com (re_...)
 * 3. Add these plain variables (not secrets):
 *    - SPACE_IDS       : comma-separated IDs. Space: "90166936041" | List: prefix with l: e.g. "90166936041,l:901615134011"
 *    - EMAIL_TO        : primary recipient e.g. "sid@tecsolex.in"
 *    - EMAIL_CC        : comma-separated CCs e.g. "ceo@tecsolex.in,pm@tecsolex.in"
 *    - EMAIL_FROM      : sender e.g. "reports@yourdomain.com" (must be verified in Resend)
 * 4. Set cron trigger: Settings → Triggers → Cron Triggers → Add: "30 4 * * *"
 *    (4:30 AM UTC = 10:00 AM IST)
 */

export default {
  // Manual trigger via HTTP GET for testing
  async fetch(request, env) {
    if (request.method === 'GET') {
      try {
        const report = await buildAndSend(env);
        return new Response('Email sent!\n\n' + report.text, {
          headers: { 'Content-Type': 'text/plain' }
        });
      } catch (e) {
        return new Response('Error: ' + e.message, { status: 500 });
      }
    }
    return new Response('Method not allowed', { status: 405 });
  },

  // Scheduled trigger — runs at 4:30 AM UTC (10:00 AM IST) every day
  async scheduled(event, env, ctx) {
    ctx.waitUntil(buildAndSend(env));
  }
};

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
      if (['in progress','pending for testing','release to uat'].includes(s)) acm[a].inprog++;
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

  // Reporting rules: Completed=Live, InProgress=IP+PFT+RUAT, UAT=separate
  const completed = sCounts['live'] || 0;
  const uat = sCounts['uat'] || 0;
  const ip = (sCounts['in progress'] || 0) + (sCounts['pending for testing'] || 0) + (sCounts['release to uat'] || 0);
  const todo = sCounts['to do'] || 0;
  const onhold = sCounts['on hold'] || 0;

  const teamRows = Object.entries(acm)
    .sort((a, b) => b[1].open - a[1].open)
    .map(([name, d]) => ({ name, ...d }));

  // Plain text version
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
    'Note: Completed = Live only. In Progress includes Pending for Testing & Release to UAT. UAT tracked separately.',
    '',
    '─────────────────────────────────',
    'TEAM WORKLOAD SUMMARY',
    '─────────────────────────────────',
    ...teamRows.map(m => {
      const oh = m.onhold || 0;
      return m.name.padEnd(24) + '— ' + m.inprog + ' in progress, ' + (m.uat||0) + ' UAT' + (oh ? ' (' + oh + ' on hold)' : '') + ', ' + m.done + ' completed';
    }),
  ];

  // HTML version
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
  .tag-open{background:#fef3c7;color:#92400e}
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
    { label: 'In Progress',      val: ip,         color: '#8b5cf6' },
    { label: 'UAT',              val: uat,        color: '#14b8a6' },
    { label: 'To Do',            val: todo,       color: '#64748b' },
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
        <span class="tag" style="background:#ccfbf1;color:#0d7561">${m.uat||0} UAT</span>
        ${m.onhold ? `<span class="tag" style="background:#fee2e2;color:#991b1b">${m.onhold} on hold</span>` : ''}
        <span class="tag tag-done">${m.done} completed</span>
      </div>
    </div>`;
  }).join('')}

  <div class="note">Completed = Live only. In Progress includes Pending Test &amp; Release to UAT. UAT and On Hold tracked separately.</div>
  <div class="footer">Sent automatically at 10:00 AM IST · Tecsolex Project Intelligence</div>
</div>
</body></html>`;

  return { text: lines.join('\n'), html, subject: `[${dateStr}] Daily Status — ${spaceNames.join(' & ')}` };
}

async function buildAndSend(env) {
  const token = env.CLICKUP_TOKEN;
  const resendKey = env.RESEND_API_KEY;
  const spaceIds = (env.SPACE_IDS || '').split(',').map(s => s.trim()).filter(Boolean);
  const emailTo = env.EMAIL_TO;
  const emailCc = (env.EMAIL_CC || '').split(',').map(s => s.trim()).filter(Boolean);
  const emailFrom = env.EMAIL_FROM || 'reports@yourdomain.com';

  if (!token) throw new Error('CLICKUP_TOKEN not set');
  if (!resendKey) throw new Error('RESEND_API_KEY not set');
  if (!spaceIds.length) throw new Error('SPACE_IDS not set');
  if (!emailTo) throw new Error('EMAIL_TO not set');

  // Fetch all sources — prefix list IDs with 'l:' e.g. SPACE_IDS = "90166936041,l:901615134011"
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

  // Send via Resend
  const emailPayload = {
    from: emailFrom,
    to: [emailTo],
    cc: emailCc.length ? emailCc : undefined,
    subject: report.subject,
    text: report.text,
    html: report.html,
  };

  const emailRes = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      'Authorization': 'Bearer ' + resendKey,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(emailPayload),
  });

  if (!emailRes.ok) {
    const err = await emailRes.json().catch(() => ({}));
    throw new Error('Resend error: ' + JSON.stringify(err));
  }

  return report;
}
