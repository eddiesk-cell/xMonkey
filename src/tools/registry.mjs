// Tool interface + registry.
//
// A tool is our own small contract, deliberately narrower than a vendor one:
//
//   name, description, inputSchema (JSON Schema)
//   isReadOnly, isConcurrencySafe
//   validate(input, ctx) -> {ok} | {ok:false, error}
//   run(input, ctx)      -> {content: string} | {content, isError: true}
//
// The registry also owns the path policy: no tool writes outside the session
// workspace unless the user explicitly widened it. Permission decisions happen
// in src/permissions, not here — tools trust that they were only called after
// the gate said yes.

import path from 'node:path';
import fs from 'node:fs/promises';

export class ToolError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ToolError';
  }
}

export class ToolRegistry {
  constructor(ctx = {}) {
    /** @type {Map<string, object>} */
    this.tools = new Map();
    this.ctx = ctx;
  }

  register(tool) {
    if (!tool?.name) throw new Error('tool needs a name');
    if (!tool.inputSchema) throw new Error(`tool ${tool.name} needs an inputSchema`);
    if (this.tools.has(tool.name)) throw new Error(`duplicate tool ${tool.name}`);
    this.tools.set(tool.name, tool);
    return this;
  }

  registerAll(list) {
    for (const t of list) this.register(t);
    return this;
  }

  get(name) {
    return this.tools.get(name);
  }

  /** Provider-facing catalogue. Stable order so prompt caching works. */
  specs() {
    return [...this.tools.values()]
      .sort((a, b) => a.name.localeCompare(b.name))
      .map((t) => ({ name: t.name, description: t.description, inputSchema: t.inputSchema }));
  }

  names() {
    return [...this.tools.keys()].sort();
  }

  async validate(name, input, ctx = this.ctx) {
    const tool = this.tools.get(name);
    if (!tool) return { ok: false, error: `unknown tool "${name}". Available: ${this.names().join(', ')}` };
    try {
      const r = tool.validate ? await tool.validate(input, ctx) : { ok: true };
      return r ?? { ok: true };
    } catch (err) {
      return { ok: false, error: err.message };
    }
  }

  async run(name, input, ctx = this.ctx) {
    const tool = this.tools.get(name);
    if (!tool) throw new ToolError(`unknown tool "${name}"`);
    // Normalise a missing/!object input to {} so tools can rely on destructuring.
    const args = input && typeof input === 'object' && !Array.isArray(input) ? input : {};
    const result = await tool.run(args, ctx);
    if (typeof result === 'string') return { content: result };
    return result ?? { content: '' };
  }
}

// ---- shared helpers used by several tools ---------------------------------

export const DEFAULT_IGNORES = [
  'node_modules', '.git', 'dist', 'build', '.next', '.cache', '.venv', 'venv',
  '__pycache__', '.idea', '.DS_Store', '.turbo', 'target', 'vendor',
];

/** Resolve a user-supplied path against the workspace, refusing escapes. */
export function resolveInWorkspace(p, ctx) {
  const root = ctx.workspace || process.cwd();
  const abs = path.resolve(root, p ?? '.');
  const rel = path.relative(root, abs);
  const escapes = rel.startsWith('..') || path.isAbsolute(rel);
  if (escapes && !ctx.allowOutsideWorkspace) {
    throw new ToolError(
      `path "${p}" resolves outside the workspace (${root}). ` +
      `xMonkey refuses by default; start it with --allow-outside or widen the workspace.`
    );
  }
  return abs;
}

/** Human-explainable byte size. */
export function humanSize(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

/** Truncate tool output, keeping the head and the tail (the tail has the error). */
export function clipOutput(text, maxChars = 30_000) {
  const s = String(text ?? '');
  if (s.length <= maxChars) return s;
  const head = Math.floor(maxChars * 0.7);
  const tail = maxChars - head;
  return `${s.slice(0, head)}\n\n… [${s.length - maxChars} chars truncated by xMonkey] …\n\n${s.slice(-tail)}`;
}

export async function pathExists(p) {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}

export function isBinary(buf) {
  const n = Math.min(buf.length, 8000);
  for (let i = 0; i < n; i++) if (buf[i] === 0) return true;
  return false;
}

/** Minimal JSON-Schema validation — enough for our own schemas, no dependency. */
export function validateSchema(schema, value, pathStr = 'input') {
  if (!schema) return [];
  const errs = [];
  const type = schema.type;
  if (type === 'object') {
    if (value === null || typeof value !== 'object' || Array.isArray(value)) {
      return [`${pathStr} must be an object`];
    }
    for (const req of schema.required || []) {
      if (!(req in value)) errs.push(`${pathStr}.${req} is required`);
    }
    for (const [k, sub] of Object.entries(schema.properties || {})) {
      if (k in value) errs.push(...validateSchema(sub, value[k], `${pathStr}.${k}`));
    }
    if (schema.additionalProperties === false) {
      for (const k of Object.keys(value)) {
        if (!(schema.properties || {})[k]) errs.push(`${pathStr}.${k} is not an allowed property`);
      }
    }
    return errs;
  }
  if (type === 'array') {
    if (!Array.isArray(value)) return [`${pathStr} must be an array`];
    if (schema.items) value.forEach((v, i) => errs.push(...validateSchema(schema.items, v, `${pathStr}[${i}]`)));
    return errs;
  }
  if (type === 'string' && typeof value !== 'string') return [`${pathStr} must be a string`];
  if (type === 'number' && typeof value !== 'number') return [`${pathStr} must be a number`];
  if (type === 'boolean' && typeof value !== 'boolean') return [`${pathStr} must be a boolean`];
  if (schema.enum && !schema.enum.includes(value)) errs.push(`${pathStr} must be one of: ${schema.enum.join(', ')}`);
  return errs;
}
