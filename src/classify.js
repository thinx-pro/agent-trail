// Tool call -> list of outbound actions. Each action:
// { kind, write, method, url, host, detail, bodyKeys?, bodyBytes?, bodySha256?, recipients?, guess? }
// `write` = it sends data or changes something outside this machine.
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { splitCommands, stripPrefix, extractHeredocs } from './shell.js';
import { hostOf, redactUrl } from './domains.js';

const sha = (s) => crypto.createHash('sha256').update(String(s)).digest('hex').slice(0, 16);
const trunc = (s, n = 70) => {
  const t = String(s).replace(/\s+/g, ' ').trim();
  return t.length > n ? t.slice(0, n - 1) + '…' : t;
};

// ---------------------------------------------------------------- entry point

/**
 * @param {{tool: string, input: object, cwd?: string, state?: {url?: string}, resolveGit?: boolean}} call
 */
export function classify(call) {
  const { tool = '', input = {} } = call;
  const state = call.state || {};
  if (tool === 'Bash' || tool === 'bash') return fromShell(String(input.command || ''), call);
  if (tool === 'WebFetch') {
    const url = input.url || '';
    return [{ kind: 'http-read', write: false, method: 'GET', url: redactUrl(url), host: hostOf(url), detail: `WebFetch ${redactUrl(url)}` }];
  }
  if (tool.startsWith('mcp__')) return fromMcp(tool, input, state, call);
  return [];
}

// ---------------------------------------------------------------- shell

function fromShell(command, call) {
  const out = [];
  const { rest, bodies } = extractHeredocs(command);
  let ctx = call;
  for (const seg of splitCommands(rest)) {
    const w = stripPrefix(seg);
    if (!w.length) continue;
    if (w[0] === 'cd' && w[1] && !w[1].startsWith('-')) {
      // follow `cd dir && git push` so the push resolves the right remote
      const base = ctx.cwd || process.cwd();
      ctx = { ...ctx, cwd: w[1].startsWith('/') ? w[1] : w[1] === '~' || w[1].startsWith('~/') ? w[1].replace('~', process.env.HOME || '') : `${base}/${w[1]}` };
      continue;
    }
    out.push(...fromWords(w, ctx));
  }
  for (const b of bodies) out.push(...fromScript(b, 'heredoc'));
  return dedupe(out);
}

function fromWords(w, call) {
  const cmd = w[0].split('/').pop();
  if (['bash', 'sh', 'zsh', 'dash'].includes(cmd)) {
    const i = w.findIndex((x) => x === '-c' || x === '-lc' || x === '-ic');
    return i >= 0 && w[i + 1] ? fromShell(w[i + 1], call) : [];
  }
  if (/^(python[\d.]*|node|deno|bun|ruby|perl|php)$/.test(cmd)) {
    const i = w.findIndex((x) => x === '-c' || x === '-e' || x === '--eval' || x === '-r');
    return i >= 0 && w[i + 1] ? fromScript(w[i + 1], cmd) : [];
  }
  if (cmd === 'curl') return curl(w);
  if (cmd === 'wget') return wget(w);
  if (['http', 'https', 'xh', 'xhs'].includes(cmd)) return httpie(w);
  if (cmd === 'gh') return gh(w);
  if (cmd === 'git') return git(w, call);
  if (cmd === 'scp' || cmd === 'rsync' || cmd === 'sftp') return transfer(w, cmd);
  if (cmd === 'ssh') return ssh(w);
  if (['mail', 'mailx', 'sendmail', 'mutt', 'msmtp'].includes(cmd)) return mail(w, cmd);
  return publish(w, cmd);
}

