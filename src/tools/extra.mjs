// Tools that complete the everyday surface: multi-file edit, plan mode,
// notebooks, asking the user a question, and background shell jobs.
//
// These mirror the operations people actually reach for in Claude Code, not the
// vendor-specific ones (teams, remote triggers, onboarding) that have no
// meaning without Anthropic's backend.

import fs from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';
import {
  ToolError, resolveInWorkspace, clipOutput, pathExists,
} from './registry.mjs';

export function editingTools() {
  return [multiEditTool(), notebookEditTool()];
}

export function workflowTools(deps = {}) {
  return [planTool(deps), askUserTool(deps), bashBackgroundTools().start, ...bashBackgroundTools().rest];
}

// ---------------------------------------------------------------- multi_edit

/**
 * Apply several edits across several files in one call. Either every edit
 * applies, or none does — a half-applied refactor is worse than a refused one.
 */
function multiEditTool() {
  return {
    name: 'multi_edit',
    description:
      'Apply multiple exact-string edits across one or more files atomically. ' +
      'Every edit must match uniquely; if any edit fails, NO file is changed.',
    inputSchema: {
      type: 'object',
      properties: {
        edits: {
          type: 'array',
          description: 'Edits to apply, in order.',
          items: {
            type: 'object',
            properties: {
              path: { type: 'string' },
              oldString: { type: 'string' },
              newString: { type: 'string' },
            },
            required: ['path', 'oldString', 'newString'],
          },
        },
      },
      required: ['edits'],
      additionalProperties: false,
    },
    isReadOnly: false,
    isConcurrencySafe: false,
    async run(input, ctx) {
      const edits = Array.isArray(input.edits) ? input.edits : [];
      if (!edits.length) throw new ToolError('no edits supplied');

      // Read every file first, apply edits in memory, then write them all.
      const byFile = new Map();
      for (const e of edits) {
        const abs = resolveInWorkspace(e.path, ctx);
        if (!byFile.has(abs)) {
          if (!(await pathExists(abs))) throw new ToolError(`file not found: ${e.path}`);
          byFile.set(abs, { rel: e.path, text: await fs.readFile(abs, 'utf8'), original: null });
        }
        const entry = byFile.get(abs);
        if (entry.original === null) entry.original = entry.text;

        const count = countOccurrences(entry.text, e.oldString);
        if (count === 0) throw new ToolError(`oldString not found in ${e.path}: ${brief(e.oldString)}`);
        if (count > 1) {
          throw new ToolError(`oldString is ambiguous in ${e.path} (${count} matches): ${brief(e.oldString)}. ` +
            'Add surrounding context to make it unique.');
        }
        entry.text = entry.text.replace(e.oldString, e.newString);
      }

      const applied = [];
      for (const [abs, entry] of byFile) {
        if (entry.text === entry.original) continue;
        await fs.writeFile(abs, entry.text, 'utf8');
        applied.push(entry.rel);
        if (ctx.hooks) {
          const { fireHook } = await import('../ext/hooks.mjs');
          fireHook(ctx.hooks, 'FileChanged', { path: abs, change: 'modified' }, { cwd: ctx.workspace });
        }
      }
      return {
        content: `Applied ${edits.length} edit(s) across ${applied.length} file(s):\n` +
          applied.map((f) => `  ${f}`).join('\n'),
      };
    },
  };
}

function countOccurrences(h, n) {
  if (!n) return 0;
  let c = 0;
  let i = 0;
  for (;;) {
    const at = h.indexOf(n, i);
    if (at < 0) return c;
    c++;
    i = at + n.length;
  }
}

function brief(s, n = 60) {
  const t = String(s ?? '').replace(/\s+/g, ' ');
  return t.length > n ? `${t.slice(0, n)}…` : t;
}

// ---------------------------------------------------------------- notebook

