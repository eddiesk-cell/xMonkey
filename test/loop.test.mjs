// Agent loop tests. A scripted provider stands in for the model so every branch
// of the loop is exercised deterministically: tool dispatch, refusal handling,
// turn limits, abort, compaction, and unbalanced-history repair.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { runAgent, compactMessages, STOP } from '../src/core/loop.mjs';
import { buildSystemPrompt, loadMemory } from '../src/core/prompt.mjs';
import { buildDefaultRegistry, createTodoStore } from '../src/tools/index.mjs';
import { decide, MODES } from '../src/permissions/gate.mjs';

/** A provider that replays a script of completions. */
function scriptedProvider(script, capabilities = {}) {
  let i = 0;
  return {
    id: 'scripted',
    model: 'scripted-1',
    maxTokens: 4096,
    capabilities: {
      streaming: true, nativeTools: true, parallelTools: true,
      systemRole: true, images: false, thinking: false, contextWindow: 200_000,
      ...capabilities,
    },
    calls: [],
    async complete(req) {
      this.calls.push({ messageCount: req.messages.length, toolCount: req.tools.length });
      const step = script[Math.min(i, script.length - 1)];
      i++;
      if (typeof step === 'function') return step(req);
      return step;
    },
  };
}

async function tempWorkspace() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'xmonkey-'));
  return dir;
}

function makeCtx(workspace, over = {}) {
  const todos = createTodoStore();
  return { workspace, todos, maxToolChars: 30_000, ...over };
}

// ---------------------------------------------------------------- basics

test('loop: finishes on a plain text answer with no tools', async () => {
  const ws = await tempWorkspace();
  const ctx = makeCtx(ws);
  const tools = buildDefaultRegistry(ctx);
  const provider = scriptedProvider([
    { content: [{ type: 'text', text: 'All done.' }], stopReason: 'end_turn', usage: { inputTokens: 10, outputTokens: 3 } },
  ]);
  const messages = [{ role: 'user', content: [{ type: 'text', text: 'say hi' }] }];
  const events = [];
  const out = await runAgent({ provider, tools, messages, system: 'sys', onEvent: (e) => events.push(e) });

  assert.equal(out.stopReason, STOP.endTurn);
  assert.equal(out.turns, 1);
  assert.equal(out.finalText, 'All done.');
  assert.equal(out.usage.inputTokens, 10);
  assert.equal(messages.length, 2, 'assistant turn appended');
  assert.ok(events.some((e) => e.type === 'done'));
});

test('loop: executes a tool call, appends the result, then finishes', async () => {
  const ws = await tempWorkspace();
  await fs.writeFile(path.join(ws, 'hello.txt'), 'hi there\n', 'utf8');
  const ctx = makeCtx(ws);
  const tools = buildDefaultRegistry(ctx);

  const provider = scriptedProvider([
    {
      content: [
        { type: 'text', text: 'Reading it.' },
        { type: 'tool_use', id: 'tu_1', name: 'read', input: { path: 'hello.txt' } },
      ],
      stopReason: 'tool_use',
      usage: { inputTokens: 20, outputTokens: 10 },
    },
    { content: [{ type: 'text', text: 'The file says hi there.' }], stopReason: 'end_turn', usage: { inputTokens: 40, outputTokens: 8 } },
  ]);

  const messages = [{ role: 'user', content: [{ type: 'text', text: 'what is in hello.txt?' }] }];
  const out = await runAgent({ provider, tools, messages, system: 'sys' });

  assert.equal(out.stopReason, STOP.endTurn);
  assert.equal(out.turns, 2);
  assert.equal(out.finalText, 'The file says hi there.');
  assert.equal(out.usage.inputTokens, 60);

  // History: user, assistant(tool_use), user(tool_result), assistant(final)
  assert.equal(messages.length, 4);
  const resultTurn = messages[2];
  assert.equal(resultTurn.role, 'user');
  assert.equal(resultTurn.content.length, 1);
  assert.equal(resultTurn.content[0].type, 'tool_result');
  assert.equal(resultTurn.content[0].toolUseId, 'tu_1');
  assert.match(resultTurn.content[0].content, /hi there/);
  assert.equal(resultTurn.content[0].isError, false);
});

