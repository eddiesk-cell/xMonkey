// Permission gate.
//
// Every tool call passes through `decide()` before it runs. The gate is
// deliberately the only place that can say "no", so the rules are auditable in
// one file.
//
// Modes
//   plan           read-only tools only; mutating calls are refused and the model
//                  is told to present a plan instead
//   default        reads allowed, writes/shell asked
//   acceptEdits    file writes allowed without asking, shell still asked
//   dontAsk        never prompt: anything that would ask becomes a deny
//   bypass         everything allowed (dangerous; explicit opt-in only)
//   auto           allow read-only + safe-classified commands, ask the rest and
//                  let a deny rule still win (this is `default` plus the
//                  read-only shell classifier applied to every tool, which is
//                  the same thing the gate already does — kept as a distinct
//                  name so configs written for other harnesses load)
//
// Rules
//   { tool: "bash", action: "deny" }                        whole-tool rule
//   { tool: "bash", pattern: "^git status", action: "allow" } command/content rule
//   { tool: "read", path: "src/**", action: "allow" }        path rule
//   { tool: "bash", field: "command", pattern: "^rm ", action: "deny" }
//                                                           INPUT-PARAMETER rule
//   A deny always wins over an allow, and over the mode.

import { ToolError } from '../tools/registry.mjs';

export const MODES = ['plan', 'default', 'acceptEdits', 'dontAsk', 'bypass', 'auto'];

export const MODE_HELP = {
  plan: 'read-only: mutating tools are refused',
  default: 'reads allowed, writes and shell ask for approval',
  acceptEdits: 'file writes allowed, shell still asks',
  dontAsk: 'never prompt: anything that would ask is denied instead',
  bypass: 'everything allowed — no prompts (use only in a disposable sandbox)',
  auto: 'read-only and safe commands allowed, everything else asks',
};

/** Tools that never modify anything. Everything else is treated as mutating. */
export const READ_ONLY_TOOLS = new Set(['read', 'list', 'glob', 'grep']);