/** Edit Jupyter cells by index. Source is a string or array of lines. */
function notebookEditTool() {
  return {
    name: 'notebook_edit',
    description:
      'Edit a Jupyter notebook (.ipynb) cell: replace, insert or delete source by cell index.',
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Path to the .ipynb file.' },
        cellIndex: { type: 'number', description: '0-based cell index.' },
        action: { type: 'string', enum: ['replace', 'insert', 'delete'], description: 'What to do.' },
        cellType: { type: 'string', enum: ['code', 'markdown'], description: 'Cell type for insert/replace.' },
        source: { type: 'string', description: 'New cell source (not needed for delete).' },
      },
      required: ['path', 'action'],
      additionalProperties: false,
    },
    isReadOnly: false,
    isConcurrencySafe: false,
    async run(input, ctx) {
      const abs = resolveInWorkspace(input.path, ctx);
      let nb;
      try {
        nb = JSON.parse(await fs.readFile(abs, 'utf8'));
      } catch (err) {
        throw new ToolError(`cannot read notebook ${input.path}: ${err.message}`);
      }
      if (!Array.isArray(nb.cells)) throw new ToolError(`${input.path} is not a Jupyter notebook (no cells array)`);

      const idx = Number.isInteger(input.cellIndex) ? input.cellIndex : 0;
      const lines = String(input.source ?? '').split('\n').map((l, i, a) => (i < a.length - 1 ? l + '\n' : l));

      if (input.action === 'delete') {
        if (idx < 0 || idx >= nb.cells.length) throw new ToolError(`cell index ${idx} out of range (0..${nb.cells.length - 1})`);
        nb.cells.splice(idx, 1);
      } else if (input.action === 'insert') {
        const cell = {
          cell_type: input.cellType ?? 'code',
          metadata: {},
          source: lines,
          ...(input.cellType === 'markdown' ? {} : { outputs: [], execution_count: null }),
        };
        nb.cells.splice(Math.max(0, Math.min(idx, nb.cells.length)), 0, cell);
      } else if (input.action === 'replace') {
        if (idx < 0 || idx >= nb.cells.length) throw new ToolError(`cell index ${idx} out of range (0..${nb.cells.length - 1})`);
        nb.cells[idx].source = lines;
        if (input.cellType) nb.cells[idx].cell_type = input.cellType;
      } else {
        throw new ToolError(`unknown action "${input.action}"`);
      }

      await fs.writeFile(abs, JSON.stringify(nb, null, 1), 'utf8');
      return { content: `${input.action} cell ${idx} in ${input.path} (now ${nb.cells.length} cells)` };
    },
  };
}

// ---------------------------------------------------------------- plan mode

/**
 * Structured plan/approval, mirroring EnterPlanMode/ExitPlanMode.
 * In plan mode the agent investigates, then submits a plan for the user to
 * approve; approval switches the session to an editing mode.
 */
function planTool(deps) {
  return {
    name: 'plan',
    description:
      'Plan mode: investigate with read-only tools, then submit a plan for approval. ' +
      'Use action "enter" to switch the session into planning, and "exit" with the plan text ' +
      'to propose it. The user approves or rejects; on approval the plan is returned for you to execute.',
    inputSchema: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['enter', 'exit'], description: 'enter = start planning; exit = submit a plan.' },
        plan: { type: 'string', description: 'The plan text (required for exit).' },
      },
      required: ['action'],
      additionalProperties: false,
    },
    isReadOnly: true,
    isConcurrencySafe: false,
    async run(input, ctx) {
      if (input.action === 'enter') {
        ctx.permissionMode = 'plan';
        return { content: 'Plan mode active: mutating tools are refused until the plan is approved. ' +
          'Investigate, then call this tool with action "exit" and the plan text.' };
      }
      const plan = String(input.plan ?? '').trim();
      if (!plan) throw new ToolError('action "exit" needs the plan text');
      if (!deps.onPlan) {
        return { content: `PLAN (no approver available):\n\n${plan}` };
      }
      const approved = await deps.onPlan(plan);
      if (!approved) {
        return { content: 'The user rejected the plan. Ask what to change before retrying.', isError: true };
      }
      ctx.permissionMode = 'default';
      return { content: `Plan approved. Execute it now:\n\n${plan}` };
    },
  };
}

// ---------------------------------------------------------------- ask

/** Ask the user a multiple-choice question and return the answer. */
function askUserTool(deps) {
  return {
    name: 'ask_user',
    description:
      'Ask the user a question when a decision cannot be inferred from the code. ' +
      'Prefer 2-4 concrete options; the user can also answer freely.',
    inputSchema: {
      type: 'object',
      properties: {
        question: { type: 'string', description: 'The question to ask.' },
        options: {
          type: 'array',
          description: 'Optional choices.',
          items: {
            type: 'object',
            properties: { label: { type: 'string' }, description: { type: 'string' } },
            required: ['label'],
          },
        },
      },
      required: ['question'],
      additionalProperties: false,
    },
    isReadOnly: true,
    isConcurrencySafe: false,
    async run(input) {
      if (!deps.onAsk) {
        return { content: `No user is available to answer. Question was: ${input.question}`, isError: true };
      }
      const answer = await deps.onAsk({
        question: String(input.question),
        options: (input.options ?? []).map((o) => ({ label: o.label, description: o.description })),
      });
      return { content: `The user answered: ${answer}` };
    },
  };
}

