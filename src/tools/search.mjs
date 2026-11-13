// Search tools: glob (find by name) and grep (find by content).
// Both walk the tree themselves so there is no ripgrep/grep dependency, which
// matters on machines where the agent environment is not a dev box.

import fs from 'node:fs/promises';
import path from 'node:path';
import {
  ToolError, resolveInWorkspace, clipOutput, isBinary, DEFAULT_IGNORES, humanSize,
} from './registry.mjs';

const MAX_FILES_WALKED = 60_000;
const MAX_FILE_BYTES = 2 * 1024 * 1024;

export function searchTools() {
  return [globTool(), grepTool()];
}

/** Translate a glob into a RegExp. Supports *, **, ?, and {a,b}. */
export function globToRegExp(glob, { caseSensitive = true } = {}) {
  let re = '';
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === '*') {
      const isDouble = glob[i + 1] === '*';
      if (isDouble) {
        const slashAfter = glob[i + 2] === '/';
        re += slashAfter ? '(?:.*/)?' : '.*';
        i += slashAfter ? 2 : 1;
      } else {
        re += '[^/]*';
      }
      continue;
    }
    if (c === '?') { re += '[^/]'; continue; }
    if (c === '{') {
      const end = glob.indexOf('}', i);
      if (end > i) {
        const alts = glob.slice(i + 1, end).split(',').map(escapeRe).join('|');
        re += `(?:${alts})`;
        i = end;
        continue;
      }
    }
    if (c === '/') { re += '/'; continue; }
    re += escapeRe(c);
  }
  return new RegExp(`^${re}$`, caseSensitive ? '' : 'i');
}

function escapeRe(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

async function* walk(root, { ignore = DEFAULT_IGNORES, max = MAX_FILES_WALKED } = {}) {
  const ignoreSet = new Set(ignore);
  let count = 0;
  const stack = [root];
  while (stack.length) {
    const dir = stack.pop();
    let entries;
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of entries) {
      if (ignoreSet.has(e.name)) continue;
      const abs = path.join(dir, e.name);
      if (e.isSymbolicLink()) continue;   // never follow: loops and escapes
      if (e.isDirectory()) {
        stack.push(abs);
      } else {
        yield abs;
        if (++count >= max) return;
      }
    }
  }
}

function globTool() {
  return {
    name: 'glob',
    description:
      'Find files by glob pattern, e.g. "src/**/*.ts" or "**/*.md". ' +
      'Returns paths sorted by modification time, newest first.',
    inputSchema: {
      type: 'object',
      properties: {
        pattern: { type: 'string', description: 'Glob pattern.' },
        path: { type: 'string', description: 'Directory to search (default the workspace root).' },
        limit: { type: 'number', description: 'Max results (default 100, max 1000).' },
      },
      required: ['pattern'],
      additionalProperties: false,
    },
    isReadOnly: true,
    isConcurrencySafe: true,
    async run(input, ctx) {
      const root = resolveInWorkspace(input.path ?? '.', ctx);
      const limit = Math.min(1000, Math.max(1, Math.floor(input.limit ?? 100)));
      const re = globToRegExp(input.pattern);
      const hits = [];
      for await (const abs of walk(root)) {
        const rel = path.relative(root, abs).split(path.sep).join('/');
        if (!re.test(rel)) continue;
        let st;
        try { st = await fs.stat(abs); } catch { continue; }
        hits.push({ rel, mtime: st.mtimeMs, size: st.size });
      }
      hits.sort((a, b) => b.mtime - a.mtime);
      if (!hits.length) return { content: `No files matched "${input.pattern}" under ${input.path ?? '.'}.` };
      const shown = hits.slice(0, limit);
      const lines = shown.map((h) => `${h.rel}  (${humanSize(h.size)})`);
      const extra = hits.length > shown.length ? `\n\n[${hits.length - shown.length} more matches not shown]` : '';
      return { content: clipOutput(`${hits.length} match(es):\n${lines.join('\n')}${extra}`, ctx.maxToolChars) };
    },
  };
}

function grepTool() {
  return {
    name: 'grep',
    description:
      'Search file contents with a JavaScript regular expression. ' +
      'Returns file:line: match. Binary files and vendored directories are skipped.',
    inputSchema: {
      type: 'object',
      properties: {
        pattern: { type: 'string', description: 'Regular expression.' },
        path: { type: 'string', description: 'Directory or file to search.' },
        include: { type: 'string', description: 'Only search files matching this glob, e.g. "*.js".' },
        ignoreCase: { type: 'boolean' },
        limit: { type: 'number', description: 'Max matching lines (default 200, max 2000).' },
      },
      required: ['pattern'],
      additionalProperties: false,
    },
    isReadOnly: true,
    isConcurrencySafe: true,
    async run(input, ctx) {
      let re;
      try {
        re = new RegExp(input.pattern, input.ignoreCase ? 'i' : '');
      } catch (err) {
        throw new ToolError(`invalid regular expression: ${err.message}`);
      }
      const target = resolveInWorkspace(input.path ?? '.', ctx);
      const limit = Math.min(2000, Math.max(1, Math.floor(input.limit ?? 200)));
      const includeRe = input.include ? globToRegExp(input.include, { caseSensitive: false }) : null;

      const st = await fs.stat(target).catch(() => null);
      if (!st) throw new ToolError(`path not found: ${input.path}`);

      const files = [];
      if (st.isFile()) {
        files.push(target);
      } else {
        const root = target;
        for await (const abs of walk(root)) {
          const rel = path.relative(root, abs).split(path.sep).join('/');
          files.push({ abs, rel });
        }
      }

      const out = [];
      let scanned = 0;
      for (const f of files) {
        const abs = typeof f === 'string' ? f : f.abs;
        const rel = typeof f === 'string' ? path.relative(ctx.workspace || process.cwd(), f) : f.rel;
        if (includeRe && !includeRe.test(rel.split('/').pop()) && !includeRe.test(rel)) continue;
        let buf;
        try { buf = await fs.readFile(abs); } catch { continue; }
        if (buf.length > MAX_FILE_BYTES || isBinary(buf)) continue;
        scanned++;
        const lines = buf.toString('utf8').split('\n');
        for (let i = 0; i < lines.length; i++) {
          if (!re.test(lines[i])) continue;
          out.push(`${rel}:${i + 1}: ${lines[i].trim().slice(0, 400)}`);
          if (out.length >= limit) break;
        }
        if (out.length >= limit) break;
      }
      if (!out.length) return { content: `No matches for /${input.pattern}/ in ${input.path ?? '.'} (${scanned} files scanned).` };
      const more = out.length >= limit ? `\n\n[stopped at the ${limit}-line limit; narrow the pattern or path]` : '';
      return { content: clipOutput(out.join('\n') + more, ctx.maxToolChars) };
    },
  };
}
