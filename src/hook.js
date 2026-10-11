// Claude Code hook mode: register `agent-trail hook` for PreToolUse and
// PostToolUse (+ PostToolUseFailure). Reads the hook JSON from stdin.
import { classify } from './classify.js';
import { findConfig, loadConfig, decide, isUnattended, worse } from './policy.js';
import { trailPath, append, loadState, saveState } from './trail.js';

export function handleHook(input, opts = {}) {
  const event = input.hook_event_name;
  const cwd = input.cwd || process.cwd();
  const cfg = opts.config || loadConfig(findConfig(opts.configPath, cwd));
  const file = trailPath(cfg);
  const session = input.session_id || 'default';
  const toolUseId = input.tool_use_id || null;

  if (event === 'PostToolUse' || event === 'PostToolUseFailure') {
    if (!toolUseId) return null;
    const ok = event === 'PostToolUse' && !looksFailed(input.tool_response);
    // only close actions we logged: the pending marker is written in PreToolUse
    const pending = loadState(file, session).pending || [];
    if (!pending.includes(toolUseId)) return null;
    append(file, [{ v: 1, type: 'result', ts: new Date().toISOString(), toolUseId, ok }]);
    const st = loadState(file, session);
    st.pending = (st.pending || []).filter((x) => x !== toolUseId);
    saveState(file, session, st);
    return null;
  }
  if (event !== 'PreToolUse') return null;

  const state = loadState(file, session);
  const before = state.url;
  const actions = classify({ tool: input.tool_name, input: input.tool_input || {}, cwd, state });
  const unattended = isUnattended(cfg, input.permission_mode);
  const ts = new Date().toISOString();
  let verdict = 'ignore';
  const reasons = [];
  const records = [];
  for (const a of actions) {
    const d = decide(cfg, a, { unattended });
    verdict = worse(verdict, d.decision);
    if (d.reason) reasons.push(d.reason);
    if (d.decision === 'ignore') continue;
    const { extraHosts, ...rest } = a;
    records.push({
      v: 1, type: 'action', ts, session, cwd, tool: input.tool_name, toolUseId, ...rest,
      ...(extraHosts?.length ? { extraHosts } : {}), category: d.category, decision: d.decision, unattended,
      ...(d.decision === 'ask' ? { status: 'asked' } : {}),
    });
  }
  append(file, records);
  if (records.length && toolUseId && verdict !== 'deny') state.pending = [...(state.pending || []), toolUseId].slice(-200);
  if (records.length || state.url !== before) saveState(file, session, state);

  if (verdict === 'deny') {
    return { hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: reasons.join('\n') } };
  }
  if (verdict === 'ask') {
    return { hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'ask', permissionDecisionReason: reasons.join('\n') } };
  }
  return null; // no opinion: normal permission rules apply
}

function looksFailed(resp) {
  if (!resp || typeof resp !== 'object') return false;
  if (resp.isError === true || resp.is_error === true) return true;
  if (typeof resp.exitCode === 'number' && resp.exitCode !== 0) return true;
  return resp.interrupted === true;
}

export const MATCHER = 'Bash|WebFetch|mcp__.*';

export const settingsSnippet = (cmd = 'agent-trail hook') => {
  const entry = [{ matcher: MATCHER, hooks: [{ type: 'command', command: cmd, timeout: 10 }] }];
  return { hooks: { PreToolUse: entry, PostToolUse: entry, PostToolUseFailure: entry } };
};
