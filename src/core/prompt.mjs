// System prompt assembly.
//
// Kept short on purpose: local models lose accuracy fast as the system prompt
// grows, so every line here earns its place. The tool catalogue is NOT inlined —
// providers pass it structurally — except in the prompted-tools fallback, which
// renders it itself.

import os from 'node:os';

const BASE = `You are xMonkey, a coding agent running in the user's terminal on their own machine.

You have tools. Use them instead of guessing: read a file before you edit it, search the tree
before you assume a path, and run the tests before you claim they pass.

## How to work

- Do the job, don't narrate it. One short sentence before a tool call is enough.
- Prefer the smallest change that fully solves the problem. Do not refactor code you were not asked to touch.
- Never invent file contents, API names, or test results. If you have not read it, say so and read it.
- When a tool fails, read the error and change approach. Do not repeat the same failing call.
- When the task has more than two real steps, use the todo tool so the user can see progress.
- Finish with what you actually did and anything still open. No victory summaries.

## Boundaries

- You cannot change anything outside the workspace, and mutating calls may be declined. If declined,
  do not retry the same call: explain what you need and why.
- Never run destructive commands (rm -rf, force-push, drop database) without the user asking for them.
- Never commit secrets, tokens or private keys. If you find one, report it, do not copy it around.
- Do not install system packages or change global configuration unless asked.

## Style

Answer in the user's language. Be terse. Use plain text or short markdown; no emoji headers.
When you show code, show only the part that changed.`;

/**
 * Build the system prompt for a session.
 * @param {object} ctx
 * @param {string} [ctx.cwd]
 * @param {string} [ctx.model]
 * @param {string} [ctx.providerId]
 * @param {'default'|'plan'|'acceptEdits'|'bypass'} [ctx.permissionMode]
 * @param {string[]} [ctx.toolNames]
 * @param {string} [ctx.memory]      contents of AGENTS.md / XMONKEY.md
 * @param {string} [ctx.extra]        user-supplied append
 * @param {boolean} [ctx.local]       true when the model is a local one
 */
export function buildSystemPrompt(ctx = {}) {
  const sections = [BASE];
  const env = environmentBlock(ctx);
  if (env) sections.push(env);
  if (ctx.memory?.trim()) {
    sections.push(`## Project memory\n\nThe user maintains this file for this workspace. Treat it as authoritative.\n\n${ctx.memory.trim()}`);
  }
  if (ctx.permissionMode && ctx.permissionMode !== 'default') {
    sections.push(`## Current mode\n\nPermission mode is \`${ctx.permissionMode}\`. ${
      ctx.permissionMode === 'plan'
        ? 'You are planning only: read, investigate, then present the plan. Mutating tools are refused.'
        : ctx.permissionMode === 'acceptEdits'
          ? 'File edits are pre-approved; shell commands still ask.'
          : 'Every guard is off. Be careful.'
    }`);
  }
  if (ctx.local) {
    sections.push(
      '## Working with a local model\n\n' +
      'You are running on a model on this machine. Be concrete and economical: prefer one small tool call ' +
      'over a clever plan, and keep each reply short. If a tool schema feels ambiguous, read the file first ' +
      'rather than inferring.'
    );
  }
  if (ctx.extra?.trim()) sections.push(ctx.extra.trim());
  return sections.join('\n\n');
}

function environmentBlock(ctx) {
  const lines = [];
  if (ctx.cwd) lines.push(`- working directory: ${ctx.cwd}`);
  if (ctx.providerId && ctx.model) lines.push(`- model: ${ctx.model} (via ${ctx.providerId})`);
  else if (ctx.model) lines.push(`- model: ${ctx.model}`);
  lines.push(`- platform: ${process.platform} ${os.arch()}`);
  lines.push(`- today: ${new Date().toISOString().slice(0, 10)}`);
  if (ctx.permissionMode) lines.push(`- permission mode: ${ctx.permissionMode}`);
  if (ctx.toolNames?.length) lines.push(`- tools: ${ctx.toolNames.join(', ')}`);
  if (!lines.length) return '';
  return `## Environment\n\n${lines.join('\n')}`;
}

/**
 * Load project memory. xMonkey reads the same filenames people already use for
 * other agents, so a repository does not need a second convention.
 *
 * ALL files found are returned, in this candidate order: XMONKEY.md, AGENTS.md,
 * .xmonkey/AGENTS.md, CLAUDE.md. The caller concatenates them, so a project can
 * keep agent-agnostic notes in AGENTS.md and xMonkey-specific notes separately.
 */
export async function loadMemory(cwd, fs) {
  const fsp = fs ?? (await import('node:fs/promises'));
  const path = await import('node:path');
  const candidates = ['XMONKEY.md', 'AGENTS.md', '.xmonkey/AGENTS.md', 'CLAUDE.md'];
  const found = [];
  for (const rel of candidates) {
    const abs = path.join(cwd, rel);
    try {
      const text = await fsp.readFile(abs, 'utf8');
      found.push({ path: rel, text });
    } catch { /* not present */ }
  }
  return found;
}
