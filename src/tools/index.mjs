// Tool index. One place that decides what a session can do.

import { ToolRegistry } from './registry.mjs';
import { fileTools } from './files.mjs';
import { shellTools } from './shell.mjs';
import { searchTools } from './search.mjs';
import { todoTools, createTodoStore } from './todo.mjs';

export { ToolRegistry, ToolError } from './registry.mjs';

/**
 * Build the default registry for a session.
 * @param {object} ctx  workspace, todos, maxToolChars, allowOutsideWorkspace
 * @param {{disable?: string[]}} [opts]
 */
export function buildDefaultRegistry(ctx, opts = {}) {
  const disable = new Set(opts.disable ?? []);
  const all = [...fileTools(), ...searchTools(), ...shellTools(), ...todoTools()];
  const registry = new ToolRegistry(ctx);
  registry.registerAll(all.filter((t) => !disable.has(t.name)));
  return registry;
}

export { createTodoStore };
