// Filesystem tools: read, write, edit, list.
// These are the ones an agent uses most, so behaviour matters more than breadth:
// read is line-numbered and paginated, edit refuses an ambiguous replacement,
// write creates parents.

import fs from 'node:fs/promises';
import path from 'node:path';
import {
  ToolError, resolveInWorkspace, clipOutput, humanSize, isBinary,
} from './registry.mjs';

const MAX_READ_BYTES = 2 * 1024 * 1024;

/** @returns {object[]} */
export function fileTools() {
  return [readTool(), writeTool(), editTool(), listTool()];
}

function readTool() {
  return {
    name: 'read',
    description:
      'Read a file from the workspace. Returns line-numbered text. Use offset/limit for large files. ' +
      'Binary files are refused with a size report rather than dumped.',
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'File path, relative to the workspace.' },
        offset: { type: 'number', description: '1-based first line to return.' },
        limit: { type: 'number', description: 'Maximum number of lines (default 2000).' },
      },
      required: ['path'],
      additionalProperties: false,
    },
    isReadOnly: true,
    isConcurrencySafe: true,
    async run(input, ctx) {
      const abs = resolveInWorkspace(input.path, ctx);
      let st;
      try {
        st = await fs.stat(abs);
      } catch {
        throw new ToolError(`file not found: ${input.path}`);
      }
      if (st.isDirectory()) throw new ToolError(`${input.path} is a directory — use the list tool`);
      if (st.size > MAX_READ_BYTES) {
        throw new ToolError(
          `${input.path} is ${humanSize(st.size)} which exceeds the ${humanSize(MAX_READ_BYTES)} read limit. ` +
          `Use bash with sed/head to read a slice.`
        );
      }
      const buf = await fs.readFile(abs);
      if (isBinary(buf)) {
        return { content: `[binary file: ${input.path}, ${humanSize(st.size)} — not displayed]` };
      }
      const lines = buf.toString('utf8').split('\n');
      const offset = Math.max(1, Math.floor(input.offset ?? 1));
      const limit = Math.max(1, Math.min(20000, Math.floor(input.limit ?? 2000)));
      const slice = lines.slice(offset - 1, offset - 1 + limit);
      if (!slice.length) return { content: `[no lines at offset ${offset}; file has ${lines.length} lines]` };
      const width = String(offset + slice.length - 1).length;
      const body = slice
        .map((l, i) => `${String(offset + i).padStart(width, ' ')}\t${l}`)
        .join('\n');
      const more = offset - 1 + slice.length < lines.length
        ? `\n\n[truncated: showing lines ${offset}-${offset + slice.length - 1} of ${lines.length}]`
        : '';
      return { content: clipOutput(body + more, ctx.maxToolChars) };
    },
  };
}

function writeTool() {
  return {
    name: 'write',
    description:
      'Create a file, or replace its entire contents. Parent directories are created. ' +
      'For a targeted change to an existing file, prefer the edit tool.',
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'File path, relative to the workspace.' },
        content: { type: 'string', description: 'Full file contents.' },
      },
      required: ['path', 'content'],
      additionalProperties: false,
    },
    isReadOnly: false,
    isConcurrencySafe: false,
    async run(input, ctx) {
      const abs = resolveInWorkspace(input.path, ctx);
      await fs.mkdir(path.dirname(abs), { recursive: true });
      let existed = false;
      let before = null;
      try {
        before = await fs.readFile(abs, 'utf8');
        existed = true;
      } catch { /* new file */ }
      await fs.writeFile(abs, input.content, 'utf8');
      const bytes = Buffer.byteLength(input.content, 'utf8');
      const verb = existed ? 'Overwrote' : 'Created';
      return { content: `${verb} ${input.path} (${bytes} bytes, ${input.content.split('\n').length} lines)` };
    },
  };
}