test('loop: a tool failure becomes an error tool_result, not a throw', async () => {
  const ws = await tempWorkspace();
  const ctx = makeCtx(ws);
  const tools = buildDefaultRegistry(ctx);
  const provider = scriptedProvider([
    { content: [{ type: 'tool_use', id: 'tu_x', name: 'read', input: { path: 'missing.txt' } }], stopReason: 'tool_use', usage: {} },
    { content: [{ type: 'text', text: 'That file does not exist.' }], stopReason: 'end_turn', usage: {} },
  ]);
  const messages = [{ role: 'user', content: [{ type: 'text', text: 'read missing' }] }];
  const out = await runAgent({ provider, tools, messages, system: 's' });
  assert.equal(out.stopReason, STOP.endTurn);
  const tr = messages[2].content[0];
  assert.equal(tr.type, 'tool_result');
  assert.equal(tr.isError, true);
  assert.match(tr.content, /file not found/);
});

test('loop: unknown tool is reported to the model with the real tool list', async () => {
  const ws = await tempWorkspace();
  const ctx = makeCtx(ws);
  const tools = buildDefaultRegistry(ctx);
  const provider = scriptedProvider([
    { content: [{ type: 'tool_use', id: 'tu_bad', name: 'nope_tool', input: {} }], stopReason: 'tool_use', usage: {} },
    { content: [{ type: 'text', text: 'ok' }], stopReason: 'end_turn', usage: {} },
  ]);
  const messages = [{ role: 'user', content: [{ type: 'text', text: 'go' }] }];
  await runAgent({ provider, tools, messages, system: 's' });
  const tr = messages[2].content[0];
  assert.equal(tr.isError, true);
  assert.match(tr.content, /no tool named "nope_tool"/);
  assert.match(tr.content, /read/, 'lists the real tools');
});

test('loop: respects maxTurns and says why', async () => {
  const ws = await tempWorkspace();
  const ctx = makeCtx(ws);
  const tools = buildDefaultRegistry(ctx);
  // A model stuck in a tool loop.
  const provider = scriptedProvider([
    { content: [{ type: 'tool_use', id: 'a', name: 'list', input: {} }], stopReason: 'tool_use', usage: {} },
  ]);
  const messages = [{ role: 'user', content: [{ type: 'text', text: 'loop forever' }] }];
  const notices = [];
  const out = await runAgent({
    provider, tools, messages, system: 's', maxTurns: 3,
    onEvent: (e) => e.type === 'notice' && notices.push(e),
  });
  assert.equal(out.stopReason, STOP.maxTurns);
  assert.equal(out.turns, 3);
  assert.ok(notices.some((n) => /3 turns/.test(n.message)));
});

test('loop: abort before a turn returns aborted', async () => {
  const ws = await tempWorkspace();
  const ctx = makeCtx(ws);
  const tools = buildDefaultRegistry(ctx);
  const provider = scriptedProvider([{ content: [{ type: 'text', text: 'x' }], stopReason: 'end_turn', usage: {} }]);
  const ac = new AbortController();
  ac.abort(new Error('user pressed ctrl-c'));
  const out = await runAgent({
    provider, tools, messages: [{ role: 'user', content: [{ type: 'text', text: 'x' }] }],
    system: 's', signal: ac.signal,
  });
  assert.equal(out.stopReason, STOP.aborted);
  assert.equal(provider.calls.length, 0, 'no model call after abort');
});

// ---------------------------------------------------------------- permissions

test('loop: a denied tool call is refused and the model is told not to retry', async () => {
  const ws = await tempWorkspace();
  const ctx = makeCtx(ws);
  const tools = buildDefaultRegistry(ctx);
  const provider = scriptedProvider([
    { content: [{ type: 'tool_use', id: 'w1', name: 'write', input: { path: 'x.txt', content: 'nope' } }], stopReason: 'tool_use', usage: {} },
    { content: [{ type: 'text', text: 'I cannot write in plan mode.' }], stopReason: 'end_turn', usage: {} },
  ]);
  const messages = [{ role: 'user', content: [{ type: 'text', text: 'write x' }] }];
  await runAgent({ provider, tools, messages, system: 's', permissions: { mode: 'plan', rules: [] } });
  const tr = messages[2].content[0];
  assert.equal(tr.isError, true);
  assert.match(tr.content, /plan mode/);
  await assert.rejects(fs.access(path.join(ws, 'x.txt')), 'file must not exist');
});

