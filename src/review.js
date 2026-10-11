// The daily review sheet: terminal (optionally coloured) or Markdown.
import { SENSITIVE } from './domains.js';

const C = (on) => {
  const w = (code) => (s) => (on ? `\x1b[${code}m${s}\x1b[0m` : String(s));
  return { b: w(1), red: w(31), green: w(32), yellow: w(33), cyan: w(36), dim: w(90) };
};

export function parseSince(s) {
  if (!s || s === 'all') return 0;
  const m = String(s).match(/^(\d+(?:\.\d+)?)\s*([mhdw])$/);
  if (!m) throw new Error(`--since: expected like 24h, 7d, 90m or "all", got "${s}"`);
  const mult = { m: 60e3, h: 3600e3, d: 86400e3, w: 7 * 86400e3 }[m[2]];
  return Date.now() - Number(m[1]) * mult;
}

const needsEyes = (a) => SENSITIVE.has(a.category) || a.decision === 'ask' || a.decision === 'deny';

function statusLabel(a) {
  if (a.retro) {
    const would = a.decision === 'ask' || a.decision === 'deny' ? `would ${a.decision}` : '';
    return [a.status === 'error' ? 'failed' : a.status === 'ok' ? 'ran' : 'no result', would].filter(Boolean).join(', ');
  }
  return { blocked: 'blocked', asked: 'asked, no result', ok: 'done', error: 'failed', unknown: 'no result' }[a.status] || a.status;
}

function when(ts) {
  const d = new Date(ts);
  if (Number.isNaN(d.getTime())) return '?';
  const p = (n) => String(n).padStart(2, '0');
  return `${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

const pad = (s, n) => {
  const t = String(s);
  return t.length >= n ? t.slice(0, n - 1) + '…' : t + ' '.repeat(n - t.length);
};

function summarize(actions) {
  const writes = actions.filter((a) => a.write);
  const byHost = new Map();
  for (const a of writes) {
    const e = byHost.get(a.host) || { host: a.host, category: a.category, n: 0, kinds: {} };
    e.n++;
    e.kinds[a.kind] = (e.kinds[a.kind] || 0) + 1;
    byHost.set(a.host, e);
  }
  const byCat = {};
  for (const a of writes) byCat[a.category] = (byCat[a.category] || 0) + 1;
  return {
    writes,
    sessions: new Set(actions.map((a) => a.session)).size,
    eyes: actions.filter(needsEyes),
    hosts: [...byHost.values()].sort((a, b) => b.n - a.n),
    byCat,
    unknown: writes.filter((a) => a.status === 'unknown' && !needsEyes(a)),
  };
}

export function renderText(actions, { title = 'agent-trail', color = false, limit = 12 } = {}) {
  const c = C(color);
  const s = summarize(actions);
  const out = [];
  out.push(`${c.b(title)} ${c.dim('·')} ${c.b(s.writes.length)} outbound writes ${c.dim('·')} ${s.sessions} session${s.sessions === 1 ? '' : 's'}`);
  if (!actions.length) {
    out.push(c.dim('  nothing outbound recorded in this window.'));
    return out.join('\n');
  }
  const cats = Object.entries(s.byCat).sort((a, b) => b[1] - a[1]);
  if (cats.length) out.push(c.dim('  ') + cats.map(([k, n]) => `${SENSITIVE.has(k) ? c.yellow(k) : k} ${n}`).join(c.dim(' · ')));
  out.push('');
  out.push(s.eyes.length ? c.b(c.yellow(`⚠ NEEDS YOUR EYES (${s.eyes.length})`)) : c.green('✓ nothing sent to government, police, election, court, bank or health sites'));
  for (const a of s.eyes.slice(-limit)) {
    const st = statusLabel(a);
    const stc = a.status === 'blocked' ? c.red(st) : /would/.test(st) ? c.yellow(st) : st;
    out.push(`  ${c.dim(when(a.ts))}  ${c.yellow(pad(a.category, 16))} ${pad(a.host, 28)} ${pad(a.detail, 44)} ${stc}`);
  }
  if (s.eyes.length > limit) out.push(c.dim(`  … ${s.eyes.length - limit} more (use --md for the full sheet)`));
  out.push('');
  out.push(c.b('WHERE THE AGENT WROTE'));
  for (const h of s.hosts.slice(0, limit)) {
    const kinds = c.dim(Object.entries(h.kinds).map(([k, n]) => `${k} ${n}`).join(' · '));
    out.push(`  ${pad(h.host, 32)} ${String(h.n).padStart(4)}  ${kinds}`);
  }
  if (s.hosts.length > limit) out.push(c.dim(`  … ${s.hosts.length - limit} more hosts`));
  if (s.unknown.length) {
    out.push('');
    out.push(c.b(`NO RESULT RECORDED (${s.unknown.length})`) + c.dim(' — started, never reported back (crash, cancel or denied prompt)'));
    for (const a of s.unknown.slice(-5)) out.push(`  ${c.dim(when(a.ts))}  ${pad(a.host, 28)} ${a.detail}`);
  }
  return out.join('\n');
}

const mdEsc = (s) => String(s ?? '').replace(/\|/g, '\\|').replace(/\n/g, ' ');

export function renderMarkdown(actions, { title = 'agent-trail review' } = {}) {
  const s = summarize(actions);
  const out = [`# ${title}`, '', `${s.writes.length} outbound writes across ${s.sessions} session(s).`, ''];
  out.push('## Needs your eyes', '');
  if (!s.eyes.length) out.push('Nothing sent to government, police, election, court, bank or health sites.', '');
  else {
    out.push('| ✓ | when | category | host | what | status | session |', '|---|---|---|---|---|---|---|');
    for (const a of s.eyes) out.push(`| [ ] | ${when(a.ts)} | ${a.category} | ${mdEsc(a.host)} | ${mdEsc(a.detail)} | ${statusLabel(a)} | ${String(a.session).slice(0, 8)} |`);
    out.push('');
  }
  out.push('## Where the agent wrote', '', '| host | category | writes | kinds |', '|---|---|---:|---|');
  for (const h of s.hosts) out.push(`| ${mdEsc(h.host)} | ${h.category} | ${h.n} | ${Object.entries(h.kinds).map(([k, n]) => `${k} ${n}`).join(', ')} |`);
  out.push('', '## All outbound writes', '', '| when | host | what | method | body fields | status |', '|---|---|---|---|---|---|');
  for (const a of s.writes) out.push(`| ${when(a.ts)} | ${mdEsc(a.host)} | ${mdEsc(a.detail)} | ${a.method} | ${mdEsc((a.bodyKeys || []).join(', '))} | ${statusLabel(a)} |`);
  out.push('', '_Generated by agent-trail. Body values are never stored: only field names, size and a hash._', '');
  return out.join('\n');
}