// Commands that only ever read. The patterns are matched against a whole
// segment (one side of a pipe), so each side must qualify on its own.
const SHELL_READONLY_PREFIXES = [
  /^git\s+(status|diff|log|show|branch(\s+(-a|-r|-v|--list))?|remote(\s+-v)?|rev-parse|blame|stash\s+list|ls-files|describe)\b/,
  /^(ls|cat|head|tail|wc|file|stat|pwd|whoami|date|which|type|echo|printf|sort|uniq|cut|tr|basename|dirname|realpath|du|df)\b/,
  /^(rg|grep|egrep|fgrep|fd|find|tree)\b/,
  /^(node|python3?|deno|bun|ruby|go|cargo|rustc|javac|java)\s+(--version|-v|-V)\b/,
  /^(npm|pnpm|yarn)\s+(ls|list|outdated|--version|version|view|info)\b/,
  /^(sed|awk)\s+-n\b/,
  /^(test|\[)\b/,
];

// Flags that turn an apparently-read-only command into a writer or a runner.
const MUTATING_FLAGS = [
  /(^|\s)--?(delete|exec|execdir|ok|okdir|in-place|output)\b/,
  /(^|\s)-i\b/,
  /(^|\s)-[a-zA-Z]*[dD]\b/,        // e.g. `git branch -D`, `git stash drop`
  /(^|\s)(-d|--delete)\b/,
];

/**
 * @typedef {Object} Decision
 * @property {'allow'|'ask'|'deny'} behavior
 * @property {string} [reason]
 * @property {string} [rule]   which rule produced this, for the audit log
 */

/**
 * Decide whether a tool call may proceed.
 *
 * @param {object} args
 * @param {string} args.tool
 * @param {object} args.input
 * @param {string} args.mode
 * @param {Array<{tool?:string,path?:string,pattern?:string,action:'allow'|'deny'}>} [args.rules]
 * @param {(tool: object, input: object) => boolean} [args.isReadOnly]
 * @returns {Decision}
 */
export function decide({ tool, input, mode = 'default', rules = [], isReadOnly }) {
  if (!MODES.includes(mode)) throw new ToolError(`unknown permission mode "${mode}"`);

  // 1. Explicit deny rules always win.
  for (const rule of rules) {
    if (rule.action !== 'deny') continue;
    if (matchesRule(rule, tool, input)) {
      return { behavior: 'deny', reason: `denied by rule for ${tool}`, rule: describeRule(rule) };
    }
  }

  const readOnly = isReadOnly ?? READ_ONLY_TOOLS.has(tool);

  // 2. Plan mode is a hard read-only wall regardless of allow rules.
  if (mode === 'plan' && !readOnly) {
    return {
      behavior: 'deny',
      reason: 'plan mode is active: this tool changes state. Present the plan for approval first.',
    };
  }

  // 3. Explicit allow rules.
  for (const rule of rules) {
    if (rule.action !== 'allow') continue;
    if (matchesRule(rule, tool, input)) {
      return { behavior: 'allow', rule: describeRule(rule) };
    }
  }

  // 4. Mode defaults.
  if (mode === 'bypass') return { behavior: 'allow', reason: 'bypass mode' };
  if (readOnly) return { behavior: 'allow', reason: 'read-only tool' };
  if (mode === 'plan') return { behavior: 'deny', reason: 'plan mode' };

  // A shell invocation that is provably read-only does not need a prompt.
  if (tool === 'bash' && isReadOnlyCommand(input.command ?? '')) {
    return { behavior: 'allow', reason: 'read-only shell command' };
  }

  if (mode === 'acceptEdits' && isFileEdit(tool)) {
    return { behavior: 'allow', reason: 'acceptEdits mode allows file edits' };
  }

  const ask = { behavior: 'ask', reason: describeAsk(tool, input) };

  // `dontAsk` is the headless-safe default: it never blocks waiting for a human,
  // and it never silently allows either — a would-be prompt becomes a denial the
  // model can read and adapt to.
  if (mode === 'dontAsk') {
    return { behavior: 'deny', reason: `${ask.reason} (dontAsk mode denies what it cannot ask)` };
  }

  return ask;
}

export function isFileEdit(tool) {
  return tool === 'write' || tool === 'edit';
}

export function isReadOnlyCommand(cmd) {
  const c = String(cmd || '').trim();
  if (!c) return false;

  // Any redirection, command substitution, subshell, or backgrounding can write
  // or execute something the allowlist below cannot see. Refuse to call it
  // read-only — the cost of a wrong "read-only" is an unprompted mutation.
  if (/[<>]|`|\$\(|\(|\)|\|&|&$/.test(c)) return false;

  // A chain is only read-only if EVERY segment is.
  const segments = c.split(/\s*(?:\|\||&&|\||;)\s*/).filter(Boolean);
  if (!segments.length) return false;

  return segments.every((seg) => {
    const s = seg.trim();
    if (!s) return false;
    if (MUTATING_FLAGS.some((re) => re.test(s))) return false;
    return SHELL_READONLY_PREFIXES.some((re) => re.test(s));
  });
}

function matchesRule(rule, tool, input) {
  if (!rule.tool) return false;
  if (rule.tool !== '*' && rule.tool !== tool) return false;

  // Input-parameter rule: {field, pattern} targets ONE named input field. This is
  // how a project says "Bash is fine, but never an `rm` command" without denying
  // the whole tool.
  if (rule.field) {
    const value = input?.[rule.field];
    if (value === undefined) return false;
    const subject = typeof value === 'string' ? value : JSON.stringify(value);
    try {
      return new RegExp(rule.pattern ?? '.*').test(subject);
    } catch {
      return false;
    }
  }

  if (rule.pattern) {
    // Command rules apply to bash; content rules to grep.
    const subject = tool === 'bash' ? input.command : tool === 'grep' ? input.pattern : undefined;
    if (subject === undefined) return false;
    try {
      if (!new RegExp(rule.pattern).test(String(subject))) return false;
    } catch {
      return false;
    }
  }
  if (rule.path) {
    const subject = input.path ?? input.cwd;
    if (typeof subject !== 'string') return false;
    if (!pathGlobMatch(rule.path, subject)) return false;
  }
  return true;
}

/** Small path glob: ** matches anything, * matches within a segment. */
export function pathGlobMatch(pattern, p) {
  const re = pattern
    .split('**').map((part) => part.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '[^/]*'))
    .join('.*');
  try {
    return new RegExp(`^${re}$`).test(p.replace(/^\.\//, ''));
  } catch {
    return false;
  }
}

function describeRule(rule) {
  const bits = [`tool=${rule.tool}`];
  if (rule.pattern) bits.push(`pattern=/${rule.pattern}/`);
  if (rule.path) bits.push(`path=${rule.path}`);
  return `${rule.action}:${bits.join(',')}`;
}

function describeAsk(tool, input) {
  if (tool === 'bash') return `run: ${String(input.command || '').slice(0, 200)}`;
  if (tool === 'write') return `write ${input.path} (${String(input.content ?? '').length} chars)`;
  if (tool === 'edit') return `edit ${input.path}`;
  return `${tool} ${JSON.stringify(input).slice(0, 160)}`;
}

/**
 * Render the message the model sees when a call is refused. It is a tool_result
 * with is_error set, so the model can adapt rather than retry blindly.
 */
export function denialMessage(decision, tool, mode) {
  const why = decision.reason ? ` (${decision.reason})` : '';
  const hint = mode === 'plan'
    ? 'You are in plan mode. Do not try again; describe what you would do and ask the user to approve the plan.'
    : 'Do not retry the same call. Choose a different approach or ask the user to allow it.';
  return `xMonkey refused ${tool}: denied by permission gate${why}. ${hint}`;
}