test('loop: ask -> approved runs the tool, ask -> declined refuses', async () => {
  const ws = await tempWorkspace();
  const ctx = makeCtx(ws);
  const tools = buildDefaultRegistry(ctx);

  let asked = 0;
  const provider1 = scriptedProvider([
    { content: [{ type: 'tool_use', id: 'w1', name: 'write', input: { path: 'yes.txt', content: 'ok' } }], stopReason: 'tool_use', usage: {} },
    { content: [{ type: 'text', text: 'written' }], stopReason: 'end_turn', usage: {} },
  ]);
  await runAgent({
    provider: provider1, tools, messages: [{ role: 'user', content: [{ type: 'text', text: 'write' }] }],
    system: 's', permissions: { mode: 'default', rules: [] },
    onAsk: async () => { asked++; return true; },
  });
  assert.equal(asked, 1);
  assert.equal(await fs.readFile(path.join(ws, 'yes.txt'), 'utf8'), 'ok');

  const provider2 = scriptedProvider([
    { content: [{ type: 'tool_use', id: 'w2', name: 'write', input: { path: 'no.txt', content: 'no' } }], stopReason: 'tool_use', usage: {} },
    { content: [{ type: 'text', text: 'fine' }], stopReason: 'end_turn', usage: {} },
  ]);
  const messages2 = [{ role: 'user', content: [{ type: 'text', text: 'write' }] }];
  await runAgent({
    provider: provider2, tools, messages: messages2, system: 's',
    permissions: { mode: 'default', rules: [] },
    onAsk: async () => false,
  });
  assert.equal(messages2[2].content[0].isError, true);
  await assert.rejects(fs.access(path.join(ws, 'no.txt')));
});

test('loop: headless with no asker refuses with an actionable message', async () => {
  const ws = await tempWorkspace();
  const tools = buildDefaultRegistry(makeCtx(ws));
  const provider = scriptedProvider([
    { content: [{ type: 'tool_use', id: 'w', name: 'write', input: { path: 'a', content: 'b' } }], stopReason: 'tool_use', usage: {} },
    { content: [{ type: 'text', text: 'ok' }], stopReason: 'end_turn', usage: {} },
  ]);
  const messages = [{ role: 'user', content: [{ type: 'text', text: 'write' }] }];
  await runAgent({ provider, tools, messages, system: 's', permissions: { mode: 'default' } });
  const tr = messages[2].content[0];
  assert.equal(tr.isError, true);
  assert.match(tr.content, /headless mode/);
  assert.match(tr.content, /--yes/);
});

test('loop: read-only tool is allowed without asking in default mode', async () => {
  const ws = await tempWorkspace();
  await fs.writeFile(path.join(ws, 'f.txt'), 'abc');
  const tools = buildDefaultRegistry(makeCtx(ws));
  let asked = false;
  const provider = scriptedProvider([
    { content: [{ type: 'tool_use', id: 'r', name: 'read', input: { path: 'f.txt' } }], stopReason: 'tool_use', usage: {} },
    { content: [{ type: 'text', text: 'done' }], stopReason: 'end_turn', usage: {} },
  ]);
  await runAgent({
    provider, tools, messages: [{ role: 'user', content: [{ type: 'text', text: 'read' }] }],
    system: 's', permissions: { mode: 'default', rules: [] }, onAsk: async () => { asked = true; return true; },
  });
  assert.equal(asked, false);
});

// ---------------------------------------------------------------- compaction

test('compactMessages: keeps the head, the tail, and marks the gap honestly', () => {
  const messages = [{ role: 'user', content: [{ type: 'text', text: 'TASK' }] }];
  for (let i = 0; i < 40; i++) {
    messages.push({ role: 'assistant', content: [{ type: 'text', text: `assistant ${i} `.repeat(40) }] });
    messages.push({ role: 'user', content: [{ type: 'text', text: `result ${i} `.repeat(40) }] });
  }
  const out = compactMessages(messages, 2000);
  assert.ok(out.length < messages.length, 'must actually drop messages');
  assert.equal(out[0].content[0].text, 'TASK', 'head anchor kept');
  const marker = out.find((m) => m.content?.[0]?.text?.includes('compacted'));
  assert.ok(marker, 'must leave an honest marker');
  assert.match(marker.content[0].text, /no longer available/);
});

