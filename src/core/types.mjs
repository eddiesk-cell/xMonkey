// xMonkey core types. Plain JS with JSDoc so there is no build step.
//
// Design note: every provider — cloud or local — speaks one internal shape.
// Messages are provider-neutral; each adapter translates to/from its wire
// dialect. Nothing above `src/models/` knows what vendor is underneath.

/**
 * A content block inside a message. This is OUR canonical form; adapters map it.
 *
 * @typedef {(
 *   | { type: 'text', text: string }
 *   | { type: 'thinking', thinking: string }
 *   | { type: 'image', mediaType: string, data: string }
 *   | { type: 'tool_use', id: string, name: string, input: Record<string, unknown> }
 *   | { type: 'tool_result', toolUseId: string, content: string, isError?: boolean }
 * )} ContentBlock
 */

/**
 * @typedef {Object} Message
 * @property {'user'|'assistant'} role
 * @property {ContentBlock[]} content
 */

/**
 * Capabilities a provider reports for a specific model. The loop consults these
 * instead of assuming: a model without `nativeTools` gets the prompted-JSON
 * fallback, a model without `systemRole` gets the system prompt folded into the
 * first user turn, and so on.
 *
 * @typedef {Object} Capabilities
 * @property {boolean} streaming
 * @property {boolean} nativeTools       // real tool-call API support
 * @property {boolean} parallelTools     // may emit >1 tool call per turn
 * @property {boolean} systemRole        // has a real `system` role
 * @property {boolean} images
 * @property {boolean} thinking          // reasoning/thinking channel
 * @property {number}  contextWindow     // tokens
 */

/**
 * @typedef {Object} ToolSpec
 * @property {string} name
 * @property {string} description
 * @property {Record<string, unknown>} inputSchema  // JSON Schema
 */

/**
 * What a provider must return from one completion call.
 *
 * @typedef {Object} Completion
 * @property {ContentBlock[]} content
 * @property {'end_turn'|'tool_use'|'max_tokens'|'stop_sequence'} stopReason
 * @property {{ inputTokens?: number, outputTokens?: number, cacheReadTokens?: number, cacheWriteTokens?: number }} usage
 */

/**
 * Provider interface. Every adapter exports `createProvider(config)` returning
 * this shape.
 *
 * @typedef {Object} Provider
 * @property {string} id
 * @property {string} model
 * @property {Capabilities} capabilities
 * @property {(req: {
 *   system: string,
 *   messages: Message[],
 *   tools: ToolSpec[],
 *   maxTokens: number,
 *   temperature?: number,
 *   signal?: AbortSignal,
 *   onText?: (chunk: string) => void,
 *   onThinking?: (chunk: string) => void,
 * }) => Promise<Completion>} complete
 */

export const CAP_DEFAULTS = {
  streaming: true,
  nativeTools: true,
  parallelTools: true,
  systemRole: true,
  images: false,
  thinking: false,
  contextWindow: 8192,
};

/** Deterministic short id for tool calls and messages. */
export function newId(prefix = '') {
  const rnd = Math.random().toString(36).slice(2, 10);
  const t = Date.now().toString(36).slice(-4);
  return `${prefix}${t}${rnd}`;
}

/** Estimate tokens for a string. Deliberately crude and provider-agnostic. */
export function estimateTokens(text) {
  if (!text) return 0;
  return Math.ceil(String(text).length / 3.6);
}

/** Estimate tokens for a whole message array (content blocks included). */
export function estimateMessages(messages) {
  let n = 0;
  for (const m of messages) {
    n += 4; // role/formatting overhead
    for (const b of m.content) {
      if (b.type === 'text') n += estimateTokens(b.text);
      else if (b.type === 'tool_result') n += estimateTokens(b.content) + 8;
      else if (b.type === 'tool_use') n += estimateTokens(JSON.stringify(b.input)) + 12;
      else if (b.type === 'thinking') n += estimateTokens(b.thinking);
      else if (b.type === 'image') n += 1600;
    }
  }
  return n;
}
