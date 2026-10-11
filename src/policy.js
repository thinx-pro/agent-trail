// Config discovery and the allow / log / ask / deny decision.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { categorize, SENSITIVE } from './domains.js';

export const DEFAULTS = {
  rules: {
    'law-enforcement': 'ask',
    elections: 'ask',
    courts: 'ask',
    government: 'ask',
    financial: 'ask',
    health: 'ask',
    external: 'log',
    internal: 'ignore',
  },
  hosts: {}, // per-host decision override, e.g. {"api.stripe.com": "log"}
  categories: {}, // host -> category override, e.g. {"mycorp.com": "internal"}
  unattended: 'auto', // auto | true | false
  logReads: false,
  trailDir: '',
};

const LEVEL = { ignore: 0, log: 1, ask: 2, deny: 3 };
export const DECISIONS = Object.keys(LEVEL);

export function homeDir() {
  return process.env.AGENT_TRAIL_HOME || path.join(os.homedir(), '.agent-trail');
}

export function findConfig(explicit, cwd) {
  if (explicit) return path.resolve(explicit);
  if (process.env.AGENT_TRAIL_CONFIG) return path.resolve(process.env.AGENT_TRAIL_CONFIG);
  let dir = path.resolve(cwd || process.cwd());
  for (let i = 0; i < 40; i++) {
    const f = path.join(dir, '.agent-trail.json');
    if (fs.existsSync(f)) return f;
    const up = path.dirname(dir);
    if (up === dir) break;
    dir = up;
  }
  const g = path.join(homeDir(), 'config.json');
  return fs.existsSync(g) ? g : null;
}

export function loadConfig(file) {
  const cfg = structuredClone(DEFAULTS);
  if (!file) return cfg;
  let raw;
  try {
    raw = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (e) {
    throw new Error(`cannot read ${file}: ${e.message}`);
  }
  return mergeConfig(cfg, raw, file);
}

export function mergeConfig(cfg, raw, label = 'config') {
  const errs = [];
  for (const [k, v] of Object.entries(raw.rules || {})) {
    if (!(v in LEVEL)) errs.push(`rules.${k}: "${v}" is not one of ${DECISIONS.join('/')}`);
    else cfg.rules[k] = v;
  }
  for (const [k, v] of Object.entries(raw.hosts || {})) {
    if (!(v in LEVEL)) errs.push(`hosts.${k}: "${v}" is not one of ${DECISIONS.join('/')}`);
    else cfg.hosts[k.toLowerCase()] = v;
  }
  for (const [k, v] of Object.entries(raw.categories || {})) cfg.categories[k.toLowerCase()] = v;
  if ('unattended' in raw) {
    if (![true, false, 'auto'].includes(raw.unattended)) errs.push('unattended: must be true, false or "auto"');
    else cfg.unattended = raw.unattended;
  }
  if ('logReads' in raw) cfg.logReads = !!raw.logReads;
  if (raw.trailDir) cfg.trailDir = raw.trailDir;
  if (errs.length) throw new Error(`${label}:\n  - ${errs.join('\n  - ')}`);
  return cfg;
}

export function isUnattended(cfg, permissionMode) {
  if (cfg.unattended === true || cfg.unattended === false) return cfg.unattended;
  return ['bypassPermissions', 'dontAsk'].includes(permissionMode || '');
}

function hostRule(cfg, host) {
  const keys = Object.keys(cfg.hosts).sort((a, b) => b.length - a.length);
  for (const k of keys) {
    const p = k.replace(/^\*\./, '');
    if (host === p || host.endsWith('.' + p)) return cfg.hosts[k];
  }
  return null;
}

/**
 * Decide one action. Returns {category, decision, reason}.
 * decision: ignore | log | ask | deny (after the unattended downgrade).
 */
export function decide(cfg, action, { unattended = false } = {}) {
  const hosts = [action.host, ...(action.extraHosts || [])].filter(Boolean);
  let category = 'external';
  let worst = -1;
  for (const h of hosts) {
    const c = h.startsWith('mcp:') || h.startsWith('git:') || h.startsWith('(') ? 'external' : categorize(h, cfg.categories);
    const rank = c === 'internal' ? 0 : SENSITIVE.has(c) ? 2 : 1;
    if (rank > worst) { worst = rank; category = c; }
  }
  if (!action.write) {
    // reads and plain clicks/typing are never gated; logged on request (or on sensitive pages)
    const show = action.kind === 'http-read' ? cfg.logReads : SENSITIVE.has(category);
    return { category, decision: category === 'internal' || !show ? 'ignore' : 'log', reason: '' };
  }
  let decision = cfg.rules[category] || 'log';
  for (const h of hosts) {
    const r = hostRule(cfg, h);
    if (r) decision = r; // explicit host rule beats category
  }
  let reason = '';
  if (decision === 'ask' || decision === 'deny') {
    reason = `agent-trail: ${action.detail} → ${action.host} is ${article(category)} ${category} site.`;
    if (decision === 'ask' && unattended) {
      decision = 'deny';
      reason += ' Nobody is watching this session, so it was blocked instead of asked and queued for review (`agent-trail review`). If it is expected, add the host to "hosts" in .agent-trail.json.';
    } else if (decision === 'ask') {
      reason += ' Confirm only if you meant the agent to submit there.';
    } else {
      reason += ' Blocked by policy; tell the user what you were about to send instead of retrying another way.';
    }
  }
  return { category, decision, reason };
}

function article(w) {
  return /^[aeiou]/.test(w) ? 'an' : 'a';
}

export function worse(a, b) {
  return LEVEL[a] >= LEVEL[b] ? a : b;
}
