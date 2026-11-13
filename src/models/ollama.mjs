// Ollama / LM Studio-style provider: the "local models are first-class" path.
//
// Two wire dialects are supported behind one adapter:
//   - `ollama-native`: POST /api/chat  (NDJSON stream, `tools` as JSON schema array)
//   - `openai-compat`: POST /v1/chat/completions (SSE, `tools` as function objects)
// Ollama exposes both; LM Studio and llama.cpp expose the OpenAI one. We use the
// native dialect by default because it reports richer per-token stats and does
// not require the `/v1` compatibility shim to be enabled.
//
// REASONING MODELS: many local models (Gemma, Qwen3, DeepSeek-R1 distills) put
// their entire output in a separate `thinking` stream and leave `content` empty
// — sometimes for hundreds of tokens before any answer appears. That is not an
// error and must not produce an empty message: the thinking is preserved as a
// `thinking` block, and if the model never reaches a text answer the caller gets
// an explicit marker rather than "".

import { streamRequest, jsonRequest, truncate, withRetry } from './http.mjs';
import { CAP_DEFAULTS, newId } from '../core/types.mjs';

export const id = 'ollama';

export function createProvider(config = {}) {
  const baseUrl = (config.baseUrl || process.env.OLLAMA_HOST || 'http://127.0.0.1:11434').replace(/\/+$/, '');
  const model = config.model || 'llama3.1';
  const dialect = config.dialect || 'ollama-native';
  const capabilities = {
    ...CAP_DEFAULTS,
    nativeTools: config.nativeTools !== false,
    streaming: true,
    systemRole: true,
    images: false,
    thinking: true,   // Ollama reports a separate `thinking` field
    contextWindow: config.contextWindow || 32_768,
  };
  const temperature = config.temperature;
  const keepAlive = config.keepAlive || '30m';

  async function complete({ system, messages, tools, maxTokens, signal, onText, onThinking }) {
    const wire = toWireMessages(system, messages);
    const body = {
      model,
      messages: wire,
      stream: true,
      options: buildOptions({ maxTokens, temperature, contextWindow: capabilities.contextWindow }),
      keep_alive: keepAlive,
    };
    if (tools?.length && capabilities.nativeTools) body.tools = toOllamaTools(tools);

    const useNative = dialect === 'ollama-native';
    const url = useNative ? `${baseUrl}/api/chat` : `${baseUrl}/v1/chat/completions`;
    if (!useNative) {
      body.tools = tools?.length ? toOpenAITools(tools) : undefined;
      body.max_tokens = maxTokens;
      if (temperature !== undefined) body.temperature = temperature;
    }

    return withRetry(async () => {
      const res = await streamRequest(url, { body, signal });
      if (useNative) return parseOllamaStream(res, { onText, onThinking, model });
      return parseOpenAIStream(res, { onText, onThinking, model });
    }, { signal });
  }

  return { id, model, capabilities, complete };
}

function buildOptions({ maxTokens, temperature, contextWindow }) {
  const o = { num_predict: maxTokens };
  if (temperature !== undefined) o.temperature = temperature;
  if (contextWindow) o.num_ctx = contextWindow;
  return o;
}

function normalizeStop(r) {
  if (r === 'stop') return 'end_turn';
  if (r === 'length') return 'max_tokens';
  return r || 'end_turn';
}

// ---- dialect translation ---------------------------------------------------

/** Our canonical messages -> Ollama /api/chat messages. */
function toWireMessages(system, messages) {
  const out = [];
  if (system) out.push({ role: 'system', content: system });
  for (const m of messages) {
    for (const block of m.content) {
      if (block.type === 'text') {
        if (block.text) pushText(out, m.role, block.text);
      } else if (block.type === 'tool_use') {
        // Ollama wants assistant tool_calls on the assistant turn.
        const last = out[out.length - 1];
        const call = { function: { name: block.name, arguments: block.input } };
        if (last && last.role === 'assistant') (last.tool_calls ||= []).push(call);
        else out.push({ role: 'assistant', content: '', tool_calls: [call] });
      } else if (block.type === 'tool_result') {
        out.push({ role: 'tool', content: String(block.content ?? '') });
      } else if (block.type === 'image') {
        const last = out[out.length - 1];
        if (last && last.role === 'user') (last.images ||= []).push(block.data);
        else out.push({ role: 'user', content: '', images: [block.data] });
      } else if (block.type === 'thinking') {
        // Never re-feed our own reasoning as user-visible text. Some backends
        // accept a `thinking` field on the assistant turn; others reject it, so
        // it is dropped rather than risking a 400.
        continue;
      }
    }
  }
  return out;
}

function pushText(out, role, text) {
  const last = out[out.length - 1];
  if (last && last.role === role) {
    last.content = last.content ? `${last.content}\n${text}` : text;
    return;
  }
  out.push({ role, content: text });
}

function toOllamaTools(tools) {
  return tools.map((t) => ({
    type: 'function',
    function: { name: t.name, description: t.description, parameters: t.inputSchema },
  }));
}

