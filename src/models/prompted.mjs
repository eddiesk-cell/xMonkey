// Prompted-JSON provider wrapper.
//
// The whole point of xMonkey is "any model, including the ones you run on your
// own laptop". A lot of local models — and every base completion model — cannot
// emit structured tool calls. Instead of refusing to work with them, this
// wrapper emulates the tool protocol in the prompt:
//
//   - the tool catalogue is rendered as text into the system prompt
//   - the model is told to answer either with prose, or with exactly one fenced
//     ```json {"tool": ..., "input": ...} ``` block
//   - we parse that block back out and turn it into a normal `tool_use` block
//
// Everything above this layer sees a provider with `nativeTools: true`, because
// the wrapper *converts* — which keeps the agent loop vendor-agnostic and lets a
// 4-bit 8B model drive the same tools as a frontier model.

import { CAP_DEFAULTS, newId, estimateTokens } from '../core/types.mjs';

const PROTOCOL = `## Tool protocol

You have tools available. You cannot call them through an API, so you must follow this
protocol exactly.

Available tools:

<<TOOLS>>

### When you need a tool
Reply with prose FIRST (one or two sentences saying what you are doing), then exactly one
fenced block, in this shape and nothing after it:

\`\`\`json
{"tool": "tool_name", "input": { ... }}
\`\`\`

Rules:
- One tool per reply. Never put two JSON blocks in one reply.
- \`input\` must be a JSON object matching that tool's schema. Use real values, never placeholders.
- Do not invent tool names. If no tool fits, answer in prose with no block.
- After you use a tool you will be shown its result, then you continue.

### When you are finished
Say so in prose and do not emit a JSON block.`;

/**
 * Wrap a provider so models without native tool support can still act.
 * @param {{complete: Function, capabilities: object, model: string, id: string}} inner
 * @param {{force?: boolean}} [opts]
 */
export function withPromptedTools(inner, opts = {}) {
  // Only the capability we actually change is overridden. Spreading CAP_DEFAULTS
  // over the inner capabilities used to mask `systemRole:false`, which made the
  // outer capability wrapper believe the model could take a system role and skip
  // the fold — losing the instructions entirely for models that lack both.
  const capabilities = {
    ...inner.capabilities,
    nativeTools: true,          // the wrapper earns this by emulating the protocol
  };
  const usePrompted = opts.force === true || !inner.capabilities?.nativeTools;

  async function complete({ system, messages, tools, maxTokens, temperature, signal, onText, onThinking }) {
    if (!usePrompted || !tools?.length) {
      return inner.complete({ system, messages, tools: inner.capabilities?.nativeTools ? tools : [], maxTokens, temperature, signal, onText, onThinking });
    }

    const withProtocol = `${system || ''}\n\n${renderProtocol(tools)}`;

    // If the model has no system role, the catalogue must travel in a user turn.
    // This has to happen HERE, before the request leaves this wrapper, because a
    // later fold would move instructions the model already needed as system.
    const hasSystemRole = inner.capabilities?.systemRole !== false;
    const trimmed = trimForContext(
      hasSystemRole ? messages : foldIntoTurn(messages, withProtocol),
      capabilities.contextWindow,
      hasSystemRole ? withProtocol : ''
    );

    let outText = '';
    const res = await inner.complete({
      system: hasSystemRole ? withProtocol : '',
      messages: trimmed,
      tools: [],                 // never pass schemas down: this model can't use them
      maxTokens,
      temperature,
      signal,
      onText: (c) => { outText += c; if (onText) onText(c); },
      onThinking,
    });

    // Some providers (and every non-streaming path) return the text in the
    // completion instead of invoking onText. Parsing only the streamed buffer
    // would then miss every tool call, so fall back to the returned content.
    if (!outText) {
      outText = res.content
        .filter((b) => b.type === 'text')
        .map((b) => b.text)
        .join('');
    }

    const parsed = extractToolCall(outText, tools);
    if (!parsed) {
      return { ...res, stopReason: res.stopReason === 'tool_use' ? 'end_turn' : res.stopReason };
    }

    // Rebuild content: prose we already streamed stays as text, the JSON block is
    // replaced by a real tool_use block.
    const prose = outText.replace(parsed.rawBlock, '').trim();
    const content = [];
    if (prose) content.push({ type: 'text', text: prose });
    content.push({ type: 'tool_use', id: newId('toolu_'), name: parsed.name, input: parsed.input });
    return { content, stopReason: 'tool_use', usage: res.usage };
  }

  // `upstream` exposes what the wrapped model can really do, so an outer wrapper
  // can decide on the ORIGINAL capabilities rather than the emulated ones.
  return { ...inner, capabilities, upstream: inner.capabilities ?? {}, complete, promptedTools: usePrompted };
}

