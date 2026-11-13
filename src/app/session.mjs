// Programmatic session API.
//
// The CLI and the desktop app both drive xMonkey through THIS object. One loop,
// one permission path, one session store — the GUI is a different renderer of the
// same events, not a second implementation. That is deliberate: two agent loops
// would drift within a week, and the drift would be invisible until it mattered.
//
// Usage:
//   const session = await createSession({ cwd, model, mode, onEvent, onAsk });
//   await session.send('fix the failing test');
//   await session.close();

import path from 'node:path';
import fs from 'node:fs/promises';

import { loadConfig } from '../config.mjs';
import { buildProvider } from '../models/registry.mjs';
import { buildDefaultRegistry, createTodoStore } from '../tools/index.mjs';
import { runAgent } from '../core/loop.mjs';
import { buildSystemPrompt, loadMemory } from '../core/prompt.mjs';
import { SessionStore } from '../sessions/store.mjs';
import { MODES } from '../permissions/gate.mjs';
import { loadSkills, renderSkillCatalogue, skillTool } from '../ext/skills.mjs';
import { connectMcpServers } from '../ext/mcp.mjs';
import { runHooks, hasHooks } from '../ext/hooks.mjs';
import { subagentTool } from '../ext/subagent.mjs';
import { describeConfig } from '../config.mjs';

const LOCAL_KINDS = new Set(['ollama', 'lmstudio', 'llama.cpp', 'vllm']);

function isLocalUrl(url) {
  if (!url) return false;
  try {
    const h = new URL(url).hostname;
    return h === '127.0.0.1' || h === 'localhost' || h === '::1' || h.endsWith('.local');
  } catch {
    return false;
  }
}

/**
 * @param {object} opts
 * @param {string} opts.cwd
 * @param {string} [opts.modelName]   alias from config, or "kind/model"
 * @param {string} [opts.mode]        permission mode
 * @param {boolean} [opts.autoApprove]
 * @param {(e:object)=>void} [opts.onEvent]
 * @param {(req:object)=>Promise<boolean>} [opts.onAsk]
 * @param {string} [opts.resumeId]
 */