// ---------------------------------------------------------------- background bash

/**
 * Long-running commands: start one, get an id, read its output later.
 * This is what `run_in_background` is for in Claude Code — a dev server or a
 * watch task must not block the agent loop.
 */
const JOBS = new Map();

function bashBackgroundTools() {
  const start = {
    name: 'bash_background',
    description:
      'Start a long-running command in the background (dev server, watcher, tail). ' +
      'Returns a job id; use bash_output to read what it printed and bash_kill to stop it.',
    inputSchema: {
      type: 'object',
      properties: {
        command: { type: 'string' },
        cwd: { type: 'string', description: 'Working directory, relative to the workspace.' },
      },
      required: ['command'],
      additionalProperties: false,
    },
    isReadOnly: false,
    isConcurrencySafe: false,
    async run(input, ctx) {
      const cwd = input.cwd ? resolveInWorkspace(input.cwd, ctx) : (ctx.workspace || process.cwd());
      const id = `job_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`;
      const shell = process.env.SHELL || '/bin/bash';
      const child = spawn(shell, ['-lc', input.command], {
        cwd,
        env: { ...process.env, XMONKEY: '1' },
        stdio: ['ignore', 'pipe', 'pipe'],
        detached: false,
      });
      const job = { id, child, command: input.command, cwd, out: '', err: '', exit: null, started: Date.now() };
      JOBS.set(id, job);
      child.stdout.on('data', (d) => { job.out = (job.out + d.toString('utf8')).slice(-200_000); });
      child.stderr.on('data', (d) => { job.err = (job.err + d.toString('utf8')).slice(-200_000); });
      child.on('close', (code, signal) => { job.exit = code ?? signal ?? null; });
      // Give it a moment so an immediate crash is reported as such.
      await new Promise((r) => setTimeout(r, 250));
      const status = job.exit === null ? 'running' : `exited (${job.exit})`;
      return { content: `started ${id} — ${status}\n  ${input.command}` };
    },
  };

  const output = {
    name: 'bash_output',
    description: 'Read accumulated output from a background job started by bash_background.',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'Job id, or "all" to list jobs.' },
        lines: { type: 'number', description: 'Only the last N lines (default 200).' },
      },
      required: ['id'],
      additionalProperties: false,
    },
    isReadOnly: true,
    isConcurrencySafe: true,
    async run(input) {
      if (input.id === 'all') {
        if (!JOBS.size) return { content: 'no background jobs' };
        const rows = [...JOBS.values()].map((j) =>
          `${j.id}  ${j.exit === null ? 'running' : `exited ${j.exit}`}  ${j.command.slice(0, 80)}`);
        return { content: rows.join('\n') };
      }
      const job = JOBS.get(input.id);
      if (!job) throw new ToolError(`no such job: ${input.id}`);
      const n = Math.max(1, Math.min(5000, input.lines ?? 200));
      const stdout = job.out.split('\n').slice(-n).join('\n');
      const stderr = job.err.split('\n').slice(-n).join('\n');
      const parts = [];
      if (stdout.trim()) parts.push(stdout.trimEnd());
      if (stderr.trim()) parts.push(`[stderr]\n${stderr.trimEnd()}`);
      parts.push(`[${job.exit === null ? `running, ${Math.round((Date.now() - job.started) / 1000)}s` : `exited ${job.exit}`}]`);
      return { content: clipOutput(parts.join('\n'), 40000) };
    },
  };

  const kill = {
    name: 'bash_kill',
    description: 'Stop a background job started by bash_background.',
    inputSchema: {
      type: 'object',
      properties: { id: { type: 'string' } },
      required: ['id'],
      additionalProperties: false,
    },
    isReadOnly: false,
    isConcurrencySafe: false,
    async run(input) {
      const job = JOBS.get(input.id);
      if (!job) throw new ToolError(`no such job: ${input.id}`);
      if (job.exit !== null) return { content: `${job.id} already exited (${job.exit})` };
      try { job.child.kill('SIGTERM'); } catch { /* gone */ }
      await new Promise((r) => setTimeout(r, 500));
      if (job.exit === null) { try { job.child.kill('SIGKILL'); } catch { /* gone */ } }
      JOBS.delete(job.id);
      return { content: `stopped ${job.id}` };
    },
  };

  return { start, rest: [output, kill] };
}

/** Kill every background job — called on session close so nothing leaks. */
export function killAllBackgroundJobs() {
  for (const job of JOBS.values()) {
    try { job.child.kill('SIGKILL'); } catch { /* gone */ }
  }
  JOBS.clear();
}
