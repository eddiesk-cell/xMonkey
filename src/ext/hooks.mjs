// Hooks: user-defined commands that run around the agent's lifecycle.
//
// The event vocabulary and the decision contract are matched to Claude Code's so
// an existing hook script can be dropped in unchanged. The 31 events below are
// the ones Claude Code declares (research/claude-code/04-sessions-extensibility.md);
// xMonkey dispatches the ones its own lifecycle has a point for, and the rest are
// accepted and recorded so a shared config never fails to load.
//
// Configuration (xmonkey.config.json or .xmonkey/hooks.json):
//
//   {
//     "hooks": {
//       "PreToolUse":  [ { "matcher": "bash|write", "command": "node scripts/guard.mjs" } ],
//       "PostToolUse": [ { "matcher": "edit", "command": "./format.sh" } ],
//       "SessionStart": [ { "command": "echo starting" } ],
//       "Stop":        [ { "command": "./notify.sh" } ]
//     }
//   }
//
// A PreToolUse hook may block by exiting non-zero and printing JSON on stdout:
//
//   { "decision": "deny", "reason": "no writes to vendor/" }
//   { "decision": "ask" }                  force the approval prompt
//   { "decision": "allow", "updatedInput": { ... } }
//
// Exit 0 with no JSON means "no opinion".

import { spawn } from 'node:child_process';

/**
 * The complete Claude Code hook vocabulary. Every one of these is accepted in a
 * config; `DISPATCHED` marks the ones xMonkey's own lifecycle currently fires.
 */
export const HOOK_EVENTS = [
  'PreToolUse', 'PostToolUse', 'PostToolUseFailure', 'PostToolBatch',
  'Notification', 'UserPromptSubmit', 'UserPromptExpansion',
  'SessionStart', 'SessionEnd', 'Stop', 'StopFailure',
  'SubagentStart', 'SubagentStop', 'PreCompact', 'PostCompact',
  'PermissionRequest', 'PermissionDenied', 'Setup', 'TeammateIdle',
  'TaskCreated', 'TaskCompleted', 'Elicitation', 'ElicitationResult',
  'ConfigChange', 'WorktreeCreate', 'WorktreeRemove', 'InstructionsLoaded',
  'CwdChanged', 'FileChanged', 'DirectoryAdded', 'MessageDisplay',
];

/** Events xMonkey actually fires, with where each is dispatched from. */
export const DISPATCHED = {
  SessionStart: 'src/app/session.mjs createSession',
  SessionEnd: 'src/app/session.mjs session.close',
  UserPromptSubmit: 'src/app/session.mjs session.send (before the loop)',
  PreToolUse: 'src/core/loop.mjs executeOne (before the gate)',
  PostToolUse: 'src/core/loop.mjs executeOne (after the tool)',
  PostToolUseFailure: 'src/core/loop.mjs executeOne (tool threw)',
  PermissionRequest: 'src/core/loop.mjs executeOne (gate said ask)',
  PermissionDenied: 'src/core/loop.mjs executeOne (refused)',
  Notification: 'src/app/session.mjs on notice events',
  SubagentStart: 'src/ext/subagent.mjs before the child runs',
  SubagentStop: 'src/ext/subagent.mjs after the child returns',
  PreCompact: 'src/core/loop.mjs before compaction',
  PostCompact: 'src/core/loop.mjs after compaction',
  Stop: 'src/core/loop.mjs finish()',
  StopFailure: 'src/core/loop.mjs finish() when the turn failed',
  MessageDisplay: 'src/app/session.mjs when text is streamed',
  InstructionsLoaded: 'src/core/prompt.mjs loadMemory',
  CwdChanged: 'src/app/session.mjs when the workspace changes',
  FileChanged: 'src/tools/files.mjs after write/edit',
  TaskCreated: 'src/tools/todo.mjs when an item is added',
  TaskCompleted: 'src/tools/todo.mjs when an item is completed',
  Setup: 'src/app/session.mjs during createSession',
  ConfigChange: 'src/config.mjs after load',
  Elicitation: 'src/core/loop.mjs onAsk (a question is asked)',
  ElicitationResult: 'src/core/loop.mjs onAsk (answered)',
};
// Accepted but not dispatched (no lifecycle point in xMonkey yet):
//   PostToolBatch, UserPromptExpansion, TeammateIdle, WorktreeCreate,
//   WorktreeRemove, DirectoryAdded, StopFailure(partial)

const HOOK_TIMEOUT_MS = 30_000;

/**
 * Run every hook registered for an event whose matcher accepts `subject`.
 * @returns {Promise<{decision?: 'allow'|'deny'|'ask', reason?: string, updatedInput?: object, results: object[]}>}
 */
