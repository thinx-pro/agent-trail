#!/usr/bin/env node
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { handleHook, settingsSnippet, MATCHER } from '../src/hook.js';
import { findConfig, loadConfig, decide } from '../src/policy.js';
import { classify } from '../src/classify.js';
import { trailPath, readTrail, fold } from '../src/trail.js';
import { renderText, renderMarkdown, parseSince } from '../src/review.js';
import { scan, defaultDirs } from '../src/scan.js';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const VERSION = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')).version;

const HELP = `agent-trail ${VERSION} — a paper trail for everything your agent sends out

Usage:
  agent-trail scan   [--days 30|all] [--project DIR] [--md FILE] [--json]
                     List outbound writes your Claude Code / Codex agents already made,
                     read from local session transcripts. Read-only.
  agent-trail init   [--global] [--write]
                     Print (or merge, with --write) the Claude Code hook settings.
  agent-trail hook   Claude Code hook entry point (PreToolUse / PostToolUse). Reads stdin.
  agent-trail review [--since 24h|7d|all] [--md FILE] [--json]
                     The daily review sheet from the live trail the hook wrote.
  agent-trail check  "<shell command>"  |  --tool NAME --input JSON [--url PAGE]
                     Dry run: show what would be logged, asked or blocked.

Options:
  --config FILE      Policy file (default: nearest .agent-trail.json, then ~/.agent-trail/config.json)
  --trail FILE       Trail file for review (default: ~/.agent-trail/trail.jsonl)
  --color / --no-color
  -h, --help         Show this help
  -v, --version      Show version

Policy decisions per category: ignore | log | ask | deny. Defaults: government, law-enforcement,
elections, courts, financial and health sites -> ask (deny when nobody is watching, e.g.
bypassPermissions); everything else external -> log; localhost/private -> ignore.`;

function flags(argv) {
  const f = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const [k, v] = a.slice(2).split('=');
      if (v !== undefined) f[k] = v;
      else if (['json', 'global', 'write', 'color', 'no-color', 'help', 'version'].includes(k)) f[k] = true;
      else f[k] = argv[++i];
    } else if (a === '-h') f.help = true;
    else if (a === '-v') f.version = true;
    else f._.push(a);
  }
  return f;
}

function useColor(f) {
  if (f['no-color'] || process.env.NO_COLOR) return false;
  return !!f.color || process.stdout.isTTY;
}

function readStdin() {
  try {
    return fs.readFileSync(0, 'utf8');
  } catch {
    return '';
  }
}

function out(file, text) {
  if (file) {
    fs.writeFileSync(file, text);
    console.error(`wrote ${file}`);
  } else console.log(text);
}

function main() {
  const [cmd, ...rest] = process.argv.slice(2);
  const f = flags(rest);
  if (!cmd || cmd === '-h' || cmd === '--help' || cmd === 'help' || f.help) return console.log(HELP);
  if (cmd === '-v' || cmd === '--version' || f.version) return console.log(VERSION);

  if (cmd === 'hook') {
    let input;
    try {
      input = JSON.parse(readStdin() || '{}');
    } catch {
      return; // not our JSON: stay out of the way
    }
    try {
      const res = handleHook(input, { configPath: f.config });
      if (res) process.stdout.write(JSON.stringify(res));
    } catch (e) {
      // fail open: a bug in the logger must not stop your agent; say so on stderr
      process.stderr.write(`agent-trail: ${e.message}\n`);
    }
    return;
  }

  const cfg = loadConfig(findConfig(f.config, process.cwd()));

  if (cmd === 'scan') {
    const all = f.days === 'all';
    const days = all ? 365 * 100 : Number(f.days || 30);
    if (!(days > 0)) throw new Error('--days must be a positive number or "all"');
    const dirs = defaultDirs().map((d) => ({ ...d, dir: (d.kind === 'claude' ? f['claude-dir'] : f['codex-dir']) || d.dir }));
    const { records, files, calls } = scan(cfg, { days, dirs, project: f.project });
    if (f.json) return out(f.out, JSON.stringify(records, null, 1));
    const span = all ? 'all time' : `last ${days}d`;
    const title = `agent-trail scan · ${span} · ${files} transcripts · ${calls} tool calls`;
    if (f.md) out(f.md, renderMarkdown(records, { title: `agent-trail scan (${span})` }));
    return console.log(renderText(records, { title, color: useColor(f) }));
  }

  if (cmd === 'review') {
    const since = parseSince(f.since || '24h');
    const file = f.trail || trailPath(cfg);
    const actions = fold(readTrail(file)).filter((a) => !since || Date.parse(a.ts) >= since);
    if (f.json) return console.log(JSON.stringify(actions, null, 1));
    const label = f.since || '24h';
    if (f.md) out(f.md, renderMarkdown(actions, { title: `agent-trail review (${label})` }));
    return console.log(renderText(actions, { title: `agent-trail review · ${label}`, color: useColor(f) }));
  }

  if (cmd === 'check') {
    let tool = f.tool || 'Bash';
    let input;
    if (f.input) input = JSON.parse(f.input);
    else if (f._.length) input = { command: f._.join(' ') };
    else throw new Error('check: give a shell command in quotes, or --tool NAME --input JSON');
    const state = f.url ? { url: f.url } : {};
    const actions = classify({ tool, input, cwd: process.cwd(), state });
    if (!actions.length) return console.log('no outbound action detected');
    for (const a of actions) {
      const d = decide(cfg, a, { unattended: false });
      const line = { decision: d.decision, category: d.category, kind: a.kind, method: a.method, host: a.host, detail: a.detail };
      if (a.bodyKeys) line.bodyKeys = a.bodyKeys;
      console.log(JSON.stringify(line));
    }
    return;
  }

  if (cmd === 'init') {
    const snippet = settingsSnippet(f.command || 'agent-trail hook');
    if (!f.write) {
      console.log(`# Add to ${f.global ? '~/.claude/settings.json' : '.claude/settings.local.json'} (or re-run with --write):`);
      console.log(JSON.stringify(snippet, null, 2));
      console.log('\n# Optional policy: copy examples/agent-trail.json to .agent-trail.json and edit.');
      return;
    }
    const target = f.global ? path.join(os.homedir(), '.claude', 'settings.json') : path.join(process.cwd(), '.claude', 'settings.local.json');
    let cur = {};
    if (fs.existsSync(target)) cur = JSON.parse(fs.readFileSync(target, 'utf8'));
    cur.hooks = cur.hooks || {};
    let added = 0;
    for (const [ev, entries] of Object.entries(snippet.hooks)) {
      const list = (cur.hooks[ev] = cur.hooks[ev] || []);
      const has = list.some((e) => e.matcher === MATCHER && (e.hooks || []).some((h) => /agent-trail(\.js)? hook/.test(h.command || '')));
      if (!has) { list.push(...entries); added++; }
    }
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, JSON.stringify(cur, null, 2) + '\n');
    console.log(added ? `added agent-trail hooks to ${target}` : `${target} already has the agent-trail hooks`);
    return;
  }

  console.error(`unknown command: ${cmd}\n`);
  console.error(HELP);
  process.exitCode = 2;
}

try {
  main();
} catch (e) {
  console.error(`agent-trail: ${e.message}`);
  process.exitCode = 1;
}
