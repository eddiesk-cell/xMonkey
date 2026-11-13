// Provider registry: turns user config into a live provider.
//
// This is the file that makes "choose your model" real. A user adds an entry to
// xmonkey.config.json; that entry names a `kind` (dialect) plus endpoint/model,
// and everything else — capabilities, tool protocol, streaming — is derived.

import * as anthropic from './anthropic.mjs';
import * as openai from './openai.mjs';
import * as ollama from './ollama.mjs';
import { withPromptedTools } from './prompted.mjs';
import { applyCapabilities } from './capabilities.mjs';

const ADAPTERS = {
  anthropic,
  openai,
  ollama,
  // Aliases so config reads naturally for local setups.
  lmstudio: openai,
  'llama.cpp': openai,
  vllm: openai,
  openrouter: openai,
  groq: openai,
  // DeepSeek exposes an OpenAI-compatible API; this alias documents intent and
  // gives `doctor` the right endpoint to probe.
  deepseek: openai,
};

export const ADAPTER_IDS = Object.keys(ADAPTERS);

/**
 * Build a provider from a resolved config block.
 * @param {{
 *   kind: string, model: string, baseUrl?: string, apiKey?: string,
 *   contextWindow?: number, nativeTools?: boolean, temperature?: number,
 *   maxTokens?: number, dialect?: string,
 * }} cfg
 */
export function buildProvider(cfg) {
  const adapter = ADAPTERS[cfg.kind];
  if (!adapter) {
    throw new Error(`unknown provider kind "${cfg.kind}". Known: ${[...new Set(Object.keys(ADAPTERS))].join(', ')}`);
  }
  const inner = adapter.createProvider(cfg);

  // Wrapper order is load-bearing. The prompted-tools wrapper must run INNERMOST:
  // it is the one that renders the tool catalogue into a system prompt and parses
  // the JSON block back out. The capability wrapper, outermost, rewrites the
  // messages for a model with no system role.
  //
  // Done the other way round (capabilities inner), the fold empties `system`
  // before the tool wrapper reads it, and the model receives neither a system
  // prompt nor a tool catalogue — a silent, total loss of instructions. There is
  // a test for exactly this combination (model lacks BOTH native tools and a
  // system role), because it is the case local models actually hit.
  const withTools = withPromptedTools(inner, { force: cfg.nativeTools === false });
  const provider = applyCapabilities(withTools);
  provider.maxTokens = cfg.maxTokens || 8192;
  return provider;
}

/** Probe every endpoint the user has configured so `doctor` can report reality. */
export async function probeAll(models) {
  const results = [];
  for (const [name, cfg] of Object.entries(models || {})) {
    const kind = cfg.kind;
    if (kind === 'ollama') {
      const r = await ollama.probe(cfg.baseUrl);
      // Ollama reports `name:tag`; a config may omit the tag (`llama3.1` means `llama3.1:latest`).
      const want = String(cfg.model ?? '');
      const hasModel = r.ok && (r.models ?? []).some((m) => m === want || m === `${want}:latest` || m.startsWith(`${want}:`));
      results.push({ name, kind, ...r, hasModel });
    } else if (kind === 'anthropic') {
      const key = cfg.apiKey || process.env.ANTHROPIC_API_KEY;
      const r = key ? await anthropic.probe(key, cfg.baseUrl) : { ok: false, error: 'no API key' };
      results.push({ name, kind, ...r });
    } else {
      const r = await openai.probe(cfg.baseUrl || 'http://127.0.0.1:8000/v1', cfg.apiKey);
      results.push({ name, kind, ...r });
    }
  }
  return results;
}
