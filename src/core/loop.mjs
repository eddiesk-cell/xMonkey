// The agent loop.
//
// One turn = one model call. The loop repeats until the model stops asking for
// tools, a budget runs out, or the caller aborts.
//
// Invariants that matter more than features:
//   1. A tool result ALWAYS appends exactly one tool_result block per tool_use
//      block. A model that receives an unbalanced history stops making sense.
//   2. A refusal is a tool_result with isError, never a thrown exception: the
//      model must see "no" and adapt, not have the session die.
//   3. The conversation is APPEND-ONLY and verbatim: we push what the model
//      produced and what the tools returned, never rewrite an earlier turn. The
//      caller keeps the array and may persist it; that is why every message is
//      appended in the exact shape it was received.
//   4. Budgets are checked BEFORE the call, so an expensive call is never made
//      with no room to act on its answer.

import { estimateMessages, estimateTokens, newId } from './types.mjs';
import { decide, denialMessage } from '../permissions/gate.mjs';
import { runHooks } from '../ext/hooks.mjs';
import { clipOutput } from '../tools/registry.mjs';

export const STOP = {
  endTurn: 'end_turn',
  maxTurns: 'max_turns',
  maxTokens: 'max_tokens',
  aborted: 'aborted',
  budget: 'context_budget',
  blocked: 'blocked',
};

/**
 * @typedef {Object} LoopEvent
 * @property {string} type  'turn_start'|'text'|'thinking'|'tool_use'|'tool_result'|'usage'|'notice'|'done'|'error'
 */

/**
 * Run the agent loop.
 *
 * @param {object} opts
 * @param {import('../core/types.mjs').Provider} opts.provider
 * @param {import('../tools/registry.mjs').ToolRegistry} opts.tools
 * @param {import('../core/types.mjs').Message[]} opts.messages   conversation (mutated: we own it)
 * @param {string} opts.system
 * @param {object} [opts.permissions]  { mode, rules, ask }
 * @param {number} [opts.maxTurns]
 * @param {number} [opts.maxTokensPerCall]
 * @param {AbortSignal} [opts.signal]
 * @param {(e: LoopEvent) => void} [opts.onEvent]
 * @param {(info: object) => Promise<boolean>} [opts.onAsk]   resolves a permission prompt
 * @returns {Promise<{stopReason: string, turns: number, usage: object, finalText: string}>}
 */
