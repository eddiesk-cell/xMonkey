// Subagents: delegate a self-contained job to a fresh agent with its own context.
//
// The reason to have this at all: the parent's context is the scarcest resource
// in a long session. A subagent reads ten files, burns its own window, and
// returns one paragraph. The parent never sees the ten files.
//
// Deliberate constraints (learned from watching agents misuse delegation):
//   - depth is capped, so a subagent cannot spawn a subagent forever
//   - the subagent gets a FRESH conversation, not the parent's history; the
//     caller must supply a self-contained prompt (the tool says so explicitly)
//   - the subagent runs with a read-only-by-default permission mode unless the
//     caller opts into a mutating one

import { runAgent } from '../core/loop.mjs';
import { buildSystemPrompt } from '../core/prompt.mjs';

export const MAX_SUBAGENT_DEPTH = 2;

/**
 * Create the `task` tool bound to a provider and a tool registry factory.
 *
 * @param {object} deps
 * @param {() => object} deps.getProvider      builds a provider for the child
 * @param {() => object} deps.getTools         builds a registry for the child
 * @param {string} deps.workspace
 * @param {number} [deps.depth]
 */
export function subagentTool(deps) {
  const depth = deps.depth ?? 0;
  return {
    name: 'task',
    description:
      'Delegate a self-contained job to a fresh subagent and get back its final report. ' +
      'The subagent does NOT see this conversation, so the prompt must contain everything it needs: ' +
      'paths, the goal, and the definition of done. Use it for a wide search or an independent ' +
      'verification; do not use it for work you could do in one or two tool calls.',
    inputSchema: {
      type: 'object',
      properties: {
        prompt: {
          type: 'string',
          description: 'A complete, self-contained brief. Include paths and acceptance criteria.',
        },
        description: { type: 'string', description: 'Short label for this subtask (3-6 words).' },
        maxTurns: { type: 'number', description: 'Turn budget for the subagent (default 20).' },
        mode: {
          type: 'string',
          enum: ['plan', 'default'],
          description: 'Subagent permission mode. Default "plan" (read-only).',
        },
      },
      required: ['prompt'],
      additionalProperties: false,
    },
    isReadOnly: false,
    isConcurrencySafe: true,   // the child gets its own history and tools
    validate(input) {
      if (depth >= MAX_SUBAGENT_DEPTH) {
        return { ok: false, error: `subagent depth limit reached (${MAX_SUBAGENT_DEPTH}); finish this job directly` };
      }
      if (String(input.prompt ?? '').trim().length < 20) {
        return { ok: false, error: 'the prompt must be a self-contained brief, not a few words' };
      }
      return { ok: true };
    },
    async run(input, ctx) {
      if (depth >= MAX_SUBAGENT_DEPTH) {
        return { content: 'subagent depth limit reached', isError: true };
      }
      const provider = deps.getProvider();
      const tools = deps.getTools(depth + 1);
      const mode = input.mode ?? 'plan';
      const system = buildSystemPrompt({
        cwd: deps.workspace,
        model: provider.model,
        providerId: provider.id,
        permissionMode: mode,
        toolNames: tools.names(),
        extra: `You are a subagent working for another agent. Your final message IS your report: ` +
          `state what you found or did, and cite the files you looked at. The caller cannot see your ` +
          `tool calls, only your final message.`,
      });
      const messages = [{ role: 'user', content: [{ type: 'text', text: input.prompt }] }];

      const out = await runAgent({
        provider,
        tools,
        messages,
        system,
        maxTurns: input.maxTurns ?? 20,
        permissions: { mode, rules: [] },
        // A subagent never prompts: a prompt inside a subagent would be a silent
        // deadlock in headless use. Denials come back as tool errors instead.
        onAsk: undefined,
      });

      const report = out.finalText?.trim() || '(the subagent produced no final text)';
      const label = input.description ? ` [${input.description}]` : '';
      return {
        content:
          `Subagent report${label} — ${out.turns} turn(s), stop: ${out.stopReason}\n\n${report}`,
        isError: out.stopReason !== 'end_turn',
      };
    },
  };
}
