// Writes the synthetic demo transcripts in demo/ (Claude Code + Codex formats).
// Every host is fictional (example.* / reserved names) except well-known APIs
// used only as category examples. Usage: node scripts/make-demo.js
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const session = 'demo-overnight-0001';
const cwd = '/home/dev/site';
let n = 0;
let t = Date.parse('2026-10-10T23:05:00Z');
const lines = [];
const call = (name, input, ok = true) => {
  const id = `toolu_demo_${String(++n).padStart(3, '0')}`;
  t += 7 * 60e3;
  const ts = new Date(t).toISOString();
  lines.push({ type: 'assistant', timestamp: ts, sessionId: session, cwd, message: { role: 'assistant', content: [{ type: 'tool_use', id, name, input }] } });
  lines.push({ type: 'user', timestamp: ts, sessionId: session, cwd, message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content: ok ? 'ok' : 'error', is_error: !ok }] } });
};

call('WebFetch', { url: 'https://docs.example.com/guide', prompt: 'summarize' });
call('Bash', { command: 'npm test && git push https://github.com/acme/site.git main' });
call('Bash', { command: 'gh pr create --title "Nightly deps bump" --body "automated"' });
call('Bash', { command: `curl -s -X POST https://hooks.slack.com/services/T0DEMO/B0DEMO/demoDemoDemo1234567890 -H 'Content-Type: application/json' -d '{"text":"build green"}'` });
call('mcp__playwright__browser_navigate', { url: 'https://unsolvedcases.example.org/submit-a-tip' });
call('mcp__playwright__browser_type', { element: 'Tip details', ref: 'e14', text: '(generated text)' });
call('mcp__playwright__browser_click', { element: 'Submit tip', ref: 'e19' });
call('mcp__playwright__browser_navigate', { url: 'https://permits.example.gov/apply/street-closure' });
call('mcp__playwright__browser_fill_form', { fields: [{ name: 'Applicant name', ref: 'e3', value: 'x' }, { name: 'Dates', ref: 'e5', value: 'y' }] });
call('mcp__playwright__browser_click', { element: 'Submit application', ref: 'e22' }, false);
call('Bash', { command: "curl https://api.stripe.com/v1/refunds -u \"$STRIPE_KEY:\" -d charge=ch_demo -d amount=500" });
call('mcp__gmail__send_email', { to: ['press@city.example.gov'], subject: 'Request for comment', body: '(generated text)' });
call('Bash', { command: 'npm publish --access public' });
call('Bash', { command: `curl -s https://api.example-llm.com/v1/chat/completions -d '{"model":"m","messages":[]}'` });
call('mcp__linear__save_issue', { title: 'Overnight run summary', team: 'ENG' });
call('Bash', { command: 'curl -s https://status.example.com/api/v2/status.json' });

const dir = path.join(root, 'demo', 'transcripts', '-home-dev-site');
fs.mkdirSync(dir, { recursive: true });
fs.writeFileSync(path.join(dir, `${session}.jsonl`), lines.map((l) => JSON.stringify(l)).join('\n') + '\n');

// a Codex rollout with one shell call, in Codex's response_item format
const cx = [
  { timestamp: '2026-10-11T02:40:00Z', type: 'session_meta', payload: { id: 'demo-codex-0001', cwd: '/home/dev/site' } },
  { timestamp: '2026-10-11T02:41:00Z', type: 'response_item', payload: { type: 'function_call', name: 'exec_command', arguments: JSON.stringify({ cmd: "curl -s -X POST https://forms.example.gov/contact -F name=bot -F message=@note.txt", workdir: '/home/dev/site' }), call_id: 'call_demo_1' } },
  { timestamp: '2026-10-11T02:41:01Z', type: 'response_item', payload: { type: 'function_call_output', call_id: 'call_demo_1', output: 'Process exited with code 0\nOutput:\n{}' } },
];
const cdir = path.join(root, 'demo', 'codex', '2026', '10', '11');
fs.mkdirSync(cdir, { recursive: true });
fs.writeFileSync(path.join(cdir, 'rollout-demo.jsonl'), cx.map((l) => JSON.stringify(l)).join('\n') + '\n');
console.log(`wrote ${lines.length / 2} Claude Code tool calls and 1 Codex call to demo/`);