function toOpenAITools(tools) {
  return tools.map((t) => ({
    type: 'function',
    function: { name: t.name, description: t.description, parameters: t.inputSchema },
  }));
}

// ---- stream parsers --------------------------------------------------------

async function parseOllamaStream(res, { onText, onThinking, model }) {
  let text = '';
  let thinking = '';
  const toolCalls = [];
  let usage = {};
  let stopReason = 'end_turn';
  let sawAny = false;

  const handle = (obj) => {
    sawAny = true;
    if (obj.error) throw new Error(`ollama: ${obj.error}`);
    const msg = obj.message || {};
    if (msg.content) {
      text += msg.content;
      if (onText) onText(msg.content);
    }
    if (msg.thinking) {
      thinking += msg.thinking;
      if (onThinking) onThinking(msg.thinking);
    }
    if (Array.isArray(msg.tool_calls)) {
      for (const tc of msg.tool_calls) {
        const fn = tc.function || {};
        toolCalls.push({
          type: 'tool_use',
          id: tc.id || newId('call_'),
          name: fn.name,
          input: normalizeArgs(fn.arguments),
        });
      }
    }
    if (obj.done) {
      if (obj.prompt_eval_count != null) usage.inputTokens = obj.prompt_eval_count;
      if (obj.eval_count != null) usage.outputTokens = obj.eval_count;
      if (obj.done_reason) stopReason = obj.done_reason;
    }
  };

  // Ollama streams NDJSON, not SSE. Read line by line.
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let buf = '';
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i).trim();
      buf = buf.slice(i + 1);
      if (!line) continue;
      handle(JSON.parse(line));
    }
  }
  if (buf.trim()) handle(JSON.parse(buf));

  if (!sawAny) throw new Error(`ollama: empty stream from model "${model}" — is it pulled? (\`ollama list\`)`);

  const content = [];
  if (thinking) content.push({ type: 'thinking', thinking });
  if (text) content.push({ type: 'text', text });
  if (toolCalls.length) {
    content.push(...toolCalls);
    stopReason = 'tool_use';
  }
  // A reasoning model that never reached an answer would otherwise produce an
  // empty assistant turn, which some chat templates reject on the next call.
  if (!content.length) {
    content.push({ type: 'text', text: '[the model returned no text and no tool call]' });
  }
  return { content, stopReason: normalizeStop(stopReason), usage };
}

async function parseOpenAIStream(res, { onText, onThinking, model }) {
  let text = '';
  let thinking = '';
  const toolAcc = new Map();
  let usage = {};
  let stopReason = 'end_turn';
  let sawAny = false;

  const handle = (obj) => {
    sawAny = true;
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
    // Local servers expose reasoning under several non-standard names.
    const r = d.reasoning_content ?? d.reasoning ?? d.thinking;
    if (typeof r === 'string' && r) {
      thinking += r;
      if (onThinking) onThinking(r);
    }
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
  };

  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let buf = '';
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      let line = buf.slice(0, i);
      buf = buf.slice(i + 1);
      if (line.endsWith('\r')) line = line.slice(0, -1);
      if (!line.startsWith('data:')) continue;
      const payload = line.slice(5).trim();
      if (!payload || payload === '[DONE]') continue;
      try {
        handle(JSON.parse(payload));
      } catch (err) {
        if (err.message?.startsWith('openai:')) throw err;
        // A malformed frame from a local server must not kill the stream.
      }
    }
  }

  if (!sawAny) throw new Error(`openai-compatible: empty stream from model "${model}"`);

  const content = [];
  if (thinking) content.push({ type: 'thinking', thinking });
  if (text) content.push({ type: 'text', text });
  const calls = [...toolAcc.values()].filter((c) => c.name);
  for (const c of calls) content.push({ type: 'tool_use', id: c.id, name: c.name, input: normalizeArgs(c.args) });
  if (calls.length) stopReason = 'tool_use';
  if (!content.length) content.push({ type: 'text', text: '[the model returned no text and no tool call]' });
  return { content, stopReason: normalizeStop(stopReason), usage };
}

/** Argument payloads arrive as object (native) or string (OpenAI) — normalise. */
function normalizeArgs(args) {
  if (args == null) return {};
  if (typeof args === 'object') return args;
  const s = String(args).trim();
  if (!s) return {};
  try {
    return JSON.parse(s);
  } catch {
    // Small local models sometimes wrap JSON in fences or prose. Recover if we can.
    const m = s.match(/\{[\s\S]*\}/);
    if (m) {
      try { return JSON.parse(m[0]); } catch { /* fall through */ }
    }
    return { __raw: truncate(s, 400), __parseError: true };
  }
}

/** Quick reachability probe used by `xmonkey doctor`. */
export async function probe(baseUrl = 'http://127.0.0.1:11434') {
  const url = `${baseUrl.replace(/\/+$/, '')}/api/tags`;
  try {
    const res = await jsonRequest(url, { timeoutMs: 3000 });
    const data = await res.json();
    return { ok: true, models: (data.models || []).map((m) => m.name) };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}
