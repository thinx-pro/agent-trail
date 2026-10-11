// Retroactive mode: read Claude Code and Codex session transcripts and list
// the outbound actions the agent already took. Read-only; nothing is sent.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { classify } from './classify.js';
import { decide } from './policy.js';

export function defaultDirs() {
  return [
    { kind: 'claude', dir: path.join(process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude'), 'projects') },
    { kind: 'codex', dir: path.join(process.env.CODEX_HOME || path.join(os.homedir(), '.codex'), 'sessions') },
  ];
}

function* walkJsonl(dir, sinceMs) {
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of entries) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) yield* walkJsonl(p, sinceMs);
    else if (e.name.endsWith('.jsonl')) {
      try {
        if (fs.statSync(p).mtimeMs >= sinceMs) yield p;
      } catch { /* vanished */ }
    }
  }
}

function lines(file) {
  const out = [];
  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch {
    return out;
  }
  for (const l of text.split('\n')) {
    if (!l || l[0] !== '{') continue;
    try {
      out.push(JSON.parse(l));
    } catch { /* partial line */ }
  }
  return out;
}

// Normalised tool calls: {ts, session, cwd, tool, input, id}
export function claudeCalls(file) {
  const calls = [];
  const results = new Map();
  for (const o of lines(file)) {
    const content = o.message?.content;
    if (!Array.isArray(content)) continue;
    for (const it of content) {
      if (it?.type === 'tool_use') {
        calls.push({ ts: o.timestamp, session: o.sessionId || o.session_id || path.basename(file, '.jsonl'), cwd: o.cwd, tool: it.name, input: it.input || {}, id: it.id });
      } else if (it?.type === 'tool_result' && it.tool_use_id) {
        results.set(it.tool_use_id, it.is_error === true ? 'error' : 'ok');
      }
    }
  }
  return { calls, results };
}

export function codexCalls(file) {
  const calls = [];
  const results = new Map();
  let session = path.basename(file, '.jsonl');
  let cwd;
  for (const o of lines(file)) {
    const p = o.payload || {};
    if (o.type === 'session_meta') {
      session = p.id || session;
      cwd = p.cwd || cwd;
    }
    if (o.type === 'turn_context' && p.cwd) cwd = p.cwd;
    if (o.type !== 'response_item') continue;
    if (p.type === 'function_call') {
      let args = {};
      try {
        args = JSON.parse(p.arguments || '{}');
      } catch { /* keep empty */ }
      let tool = p.name;
      let input = args;
      if (p.name === 'exec_command' || p.name === 'shell' || p.name === 'local_shell') {
        const cmd = args.cmd ?? args.command;
        const command = Array.isArray(cmd) ? (cmd[0] === 'bash' && cmd[1] === '-lc' ? cmd[2] : cmd.join(' ')) : String(cmd || '');
        tool = 'Bash';
        input = { command };
      } else if (p.namespace && p.namespace.startsWith('mcp__')) {
        tool = `${p.namespace.replace(/__$/, '')}__${p.name.replace(/^_+/, '')}`;
      }
      calls.push({ ts: o.timestamp, session, cwd: args.workdir || cwd, tool, input, id: p.call_id });
    } else if (p.type === 'function_call_output' && p.call_id) {
      const m = String(p.output || '').match(/exited with code (\d+)/);
      results.set(p.call_id, m && m[1] !== '0' ? 'error' : 'ok');
    }
  }
  return { calls, results };
}

/**
 * @returns {{records: object[], files: number, calls: number}}
 */
export function scan(cfg, { days = 30, dirs = defaultDirs(), project } = {}) {
  const sinceMs = Date.now() - days * 86400e3;
  const records = [];
  let files = 0;
  let total = 0;
  for (const { kind, dir } of dirs) {
    for (const file of walkJsonl(dir, sinceMs)) {
      files++;
      const { calls, results } = kind === 'codex' ? codexCalls(file) : claudeCalls(file);
      const states = new Map();
      for (const c of calls) {
        total++;
        if (c.ts && Date.parse(c.ts) < sinceMs) continue;
        if (project && !(c.cwd || '').startsWith(path.resolve(project))) continue;
        if (!states.has(c.session)) states.set(c.session, {});
        const state = states.get(c.session);
        let actions;
        try {
          actions = classify({ tool: c.tool, input: c.input, cwd: c.cwd, state, resolveGit: false });
        } catch {
          continue;
        }
        for (const a of actions) {
          const d = decide(cfg, a, { unattended: false });
          if (d.decision === 'ignore') continue;
          const { extraHosts, ...rest } = a;
          records.push({
            v: 1, type: 'action', ts: c.ts, session: c.session, cwd: c.cwd, tool: c.tool, toolUseId: c.id, agent: kind, ...rest,
            ...(extraHosts?.length ? { extraHosts } : {}), category: d.category, decision: d.decision, status: results.get(c.id) || 'unknown', retro: true,
          });
        }
      }
    }
  }
  records.sort((a, b) => String(a.ts).localeCompare(String(b.ts)));
  return { records, files, calls: total };
}
