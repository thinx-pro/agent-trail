import test from 'node:test';
import assert from 'node:assert/strict';
import { classify } from '../src/classify.js';
import { splitCommands } from '../src/shell.js';
import { categorize, hostOf, redactUrl } from '../src/domains.js';

const bash = (command, extra = {}) => classify({ tool: 'Bash', input: { command }, resolveGit: false, ...extra });

test('shell splitting keeps quotes and drops redirections', () => {
  assert.deepEqual(splitCommands(`curl -d 'a=1&b=2' "https://x.io/a b" 2>&1 | head > out.txt; echo hi`), [
    ['curl', '-d', 'a=1&b=2', 'https://x.io/a b'],
    ['head'],
    ['echo', 'hi'],
  ]);
  assert.deepEqual(splitCommands('git push origin main 2>&1 && echo done &>/dev/null'), [['git', 'push', 'origin', 'main'], ['echo', 'done']]);
});

test('curl: method inference, body field names, no values stored', () => {
  const [a] = bash(`curl -s https://tips.example.org/api -d 'name=Al&tip=secret text'`);
  assert.equal(a.kind, 'http-write');
  assert.equal(a.method, 'POST');
  assert.deepEqual(a.bodyKeys, ['name', 'tip']);
  assert.ok(!JSON.stringify(a).includes('secret text'));
  assert.equal(bash('curl -sSL https://example.com/x')[0].write, false);
  assert.equal(bash('curl -G https://example.com/search -d q=1')[0].method, 'GET');
  assert.equal(bash('curl -sX DELETE https://api.example.com/v1/item/3')[0].method, 'DELETE');
  assert.equal(bash('curl -T file.zip https://up.example.com/')[0].method, 'PUT');
  assert.deepEqual(bash(`curl https://x.io/j --json '{"to":"a","body":"b"}'`)[0].bodyKeys, ['to', 'body']);
  assert.equal(bash('curl -o out.json -H "Authorization: Bearer abc" https://example.com/a')[0].host, 'example.com');
});

test('graphql: query is a read, mutation is a write', () => {
  assert.equal(bash(`curl https://api.example.com/graphql -d '{"query":"{ viewer { id } }"}'`)[0].write, false);
  assert.equal(bash(`curl https://api.example.com/graphql -d '{"query":"mutation { issueCreate }"}'`)[0].write, true);
});

test('wrappers, sh -c, inline scripts and heredocs', () => {
  assert.equal(bash(`sudo -E env A=1 timeout 10 curl -X POST https://a.example.com/x`)[0].host, 'a.example.com');
  assert.equal(bash(`bash -lc "curl -XPUT https://b.example.com/y"`)[0].method, 'PUT');
  const py = bash(`python3 -c 'import requests; requests.post("https://c.example.com/hook", json={})'`)[0];
  assert.equal(py.kind, 'script-http');
  assert.equal(py.host, 'c.example.com');
  const hd = bash(`node <<'EOF'\nawait fetch("https://d.example.com/api", { method: "POST", body: "x" });\nEOF`)[0];
  assert.equal(hd.host, 'd.example.com');
});

test('git, gh, publish, scp, ssh, mail', () => {
  const [p] = bash('git -C repo push --force-with-lease origin main');
  assert.equal(p.kind, 'git-push');
  assert.match(p.detail, /force/);
  assert.equal(bash('git push https://github.com/o/r.git HEAD')[0].host, 'github.com');
  assert.equal(bash('git status').length, 0);
  assert.equal(bash('gh pr create --title t --body b')[0].kind, 'repo-write');
  assert.equal(bash('gh pr list').length, 0);
  assert.equal(bash('gh api repos/o/r/issues').length, 0);
  assert.equal(bash('gh api repos/o/r/issues -f title=x')[0].method, 'POST');
  assert.equal(bash('npm publish --access public')[0].host, 'registry.npmjs.org');
  assert.equal(bash('docker push ghcr.io/o/img:1')[0].host, 'ghcr.io');
  assert.equal(bash('scp a.txt deploy@10.0.0.5:/srv/')[0].kind, 'file-transfer');
  assert.equal(bash('scp deploy@10.0.0.5:/srv/a.txt .').length, 0, 'downloads are not writes');
  const [m] = bash('mail -s hi someone@city.example.gov < body.txt');
  assert.equal(m.host, 'city.example.gov');
  assert.ok(!JSON.stringify(m).includes('someone'), 'recipient local part is not stored');
});