export async function createSession(opts = {}) {
  const cwd = opts.cwd || process.cwd();
  const flags = {};
  if (opts.modelName) flags.model = opts.modelName;
  if (opts.mode) flags.mode = opts.mode;
  if (opts.maxTurns) flags.maxturns = opts.maxTurns;

  const cfg = await loadConfig({ cwd, flags });
  const selected = cfg.selected;
  if (!selected) {
    throw new Error('no model configured and no local model server was detected');
  }

  /**
   * The model to build. `cfg.models[selected]` exists for configured models.
   * A model that was AUTO-DETECTED (e.g. "auto-local") is not in the user's
   * config file — it was discovered from a running server — so the caller can
   * hand its resolved entry in directly. Without this the GUI could show a
   * detected model and then fail to start it, which is exactly what happened.
   */
  const entry = opts.modelConfig ?? cfg.models[selected];
  if (!entry) {
    throw new Error(`unknown model "${selected}". Configured: ${Object.keys(cfg.models).join(', ') || '(none)'}`);
  }

  // loadConfig already merged a key from DEEPSEEK_API_KEY / the auth file into
  // `entry.apiKey`, so the GUI gets credentials without any extra plumbing.
  const provider = buildProvider({ ...entry, apiKey: opts.apiKey || entry.apiKey });
  const mode = opts.autoApprove ? 'bypass' : (opts.mode || cfg.permissions.mode || 'default');
  if (!MODES.includes(mode)) throw new Error(`unknown permission mode "${mode}"`);

  // ---- tools + extensions -------------------------------------------------
  const todos = createTodoStore();
  const toolCtx = { workspace: cwd, todos, maxToolChars: 30_000, allowOutsideWorkspace: !!opts.allowOutside };
  const tools = buildDefaultRegistry(toolCtx);

  const skills = await loadSkills(cwd);
  if (skills.length) tools.register(skillTool(async () => skills));

  let mcpClients = [];
  const mcpErrors = [];
  if (cfg.mcpServers && Object.keys(cfg.mcpServers).length) {
    const { clients, errors } = await connectMcpServers(cfg.mcpServers);
    mcpClients = clients;
    mcpErrors.push(...errors);
    for (const c of clients) {
      for (const t of c.asXmonkeyTools()) {
        try { tools.register(t); } catch { /* built-in wins a name clash */ }
      }
    }
  }

  // The parent's resolved entry is the right default for a subagent: it works for
  // auto-detected models and keeps the child on the same model family.
  tools.register(subagentTool({
    getProvider: () => buildProvider({ ...entry, apiKey: opts.apiKey || entry.apiKey }),
    getTools: () => buildDefaultRegistry({ workspace: cwd, todos: createTodoStore(), maxToolChars: 20_000 }),
    workspace: cwd,
  }));

  const hooks = hasHooks(cfg.hooks) ? cfg.hooks : undefined;

  // ---- memory + prompt ----------------------------------------------------
  const memory = await loadMemory(cwd);
  const local = LOCAL_KINDS.has(entry.kind) || isLocalUrl(entry.baseUrl);
  const system = buildSystemPrompt({
    cwd,
    model: provider.model,
    providerId: provider.id,
    permissionMode: mode,
    toolNames: tools.names(),
    memory: memory.map((m) => `### ${m.path}\n${m.text}`).join('\n\n'),
    extra: renderSkillCatalogue(skills) || undefined,
    local,
  });

  // ---- session store ------------------------------------------------------
  const store = opts.resumeId ? new SessionStore(opts.resumeId) : new SessionStore();
  const history = opts.resumeId ? await store.loadMessages() : [];
  await store.writeMeta({
    model: selected,
    modelName: provider.model,
    providerKind: entry.kind,
    permissionMode: mode,
    cwd,
  });

  let busy = false;
  let aborter = null;
  const onEvent = opts.onEvent ?? (() => {});

  if (hooks) await runHooks(hooks, 'SessionStart', { sessionId: store.id, cwd }, { cwd });

  const session = {
    id: store.id,
    cwd,
    mode,
    local,
    skills: skills.map((s) => ({ id: s.id, description: s.description })),
    mcpServers: mcpClients.map((c) => ({ name: c.name, tools: c.tools.length })),
    mcpErrors,
    configSummary: describeConfig(cfg),
    model: { name: selected, model: provider.model, kind: entry.kind, providerId: provider.id },
    capabilities: provider.capabilities,
    models: Object.entries(cfg.models).map(([name, m]) => ({ name, kind: m.kind, model: m.model, baseUrl: m.baseUrl })),
    history,
    get busy() { return busy; },

    todoItems() { return todos.items; },

    /** Send one user turn. Resolves when the agent has finished the turn. */
    async send(text) {
      if (busy) throw new Error('a turn is already running');
      const prompt = String(text ?? '').trim();
      if (!prompt) throw new Error('empty prompt');
      busy = true;
      aborter = new AbortController();
      const persistFrom = history.length;
      try {
        history.push({ role: 'user', content: [{ type: 'text', text: prompt }] });
        onEvent({ type: 'user', text: prompt });
        await store.append({ kind: 'user', content: prompt });

        const out = await runAgent({
          provider,
          tools,
          messages: history,
          system,
          maxTurns: cfg.loop.maxTurns,
          signal: aborter.signal,
          permissions: { mode, rules: cfg.permissions.rules ?? [], hooks, cwd },
          onAsk: opts.onAsk,
          onEvent,
        });

        for (const m of history.slice(persistFrom)) {
          await store.append({ kind: 'message', role: m.role, content: m.content });
        }
        await store.writeMeta({ lastStopReason: out.stopReason, turns: out.turns, usage: out.usage });
        if (hooks) await runHooks(hooks, 'Stop', { stopReason: out.stopReason }, { cwd }).catch(() => {});
        onEvent({ type: 'turn_done', ...out, sessionId: store.id });
        return out;
      } catch (err) {
        onEvent({ type: 'turn_error', message: err.message });
        throw err;
      } finally {
        busy = false;
        aborter = null;
      }
    },

    abort(reason = 'interrupted by user') {
      if (aborter) aborter.abort(new Error(reason));
    },

    async close() {
      if (hooks) await runHooks(hooks, 'SessionEnd', { sessionId: store.id, cwd }, { cwd }).catch(() => {});
      await Promise.all(mcpClients.map((c) => c.close().catch(() => {})));
      mcpClients = [];
    },
  };

  return session;
}

/** Probe every configured model endpoint. Used by the app's status screen. */
export async function probeModels(cwd) {
  const { probeAll } = await import('../models/registry.mjs');
  const cfg = await loadConfig({ cwd });
  const results = await probeAll(cfg.models);
  return {
    results,
    selected: cfg.selected,
    selectedConfig: cfg.selected ? cfg.models[cfg.selected] : null,
    detected: cfg.detected,
    sources: cfg.sources,
  };
}

/** Read the recent sessions so the app can offer "resume". */
export async function recentSessions(limit = 15) {
  const { listSessions } = await import('../sessions/store.mjs');
  return listSessions(limit);
}

/** Write an example config into a directory. */
export async function scaffoldConfig(dir) {
  const target = path.join(dir, 'xmonkey.config.json');
  try {
    await fs.access(target);
    return { created: false, path: target };
  } catch { /* absent */ }
  const { EXAMPLE_CONFIG } = await import('../config.mjs');
  await fs.writeFile(target, JSON.stringify(EXAMPLE_CONFIG, null, 2) + '\n', 'utf8');
  return { created: true, path: target };
}