const CURL_VALUE = new Set([
  '-H', '--header', '-o', '--output', '-u', '--user', '-A', '--user-agent', '-e', '--referer', '-b', '--cookie',
  '-c', '--cookie-jar', '-w', '--write-out', '-m', '--max-time', '--connect-timeout', '-x', '--proxy', '--retry',
  '-K', '--config', '-E', '--cert', '--key', '--cacert', '-r', '--range', '--resolve', '-U', '--proxy-user',
  '--retry-delay', '--retry-max-time', '-y', '--speed-time', '-Y', '--speed-limit', '--limit-rate', '--max-filesize',
  '--oauth2-bearer', '--aws-sigv4', '--interface', '--dns-servers', '-D', '--dump-header', '--trace', '--trace-ascii',
  '--stderr', '-z', '--time-cond', '--max-redirs', '--unix-socket', '--connect-to', '-C', '--continue-at',
]);
const CURL_DATA = new Set(['-d', '--data', '--data-raw', '--data-binary', '--data-urlencode', '--data-ascii', '--json', '-F', '--form', '--form-string']);

function curl(w) {
  let method = null;
  let get = false;
  let head = false;
  let upload = false;
  const data = [];
  const urls = [];
  for (let i = 1; i < w.length; i++) {
    const a = w[i];
    if (a === '-X' || a === '--request') method = (w[++i] || '').toUpperCase();
    else if (/^-[a-zA-Z]*X$/.test(a) && a.length > 2) method = (w[++i] || '').toUpperCase();
    else if (/^-X[A-Z]+$/.test(a)) method = a.slice(2);
    else if (a.startsWith('--request=')) method = a.slice(10).toUpperCase();
    else if (CURL_DATA.has(a)) data.push({ flag: a, v: w[++i] || '' });
    else if (/^-d./.test(a)) data.push({ flag: '-d', v: a.slice(2) });
    else if (a === '-T' || a === '--upload-file') { upload = true; i++; }
    else if (a === '-G' || a === '--get') get = true;
    else if (a === '-I' || a === '--head') head = true;
    else if (a === '--url') urls.push(w[++i] || '');
    else if (CURL_VALUE.has(a)) i++;
    else if (a.startsWith('-')) { /* boolean flag(s) */ }
    else urls.push(a);
  }
  if (!method) method = upload ? 'PUT' : data.length && !get ? 'POST' : head ? 'HEAD' : 'GET';
  // a GraphQL query sent as POST is a read; a mutation is a write
  const gqlRead = method === 'POST' && urls.some((u) => /\/graphql\/?(\?|$)/.test(u)) && data.length && !data.some((d) => /mutation/.test(d.v));
  const write = !['GET', 'HEAD', 'OPTIONS'].includes(method) && !gqlRead;
  return urls.filter(looksLikeUrl).map((u) => ({
    kind: write ? 'http-write' : 'http-read',
    write,
    method,
    url: redactUrl(u),
    host: hostOf(u),
    detail: `curl ${method} ${redactUrl(u)}`,
    ...bodyInfo(data),
  }));
}

function bodyInfo(data) {
  if (!data.length) return {};
  const keys = new Set();
  let raw = '';
  for (const { flag, v } of data) {
    raw += v;
    if (flag === '-F' || flag === '--form' || flag === '--form-string') {
      const k = v.split('=')[0];
      if (k) keys.add(k);
      continue;
    }
    const t = v.trim();
    if (t.startsWith('{')) {
      try {
        Object.keys(JSON.parse(t)).forEach((k) => keys.add(k));
        continue;
      } catch { /* not JSON */ }
      for (const m of t.matchAll(/"([\w.-]{1,40})"\s*:/g)) keys.add(m[1]);
      continue;
    }
    if (t.startsWith('@')) { keys.add('(file)'); continue; }
    for (const part of t.split('&')) {
      const k = part.split('=')[0];
      if (k && k.length <= 40 && /^[\w.\-[\]]+$/.test(k)) keys.add(k);
    }
  }
  return { bodyKeys: [...keys].slice(0, 12), bodyBytes: Buffer.byteLength(raw), bodySha256: sha(raw) };
}