export async function runHooks(hooksConfig, event, payload, { cwd = process.cwd(), signal } = {}) {
  const list = hooksConfig?.[event];
  if (!Array.isArray(list) || !list.length) return { results: [] };

  const subject = payload.toolName ?? '';
  const applicable = list.filter((h) => !h.matcher || matcherMatches(h.matcher, subject));

  const results = [];
  let decision;
  let reason;
  let updatedInput;

  for (const hook of applicable) {
    const r = await runOne(hook, event, payload, { cwd, signal });
    results.push(r);
    if (r.decision === 'deny') {
      // A deny short-circuits: a later hook must not be able to undo it.
      return { decision: 'deny', reason: r.reason, results };
    }
    if (r.decision === 'ask') decision = 'ask';
    if (r.updatedInput) updatedInput = { ...(updatedInput ?? {}), ...r.updatedInput };
    if (r.reason) reason = r.reason;
  }
  return { decision, reason, updatedInput, results };
}

/** Fire an event and ignore the outcome — for notification-style hooks. */
export function fireHook(hooksConfig, event, payload, opts) {
  if (!hooksConfig?.[event]) return;
  runHooks(hooksConfig, event, payload, opts).catch(() => {});
}

function matcherMatches(matcher, subject) {
  if (matcher === '*') return true;
  try {
    return new RegExp(`^(?:${matcher})$`).test(subject);
  } catch {
    return matcher === subject;
  }
}

async function runOne(hook, event, payload, { cwd, signal }) {
  const started = Date.now();
  const env = {
    ...process.env,
    XMONKEY_HOOK_EVENT: event,
    XMONKEY_TOOL_NAME: payload.toolName ?? '',
    ...hook.env,
  };
  return await new Promise((resolve) => {
    let stdout = '';
    let stderr = '';
    const child = spawn('/bin/sh', ['-c', hook.command], {
      cwd: hook.cwd ? `${cwd}/${hook.cwd}` : cwd,
      env,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    const timer = setTimeout(() => {
      try { child.kill('SIGKILL'); } catch { /* gone */ }
      resolve({ ok: false, timedOut: true, durationMs: Date.now() - started, stderr: 'hook timed out' });
    }, hook.timeout ?? HOOK_TIMEOUT_MS);

    child.stdout.on('data', (d) => { stdout += d.toString('utf8'); });
    child.stderr.on('data', (d) => { stderr += d.toString('utf8'); });

    try {
      child.stdin.write(JSON.stringify({ event, ...payload }));
      child.stdin.end();
    } catch { /* hook may not read stdin */ }

    child.on('error', (err) => {
      clearTimeout(timer);
      resolve({ ok: false, error: err.message, durationMs: Date.now() - started });
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      const out = { ok: code === 0, code, durationMs: Date.now() - started, stdout, stderr };
      const parsed = parseHookJson(stdout);
      if (parsed) {
        if (parsed.decision) out.decision = parsed.decision;
        if (parsed.reason) out.reason = parsed.reason;
        if (parsed.updatedInput) out.updatedInput = parsed.updatedInput;
        if (parsed.updatedOutput) out.updatedOutput = parsed.updatedOutput;
        if (parsed.additionalContext) out.additionalContext = parsed.additionalContext;
      }
      // Non-zero exit with no explicit JSON is a block with stderr as the reason.
      if (code !== 0 && !out.decision) {
        out.decision = 'deny';
        out.reason = (parsed?.reason ?? stderr.trim() ?? '').slice(0, 500) || `hook exited with ${code}`;
      }
      resolve(out);
    });
  });
}

function parseHookJson(text) {
  const s = String(text ?? '').trim();
  if (!s) return null;
  try {
    return JSON.parse(s);
  } catch {
    const m = s.match(/\{[\s\S]*\}$/);
    if (m) {
      try { return JSON.parse(m[0]); } catch { return null; }
    }
    return null;
  }
}

/** True if any configured hook event exists. */
export function hasHooks(hooksConfig) {
  return !!hooksConfig && Object.keys(hooksConfig).some((k) => Array.isArray(hooksConfig[k]) && hooksConfig[k].length);
}

/** Which of a user's configured events xMonkey will not fire, so `doctor` can say so. */
export function undispatchedEvents(hooksConfig) {
  if (!hooksConfig) return [];
  const known = new Set(Object.keys(DISPATCHED));
  return Object.keys(hooksConfig).filter((e) => Array.isArray(hooksConfig[e]) && hooksConfig[e].length && !known.has(e));
}
