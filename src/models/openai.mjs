// OpenAI-compatible adapter. Covers OpenAI, LM Studio, llama.cpp server,
// vLLM, OpenRouter, DeepSeek, Groq, Together, Ollama's /v1 shim — anything that
// speaks POST /v1/chat/completions with `tools`.
//
// This is the most important adapter for "fit local models too", because the
// overwhelming majority of local inference servers implement this one API.

import { readSSE, streamRequest, jsonRequest, withRetry } from './http.mjs';
import { CAP_DEFAULTS, newId } from '../core/types.mjs';

export const id = 'openai';

export function createProvider(config = {}) {
  const baseUrl = (config.baseUrl || process.env.OPENAI_BASE_URL || 'https://api.openai.com/v1').replace(/\/+$/, '');
  const apiKey = config.apiKey || process.env.OPENAI_API_KEY || 'not-needed';
  const model = config.model || 'gpt-4o-mini';
  const capabilities = {
    ...CAP_DEFAULTS,
    images: config.images !== false,
    thinking: false,
    contextWindow: config.contextWindow || 128_000,
  };

  async function complete({ system, messages, tools, maxTokens, temperature, signal, onText }) {
    const body = {
      model,
      messages: toWireMessages(system, messages),
      stream: true,
      stream_options: { include_usage: true },
      max_tokens: maxTokens,
    };
    if (tools?.length) {
      body.tools = tools.map((t) => ({
        type: 'function',
        function: { name: t.name, description: t.description, parameters: t.inputSchema },
      }));
      body.tool_choice = 'auto';
    }
    if (temperature !== undefined) body.temperature = temperature;

    return withRetry(async () => {
      const res = await streamRequest(`${baseUrl}/chat/completions`, {
        headers: { authorization: `Bearer ${apiKey}` },
        body,
        signal,
      });
      return parseStream(res, { onText });
    }, { signal });
  }

  return { id, model, capabilities, complete };
}

function toWireMessages(system, messages) {
  const out = [];
  if (system) out.push({ role: 'system', content: system });
  for (const m of messages) {
    const toolUses = m.content.filter((b) => b.type === 'tool_use');
    const texts = m.content.filter((b) => b.type === 'text').map((b) => b.text).join('\n');
    const images = m.content.filter((b) => b.type === 'image');

    if (m.role === 'assistant') {
      const msg = { role: 'assistant', content: texts || null };
      if (toolUses.length) {
        msg.tool_calls = toolUses.map((t) => ({
          id: t.id,
          type: 'function',
          function: { name: t.name, arguments: JSON.stringify(t.input ?? {}) },
        }));
      }
      out.push(msg);
      continue;
    }

    // user turn: tool results are their own `tool` messages in this dialect and
    // must directly follow the assistant tool_calls message.
    for (const b of m.content) {
      if (b.type === 'tool_result') {
        out.push({ role: 'tool', tool_call_id: b.toolUseId, content: String(b.content ?? '') });
      } else if (b.type === 'text') {
        out.push({ role: 'user', content: b.text });
      } else if (b.type === 'image') {
        out.push({
          role: 'user',
          content: [{ type: 'image_url', image_url: { url: `data:${b.mediaType};base64,${b.data}` } }],
        });
      }
    }
    if (m.content.length === 0) out.push({ role: 'user', content: '' });
  }
  return out;
}

async function parseStream(res, { onText }) {
  const content = [];
  const toolAcc = new Map();
  let text = '';
  let thinking = '';
  const usage = {};
  let stopReason = 'end_turn';

  await readSSE(res.body, (payload) => {
    if (payload === '[DONE]') return;
    let obj;
    try {
      obj = JSON.parse(payload);
    } catch {
      return;
    }
    if (obj.error) {
      throw Object.assign(new Error(`openai: ${obj.error.message || 'error'}`), {
        retryable: obj.error.type === 'server_error' || obj.error.code === 'rate_limit_exceeded',
        status: obj.error.code === 'rate_limit_exceeded' ? 429 : undefined,
      });
    }
    if (obj.usage) {
      usage.inputTokens = obj.usage.prompt_tokens;
      usage.outputTokens = obj.usage.completion_tokens;
      usage.cacheReadTokens = obj.usage.prompt_tokens_details?.cached_tokens;
    }
    const choice = obj.choices?.[0];
    if (!choice) return;
    const d = choice.delta || {};
    if (d.content) {
      text += d.content;
      if (onText) onText(d.content);
    }
    // Some local servers expose reasoning as a non-standard field.
    const r = d.reasoning_content ?? d.reasoning;
    if (typeof r === 'string' && r) thinking += r;
    if (d.tool_calls) {
      for (const tc of d.tool_calls) {
        const i = tc.index ?? 0;
        const cur = toolAcc.get(i) || { id: tc.id || newId('call_'), name: '', args: '' };
        if (tc.id) cur.id = tc.id;
        if (tc.function?.name) cur.name = tc.function.name;
        if (tc.function?.arguments) cur.args += tc.function.arguments;
        toolAcc.set(i, cur);
      }
    }
    if (choice.finish_reason) stopReason = choice.finish_reason;
  });

  if (thinking) content.push({ type: 'thinking', thinking });
  if (text) content.push({ type: 'text', text });
  const calls = [...toolAcc.values()].filter((c) => c.name);
  for (const c of calls) {
    content.push({ type: 'tool_use', id: c.id, name: c.name, input: parseArgs(c.args) });
  }
  if (calls.length) stopReason = 'tool_use';
  if (!content.length) content.push({ type: 'text', text: '' });
  return { content, stopReason: normalizeStop(stopReason), usage };
}

function normalizeStop(r) {
  if (r === 'tool_calls' || r === 'function_call') return 'tool_use';
  if (r === 'length') return 'max_tokens';
  if (r === 'stop') return 'end_turn';
  return r || 'end_turn';
}

function parseArgs(args) {
  const s = String(args ?? '').trim();
  if (!s) return {};
  try {
    return JSON.parse(s);
  } catch {
    const m = s.match(/\{[\s\S]*\}/);
    if (m) {
      try { return JSON.parse(m[0]); } catch { /* fall through */ }
    }
    return { __raw: s.slice(0, 400), __parseError: true };
  }
}

export async function probe(baseUrl, apiKey) {
  try {
    const res = await jsonRequest(`${baseUrl.replace(/\/+$/, '')}/models`, {
      headers: apiKey ? { authorization: `Bearer ${apiKey}` } : {},
      timeoutMs: 4000,
    });
    const data = await res.json();
    return { ok: true, models: (data.data || []).map((m) => m.id) };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}