function looksLikeUrl(u) {
  if (!u) return false;
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(u)) return /^https?:/i.test(u);
  return /^[\w-]+(\.[\w-]+)+(:\d+)?(\/|$)/.test(u) || /^localhost(:\d+)?(\/|$)/.test(u);
}

function wget(w) {
  let method = 'GET';
  const data = [];
  const urls = [];
  const VALUE = new Set(['-O', '-o', '-a', '-P', '-U', '-t', '-T', '-w', '-e', '-i', '-B', '--header', '--user', '--password', '--output-document', '--user-agent', '--tries', '--timeout']);
  for (let i = 1; i < w.length; i++) {
    const a = w[i];
    if (a.startsWith('--method=')) method = a.slice(9).toUpperCase();
    else if (a === '--method') method = (w[++i] || '').toUpperCase();
    else if (/^--(post|body)-(data|file)=/.test(a)) { data.push({ flag: '-d', v: a.split('=').slice(1).join('=') }); if (method === 'GET') method = 'POST'; }
    else if (/^--(post|body)-(data|file)$/.test(a)) { data.push({ flag: '-d', v: w[++i] || '' }); if (method === 'GET') method = 'POST'; }
    else if (VALUE.has(a)) i++;
    else if (a.startsWith('-')) { /* flag */ }
    else urls.push(a);
  }
  const write = !['GET', 'HEAD'].includes(method);
  return urls.filter(looksLikeUrl).map((u) => ({
    kind: write ? 'http-write' : 'http-read', write, method, url: redactUrl(u), host: hostOf(u), detail: `wget ${method} ${redactUrl(u)}`, ...bodyInfo(data),
  }));
}

function httpie(w) {
  const args = w.slice(1).filter((a) => !a.startsWith('-'));
  let method = null;
  if (args[0] && /^[A-Z]+$/.test(args[0])) method = args.shift();
  const url = args.shift();
  if (!url) return [];
  const items = args.filter((a) => /^[^=:@]+(:=|=|@)/.test(a) && !/^[^=]+==/.test(a));
  if (!method) method = items.length ? 'POST' : 'GET';
  const write = !['GET', 'HEAD'].includes(method);
  const keys = items.map((a) => a.split(/:=|=|@/)[0]);
  const full = /^(https?:)?\/\//.test(url) ? url : url.startsWith(':') ? 'localhost' + url : url;
  return [{
    kind: write ? 'http-write' : 'http-read', write, method, url: redactUrl(full), host: hostOf(full),
    detail: `${w[0]} ${method} ${redactUrl(full)}`, ...(keys.length ? { bodyKeys: keys, bodySha256: sha(items.join(' ')) } : {}),
  }];
}

const GH_WRITES = {
  issue: ['create', 'comment', 'close', 'reopen', 'edit', 'delete', 'lock', 'unlock', 'transfer', 'pin', 'unpin', 'develop'],
  pr: ['create', 'comment', 'close', 'reopen', 'edit', 'merge', 'review', 'ready', 'lock', 'unlock'],
  release: ['create', 'upload', 'delete', 'edit', 'delete-asset'],
  repo: ['create', 'delete', 'fork', 'edit', 'archive', 'unarchive', 'rename', 'sync', 'deploy-key'],
  gist: ['create', 'edit', 'delete', 'rename'],
  label: ['create', 'edit', 'delete', 'clone'],
  secret: ['set', 'delete'],
  variable: ['set', 'delete'],
  workflow: ['run', 'enable', 'disable'],
  run: ['cancel', 'rerun', 'delete'],
  discussion: ['create', 'comment'],
};