test('MCP: first verb decides read vs write; recipients become hosts', () => {
  const t = (tool, input = {}) => classify({ tool, input });
  assert.equal(t('mcp__linear__save_issue', { title: 'x' })[0].kind, 'mcp-write');
  assert.equal(t('mcp__github__get_release').length, 0);
  assert.equal(t('mcp__github__list_release_notes').length, 0);
  const [mail] = t('mcp__gmail__send_email', { to: ['tips@police.example.gov'], subject: 's', body: 'b' });
  assert.equal(mail.kind, 'message');
  assert.equal(mail.host, 'police.example.gov');
  const [issue] = t('mcp__linear__save_issue', { title: 'x', description: 'see https://www.irs.gov/forms and https://github.com/o/r' });
  assert.equal(issue.host, 'mcp:linear', 'links inside content are not destinations');
  assert.equal(t('mcp__linear__save_issue', { title: 'x', links: [{ url: 'https://github.com/o/r/pull/1' }] })[0].host, 'mcp:linear');
  assert.equal(t('mcp__hooks__send_webhook', { url: 'https://hooks.example.com/abc' })[0].host, 'hooks.example.com');
});

test('browser: navigation sets the page, submit-like clicks are writes', () => {
  const state = {};
  const t = (tool, input) => classify({ tool, input, state });
  assert.deepEqual(t('mcp__playwright__browser_navigate', { url: 'https://forms.example.gov/report' }), []);
  assert.equal(state.url, 'https://forms.example.gov/report');
  const [typed] = t('mcp__playwright__browser_type', { element: 'Description', ref: 'e3', text: 'hello' });
  assert.equal(typed.kind, 'browser-input');
  assert.equal(typed.write, false);
  const [click] = t('mcp__playwright__browser_click', { element: 'Submit report button', ref: 'e9' });
  assert.equal(click.kind, 'submit');
  assert.equal(click.host, 'forms.example.gov');
  const [enter] = t('mcp__playwright__browser_press_key', { key: 'Enter' });
  assert.equal(enter.kind, 'submit');
  const batch = t('mcp__Claude_Browser__browser_batch', { actions: [
    { name: 'navigate', input: { url: 'https://shop.example.com/cart' } },
    { name: 'computer', input: { action: 'left_click', coordinate: [1, 2], action_summary: 'Place order for 3 items' } },
  ] });
  assert.equal(batch.length, 1);
  assert.equal(batch[0].host, 'shop.example.com');
  assert.equal(batch[0].kind, 'submit');
  const [js] = t('mcp__claude-in-chrome__javascript_tool', { action: 'javascript_exec', text: "document.querySelector('form').submit()" });
  assert.equal(js.kind, 'submit');
});

test('domain categories', () => {
  const cases = {
    'phillyunsolvedmurders.com': 'law-enforcement',
    'tips.fbi.gov': 'law-enforcement',
    'www.met.police.uk': 'law-enforcement',
    'www.irs.gov': 'government',
    'www.gov.uk': 'government',
    'www.service.gov.uk': 'government',
    'www.canada.ca': 'government',
    'ec.europa.eu': 'government',
    'www.vote.org': 'elections',
    'ecf.uscourts.gov': 'courts',
    'api.stripe.com': 'financial',
    'online.citibank.com': 'financial',
    'mychart.example-health.org': 'health',
    'localhost': 'internal',
    '192.168.1.20': 'internal',
    'devbox': 'internal',
    'github.com': 'external',
    'devote.com': 'external',
  };
  for (const [h, c] of Object.entries(cases)) assert.equal(categorize(h), c, h);
  assert.equal(categorize('forms.example.gov', { 'example.gov': 'external' }), 'external', 'overrides win');
});

test('hostOf and redaction', () => {
  assert.equal(hostOf('git@github.com:o/r.git'), 'github.com');
  assert.equal(hostOf('localhost:8080/x'), 'localhost');
  assert.equal(hostOf('HTTPS://Example.COM:443/a'), 'example.com');
  assert.equal(redactUrl('https://x.io/a?token=abc&q=1'), 'https://x.io/a?token=…&q=…');
  assert.equal(redactUrl('https://hooks.slack.com/services/T000/B000/abcdefghij1234567890XYZ'), 'https://hooks.slack.com/services/T000/B000/…');
});
