// Renders the demo scan (plus a live hook decision) as an HTML terminal window
// for the README screenshot, captured with headless Chrome.
// Usage: node scripts/screenshot-html.js assets/demo.html
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
import os from 'node:os';
// isolated home so the demo never touches your real trail or config
const env = { ...process.env, TZ: 'UTC', AGENT_TRAIL_CONFIG: '', AGENT_TRAIL_HOME: fs.mkdtempSync(path.join(os.tmpdir(), 'agent-trail-demo-')) };
const run = (args, input) => execFileSync('node', ['bin/agent-trail.js', ...args], { cwd: root, encoding: 'utf8', env, input });
const scan = run(['scan', '--claude-dir', 'demo/transcripts', '--codex-dir', 'demo/codex', '--days', 'all', '--color']);
const hookIn = JSON.stringify({
  hook_event_name: 'PreToolUse', session_id: 'x', cwd: root, permission_mode: 'bypassPermissions', tool_name: 'Bash',
  tool_input: { command: "curl -X POST https://unsolvedcases.example.org/tips -d 'case=...&tip=...'" },
});
const hook = JSON.parse(run(['hook'], hookIn)).hookSpecificOutput;

const color = { 1: 'font-weight:700', 31: 'color:#ff7b72', 32: 'color:#7ee787', 33: 'color:#e3b341', 36: 'color:#56d4dd', 90: 'color:#8b949e' };
const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const ansi = (src) => {
  let open = 0;
  return esc(src).replace(/\x1b\[(\d+)m/g, (_, c) => {
    if (c === '0') { const s = '</span>'.repeat(open); open = 0; return s; }
    open += 1;
    return `<span style="${color[c] || ''}">`;
  });
};
const wrap = (s, n) => s.replace(new RegExp(`(.{1,${n}})(\\s|$)`, 'g'), '$1\n').trimEnd();
const html = `<!doctype html><meta charset="utf-8"><style>
body{margin:0;background:#0d1117}
.win{margin:24px;border-radius:10px;background:#161b22;box-shadow:0 8px 30px rgba(0,0,0,.5);overflow:hidden;width:max-content}
.bar{height:30px;background:#21262d;display:flex;align-items:center;gap:8px;padding:0 12px}
.dot{width:12px;height:12px;border-radius:50%}
pre{margin:0;padding:18px 22px 22px;color:#c9d1d9;font:14px/1.45 "SF Mono",Menlo,Consolas,monospace}
.cmd{color:#8b949e}
</style><div class="win"><div class="bar"><span class="dot" style="background:#ff5f56"></span><span class="dot" style="background:#ffbd2e"></span><span class="dot" style="background:#27c93f"></span></div><pre><span class="cmd">$ npm run demo      # agent-trail scan over the bundled synthetic transcripts</span>
${ansi(scan.trimEnd())}

<span class="cmd">$ # same tip, live, with the hook installed and nobody watching (bypassPermissions):</span>
<span style="color:#ff7b72;font-weight:700">PreToolUse → ${hook.permissionDecision}</span>
<span style="color:#8b949e">${esc(wrap(hook.permissionDecisionReason.split(' If it is expected')[0], 108))}</span></pre></div>`;
fs.writeFileSync(process.argv[2] || 'demo.html', html);