function gh(w) {
  const rest = w.slice(1).filter((a, i, arr) => !(a === '-R' || a === '--repo' || arr[i - 1] === '-R' || arr[i - 1] === '--repo'));
  const repoIdx = w.findIndex((a) => a === '-R' || a === '--repo');
  const repo = repoIdx > 0 ? w[repoIdx + 1] : '';
  const [sub, act] = rest;
  const hostIdx = w.indexOf('--hostname');
  const host = hostIdx > 0 ? w[hostIdx + 1] : 'github.com';
  if (sub === 'api') {
    let method = null;
    let fields = false;
    let path = '';
    for (let i = 2; i < w.length; i++) {
      const a = w[i];
      if (a === '-X' || a === '--method') method = (w[++i] || '').toUpperCase();
      else if (a.startsWith('--method=')) method = a.slice(9).toUpperCase();
      else if (['-f', '-F', '--field', '--raw-field', '--input'].includes(a)) { fields = true; i++; }
      else if (['-H', '--header', '-q', '--jq', '-t', '--template', '--hostname', '--cache', '-p', '--preview'].includes(a)) i++;
      else if (!a.startsWith('-') && !path) path = a;
    }
    if (!method) method = fields ? 'POST' : 'GET';
    if (method === 'GET') return [];
    if (/^graphql$/.test(path) && !w.some((a) => /mutation/.test(a))) return [];
    return [{ kind: 'repo-write', write: true, method, url: `https://api.${host}/${path.replace(/^\//, '')}`, host, detail: `gh api ${method} ${trunc(path, 50)}` }];
  }
  if (GH_WRITES[sub] && GH_WRITES[sub].includes(act)) {
    return [{ kind: 'repo-write', write: true, method: 'POST', url: repo ? `https://${host}/${repo}` : `https://${host}/`, host, detail: `gh ${sub} ${act}${repo ? ' -R ' + repo : ''}` }];
  }
  return [];
}

function git(w, call) {
  let i = 1;
  let dir = call.cwd;
  while (i < w.length && w[i].startsWith('-')) {
    if (w[i] === '-C') dir = w[i + 1];
    if (w[i] === '-C' || w[i] === '-c') i++;
    i++;
  }
  if (w[i] !== 'push') return [];
  const args = w.slice(i + 1).filter((a) => !a.startsWith('-'));
  const remote = args[0] || 'origin';
  let url = /[:/]/.test(remote) ? remote : '';
  if (!url && call.resolveGit !== false && dir) {
    try {
      url = execFileSync('git', ['-C', dir, 'remote', 'get-url', remote], { encoding: 'utf8', timeout: 1500, stdio: ['ignore', 'pipe', 'ignore'] }).trim();
    } catch { /* unknown remote */ }
  }
  const host = url ? hostOf(url) : '';
  const force = w.some((a) => a === '-f' || a === '--force' || a.startsWith('--force-with-lease'));
  return [{
    kind: 'git-push', write: true, method: 'PUSH', url: url ? redactUrl(url.replace(/^[^@/]+@([^:]+):/, 'https://$1/')) : remote,
    host: host || `git:${remote}`, detail: `git push ${remote}${args[1] ? ' ' + args[1] : ''}${force ? ' (force)' : ''}`,
  }];
}

function transfer(w, cmd) {
  const args = w.slice(1).filter((a) => !a.startsWith('-'));
  const dest = args[args.length - 1] || '';
  const m = dest.match(/^(?:[^@/\s]+@)?([A-Za-z0-9.-]+):/);
  if (!m || args.length < 2) return [];
  return [{ kind: 'file-transfer', write: true, method: 'UPLOAD', url: m[1], host: m[1].toLowerCase(), detail: `${cmd} → ${m[1]}` }];
}

function ssh(w) {
  const VALUE = new Set(['-p', '-i', '-l', '-o', '-F', '-J', '-L', '-R', '-D', '-W', '-b', '-c', '-E', '-m', '-O', '-Q', '-S', '-w', '-B', '-e', '-I']);
  for (let i = 1; i < w.length; i++) {
    if (VALUE.has(w[i])) { i++; continue; }
    if (w[i].startsWith('-')) continue;
    const host = w[i].replace(/^[^@]+@/, '').toLowerCase();
    return [{ kind: 'remote-shell', write: true, method: 'SSH', url: host, host, detail: `ssh ${host}${w[i + 1] ? ' ' + trunc(w.slice(i + 1).join(' '), 40) : ''}` }];
  }
  return [];
}

