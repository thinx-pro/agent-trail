// A small, forgiving shell reader: enough to find the outbound commands in
// what an agent runs through Bash. It is not a full POSIX parser.

const HEREDOC = /<<-?[ \t]*(['"]?)([A-Za-z_][\w-]*)\1([^\n]*)\n([\s\S]*?)\n[ \t]*\2[ \t]*(?=\n|$)/g;

// Pull heredoc bodies out (they are script text, not commands).
export function extractHeredocs(src) {
  const bodies = [];
  const rest = src.replace(HEREDOC, (_, _q, _d, tail, body) => {
    bodies.push(body);
    return tail;
  });
  return { rest, bodies };
}

// Split into simple commands (arrays of words), honouring quotes and escapes.
export function splitCommands(src) {
  const segs = [];
  let cur = [];
  let word = '';
  let inWord = false;
  const push = () => {
    if (inWord) cur.push(word);
    word = '';
    inWord = false;
  };
  const end = () => {
    push();
    if (cur.length) segs.push(cur);
    cur = [];
  };
  let i = 0;
  while (i < src.length) {
    const c = src[i];
    if (c === "'") {
      const j = src.indexOf("'", i + 1);
      const e = j < 0 ? src.length : j;
      word += src.slice(i + 1, e);
      inWord = true;
      i = e + 1;
      continue;
    }
    if (c === '"') {
      let j = i + 1;
      while (j < src.length && src[j] !== '"') {
        if (src[j] === '\\' && j + 1 < src.length && '"\\$`'.includes(src[j + 1])) {
          word += src[j + 1];
          j += 2;
          continue;
        }
        word += src[j];
        j++;
      }
      inWord = true;
      i = j + 1;
      continue;
    }
    if (c === '\\' && i + 1 < src.length) {
      if (src[i + 1] !== '\n') {
        word += src[i + 1];
        inWord = true;
      }
      i += 2;
      continue;
    }
    if (c === ' ' || c === '\t') {
      push();
      i++;
      continue;
    }
    // redirections: 2>&1, >file, >> log, &>/dev/null, < in — dropped with their target
    if (c === '>' || c === '<' || (c === '&' && src[i + 1] === '>')) {
      if (inWord && /^\d+$/.test(word)) { word = ''; inWord = false; }
      push();
      let j = i + 1;
      while (j < src.length && '<>&|'.includes(src[j])) j++;
      if (/[&]$/.test(src.slice(i, j)) && /[\d-]/.test(src[j] || '')) {
        while (j < src.length && /[\d-]/.test(src[j])) j++;
        i = j;
        continue;
      }
      while (j < src.length && (src[j] === ' ' || src[j] === '\t')) j++;
      if (src[j] === '"' || src[j] === "'") {
        const q = src[j];
        const k = src.indexOf(q, j + 1);
        j = k < 0 ? src.length : k + 1;
      } else {
        while (j < src.length && !' \t\n;|&()'.includes(src[j])) j++;
      }
      i = j;
      continue;
    }
    if (c === '\n' || c === ';' || c === '|' || c === '&' || c === '(' || c === ')' || c === '`') {
      end();
      i++;
      continue;
    }
    if (c === '$' && src[i + 1] === '(') {
      end();
      i += 2;
      continue;
    }
    if (c === '#' && !inWord) {
      const j = src.indexOf('\n', i);
      i = j < 0 ? src.length : j;
      continue;
    }
    word += c;
    inWord = true;
    i++;
  }
  end();
  return segs;
}

const WRAPPERS = new Set(['sudo', 'env', 'time', 'nohup', 'command', 'exec', 'nice', 'caffeinate', 'stdbuf']);

// Drop env assignments and wrapper commands (`sudo`, `env X=1`, `timeout 10`...).
export function stripPrefix(words) {
  let w = words.slice();
  for (let guard = 0; guard < 10 && w.length; guard++) {
    if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(w[0])) { w.shift(); continue; }
    const base = w[0].split('/').pop();
    if (WRAPPERS.has(base)) {
      w.shift();
      while (w.length && w[0].startsWith('-')) w.shift();
      continue;
    }
    if (base === 'timeout' || base === 'gtimeout') {
      w.shift();
      while (w.length && w[0].startsWith('-')) w.shift();
      w.shift(); // duration
      continue;
    }
    if (base === 'xargs') {
      w.shift();
      while (w.length && w[0].startsWith('-')) {
        const f = w.shift();
        if (/^-[IdEnLPs]$/.test(f)) w.shift();
      }
      continue;
    }
    break;
  }
  return w;
}
