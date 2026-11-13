// Configuration.
//
// Resolution order (first wins per key):
//   1. explicit CLI flags
//   2. ./xmonkey.config.json          (project)
//   3. ~/.config/xmonkey/config.json  (user)
//   4. environment variables
//   5. auto-detected local runtime (Ollama, LM Studio on their default ports)
//
// The point of step 5 is that `xmonkey` with no configuration at all should
// still find a model if the user has one running locally. A coding agent that
// insists on an API key before it will start is not "local-model friendly".

import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { probe } from './models/ollama.mjs';
import { probe as probeOpenAI } from './models/openai.mjs';

export const DEFAULT_CONFIG_PATHS = (cwd = process.cwd()) => [
  path.join(cwd, 'xmonkey.config.json'),
  path.join(os.homedir(), '.config', 'xmonkey', 'config.json'),
];

/** A config file that works with zero setup: the local model you already have. */
export const EXAMPLE_CONFIG = {
  models: {
    local: { kind: 'ollama', baseUrl: 'http://127.0.0.1:11434', model: 'qwen2.5-coder:7b' },
    lmstudio: { kind: 'lmstudio', baseUrl: 'http://127.0.0.1:1234/v1', model: 'local-model' },
    sonnet: { kind: 'anthropic', model: 'claude-sonnet-4-5' },
    gpt: { kind: 'openai', model: 'gpt-4o-mini' },
  },
  default: 'local',
  permissions: {
    mode: 'default',
    rules: [
      { tool: 'bash', pattern: '^git (status|diff|log)', action: 'allow' },
      { tool: 'bash', pattern: '^rm -rf /', action: 'deny' },
    ],
  },
  loop: { maxTurns: 60 },
};

function mergeHooks(base = {}, add = {}) {
  const out = { ...base };
  for (const [event, list] of Object.entries(add)) {
    out[event] = [...(out[event] ?? []), ...(Array.isArray(list) ? list : [list])];
  }
  return out;
}

export async function loadConfig({ cwd = process.cwd(), flags = {} } = {}) {
  // DEFAULT_CONFIG_PATHS is ordered [project, user]. Precedence is the opposite:
  // USER is the base and PROJECT overrides it. So we read in path order and then
  // apply in reverse, which applies the user file first and the project file last.
  const configs = [];
  for (const p of DEFAULT_CONFIG_PATHS(cwd)) {
    try {
      const raw = await fs.readFile(p, 'utf8');
      configs.push({ path: p, data: JSON.parse(raw) });
    } catch (err) {
      if (err.code === 'ENOENT') continue;
      if (err instanceof SyntaxError) {
        throw new Error(
          `${p} is not valid JSON: ${err.message}\n` +
          `Fix the syntax, or delete the file and run \`xmonkey --init\` to regenerate it.`
        );
      }
      throw new Error(`cannot read ${p}: ${err.message}`);
    }
  }

  const merged = {
    models: {},
    default: undefined,
    permissions: { mode: 'default', rules: [] },
    loop: { maxTurns: 60, maxTokens: 8192 },
    mcpServers: {},
    hooks: {},
    sources: configs.map((c) => c.path),
  };

  // `configs` arrives [project, user]. Applying it REVERSED (user, then project)
  // means the project file is merged last and wins per key. Each section is
  // shallow-merged so a project can override one key without dropping the rest.
  for (const { data } of [...configs].reverse()) {
    Object.assign(merged.models, data.models || {});
    if (data.default) merged.default = data.default;
    if (data.permissions) merged.permissions = { ...merged.permissions, ...data.permissions };
    if (data.loop) merged.loop = { ...merged.loop, ...data.loop };
    if (data.mcpServers) merged.mcpServers = { ...(merged.mcpServers || {}), ...data.mcpServers };
    if (data.hooks) merged.hooks = mergeHooks(merged.hooks, data.hooks);
  }

  // Pick the model before flags, so we can tell "the user named a real model"
  // apart from "nothing is configured and we should auto-detect".
  merged.selected = flags.model || merged.default;

  // Flags win.
  if (flags.mode) merged.permissions.mode = flags.mode;
  if (flags.maxturns) merged.loop.maxTurns = flags.maxturns;

  // Auto-detect only when there is no usable selection at all.
  if (!merged.selected) {
    const detected = await detectLocalModel();
    if (detected) {
      merged.models[detected.name] = detected.config;
      merged.selected = detected.name;
      merged.detected = detected.reason;
    }
  }
  return merged;
}

/**
 * Find a model that is actually running on this machine right now.
 * Ollama first (it is the most common local runner), then any OpenAI-compatible
 * server on the usual LM Studio / llama.cpp ports.
 */
export async function detectLocalModel() {
  // Honour OLLAMA_HOST: a user who points it at another port or host means it.
  const ollamaBase = (process.env.OLLAMA_HOST || 'http://127.0.0.1:11434').replace(/\/+$/, '');
  const ollama = await probe(ollamaBase);
  if (ollama.ok && ollama.models?.length) {
    // Never pick an embedding model: it cannot chat, let alone run tools.
    const chat = ollama.models.filter((m) => !/embed|bge|nomic-embed|minilm|e5-|rerank/i.test(m));
    if (chat.length) {
      // Prefer something trained for code; among candidates prefer the larger
      // parameter count, because small models are much worse at tool calling.
      const size = (n) => {
        const m = n.match(/(\d+(?:\.\d+)?)\s*b\b/i);
        return m ? parseFloat(m[1]) : 0;
      };
      const ranked = [...chat].sort((a, b) => size(b) - size(a));
      const preferred =
        ranked.find((m) => /coder|devstral|deepseek-coder|codeqwen/i.test(m)) ??
        ranked.find((m) => /qwen|deepseek|llama|gemma|mistral|phi/i.test(m)) ??
        ranked[0];
      return {
        name: 'auto-local',
        reason: `detected a running Ollama with ${chat.length} chat model(s); using ${preferred}`,
        config: { kind: 'ollama', baseUrl: ollamaBase, model: preferred },
        available: chat,
      };
    }
  }
  for (const port of [1234, 8080, 8000, 5000]) {
    const r = await probeOpenAI(`http://127.0.0.1:${port}/v1`);
    if (r.ok && r.models?.length) {
      return {
        name: 'auto-local',
        reason: `detected an OpenAI-compatible server on port ${port}; using ${r.models[0]}`,
        config: { kind: 'openai', baseUrl: `http://127.0.0.1:${port}/v1`, model: r.models[0] },
        available: r.models,
      };
    }
  }
  return null;
}

/** Human-readable explanation of which config files were used. */
export function describeConfig(cfg) {
  const lines = [];
  if (cfg.sources.length) lines.push(`config: ${cfg.sources.join(', ')}`);
  else lines.push('config: none found (using auto-detection / flags)');
  if (cfg.detected) lines.push(`detected: ${cfg.detected}`);
  const m = cfg.models[cfg.selected];
  if (m) lines.push(`model: ${cfg.selected} -> ${m.kind}/${m.model}${m.baseUrl ? ` @ ${m.baseUrl}` : ''}`);
  else lines.push(`model: <none selected>`);
  lines.push(`permission mode: ${cfg.permissions.mode}`);
  return lines.join('\n');
}