function mail(w, cmd) {
  const rcpt = w.slice(1).filter((a) => /^[^@\s]+@[^@\s]+\.[a-z]{2,}$/i.test(a));
  if (!rcpt.length) return [];
  return rcpt.map((r) => {
    const host = r.split('@')[1].toLowerCase();
    return { kind: 'message', write: true, method: 'SEND', url: `mailto:…@${host}`, host, recipients: [host], detail: `${cmd} to …@${host}` };
  });
}

function publish(w, cmd) {
  const sub = w[1];
  const reg = (host, what) => [{ kind: 'publish', write: true, method: 'PUBLISH', url: `https://${host}/`, host, detail: what }];
  if (['npm', 'pnpm', 'bun'].includes(cmd) && sub === 'publish') return reg('registry.npmjs.org', `${cmd} publish`);
  if (cmd === 'yarn' && (sub === 'publish' || (sub === 'npm' && w[2] === 'publish'))) return reg('registry.npmjs.org', 'yarn publish');
  if (cmd === 'twine' && sub === 'upload') return reg('upload.pypi.org', 'twine upload');
  if ((cmd === 'uv' || cmd === 'poetry' || cmd === 'hatch' || cmd === 'flit') && sub === 'publish') return reg('upload.pypi.org', `${cmd} publish`);
  if (cmd === 'cargo' && sub === 'publish') return reg('crates.io', 'cargo publish');
  if (cmd === 'gem' && sub === 'push') return reg('rubygems.org', 'gem push');
  if ((cmd === 'docker' || cmd === 'podman') && sub === 'push') {
    const img = w.slice(2).find((a) => !a.startsWith('-')) || '';
    const first = img.split('/')[0];
    const host = img.includes('/') && /[.:]/.test(first) ? first : 'docker.io';
    return reg(host, `${cmd} push ${trunc(img, 40)}`);
  }
  return [];
}