function editTool() {
  return {
    name: 'edit',
    description:
      'Replace one exact string in a file. The old string must match exactly once unless replaceAll is set — ' +
      'an ambiguous match is refused so a wrong edit cannot silently land.',
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string' },
        oldString: { type: 'string', description: 'Exact text to find.' },
        newString: { type: 'string', description: 'Replacement text.' },
        replaceAll: { type: 'boolean', description: 'Replace every occurrence.' },
      },
      required: ['path', 'oldString', 'newString'],
      additionalProperties: false,
    },
    isReadOnly: false,
    isConcurrencySafe: false,
    validate(input) {
      if (input.oldString === input.newString) return { ok: false, error: 'oldString and newString are identical — nothing to do' };
      return { ok: true };
    },
    async run(input, ctx) {
      const abs = resolveInWorkspace(input.path, ctx);
      let text;
      try {
        text = await fs.readFile(abs, 'utf8');
      } catch {
        throw new ToolError(`file not found: ${input.path}`);
      }
      const count = countOccurrences(text, input.oldString);
      if (count === 0) {
        throw new ToolError(
          `oldString not found in ${input.path}. Read the file and copy the exact text, ` +
          `including indentation and line endings.`
        );
      }
      if (count > 1 && !input.replaceAll) {
        throw new ToolError(
          `oldString occurs ${count} times in ${input.path}. Add more surrounding context to make it unique, ` +
          `or set replaceAll: true to change all ${count}.`
        );
      }
      const next = input.replaceAll
        ? text.split(input.oldString).join(input.newString)
        : text.replace(input.oldString, input.newString);
      await fs.writeFile(abs, next, 'utf8');
      return {
        content: `Edited ${input.path}: replaced ${input.replaceAll ? count : 1} occurrence(s), ` +
          `${text.split('\n').length} → ${next.split('\n').length} lines`,
      };
    },
  };
}

function listTool() {
  return {
    name: 'list',
    description: 'List a directory. Set recursive for a shallow tree. Common build/vendor directories are skipped.',
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Directory, relative to the workspace (default ".").' },
        recursive: { type: 'boolean' },
        depth: { type: 'number', description: 'Max depth when recursive (default 2).' },
      },
      additionalProperties: false,
    },
    isReadOnly: true,
    isConcurrencySafe: true,
    async run(input, ctx) {
      const abs = resolveInWorkspace(input.path ?? '.', ctx);
      const depth = Math.max(1, Math.min(6, Math.floor(input.depth ?? 2)));
      const lines = [];
      const SKIP = new Set(['node_modules', '.git', 'dist', 'build', '.next', '.cache', '.venv', '__pycache__']);
      async function walk(dir, prefix, level) {
        let entries;
        try {
          entries = await fs.readdir(dir, { withFileTypes: true });
        } catch (err) {
          lines.push(`${prefix}[cannot read: ${err.code}]`);
          return;
        }
        entries.sort((a, b) => (Number(b.isDirectory()) - Number(a.isDirectory())) || a.name.localeCompare(b.name));
        for (const e of entries) {
          if (SKIP.has(e.name)) continue;
          if (e.isDirectory()) {
            lines.push(`${prefix}${e.name}/`);
            if (input.recursive && level < depth) await walk(path.join(dir, e.name), prefix + '  ', level + 1);
          } else {
            let size = 0;
            try { size = (await fs.stat(path.join(dir, e.name))).size; } catch { /* race */ }
            lines.push(`${prefix}${e.name}  ${humanSize(size)}`);
          }
          if (lines.length > 3000) {
            lines.push('… [listing capped at 3000 entries]');
            return;
          }
        }
      }
      await walk(abs, '', 1);
      if (!lines.length) return { content: `[empty directory: ${input.path ?? '.'}]` };
      return { content: clipOutput(lines.join('\n'), ctx.maxToolChars) };
    },
  };
}

function countOccurrences(haystack, needle) {
  if (!needle) return 0;
  let n = 0;
  let i = 0;
  for (;;) {
    const at = haystack.indexOf(needle, i);
    if (at < 0) break;
    n++;
    i = at + needle.length;
  }
  return n;
}