/** Put instructions at the top of the first user turn (no system-role models). */
function foldIntoTurn(messages, system) {
  if (!system) return messages;
  const rest = messages.map((m) => ({ role: m.role, content: [...m.content] }));
  const at = rest.findIndex((m) => m.role === 'user');
  if (at === -1) return [{ role: 'user', content: [{ type: 'text', text: system }] }, ...rest];
  const original = rest[at].content.map((b) => (b.type === 'text' ? b.text : '')).join('\n\n');
  rest[at] = { role: 'user', content: [{ type: 'text', text: `${system}\n\n---\n\n${original}` }] };
  return rest;
}

function renderProtocol(tools) {
  const lines = tools.map((t) => {
    const schema = JSON.stringify(t.inputSchema ?? {});
    return `- \`${t.name}\` — ${t.description}\n  input schema: ${schema}`;
  });
  return PROTOCOL.replace('<<TOOLS>>', lines.join('\n'));
}

/** Find the last fenced json block that names a real tool. */
export function extractToolCall(text, tools) {
  const names = new Set(tools.map((t) => t.name));
  const fenceRe = /```(?:json|JSON)?\s*\n?([\s\S]*?)```/g;
  let match;
  const candidates = [];
  while ((match = fenceRe.exec(text)) !== null) {
    candidates.push({ body: match[1].trim(), rawBlock: match[0] });
  }
  // Also accept a bare JSON object as a last resort (small models forget fences).
  if (!candidates.length) {
    const bare = text.match(/\{\s*"tool"\s*:[\s\S]*\}/);
    if (bare) candidates.push({ body: bare[0], rawBlock: bare[0] });
  }
  // Prefer the last candidate: a model may narrate earlier attempts.
  //
  // A candidate counts only if it names a real tool. That matters because the
  // protocol instructions themselves contain an example block
  // `{"tool": "tool_name"}`; treating that as a call both invents a tool and
  // swallows the model's actual reply, so it is skipped by construction here.
  for (let i = candidates.length - 1; i >= 0; i--) {
    const parsed = tryParseTool(candidates[i].body, names);
    if (parsed) return { ...parsed, rawBlock: candidates[i].rawBlock };
  }
  return null;
}

function tryParseTool(body, names) {
  let obj;
  try {
    obj = JSON.parse(body);
  } catch {
    return null;
  }
  // Accept {"tool","input"} and the common variants small models produce.
  const name = obj.tool ?? obj.name ?? obj.function;
  const input = obj.input ?? obj.arguments ?? obj.parameters ?? obj.args ?? {};
  if (typeof name !== 'string' || !names.has(name)) return null;
  // Reject the protocol's own placeholder, whatever a caller's tool list looks like.
  if (name === 'tool_name' || name === 'name') return null;
  return { name, input: typeof input === 'object' && input !== null ? input : {} };
}

/** Keep the prompt inside the model's window: drop the oldest turns, keep the system. */
function trimForContext(messages, contextWindow, system) {
  const budget = Math.max(1024, contextWindow - estimateTokens(system) - 2048);
  let total = 0;
  const kept = [];
  for (let i = messages.length - 1; i >= 0; i--) {
    const cost = estimateTokens(JSON.stringify(messages[i]));
    if (total + cost > budget && kept.length > 0) break;
    total += cost;
    kept.unshift(messages[i]);
  }
  return kept;
}