test('loop: compacts instead of overflowing a small context window', async () => {
  const ws = await tempWorkspace();
  const tools = buildDefaultRegistry(makeCtx(ws));
  const big = 'x'.repeat(3000);
  const provider = scriptedProvider([
    (req) => ({
      content: [{ type: 'text', text: 'ok' }],
      stopReason: 'end_turn',
      usage: {},
      _saw: req.messages.length,
    }),
  ], { contextWindow: 4000 });

  const messages = [{ role: 'user', content: [{ type: 'text', text: 'task' }] }];
  for (let i = 0; i < 12; i++) {
    messages.push({ role: 'assistant', content: [{ type: 'text', text: big }] });
    messages.push({ role: 'user', content: [{ type: 'text', text: big }] });
  }
  const notices = [];
  const out = await runAgent({
    provider, tools, messages, system: 's',
    onEvent: (e) => e.type === 'notice' && notices.push(e.message),
  });
  assert.equal(out.stopReason, STOP.endTurn);
  assert.ok(notices.some((m) => /compacted history/.test(m)), 'must announce compaction');
  assert.ok(messages.length < 25, 'history was actually shortened');
});

// ---------------------------------------------------------------- prompt

test('system prompt: carries environment, mode and project memory', async () => {
  const ws = await tempWorkspace();
  await fs.writeFile(path.join(ws, 'AGENTS.md'), 'Use tabs. Never touch vendor/.\n');
  const memory = await loadMemory(ws);
  assert.equal(memory.length, 1);
  assert.equal(memory[0].path, 'AGENTS.md');

  const prompt = buildSystemPrompt({
    cwd: ws,
    model: 'gemma4:12b',
    providerId: 'ollama',
    permissionMode: 'plan',
    toolNames: ['read', 'write'],
    memory: memory[0].text,
    local: true,
  });
  assert.match(prompt, /You are xMonkey/);
  assert.match(prompt, new RegExp(`working directory: ${ws.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`));
  assert.match(prompt, /gemma4:12b \(via ollama\)/);
  assert.match(prompt, /Permission mode is `plan`/);
  assert.match(prompt, /Use tabs/);
  assert.match(prompt, /local model/);
});

// ---------------------------------------------------------------- gate unit

test('gate: deny rule beats bypass mode', () => {
  const d = decide({
    tool: 'bash', input: { command: 'rm -rf /' }, mode: 'bypass',
    rules: [{ tool: 'bash', pattern: '^rm ', action: 'deny' }],
    isReadOnly: false,
  });
  assert.equal(d.behavior, 'deny');
});

test('gate: read-only shell commands are allowed without a prompt', () => {
  for (const cmd of ['git status', 'ls -la', 'cat a.txt', 'grep -r foo .', 'git status && ls']) {
    const d = decide({ tool: 'bash', input: { command: cmd }, mode: 'default', rules: [], isReadOnly: false });
    assert.equal(d.behavior, 'allow', `${cmd} should be allowed`);
  }
  for (const cmd of ['rm -rf build', 'git push --force', 'npm install left-pad', 'echo x > f']) {
    const d = decide({ tool: 'bash', input: { command: cmd }, mode: 'default', rules: [], isReadOnly: false });
    assert.equal(d.behavior, 'ask', `${cmd} should ask`);
  }
});

test('gate: every declared mode is handled', () => {
  for (const mode of MODES) {
    const d = decide({ tool: 'read', input: { path: 'a' }, mode, rules: [], isReadOnly: true });
    assert.ok(['allow', 'ask', 'deny'].includes(d.behavior));
  }
  assert.throws(() => decide({ tool: 'read', input: {}, mode: 'nonsense', rules: [] }), /unknown permission mode/);
});

// ---------------------------------------------------------------- hooks in the loop

test('loop: a PreToolUse hook blocks the call even in bypass mode', async () => {
  const ws = await tempWorkspace();
  const tools = buildDefaultRegistry(makeCtx(ws));
  const provider = scriptedProvider([
    { content: [{ type: 'tool_use', id: 'w', name: 'write', input: { path: 'vendor/x.js', content: 'nope' } }], stopReason: 'tool_use', usage: {} },
    { content: [{ type: 'text', text: 'blocked' }], stopReason: 'end_turn', usage: {} },
  ]);
  const messages = [{ role: 'user', content: [{ type: 'text', text: 'write vendor' }] }];
  await runAgent({
    provider, tools, messages, system: 's',
    permissions: {
      mode: 'bypass',
      rules: [],
      cwd: ws,
      hooks: { PreToolUse: [{ matcher: 'write', command: `printf '{"decision":"deny","reason":"vendor is protected"}'` }] },
    },
  });
  const tr = messages[2].content[0];
  assert.equal(tr.isError, true);
  assert.match(tr.content, /hook denied it/);
  assert.match(tr.content, /vendor is protected/);
  await assert.rejects(fs.access(path.join(ws, 'vendor/x.js')), 'file must not have been written');
});

