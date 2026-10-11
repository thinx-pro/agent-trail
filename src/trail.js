// Append-only JSONL trail. One line per outbound action, plus `result` lines
// that close an action by tool_use_id. Also a tiny per-session state file
// (the page the browser is on) so a later click knows its host.
import fs from 'node:fs';
import path from 'node:path';
import { homeDir } from './policy.js';

export function trailPath(cfg) {
  const dir = process.env.AGENT_TRAIL_DIR || cfg?.trailDir || homeDir();
  return path.join(dir, 'trail.jsonl');
}

export function append(file, records) {
  if (!records.length) return;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const fd = fs.openSync(file, 'a', 0o600);
  try {
    fs.writeSync(fd, records.map((r) => JSON.stringify(r)).join('\n') + '\n');
  } finally {
    fs.closeSync(fd);
  }
}

export function readTrail(file) {
  if (!fs.existsSync(file)) return [];
  const out = [];
  for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
    if (!line.trim()) continue;
    try {
      out.push(JSON.parse(line));
    } catch { /* torn line from a crash: skip */ }
  }
  return out;
}

// Merge result lines into their actions: status ok | error | unknown | blocked
export function fold(records) {
  const results = new Map();
  for (const r of records) if (r.type === 'result' && r.toolUseId) results.set(r.toolUseId, r);
  return records
    .filter((r) => r.type === 'action')
    .map((a) => {
      if (a.decision === 'deny') return { ...a, status: 'blocked' };
      const res = a.toolUseId ? results.get(a.toolUseId) : null;
      return { ...a, status: res ? (res.ok ? 'ok' : 'error') : a.status || 'unknown' };
    });
}

function statePath(file, session) {
  return path.join(path.dirname(file), 'state', `${String(session).replace(/[^\w.-]/g, '_')}.json`);
}

export function loadState(file, session) {
  try {
    return JSON.parse(fs.readFileSync(statePath(file, session), 'utf8'));
  } catch {
    return {};
  }
}

export function saveState(file, session, state) {
  const p = statePath(file, session);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, JSON.stringify(state));
}
