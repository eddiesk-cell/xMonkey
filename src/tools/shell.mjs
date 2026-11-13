// Shell tool. One command per call, run through the user's shell, with a
// timeout, a bounded output buffer, and no implicit cwd escape.

import { spawn } from 'node:child_process';
import { ToolError, resolveInWorkspace, clipOutput } from './registry.mjs';

const DEFAULT_TIMEOUT_MS = 120_000;
const MAX_TIMEOUT_MS = 600_000;
const MAX_BUFFER = 1024 * 1024; // 1 MiB retained per stream

export function shellTools() {
  return [bashTool()];
}

function bashTool() {
  return {
    name: 'bash',
    description:
      'Run one shell command in the workspace and return its combined output. ' +
      'Use it for git, builds, tests, and anything the other tools do not cover. ' +
      'Prefer read/write/edit/glob/grep for file work: they are safer and cheaper.',
    inputSchema: {
      type: 'object',
      properties: {
        command: { type: 'string', description: 'The command to run.' },
        cwd: { type: 'string', description: 'Working directory, relative to the workspace.' },
        timeoutMs: { type: 'number', description: `Timeout in ms (default ${DEFAULT_TIMEOUT_MS}, max ${MAX_TIMEOUT_MS}).` },
        description: { type: 'string', description: 'Short human description of what this does.' },
      },
      required: ['command'],
      additionalProperties: false,
    },
    isReadOnly: false,
    isConcurrencySafe: false,
    async run(input, ctx) {
      const cwd = input.cwd ? resolveInWorkspace(input.cwd, ctx) : (ctx.workspace || process.cwd());
      const timeout = Math.min(MAX_TIMEOUT_MS, Math.max(1000, input.timeoutMs ?? DEFAULT_TIMEOUT_MS));
      const shell = process.env.SHELL || '/bin/bash';

      return await new Promise((resolve) => {
        const child = spawn(shell, ['-lc', input.command], {
          cwd,
          env: { ...process.env, XMONKEY: '1' },
          stdio: ['ignore', 'pipe', 'pipe'],
        });
        let out = '';
        let err = '';
        let outCut = false;
        let errCut = false;
        let timedOut = false;

        const timer = setTimeout(() => {
          timedOut = true;
          try { child.kill('SIGTERM'); } catch { /* already dead */ }
          setTimeout(() => { try { child.kill('SIGKILL'); } catch { /* gone */ } }, 2000).unref?.();
        }, timeout);

        child.stdout.on('data', (d) => {
          if (out.length < MAX_BUFFER) out += d.toString('utf8');
          else outCut = true;
        });
        child.stderr.on('data', (d) => {
          if (err.length < MAX_BUFFER) err += d.toString('utf8');
          else errCut = true;
        });
        child.on('error', (e) => {
          clearTimeout(timer);
          resolve({ content: `failed to start command: ${e.message}`, isError: true });
        });
        child.on('close', (code, signal) => {
          clearTimeout(timer);
          const parts = [];
          if (out.trim()) parts.push(out.trimEnd());
          if (err.trim()) parts.push(`[stderr]\n${err.trimEnd()}`);
          if (outCut || errCut) parts.push('[output truncated at 1 MiB per stream]');
          let status;
          if (timedOut) status = `[timed out after ${timeout}ms — process killed]`;
          else if (signal) status = `[killed by signal ${signal}]`;
          else status = `[exit code: ${code}]`;
          parts.push(status);
          resolve({
            content: clipOutput(parts.join('\n'), ctx.maxToolChars),
            isError: timedOut || (code !== 0 && code !== null) || !!signal,
          });
        });
      });
    },
  };
}
