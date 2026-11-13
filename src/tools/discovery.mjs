// Tool search: keep a large tool catalogue out of the context window.
//
// The problem this solves: xMonkey + an MCP server can expose 150-300 tools, and
// every advertised schema costs prompt tokens. With REA's full surface that was
// ~96,000 tokens — more than a local model's entire context, so the model could
// not call anything. Scoping the server helps but does not fix it.
//
// The fix is the one Claude Code uses: advertise a SMALL core set, plus two
// tools that can reach the rest on demand.
//
//   tool_search   find tools by name/description keyword → returns schemas
//   tool_call     invoke a tool by name (needed because a deferred tool is not
//                 in the advertised list, so the model cannot call it directly)
//
// Once a tool has been found it is promoted into the advertised set for the rest
// of the session, so repeated use costs nothing and the model learns the shape.

const CORE_ALWAYS = new Set([
  'read', 'write', 'edit', 'bash', 'list', 'glob', 'grep', 'todo',
  'tool_search', 'tool_call', 'multi_edit', 'task',
]);

const DEFAULT_MAX_RESULTS = 6;
const PROMOTED_LIMIT = 24;

export function createToolSearcher(registry) {
  /** Tools promoted from a search, so they stay callable without re-searching. */
  const promoted = new Set();
  /** Schemas the model has already seen, to report search results cheaply. */
  const seen = new Set();

  const search = {
    name: 'tool_search',
    description:
      'Find tools by keyword when the tool you need is not in your tool list. ' +
      'Returns matching tool names, descriptions and input schemas. After a search the ' +
      'tools are available to tool_call. Use it for MCP tools (names like mcp__server__tool) ' +
      'and for anything uncommon.',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Keywords, e.g. "rea binary inspect" or "notebook".' },
        limit: { type: 'number', description: 'Max results (default 6, max 20).' },
      },
      required: ['query'],
      additionalProperties: false,
    },
    isReadOnly: true,
    isConcurrencySafe: true,
    async run(input) {
      const query = String(input.query ?? '').trim().toLowerCase();
      if (!query) return { content: 'Give a search query.', isError: true };
      const limit = Math.min(20, Math.max(1, input.limit ?? DEFAULT_MAX_RESULTS));
      const terms = query.split(/\s+/).filter(Boolean);

      const scored = [];
      for (const tool of registry.tools.values()) {
        if (CORE_ALWAYS.has(tool.name)) continue;
        const hay = `${tool.name} ${tool.description ?? ''}`.toLowerCase();
        let score = 0;
        for (const t of terms) {
          if (tool.name.toLowerCase().includes(t)) score += 5;
          if (hay.includes(t)) score += 2;
        }
        if (score > 0) scored.push({ tool, score });
      }
      scored.sort((a, b) => b.score - a.score || a.tool.name.localeCompare(b.tool.name));

      if (!scored.length) {
        const total = registry.tools.size;
        return {
          content: `No tool matched "${input.query}". ${total} tools exist; try a broader word ` +
            `(e.g. "rea", "native", "electron", "browser", "evidence").`,
        };
      }

      const picked = scored.slice(0, limit);
      for (const { tool } of picked) {
        promoted.add(tool.name);
        seen.add(tool.name);
      }
      // Keep the promoted set bounded so the advertised list cannot creep back up
      // to hundreds of tools over a long session.
      if (promoted.size > PROMOTED_LIMIT) {
        const keep = [...promoted].slice(-PROMOTED_LIMIT);
        promoted.clear();
        for (const n of keep) promoted.add(n);
      }

      const body = picked.map(({ tool }) => {
        const schema = JSON.stringify(tool.inputSchema ?? {});
        return `### ${tool.name}\n${tool.description ?? ''}\ninput: ${schema}`;
      }).join('\n\n');

      return {
        content:
          `Found ${scored.length} match(es); showing ${picked.length}.\n` +
          `Call any of them with tool_call { "name": "...", "input": { ... } }.\n\n${body}`,
      };
    },
  };

  const call = {
    name: 'tool_call',
    description:
      'Invoke a tool by name. Use for tools discovered with tool_search, and for tools whose ' +
      'name you already know but which are not in your advertised tool list.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Exact tool name.' },
        input: { type: 'object', description: 'Arguments for that tool.' },
        timeoutMs: { type: 'number', description: 'Optional timeout in ms (default 180000).' },
      },
      required: ['name'],
      additionalProperties: false,
    },
    isReadOnly: false,
    isConcurrencySafe: false,
    async run(input, ctx) {
      const name = String(input.name ?? '').trim();
      if (!name) return { content: 'Give the tool name.', isError: true };
      if (name === 'tool_call' || name === 'tool_search') {
        return { content: 'tool_call cannot invoke itself.', isError: true };
      }
      const tool = registry.get(name);
      if (!tool) {
        return {
          content: `No tool named "${name}". Use tool_search to find the right one.`,
          isError: true,
        };
      }
      const args = input.input && typeof input.input === 'object' ? input.input : {};
      const validation = await registry.validate(name, args);
      if (!validation.ok) return { content: `Invalid input for ${name}: ${validation.error}`, isError: true };
      // Bound the call: a tool server that stops answering must surface as an
      // error the model can react to, never as a silently hung turn.
      const timeoutMs = Number(input.timeoutMs) || 180_000;
      try {
        const res = await Promise.race([
          registry.run(name, args, ctx),
          new Promise((_, reject) => setTimeout(
            () => reject(new Error(`timed out after ${Math.round(timeoutMs / 1000)}s`)), timeoutMs).unref?.(),
          ),
        ]);
        return { content: String(res.content ?? ''), isError: !!res.isError };
      } catch (err) {
        return { content: `${name} failed: ${err.message}`, isError: true };
      }
    },
  };

  return {
    search,
    call,
    /** Names to advertise in addition to the core set. */
    promotedNames: () => [...promoted],
    promotedCount: () => promoted.size,
  };
}

/**
 * Build the advertised tool list for a model call.
 *
 * @param {object} registry        the full registry
 * @param {object} searcher        result of createToolSearcher
 * @param {{defer?: boolean}} opts defer=false advertises everything (a big-context
 *                                 model can afford it); defer=true advertises only
 *                                 the core set plus promoted tools.
 */
export function advertisedSpecs(registry, searcher, opts = {}) {
  const defer = opts.defer === true;
  if (!defer) return registry.specs();
  const names = new Set([...CORE_ALWAYS, ...searcher.promotedNames()]);
  // tool_call/tool_search are always present when deferring.
  names.add('tool_search');
  names.add('tool_call');
  return registry.specs().filter((s) => names.has(s.name));
}

/**
 * Decide whether to defer. A model needs room for the conversation AND the tool
 * schemas; if the full catalogue would eat more than a third of the window, the
 * schemas have to be fetched on demand.
 */
export function shouldDefer(registry, contextWindow, systemTokens = 0) {
  const bytes = JSON.stringify(registry.specs()).length;
  const schemaTokens = Math.round(bytes / 3.6);
  const budget = contextWindow - systemTokens;
  return schemaTokens > Math.max(4000, budget * 0.33);
}
