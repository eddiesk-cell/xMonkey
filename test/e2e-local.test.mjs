// Real local-model integration test.
//
// This is the test that matters most for xMonkey's premise: a model running on
// this machine, reached over Ollama's API with no cloud credentials, driving the
// harness through a real multi-step tool task.
//
// It SKIPS (does not fail) when no local model is available, so the suite is
// still usable on a machine without Ollama — but `npm run test:local` is the
// check that must pass on a machine that has one.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { probe } from '../src/models/ollama.mjs';
import { createProvider } from '../src/models/ollama.mjs';
import { buildDefaultRegistry, createTodoStore } from '../src/tools/index.mjs';
import { runAgent } from '../src/core/loop.mjs';
import { buildSystemPrompt } from '../src/core/prompt.mjs';

const OLLAMA = process.env.OLLAMA_HOST || 'http://127.0.0.1:11434';

/** Pick the strongest chat model the local server actually has. */
async function pickLocalModel() {
  const r = await probe(OLLAMA);
  if (!r.ok || !r.models?.length) return null;
  const chat = r.models.filter((m) => !/embed|nomic|minilm|rerank/i.test(m));
  if (!chat.length) return null;
  const size = (n) => {
    const m = n.match(/(\d+(?:\.\d+)?)\s*b\b/i);
    return m ? parseFloat(m[1]) : 0;
  };
  chat.sort((a, b) => size(b) - size(a));
  return chat[0];
}

const model = await pickLocalModel();
if (model) console.error(`[e2e-local] using local model: ${model}`);
const skip = model ? false : 'no local Ollama chat model available';

test('local model: real tool call against a real file', { skip, timeout: 180_000 }, async () => {
  const ws = await fs.mkdtemp(path.join(os.tmpdir(), 'xmlocal-'));
  await fs.writeFile(path.join(ws, 'config.json'), JSON.stringify({ service: 'billing', port: 8443, retries: 5 }, null, 2));

  const provider = createProvider({ baseUrl: OLLAMA, model, contextWindow: 16_384 });
  assert.equal(provider.id, 'ollama');
  assert.equal(provider.capabilities.nativeTools, true);

  const todos = createTodoStore();
  const tools = buildDefaultRegistry({ workspace: ws, todos, maxToolChars: 20_000 });
  const system = buildSystemPrompt({
    cwd: ws, model, providerId: 'ollama', permissionMode: 'plan',
    toolNames: tools.names(), local: true,
  });

  const messages = [{
    role: 'user',
    content: [{ type: 'text', text: 'Read config.json and tell me the value of the "port" field. Use the read tool first.' }],
  }];

  const toolCalls = [];
  const out = await runAgent({
    provider, tools, messages, system,
    maxTurns: 6,
    permissions: { mode: 'plan', rules: [] },
    onEvent: (e) => { if (e.type === 'tool_use') toolCalls.push(e.name); },
  });

  assert.equal(out.stopReason, 'end_turn', `model ${model} did not finish: ${out.stopReason}`);
  assert.ok(toolCalls.includes('read'), `model ${model} never called the read tool (calls: ${toolCalls.join(',') || 'none'})`);
  assert.match(out.finalText, /8443/, `answer should contain the port: "${out.finalText.slice(0, 300)}"`);
});

test('local model: streams incrementally and never produces an empty turn', { skip, timeout: 120_000 }, async () => {
  const provider = createProvider({ baseUrl: OLLAMA, model, contextWindow: 8192 });
  let textChunks = 0;
  let thinkingChunks = 0;
  const out = await provider.complete({
    system: 'Answer in exactly one short sentence.',
    messages: [{ role: 'user', content: [{ type: 'text', text: 'Name a colour.' }] }],
    tools: [],
    maxTokens: 96,
    onText: () => { textChunks++; },
    onThinking: () => { thinkingChunks++; },
  });

  // Reasoning models may route everything through `thinking`; both are valid
  // streamed output, but something must have streamed and nothing may be empty.
  assert.ok(textChunks + thinkingChunks > 0, 'the stream must deliver tokens');
  assert.ok(out.content.length > 0, 'the turn must never be empty');
  assert.ok(
    out.content.some((b) => b.type === 'text' || b.type === 'thinking'),
    'content must carry the model output'
  );
  assert.ok(out.usage.outputTokens > 0, 'the server reported token usage');
});

test('local model: a reasoning model keeps its thinking and still answers', { skip, timeout: 180_000 }, async () => {
  // This is the interoperability case that broke when the adapter assumed every
  // model streams its answer in `content`.
  const provider = createProvider({ baseUrl: OLLAMA, model, contextWindow: 8192 });
  let thinking = '';
  const out = await provider.complete({
    system: 'Think it through, then answer in one short sentence.',
    messages: [{ role: 'user', content: [{ type: 'text', text: 'What is 17 + 25?' }] }],
    tools: [],
    maxTokens: 400,
    onThinking: (c) => { thinking += c; },
  });
  const thinkingBlock = out.content.find((b) => b.type === 'thinking');
  const textBlock = out.content.find((b) => b.type === 'text');
  assert.ok(thinkingBlock || textBlock, 'at least one output channel');
  // If the model reasoned, the reasoning must be preserved as a thinking block.
  if (thinking.length > 0) {
    assert.ok(thinkingBlock, 'streamed thinking must survive into the content blocks');
    assert.equal(thinkingBlock.thinking, thinking);
  }
});

test('local model: reports cleanly when the model name does not exist', { skip, timeout: 60_000 }, async () => {
  const provider = createProvider({ baseUrl: OLLAMA, model: 'definitely-not-a-real-model:0b' });
  await assert.rejects(
    () => provider.complete({
      system: '', messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }], tools: [], maxTokens: 8,
    }),
    /not found|error/i
  );
});

test('local model: drives a multi-step task with two tools', { skip, timeout: 240_000 }, async () => {
  const ws = await fs.mkdtemp(path.join(os.tmpdir(), 'xmlocal2-'));
  await fs.writeFile(path.join(ws, 'a.txt'), 'alpha\n');
  await fs.writeFile(path.join(ws, 'b.txt'), 'beta\n');

  const provider = createProvider({ baseUrl: OLLAMA, model, contextWindow: 16_384 });
  const tools = buildDefaultRegistry({ workspace: ws, todos: createTodoStore(), maxToolChars: 20_000 });
  const system = buildSystemPrompt({ cwd: ws, model, providerId: 'ollama', permissionMode: 'plan', local: true });
  const messages = [{
    role: 'user',
    content: [{ type: 'text', text: 'Read both a.txt and b.txt, then tell me both words. Use the read tool for each file.' }],
  }];

  const calls = [];
  const out = await runAgent({
    provider, tools, messages, system, maxTurns: 8,
    permissions: { mode: 'plan', rules: [] },
    onEvent: (e) => { if (e.type === 'tool_use') calls.push(e.name); },
  });

  assert.equal(out.stopReason, 'end_turn');
  assert.ok(calls.filter((c) => c === 'read').length >= 2, `expected two reads, got: ${calls.join(',')}`);
  assert.match(out.finalText, /alpha/i);
  assert.match(out.finalText, /beta/i);
});