export async function runAgent(opts) {
  const {
    provider, tools, system, signal,
    maxTurns = 60,
    maxTokensPerCall,
    onEvent = () => {},
    onAsk,
  } = opts;

  const messages = opts.messages;
  const permissions = opts.permissions ?? { mode: 'default', rules: [] };
  const maxTokens = maxTokensPerCall ?? provider.maxTokens ?? 8192;
  const capabilities = provider.capabilities ?? {};
  const contextWindow = capabilities.contextWindow ?? 32_768;

  const usageTotal = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0 };
  let turns = 0;
  let finalText = '';

  for (;;) {
    if (signal?.aborted) return finish(STOP.aborted, 'aborted by user');
    if (turns >= maxTurns) {
      return finish(STOP.maxTurns, `stopped after ${maxTurns} turns without finishing`);
    }

    // --- context budget check -------------------------------------------
    const projected = estimateMessages(messages) + estimateTokens(system) + 2048;
    if (projected > contextWindow) {
      const compacted = compactMessages(messages, Math.floor(contextWindow * 0.6));
      const after = estimateMessages(compacted) + estimateTokens(system) + 2048;
      if (after > contextWindow) {
        onEvent({ type: 'notice', level: 'error', message: `context budget exhausted (~${projected}) and compaction did not free enough room` });
        // `blocked` is the honest name: the turn cannot proceed at all, as
        // opposed to `budget` which just means we ran out of room to continue.
        return finish(STOP.blocked, 'context window full and compaction could not free enough room');
      }
      messages.length = 0;
      messages.push(...compacted);
      onEvent({ type: 'notice', level: 'warn', message: `compacted history to fit the model's ${contextWindow}-token window` });
    }

    turns++;
    onEvent({ type: 'turn_start', turn: turns });

    // --- model call ------------------------------------------------------
    let completion;
    try {
      completion = await provider.complete({
        system,
        messages,
        tools: tools.specs(),
        maxTokens,
        signal,
        onText: (chunk) => onEvent({ type: 'text', text: chunk }),
        onThinking: (chunk) => onEvent({ type: 'thinking', text: chunk }),
      });
    } catch (err) {
      if (signal?.aborted) return finish(STOP.aborted, 'aborted by user');
      onEvent({ type: 'error', error: err });
      throw err;
    }

    if (completion.usage) {
      usageTotal.inputTokens += completion.usage.inputTokens ?? 0;
      usageTotal.outputTokens += completion.usage.outputTokens ?? 0;
      usageTotal.cacheReadTokens += completion.usage.cacheReadTokens ?? 0;
      onEvent({ type: 'usage', usage: { ...completion.usage }, total: { ...usageTotal } });
    }

    // Append the assistant turn verbatim — including thinking blocks, so the
    // history we send next turn matches what the model actually produced.
    messages.push({ role: 'assistant', content: completion.content });

    const textParts = completion.content.filter((b) => b.type === 'text').map((b) => b.text).join('');
    if (textParts) finalText = textParts;

    const toolUses = completion.content.filter((b) => b.type === 'tool_use');

    // --- no tools requested: we are done --------------------------------
    if (completion.stopReason !== 'tool_use' || toolUses.length === 0) {
      return finish(
        completion.stopReason === 'max_tokens' ? STOP.maxTokens : STOP.endTurn,
        completion.stopReason === 'max_tokens' ? 'the model hit its output token limit' : ''
      );
    }

    // --- execute tools ---------------------------------------------------
    const results = [];
    for (const call of toolUses) {
      if (signal?.aborted) break;
      onEvent({ type: 'tool_use', id: call.id, name: call.name, input: call.input });

      const outcome = await executeOne({ call, tools, permissions, onAsk, signal, onEvent });
      results.push(outcome.block);
      onEvent({ type: 'tool_result', id: call.id, name: call.name, ...outcome.block, isError: !!outcome.block.isError });
    }

    // Unbalanced history is worse than a fast stop.
    if (results.length !== toolUses.length) {
      for (const call of toolUses.slice(results.length)) {
        results.push({
          type: 'tool_result',
          toolUseId: call.id,
          content: 'Interrupted before this tool ran.',
          isError: true,
        });
      }
    }

    messages.push({ role: 'user', content: results });
  }

  function finish(stopReason, note) {
    // The Stop hook fires when the agent believes it is done, which is the only
    // moment a "you forgot something" hook is useful. It is fire-and-forget:
    // it cannot retroactively deny work that already happened.
    if (permissions.hooks && stopReason === STOP.endTurn) {
      runHooks(permissions.hooks, 'Stop', { stopReason, finalText }, { cwd: permissions.cwd, signal })
        .then((r) => {
          for (const res of r.results ?? []) {
            if (res.stdout?.trim()) onEvent({ type: 'notice', level: 'info', message: `stop hook: ${String(res.stdout).trim().slice(0, 300)}` });
          }
        })
        .catch(() => {});
    }
    if (note) onEvent({ type: 'notice', level: 'info', message: note });
    onEvent({ type: 'done', stopReason, turns, usage: { ...usageTotal }, finalText });
    return { stopReason, turns, usage: { ...usageTotal }, finalText };
  }
}