test('loop: a PreToolUse hook can rewrite the input that actually runs', async () => {
  const ws = await tempWorkspace();
  const tools = buildDefaultRegistry(makeCtx(ws));
  const provider = scriptedProvider([
    { content: [{ type: 'tool_use', id: 'b', name: 'bash', input: { command: 'echo original' } }], stopReason: 'tool_use', usage: {} },
    { content: [{ type: 'text', text: 'done' }], stopReason: 'end_turn', usage: {} },
  ]);
  const messages = [{ role: 'user', content: [{ type: 'text', text: 'run' }] }];
  await runAgent({
    provider, tools, messages, system: 's',
    permissions: {
      mode: 'bypass', rules: [], cwd: ws,
      hooks: { PreToolUse: [{ matcher: 'bash', command: `printf '{"updatedInput":{"command":"echo rewritten"}}'` }] },
    },
  });
  const tr = messages[2].content[0];
  assert.match(tr.content, /rewritten/, 'the rewritten command ran');
  assert.doesNotMatch(tr.content, /original/);
});

// ---------------------------------------------------------------- input-parameter rules

test('gate: an input-parameter rule denies one command without denying the tool', () => {
  const rules = [{ tool: 'bash', field: 'command', pattern: '^rm\\s', action: 'deny' }];
  const denied = decide({ tool: 'bash', input: { command: 'rm -rf build' }, mode: 'bypass', rules, isReadOnly: false });
  assert.equal(denied.behavior, 'deny', 'rm is denied even in bypass mode');

  const allowed = decide({ tool: 'bash', input: { command: 'npm test' }, mode: 'default', rules, isReadOnly: false });
  assert.notEqual(allowed.behavior, 'deny', 'other bash commands are not denied by this rule');
});

test('gate: an input-parameter rule can target the read path', () => {
  const rules = [{ tool: 'read', field: 'path', pattern: '^secrets/', action: 'deny' }];
  assert.equal(decide({ tool: 'read', input: { path: 'secrets/key.pem' }, mode: 'bypass', rules, isReadOnly: true }).behavior, 'deny');
  assert.equal(decide({ tool: 'read', input: { path: 'src/a.js' }, mode: 'default', rules, isReadOnly: true }).behavior, 'allow');
});

test('gate: dontAsk never prompts — it denies and says why', () => {
  const d = decide({ tool: 'write', input: { path: 'a', content: 'b' }, mode: 'dontAsk', rules: [], isReadOnly: false });
  assert.equal(d.behavior, 'deny');
  assert.match(d.reason, /dontAsk/);

  // Read-only work still proceeds.
  const r = decide({ tool: 'read', input: { path: 'a' }, mode: 'dontAsk', rules: [], isReadOnly: true });
  assert.equal(r.behavior, 'allow');
});

test('gate: auto mode allows safe work and asks for the rest', () => {
  assert.equal(decide({ tool: 'read', input: { path: 'a' }, mode: 'auto', rules: [], isReadOnly: true }).behavior, 'allow');
  assert.equal(decide({ tool: 'bash', input: { command: 'git status' }, mode: 'auto', rules: [], isReadOnly: false }).behavior, 'allow');
  assert.equal(decide({ tool: 'write', input: { path: 'a', content: 'b' }, mode: 'auto', rules: [], isReadOnly: false }).behavior, 'ask');
});

test('gate: dontAsk still refuses a build that cannot ask, at the loop level', async () => {
  const ws = await tempWorkspace();
  const tools = buildDefaultRegistry(makeCtx(ws));
  const provider = scriptedProvider([
    { content: [{ type: 'tool_use', id: 'w', name: 'write', input: { path: 'x', content: 'y' } }], stopReason: 'tool_use', usage: {} },
    { content: [{ type: 'text', text: 'denied' }], stopReason: 'end_turn', usage: {} },
  ]);
  const messages = [{ role: 'user', content: [{ type: 'text', text: 'write' }] }];
  let asked = false;
  await runAgent({
    provider, tools, messages, system: 's',
    permissions: { mode: 'dontAsk', rules: [] },
    onAsk: async () => { asked = true; return true; },
  });
  assert.equal(asked, false, 'dontAsk must never invoke the asker');
  assert.equal(messages[2].content[0].isError, true);
});
