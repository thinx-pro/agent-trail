// Host -> sensitivity category. Rules are deliberately simple and listed in
// the README so you can see exactly why a host was flagged.

export const CATEGORIES = [
  'law-enforcement', 'elections', 'courts', 'government', 'financial', 'health', 'external', 'internal',
];

export const SENSITIVE = new Set(['law-enforcement', 'elections', 'courts', 'government', 'financial', 'health']);

const GOV_SUFFIX = [
  /\.gov$/, /\.mil$/, /\.gov\.[a-z]{2}$/, /\.gob\.[a-z]{2}$/, /\.go\.[a-z]{2}$/, /\.gouv\.[a-z]{2}$/,
  /\.gouv\.qc\.ca$/, /\.gc\.ca$/, /(^|\.)canada\.ca$/, /\.europa\.eu$/, /\.bund\.de$/, /\.admin\.ch$/,
  /\.govt\.nz$/, /\.gv\.at$/, /\.mil\.[a-z]{2}$/, /\.parliament\.uk$/, /\.nic\.in$/, /\.gub\.uy$/,
];

const LAW = /(^|[.-])(police|polizei|policia|politie|gendarmerie|sheriff|sheriffs|crimestoppers?|unsolved|fbi|ic3|interpol|europol|tips?line|copwatch)([.-]|$)|police|sheriff|crimestopper|unsolved/;
const ELECTION = /(^|[.-])(vote|votes|voter|voters|voting|election|elections|ballot|ballots)([.-]|$)/;
const COURTS = /(^|[.-])(court|courts|judiciary|uscourts|pacer|tribunal)([.-]|$)/;

const FINANCIAL_DOMAINS = [
  'paypal.com', 'stripe.com', 'wise.com', 'venmo.com', 'cash.app', 'squareup.com', 'coinbase.com', 'binance.com',
  'kraken.com', 'robinhood.com', 'schwab.com', 'fidelity.com', 'vanguard.com', 'chase.com', 'bankofamerica.com',
  'wellsfargo.com', 'citi.com', 'capitalone.com', 'americanexpress.com', 'hsbc.com', 'barclays.co.uk',
  'revolut.com', 'monzo.com', 'n26.com', 'alipay.com', 'pay.weixin.qq.com', 'klarna.com', 'adyen.com',
  'plaid.com', 'brex.com', 'mercury.com', 'ramp.com', 'payoneer.com', 'zelle.com',
];
const FINANCIAL_KW = /(^|[.-])[a-z]*bank[a-z]*([.-]|$)|(^|[.-])(pay|payments|billing|checkout|wallet)\./;

const HEALTH = /(^|\.)nhs\.uk$|(^|[.-])(mychart|patient|patients|patientportal|telehealth|pharmacy)([.-]|$)/;

const PRIVATE_V4 = /^(127\.|10\.|192\.168\.|169\.254\.|0\.0\.0\.0$|172\.(1[6-9]|2\d|3[01])\.)/;

export function normalizeHost(h) {
  if (!h) return '';
  let s = String(h).trim().toLowerCase();
  s = s.replace(/^\[|\]$/g, '');
  s = s.replace(/:\d+$/, '');
  return s.replace(/\.$/, '');
}

function suffixMatch(host, pattern) {
  const p = pattern.toLowerCase().replace(/^\*\./, '').replace(/^\./, '');
  return host === p || host.endsWith('.' + p);
}

export function categorize(rawHost, overrides = {}) {
  const host = normalizeHost(rawHost);
  if (!host) return 'external';
  // user overrides win; longest pattern first
  const keys = Object.keys(overrides).sort((a, b) => b.length - a.length);
  for (const k of keys) if (suffixMatch(host, k)) return overrides[k];

  if (host === 'localhost' || host.endsWith('.localhost') || host === '::1' || PRIVATE_V4.test(host)) return 'internal';
  if (/\.(local|test|internal|lan|home\.arpa)$/.test(host) || (!host.includes('.') && !host.includes(':'))) return 'internal';

  const labels = host.replace(/\.(gov|mil)(\.[a-z]{2})?$/, '');
  if (/\.police\.uk$/.test(host) || LAW.test(labels)) return 'law-enforcement';
  if (ELECTION.test(host)) return 'elections';
  if (COURTS.test(host)) return 'courts';
  if (GOV_SUFFIX.some((r) => r.test(host)) || host === 'usa.gov') return 'government';
  if (FINANCIAL_DOMAINS.some((d) => suffixMatch(host, d)) || FINANCIAL_KW.test(host)) return 'financial';
  if (HEALTH.test(host)) return 'health';
  return 'external';
}

export function hostOf(url) {
  if (!url) return '';
  let s = String(url).trim();
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(s)) {
    // scp-style remote: git@github.com:owner/repo, user@host:path (but not host:8080/path)
    const scp = s.match(/^(?:[^@/\s]+@)?([A-Za-z0-9.-]+):(?!\d+(?:\/|$))/);
    if (scp) return normalizeHost(scp[1]);
    s = 'http://' + s;
  }
  try {
    return normalizeHost(new URL(s).hostname);
  } catch {
    return '';
  }
}

// Keep origin + path, blank out query values and secret-looking path segments.
export function redactUrl(url) {
  if (!url) return '';
  let s = String(url).trim();
  const hadScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(s);
  if (!hadScheme) s = 'http://' + s;
  let u;
  try {
    u = new URL(s);
  } catch {
    return String(url).slice(0, 120);
  }
  const path = u.pathname
    .split('/')
    .map((seg) => (looksSecret(seg) ? '…' : seg))
    .join('/');
  const keys = [...u.searchParams.keys()];
  const q = keys.length ? '?' + [...new Set(keys)].map((k) => `${k}=…`).join('&') : '';
  const out = `${u.protocol}//${u.host}${path}${q}`;
  return hadScheme ? out : out.replace(/^http:\/\//, '');
}

function looksSecret(seg) {
  if (seg.length < 20) return false;
  return /^[A-Za-z0-9_\-.~%]+$/.test(seg) && /\d/.test(seg) && /[A-Za-z]/.test(seg);
}