async function executeOne({ call, tools, permissions, onAsk, signal, onEvent }) {
  const tool = tools.get(call.name);
  if (!tool) {
    const available = tools.names().join(', ');
    return block(call, `xMonkey has no tool named "${call.name}". Available tools: ${available}.`, true);
  }

  const validation = await tools.validate(call.name, call.input);
  if (!validation.ok) {
    return block(call, `Invalid input for ${call.name}: ${validation.error}`, true);
  }

  // User hooks run before the permission gate: a project guard that forbids
  // writing under vendor/ should refuse even in bypass mode.
  let effectiveInput = call.input;
  if (permissions.hooks) {
    const pre = await runHooks(permissions.hooks, 'PreToolUse', {
      toolName: call.name,
      toolUseId: call.id,
      input: effectiveInput,
    }, { cwd: permissions.cwd, signal });
    if (pre.decision === 'deny') {
      onEvent({ type: 'notice', level: 'warn', message: `hook refused ${call.name}: ${pre.reason ?? 'denied'}` });
      return block(call, `xMonkey refused ${call.name}: a PreToolUse hook denied it. ${pre.reason ?? ''} Do not retry.`, true);
    }
    if (pre.updatedInput) effectiveInput = { ...effectiveInput, ...pre.updatedInput };
    // A hook can force the approval prompt for a call the mode would have allowed.
    // Discarding this was a silent hole: a project guard that says "ask me" was ignored.
    if (pre.decision === 'ask') {
      if (!onAsk) {
        return block(call, `a PreToolUse hook requires approval for ${call.name}, but this session cannot ask (headless without --yes). ${pre.reason ?? ''}`, true);
      }
      const ok = await onAsk({ tool: call.name, input: effectiveInput, reason: pre.reason ?? 'a hook requires approval' });
      if (!ok) return block(call, denialMessage({ behavior: 'deny', reason: 'the user declined (a hook required approval)' }, call.name, permissions.mode), true);
    }
  }

  const decision = decide({
    tool: call.name,
    input: effectiveInput,
    mode: permissions.mode,
    rules: permissions.rules ?? [],
    isReadOnly: tool.isReadOnly === true,
  });

  if (decision.behavior === 'deny') {
    onEvent({ type: 'notice', level: 'warn', message: `refused ${call.name}: ${decision.reason}` });
    return block(call, denialMessage(decision, call.name, permissions.mode), true);
  }

  if (decision.behavior === 'ask') {
    if (!onAsk) {
      return block(
        call,
        `xMonkey needs approval to ${decision.reason ?? call.name}, but this session cannot ask ` +
        `(headless mode without --yes). Re-run with --yes or add an allow rule.`,
        true
      );
    }
    const approved = await onAsk({ tool: call.name, input: effectiveInput, reason: decision.reason });
    if (!approved) {
      return block(call, denialMessage({ behavior: 'deny', reason: 'the user declined' }, call.name, permissions.mode), true);
    }
  }

  let result;
  try {
    result = await tools.run(call.name, effectiveInput);
  } catch (err) {
    // A tool failure is data for the model, not a crash for the session.
    onEvent({ type: 'notice', level: 'warn', message: `${call.name} failed: ${err.message}` });
    return block(call, `${call.name} failed: ${err.message}`, true);
  }

  let content = result.content;
  let isError = !!result.isError;

  if (permissions.hooks) {
    const post = await runHooks(permissions.hooks, 'PostToolUse', {
      toolName: call.name,
      input: effectiveInput,
      output: typeof content === 'string' ? content : '',
      isError,
    }, { cwd: permissions.cwd, signal });
    // A hook may rewrite the output, e.g. to auto-format or redact.
    if (post.results?.some((r) => typeof r.updatedOutput === 'string')) {
      const replacement = post.results.findLast((r) => typeof r.updatedOutput === 'string').updatedOutput;
      content = replacement;
    }
  }

  return { block: { type: 'tool_result', toolUseId: call.id, content: clipOutput(content, 60_000), isError } };
}

function block(call, content, isError) {
  return { block: { type: 'tool_result', toolUseId: call.id, content, isError } };
}

