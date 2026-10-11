// End-to-end: run the real CLI as Claude Code would (JSON on stdin).
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const bin = path.join(root, 'bin', 'agent-trail.js');

function sandbox() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-trail-test-'));
  const work = path.join(dir, 'work');
  fs.mkdirSync(work);
  return { dir, work, home: path.join(dir, 'home') };
}

function cli(sb, args, stdin) {
  const r = spawnSync(process.execPath, [bin, ...args], {
    input: stdin === undefined ? '' : typeof stdin === 'string' ? stdin : JSON.stringify(stdin),
    cwd: sb.work,
    encoding: 'utf8',
    env: { ...process.env, AGENT_TRAIL_HOME: sb.home, AGENT_TRAIL_CONFIG: '', NO_COLOR: '1', HOME: sb.dir },
  });
  let json = null;
  try {
    json = JSON.parse(r.stdout);
  } catch { /* text output */ }
  return { code: r.status, out: r.stdout, err: r.stderr, json };
}

const pre = (sb, tool, input, extra = {}) => ({
  hook_event_name: 'PreToolUse', session_id: 's1', cwd: sb.work, tool_name: tool, tool_input: input, permission_mode: 'default', ...extra,
});

const trail = (sb) => fs.readFileSync(path.join(sb.home, 'trail.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));

test('external POST: silent allow, logged, closed by PostToolUse', () => {
  const sb = sandbox();
  const r = cli(sb, ['hook'], pre(sb, 'Bash', { command: 'curl -X POST https://api.example.com/v1/items -d name=x' }, { tool_use_id: 'tu1' }));
  assert.equal(r.code, 0);
  assert.equal(r.out, '', 'no opinion -> empty stdout, normal permissions apply');
  const post = cli(sb, ['hook'], { hook_event_name: 'PostToolUse', session_id: 's1', cwd: sb.work, tool_name: 'Bash', tool_use_id: 'tu1', tool_response: { stdout: '{}' } });
  assert.equal(post.out, '');
  const t = trail(sb);
  assert.equal(t.length, 2);
  assert.equal(t[0].type, 'action');
  assert.equal(t[0].host, 'api.example.com');
  assert.equal(t[0].decision, 'log');
  assert.deepEqual(t[1], { ...t[1], type: 'result', toolUseId: 'tu1', ok: true });
  const rv = cli(sb, ['review', '--since', '1h']);
  assert.match(rv.out, /1 outbound writes/);
  assert.match(rv.out, /api\.example\.com/);
});

test('reads and localhost are not logged', () => {
  const sb = sandbox();
  cli(sb, ['hook'], pre(sb, 'WebFetch', { url: 'https://docs.example.com', prompt: 'x' }));
  cli(sb, ['hook'], pre(sb, 'Bash', { command: 'curl -X POST http://localhost:3000/api -d a=1' }));
  cli(sb, ['hook'], pre(sb, 'Bash', { command: 'ls -la && git status' }));
  assert.equal(fs.existsSync(path.join(sb.home, 'trail.jsonl')), false);
});

test('sensitive site: ask when attended, deny when nobody is watching', () => {
  const sb = sandbox();
  const cmd = { command: "curl https://tips.example-police.org/submit -d 'tip=generated'" };
  const asked = cli(sb, ['hook'], pre(sb, 'Bash', cmd, { tool_use_id: 'a1' }));
  assert.equal(asked.json.hookSpecificOutput.permissionDecision, 'ask');
  assert.match(asked.json.hookSpecificOutput.permissionDecisionReason, /law-enforcement/);
  const denied = cli(sb, ['hook'], pre(sb, 'Bash', cmd, { tool_use_id: 'a2', permission_mode: 'bypassPermissions' }));
  assert.equal(denied.json.hookSpecificOutput.permissionDecision, 'deny');
  assert.match(denied.json.hookSpecificOutput.permissionDecisionReason, /Nobody is watching/);
  const t = trail(sb);
  assert.deepEqual(t.map((x) => x.decision), ['ask', 'deny']);
  const rv = cli(sb, ['review', '--since', 'all']);
  assert.match(rv.out, /NEEDS YOUR EYES \(2\)/);
  assert.match(rv.out, /blocked/);
  assert.match(rv.out, /asked, no result/);
});

test('browser page is remembered across hook processes', () => {
  const sb = sandbox();
  assert.equal(cli(sb, ['hook'], pre(sb, 'mcp__playwright__browser_navigate', { url: 'https://permits.example.gov/apply' })).out, '');
  const r = cli(sb, ['hook'], pre(sb, 'mcp__playwright__browser_click', { element: 'Submit application', ref: 'e2' }, { tool_use_id: 'b1' }));
  assert.equal(r.json.hookSpecificOutput.permissionDecision, 'ask');
  assert.equal(trail(sb)[0].host, 'permits.example.gov');
  // a different session does not inherit the page
  const other = cli(sb, ['hook'], pre(sb, 'mcp__playwright__browser_click', { element: 'Submit', ref: 'e2' }, { session_id: 's2' }));
  assert.equal(other.out, '', 'unknown page -> external -> log only');
});

test('policy file: host override, category override, unattended=false', () => {
  const sb = sandbox();
  fs.writeFileSync(path.join(sb.work, '.agent-trail.json'), JSON.stringify({
    hosts: { 'api.stripe.com': 'log', 'evil.example.com': 'deny' },
    categories: { 'example.gov': 'external' },
    unattended: false,
  }));
  const s = cli(sb, ['hook'], pre(sb, 'Bash', { command: 'curl https://api.stripe.com/v1/refunds -d charge=c' }, { permission_mode: 'bypassPermissions' }));
  assert.equal(s.out, '');
  const g = cli(sb, ['hook'], pre(sb, 'Bash', { command: 'curl -X POST https://forms.example.gov/x' }));
  assert.equal(g.out, '');
  const e = cli(sb, ['hook'], pre(sb, 'Bash', { command: 'curl -X PUT https://evil.example.com/x' }));
  assert.equal(e.json.hookSpecificOutput.permissionDecision, 'deny');
  const b = cli(sb, ['hook'], pre(sb, 'Bash', { command: 'curl -X POST https://www.irs.gov/x' }, { permission_mode: 'bypassPermissions' }));
  assert.equal(b.json.hookSpecificOutput.permissionDecision, 'ask', 'unattended:false keeps ask even in bypass mode');
});

test('fails open: bad stdin and bad config never block the agent', () => {
  const sb = sandbox();
  const r1 = cli(sb, ['hook'], 'not json');
  assert.equal(r1.code, 0);
  assert.equal(r1.out, '');
  fs.writeFileSync(path.join(sb.work, '.agent-trail.json'), '{"rules": {"government": "maybe"}}');
  const r2 = cli(sb, ['hook'], pre(sb, 'Bash', { command: 'curl -X POST https://www.irs.gov/x' }));
  assert.equal(r2.code, 0);
  assert.equal(r2.out, '');
  assert.match(r2.err, /not one of/);
  const r3 = cli(sb, ['check', 'echo hi']);
  assert.equal(r3.code, 1, 'interactive commands do report a bad config');
});

test('CLI: help, version, check, init --write is idempotent', () => {
  const sb = sandbox();
  assert.match(cli(sb, ['--help']).out, /paper trail/);
  assert.equal(cli(sb, ['--version']).out.trim(), JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')).version);
  assert.match(cli(sb, ['check', 'curl -X POST https://www.vote.org/x']).out, /"decision":"ask","category":"elections"/);
  assert.match(cli(sb, ['check', 'ls']).out, /no outbound action/);
  assert.equal(cli(sb, ['nope']).code, 2);
  fs.mkdirSync(path.join(sb.work, '.claude'));
  fs.writeFileSync(path.join(sb.work, '.claude', 'settings.local.json'), JSON.stringify({ permissions: { allow: ['Bash(ls)'] }, hooks: { Stop: [{ hooks: [{ type: 'command', command: 'x' }] }] } }));
  assert.match(cli(sb, ['init', '--write']).out, /added/);
  assert.match(cli(sb, ['init', '--write']).out, /already has/);
  const s = JSON.parse(fs.readFileSync(path.join(sb.work, '.claude', 'settings.local.json'), 'utf8'));
  assert.deepEqual(s.permissions, { allow: ['Bash(ls)'] }, 'other settings kept');
  assert.equal(s.hooks.Stop.length, 1);
  assert.equal(s.hooks.PreToolUse.length, 1);
  assert.equal(s.hooks.PostToolUse[0].matcher, 'Bash|WebFetch|mcp__.*');
});

test('scan: reads Claude Code and Codex transcripts (demo fixtures)', () => {
  const sb = sandbox();
  const r = cli(sb, ['scan', '--claude-dir', path.join(root, 'demo', 'transcripts'), '--codex-dir', path.join(root, 'demo', 'codex'), '--days', 'all', '--json']);
  assert.equal(r.code, 0, r.err);
  const recs = r.json;
  const writes = recs.filter((x) => x.write);
  assert.equal(writes.length, 11);
  assert.ok(recs.some((x) => x.agent === 'codex' && x.host === 'forms.example.gov' && x.category === 'government'));
  const tip = recs.find((x) => x.kind === 'submit' && x.host === 'unsolvedcases.example.org');
  assert.equal(tip.category, 'law-enforcement');
  assert.equal(tip.status, 'ok');
  assert.equal(recs.find((x) => /Submit application/.test(x.detail)).status, 'error');
  assert.ok(!recs.some((x) => x.host === 'status.example.com'), 'GETs are not listed');
  const md = path.join(sb.dir, 'sheet.md');
  cli(sb, ['scan', '--claude-dir', path.join(root, 'demo', 'transcripts'), '--codex-dir', path.join(root, 'demo', 'codex'), '--days', 'all', '--md', md]);
  const text = fs.readFileSync(md, 'utf8');
  assert.match(text, /\| \[ \] \|/);
  assert.ok(!/generated text/.test(text), 'typed text never reaches the sheet');
});
