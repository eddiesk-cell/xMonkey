// Hooks: user-defined commands that run around tool calls.
//
// Configuration (in xmonkey.config.json or .xmonkey/hooks.json):
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
// A PreToolUse hook can BLOCK a tool call. It signals that by exiting non-zero
// and printing a JSON object on stdout:
//
//   { "decision": "deny", "reason": "no writes to vendor/" }
//   { "decision": "ask" }                  force the approval prompt
//   { "decision": "allow", "updatedInput": { ... } }
//
// Anything else (exit 0, no JSON) means "no opinion". This is deliberately the
// same contract shape as other agent harnesses so an existing hook script can be
// reused without editing it.

import { spawn } from 'node:child_process';

export const HOOK_EVENTS = ['PreToolUse', 'PostToolUse', 'SessionStart', 'SessionEnd', 'Stop', 'UserPromptSubmit', 'PreCompact'];

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
    if (r.updatedInput && r.updatedInput) updatedInput = { ...(updatedInput ?? {}), ...r.updatedInput };
    if (r.reason) reason = r.reason;
  }
  return { decision, reason, updatedInput, results };
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

    // The payload goes in on stdin as JSON, and is also available via env.
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
      }
      // Non-zero exit with no explicit JSON is a block with the stderr as reason.
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
    // Tolerate a hook that prints log lines then JSON.
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