/**
 * Compaction: keep the task anchor and the most recent complete turns, and mark
 * the gap honestly. Deliberately lossy, never inventive — a fabricated summary is
 * indistinguishable from fact to the model, so we say what was dropped instead.
 *
 * CRITICAL: compaction must never split a `tool_use` from its `tool_result`.
 * An orphaned block is not a smaller history, it is a malformed request that a
 * strict provider rejects with a 400 — so the cut is chosen on turn boundaries
 * and then repaired so that the kept suffix is structurally valid.
 *
 * A "turn" here is one assistant message plus anything that answers it.
 */
export function compactMessages(messages, targetTokens) {
  if (messages.length <= 4) return messages.slice();

  // 1. The anchor is the first USER message: it carries the task. Never a
  //    tool_result, because a tool_result can only appear after a tool_use.
  const anchorIdx = messages.findIndex((m) => m.role === 'user' && !isToolResultTurn(m));
  const head = anchorIdx >= 0 ? [messages[anchorIdx]] : [messages[0]];
  const startFrom = anchorIdx >= 0 ? anchorIdx + 1 : 1;

  // 2. Walk backwards keeping whole messages while they fit.
  let used = estimateMessages(head);
  const tail = [];
  for (let i = messages.length - 1; i >= startFrom; i--) {
    const cost = estimateMessages([messages[i]]);
    if (used + cost > targetTokens && tail.length > 0) break;
    used += cost;
    tail.unshift(messages[i]);
  }

  // 3. Repair the boundary: if the suffix starts with a tool_result whose
  //    tool_use is not in the suffix, drop forward until it does not.
  const kept = dropLeadingOrphans(tail);
  const dropped = messages.length - head.length - kept.length;

  if (dropped <= 0) return messages.slice();

  const marker = {
    role: 'user',
    content: [{
      type: 'text',
      text: `[xMonkey compacted ${dropped} earlier message(s) to stay inside the context window. ` +
        `They are no longer available. If you need a detail from earlier, re-read the file or ask.]`,
    }],
  };
  const out = [...head, marker, ...kept];

  // 4. Final guard: the result must be structurally valid, or we hand back the
  //    full history and let the caller deal with the budget instead of sending a
  //    request that is guaranteed to fail.
  if (!isStructurallyValid(out)) return messages.slice();
  return out;
}

/** True when this message is only tool results (i.e. it answers a prior turn). */
export function isToolResultTurn(m) {
  return Array.isArray(m.content) && m.content.length > 0 && m.content.every((b) => b.type === 'tool_result');
}

/**
 * Drop messages from the front of `list` until every tool_result has its
 * tool_use present earlier in the list.
 */
export function dropLeadingOrphans(list) {
  const out = list.slice();
  for (;;) {
    if (!out.length) return out;
    const useIds = new Set();
    for (const m of out) for (const b of m.content ?? []) if (b.type === 'tool_use') useIds.add(b.id);

    let cut = -1;
    for (let i = 0; i < out.length; i++) {
      const blocks = out[i].content ?? [];
      const orphan = blocks.some((b) => b.type === 'tool_result' && !useIds.has(b.toolUseId));
      if (!orphan) continue;
      // Drop this message and everything before it: a tool_result cannot be the
      // first thing in a history, so the boundary has to move past it.
      cut = i + 1;
      break;
    }
    if (cut === -1) return out;
    out.splice(0, cut);
  }
}

/**
 * Structural validity: every tool_result has a preceding tool_use, and every
 * tool_use is answered. Both directions matter; providers enforce both.
 */
export function isStructurallyValid(messages) {
  const seenUses = new Set();
  const answered = new Set();
  for (const m of messages) {
    for (const b of m.content ?? []) {
      if (b.type === 'tool_use') {
        if (seenUses.has(b.id)) return false;
        seenUses.add(b.id);
      } else if (b.type === 'tool_result') {
        if (!seenUses.has(b.toolUseId)) return false;   // orphan result
        if (answered.has(b.toolUseId)) return false;    // duplicate answer
        answered.add(b.toolUseId);
      }
    }
  }
  // A tool_use with no result is only legal as the very last turn (we are about
  // to execute it), so in a compacted history it is not acceptable.
  for (const id of seenUses) if (!answered.has(id)) return false;
  return true;
}
