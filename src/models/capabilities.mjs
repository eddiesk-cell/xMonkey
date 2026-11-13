// Capability adapters: make the declared capability flags actually DO something.
//
// Previously these flags were decorative — documented in the provider contract
// and read by nothing. A flag that no code reads is a lie in the type system, so
// each one is applied here, in one place, wrapped around every provider.
//
//   systemRole: false   the model has no system role, so the system prompt is
//                       folded into the first user message instead of being
//                       dropped on the floor.
//   streaming: false    the caller ignores incremental callbacks; nothing to do
//                       at this layer (adapters always stream on the wire).
//
// `nativeTools` is applied by prompted.mjs and `contextWindow` by the loop, so
// they are not repeated here.

/** Fold a system prompt into the first user turn. */
export function foldSystemIntoFirstUser(system, messages) {
  if (!system) return { system: '', messages };
  const rest = messages.map((m) => ({ role: m.role, content: [...m.content] }));
  const firstUser = rest.findIndex((m) => m.role === 'user');
  if (firstUser === -1) {
    return { system: '', messages: [{ role: 'user', content: [{ type: 'text', text: system }] }, ...rest] };
  }
  const target = rest[firstUser];
  rest[firstUser] = {
    role: 'user',
    content: [{ type: 'text', text: `${system}\n\n---\n\n${target.content.map(blockToText).join('\n\n')}` }],
  };
  return { system: '', messages: rest };
}

function blockToText(b) {
  if (b.type === 'text') return b.text;
  if (b.type === 'tool_result') return `[tool result]\n${b.content}`;
  if (b.type === 'tool_use') return `[tool call ${b.name}] ${JSON.stringify(b.input)}`;
  return '';
}

/**
 * Wrap a provider so its declared capabilities are honoured.
 * @param {object} provider  { id, model, capabilities, complete }
 */
export function applyCapabilities(provider) {
  // Decide on the ORIGINAL capabilities when a wrapper (e.g. prompted tools)
  // reports emulated ones: `provider.upstream` is the real model's set.
  const caps = provider.upstream ?? provider.capabilities ?? {};
  if (caps.systemRole !== false) return provider;

  return {
    ...provider,
    capabilities: { ...caps, systemRole: true },
    async complete(req) {
      const folded = foldSystemIntoFirstUser(req.system, req.messages);
      return provider.complete({ ...req, system: folded.system, messages: folded.messages });
    },
  };
}
