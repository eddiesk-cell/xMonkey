// Anthropic Messages API adapter.
// Wire doc: POST /v1/messages with `x-api-key`, `anthropic-version`, SSE when
// `stream: true`. Content blocks map almost 1:1 to our canonical form, which is
// why this adapter is the shortest of the three.

import { readSSE, streamRequest, jsonRequest, withRetry } from './http.mjs';
import { CAP_DEFAULTS, newId } from '../core/types.mjs';

export const id = 'anthropic';

export function createProvider(config = {}) {
  const baseUrl = (config.baseUrl || process.env.ANTHROPIC_BASE_URL || 'https://api.anthropic.com').replace(/\/+$/, '');
  const apiKey = config.apiKey || process.env.ANTHROPIC_API_KEY || process.env.ANTHROPIC_AUTH_TOKEN;
  const model = config.model || 'claude-sonnet-4-5';
  const version = config.version || '2023-06-01';
  const capabilities = {
    ...CAP_DEFAULTS,
    images: true,
    thinking: true,
    contextWindow: config.contextWindow || 200_000,
  };

  async function complete({ system, messages, tools, maxTokens, temperature, signal, onText, onThinking }) {
    if (!apiKey && !config.baseUrl) {
      throw new Error('anthropic: no API key. Set ANTHROPIC_API_KEY or pass --api-key.');
    }
    const body = {
      model,
      max_tokens: maxTokens,
      system: system ? [{ type: 'text', text: system, cache_control: { type: 'ephemeral' } }] : undefined,
      messages: toWireMessages(messages),
      stream: true,
    };
    if (tools?.length) {
      body.tools = tools.map((t) => ({ name: t.name, description: t.description, input_schema: t.inputSchema }));
    }
    if (temperature !== undefined) body.temperature = temperature;

    return withRetry(async () => {
      const res = await streamRequest(`${baseUrl}/v1/messages`, {
        headers: { 'x-api-key': apiKey, 'anthropic-version': version, 'anthropic-beta': 'interleaved-thinking-2025-05-14' },
        body,
        signal,
      });
      return parseStream(res, { onText, onThinking });
    }, { signal });
  }

  return { id, model, capabilities, complete };
}

function toWireMessages(messages) {
  return messages.map((m) => ({
    role: m.role,
    content: m.content.map((b) => {
      switch (b.type) {
        case 'text':
          return { type: 'text', text: b.text };
        case 'image':
          return { type: 'image', source: { type: 'base64', media_type: b.mediaType, data: b.data } };
        case 'tool_use':
          return { type: 'tool_use', id: b.id, name: b.name, input: b.input };
        case 'tool_result':
          return { type: 'tool_result', tool_use_id: b.toolUseId, content: b.content, is_error: !!b.isError };
        case 'thinking':
          return { type: 'thinking', thinking: b.thinking };
        default:
          throw new Error(`anthropic: unknown content block ${b.type}`);
      }
    }),
  }));
}

async function parseStream(res, { onText, onThinking }) {
  const blocks = [];        // accumulated by index
  const partialJson = new Map();
  const usage = {};
  let stopReason = 'end_turn';

  await readSSE(res.body, async (payload) => {
    let evt;
    try {
      evt = JSON.parse(payload);
    } catch {
      return;
    }
    switch (evt.type) {
      case 'message_start':
        if (evt.message?.usage) {
          usage.inputTokens = evt.message.usage.input_tokens;
          usage.cacheReadTokens = evt.message.usage.cache_read_input_tokens;
          usage.cacheWriteTokens = evt.message.usage.cache_creation_input_tokens;
        }
        break;
      case 'content_block_start': {
        const b = evt.content_block;
        if (b.type === 'text') blocks[evt.index] = { type: 'text', text: b.text ?? '' };
        else if (b.type === 'thinking') blocks[evt.index] = { type: 'thinking', thinking: b.thinking ?? '' };
        else if (b.type === 'tool_use') {
          blocks[evt.index] = { type: 'tool_use', id: b.id || newId('toolu_'), name: b.name, input: {} };
          partialJson.set(evt.index, '');
        }
        break;
      }
      case 'content_block_delta': {
        const d = evt.delta;
        const cur = blocks[evt.index];
        if (!cur) break;
        if (d.type === 'text_delta') {
          cur.text += d.text;
          if (onText) onText(d.text);
        } else if (d.type === 'thinking_delta') {
          cur.thinking += d.thinking;
          if (onThinking) onThinking(d.thinking);
        } else if (d.type === 'input_json_delta') {
          partialJson.set(evt.index, (partialJson.get(evt.index) || '') + d.partial_json);
        }
        break;
      }
      case 'content_block_stop': {
        const cur = blocks[evt.index];
        if (cur?.type === 'tool_use') {
          const raw = partialJson.get(evt.index) || '';
          cur.input = safeParseJson(raw);
        }
        break;
      }
      case 'message_delta':
        if (evt.delta?.stop_reason) stopReason = evt.delta.stop_reason;
        if (evt.usage) {
          if (evt.usage.output_tokens != null) usage.outputTokens = evt.usage.output_tokens;
          if (evt.usage.input_tokens != null) usage.inputTokens = evt.usage.input_tokens;
        }
        break;
      case 'error':
        throw Object.assign(new Error(`anthropic: ${evt.error?.message || 'stream error'}`), {
          retryable: evt.error?.type === 'overloaded_error',
        });
      default:
        break;
    }
  });

  const content = blocks.filter(Boolean);
  if (!content.length) content.push({ type: 'text', text: '' });
  // Anthropic reports stop_reason 'tool_use' when it wants us to run tools.
  return { content, stopReason: stopReason || 'end_turn', usage };
}

function safeParseJson(raw) {
  const s = String(raw || '').trim();
  if (!s) return {};
  try {
    return JSON.parse(s);
  } catch {
    return { __raw: s.slice(0, 400), __parseError: true };
  }
}

export async function probe(apiKey, baseUrl = 'https://api.anthropic.com') {
  try {
    const res = await jsonRequest(`${baseUrl.replace(/\/+$/, '')}/v1/models`, {
      headers: { 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' },
      timeoutMs: 5000,
    });
    const data = await res.json();
    return { ok: true, models: (data.data || []).map((m) => m.id) };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}