// Inline scripts (python -c, node -e, heredocs): look for HTTP verbs and URLs.
const SCRIPT_WRITE = [
  /\b(?:requests|httpx|session|client|s)\.(post|put|patch|delete)\s*\(/gi,
  /\baxios\.(post|put|patch|delete)\s*\(/gi,
  /\bmethod\s*[:=]\s*['"](POST|PUT|PATCH|DELETE)['"]/gi,
  /\b(?:smtplib\.SMTP|nodemailer|sendmail)\b/gi,
];

function fromScript(src, via) {
  const out = [];
  for (const rx of SCRIPT_WRITE) {
    for (const m of src.matchAll(rx)) {
      const method = /smtp|nodemailer|sendmail/i.test(m[0]) ? 'SEND' : (m[1] || 'POST').toUpperCase();
      const after = src.slice(m.index);
      const um = after.match(/https?:\/\/[^\s'"`)<>]+/) || src.match(/https?:\/\/[^\s'"`)<>]+/);
      const url = um ? um[0] : '';
      out.push({
        kind: method === 'SEND' ? 'message' : 'script-http', write: true, method, url: redactUrl(url), host: url ? hostOf(url) : '(unknown host)',
        detail: `${via} script ${method}${url ? ' ' + redactUrl(url) : ' (host unknown)'}`, guess: true,
      });
    }
  }
  return out;
}

// ---------------------------------------------------------------- MCP

const WRITE_VERBS = new Set([
  'send', 'post', 'create', 'submit', 'publish', 'reply', 'comment', 'upload', 'delete', 'remove', 'update', 'edit',
  'write', 'insert', 'add', 'save', 'set', 'transfer', 'pay', 'charge', 'refund', 'order', 'book', 'invite', 'share',
  'merge', 'push', 'move', 'archive', 'approve', 'schedule', 'tweet', 'message', 'notify', 'forward', 'assign',
  'close', 'resolve', 'react', 'like', 'follow', 'subscribe', 'unsubscribe', 'cancel', 'purchase', 'buy', 'sign',
  'draft', 'put', 'patch', 'upsert', 'append', 'trigger', 'deploy', 'release', 'duplicate', 'restore',
]);
const READ_VERBS = new Set([
  'get', 'list', 'search', 'read', 'fetch', 'query', 'find', 'describe', 'view', 'show', 'download', 'export', 'check',
  'lookup', 'count', 'preview', 'status', 'inspect', 'watch', 'wait', 'retrieve', 'browse', 'load', 'resolve_library',
]);
const MESSAGE_HINT = /(mail|gmail|outlook|slack|discord|telegram|whatsapp|sms|twilio|twitter|tweet|linkedin|teams|messag|chat)/i;
const SUBMIT_TEXT = /\b(submit|send|post|publish|confirm|pay|purchase|buy|place order|order now|checkout|check out|sign up|register|apply|report|file a|donate|transfer|book|reserve|delete|tip|vote|enroll)\b/i;

function words(name) {
  return name
    .replace(/([a-z])([A-Z])/g, '$1_$2')
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean);
}

function fromMcp(tool, input, state, call) {
  const parts = tool.split('__');
  const server = parts[1] || '';
  const name = parts.slice(2).join('__');
  const ws = words(name);

  // batched browser actions: [{name, input}]
  if (Array.isArray(input.actions) && /batch/.test(name)) {
    const out = [];
    for (const a of input.actions) {
      if (a && a.name) out.push(...fromMcp(`mcp__${server}__${a.name}`, a.input || {}, state, call));
    }
    return out;
  }

  const browserish = ws.some((x) => ['browser', 'navigate', 'goto', 'click', 'computer', 'puppeteer', 'playwright', 'page', 'tab', 'form'].includes(x)) || /browser|chrome|playwright|puppeteer/i.test(server);

  // navigation: remember where the browser is
  if (browserish && typeof input.url === 'string' && !ws.some((x) => ['click', 'type', 'fill', 'fetch'].includes(x))) {
    if (/^(back|forward)$/.test(input.url)) return [];
    state.url = input.url;
    return [];
  }

  if (browserish) {
    const here = state.url || '';
    const host = hostOf(here);
    const base = { url: redactUrl(here), host: host || '(unknown page)', method: 'BROWSER' };
    const label = input.element || input.action_summary || input.description || input.ref || '';
    const act = input.action || '';
    const isClick = ws.some((x) => ['click', 'tap'].includes(x)) || /click/.test(act);
    const isType = ws.some((x) => ['type', 'fill', 'input', 'select', 'upload'].includes(x)) || act === 'type' || ws.join('_').includes('form_input');
    const isKey = ws.includes('key') || ws.includes('press') || act === 'key';
    const isJs = ws.some((x) => ['evaluate', 'javascript', 'eval', 'script', 'js'].includes(x));
    if (isJs) {
      const code = String(input.text || input.function || input.code || input.script || '');
      if (/\.submit\s*\(|requestSubmit\s*\(|method\s*:\s*['"](POST|PUT|PATCH|DELETE)/i.test(code)) {
        return [{ ...base, kind: 'submit', write: true, detail: `page script submits (${trunc(code, 40)})` }];
      }
      return [];
    }
    if (isKey) {
      const key = String(input.key || input.text || '');
      if (/(^|\s|\+)(Enter|Return|KP_Enter)($|\s)/i.test(key)) return [{ ...base, kind: 'submit', write: true, detail: `press ${trunc(key, 20)}${label ? ' on ' + trunc(label, 40) : ''}`, guess: true }];
      return [];
    }
    if (isClick) {
      if (SUBMIT_TEXT.test(String(label))) return [{ ...base, kind: 'submit', write: true, detail: `click "${trunc(label, 50)}"` }];
      return [{ ...base, kind: 'browser-click', write: false, detail: label ? `click "${trunc(label, 50)}"` : 'click (no label)', guess: !label }];
    }
    if (isType) {
      const submitFlag = input.submit === true;
      const fields = Array.isArray(input.fields) ? input.fields.map((f) => f.name || f.ref).filter(Boolean) : [];
      return [{
        ...base, kind: submitFlag ? 'submit' : 'browser-input', write: submitFlag,
        detail: fields.length
          ? `fill ${fields.length} field${fields.length === 1 ? '' : 's'} (${trunc(fields.join(', '), 40)})`
          : `${submitFlag ? 'type + submit' : 'type'}${label ? ' into ' + trunc(label, 40) : ''}`,
        ...(fields.length ? { bodyKeys: fields.slice(0, 12) } : {}),
      }];
    }
    return [];
  }

  // the first verb decides: get_release is a read, create_release is a write
  const verb = ws.find((x) => WRITE_VERBS.has(x) || READ_VERBS.has(x));
  if (!verb || READ_VERBS.has(verb)) return [];
  // hosts and recipients mentioned in the args
  const urls = [];
  const rcpt = [];
  walk(input, (k, v) => {
    if (typeof v !== 'string') return;
    // only top-level destination-like fields: a link inside an issue body or an
    // attachment list (links: [{url}]) is not where the call goes
    if (input[k] === v && /^(url|uri|endpoint|webhook|webhook_?url|target|target_?url|href|site|domain|host|base_?url)$/i.test(k)) {
      for (const m of v.matchAll(/https?:\/\/[^\s'"<>)]+/g)) urls.push(m[0]);
      if (!/^https?:/i.test(v) && /^[\w-]+(\.[\w-]+)+$/.test(v)) urls.push('https://' + v);
    }
    if (/^(to|cc|bcc|recipients?|email|emails|attendees?|invitees?)$/i.test(k)) {
      for (const m of v.matchAll(/[^@\s,;<>"]+@([A-Za-z0-9.-]+\.[a-z]{2,})/gi)) rcpt.push(m[1].toLowerCase());
    }
  });
  const isMsg = MESSAGE_HINT.test(server + ' ' + name) && ws.some((x) => ['send', 'reply', 'forward', 'post', 'message', 'tweet', 'draft'].includes(x));
  const target = rcpt[0] || (urls[0] ? hostOf(urls[0]) : '');
  return [{
    kind: isMsg || rcpt.length ? 'message' : 'mcp-write', write: true, method: 'MCP',
    url: urls[0] ? redactUrl(urls[0]) : '', host: target || `mcp:${server}`, ...(rcpt.length ? { recipients: [...new Set(rcpt)] } : {}),
    extraHosts: [...new Set([...rcpt, ...urls.map(hostOf)])].filter((h) => h && h !== target).slice(0, 5),
    detail: `${server.replace(/^claude_ai_/, '')} ${name}`,
  }];
}

function walk(o, fn, depth = 0) {
  if (depth > 4 || o == null) return;
  if (Array.isArray(o)) { o.forEach((v) => (typeof v === 'object' ? walk(v, fn, depth + 1) : fn('', v))); return; }
  if (typeof o === 'object') {
    for (const [k, v] of Object.entries(o)) {
      if (Array.isArray(v) && v.every((x) => typeof x === 'string')) v.forEach((x) => fn(k, x));
      else if (typeof v === 'object') walk(v, fn, depth + 1);
      else fn(k, v);
    }
  }
}

function dedupe(actions) {
  const seen = new Set();
  return actions.filter((a) => {
    const k = `${a.kind}|${a.method}|${a.url}|${a.detail}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}
