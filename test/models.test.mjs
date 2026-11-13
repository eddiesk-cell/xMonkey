// Model layer tests. No network: a fake HTTP server stands in for each dialect,
// so the adapters' translation logic is proven without any provider account.

import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';

import { createProvider as createOllama } from '../src/models/ollama.mjs';
import { createProvider as createOpenAI } from '../src/models/openai.mjs';
import { createProvider as createAnthropic } from '../src/models/anthropic.mjs';
import { withPromptedTools, extractToolCall } from '../src/models/prompted.mjs';
import { applyCapabilities } from '../src/models/capabilities.mjs';
import { buildProvider } from '../src/models/registry.mjs';

/** Start a throwaway server that answers with a fixed SSE body. */
async function fakeServer(handler) {
  const server = http.createServer(handler);
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const { port } = server.address();
  return {
    url: `http://127.0.0.1:${port}`,
    close: () => new Promise((r) => server.close(r)),
  };
}

function sse(res, events) {
  res.writeHead(200, { 'content-type': 'text/event-stream' });
  for (const e of events) res.write(`data: ${JSON.stringify(e)}\n\n`);
  res.write('data: [DONE]\n\n');
  res.end();
}

// ---------------------------------------------------------------- ollama

test('ollama adapter: parses NDJSON text stream', async () => {
  const srv = await fakeServer((req, res) => {
    res.writeHead(200, { 'content-type': 'application/x-ndjson' });
    res.write(JSON.stringify({ message: { role: 'assistant', content: 'Hel' } }) + '\n');
    res.write(JSON.stringify({ message: { role: 'assistant', content: 'lo' } }) + '\n');
    res.end(JSON.stringify({ done: true, prompt_eval_count: 11, eval_count: 2, done_reason: 'stop' }) + '\n');
  });
  const p = createOllama({ baseUrl: srv.url, model: 'test' });
  let streamed = '';
  const out = await p.complete({ system: 'sys', messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }], tools: [], maxTokens: 10, onText: (c) => (streamed += c) });
  await srv.close();
  assert.equal(out.content[0].text, 'Hello');
  assert.equal(streamed, 'Hello');
  assert.equal(out.stopReason, 'end_turn');
  assert.equal(out.usage.inputTokens, 11);
  assert.equal(out.usage.outputTokens, 2);
});

test('ollama adapter: parses native tool_calls into tool_use blocks', async () => {
  const srv = await fakeServer((req, res) => {
    res.writeHead(200, { 'content-type': 'application/x-ndjson' });
    res.end(JSON.stringify({
      message: { role: 'assistant', content: '', tool_calls: [{ function: { name: 'read_file', arguments: { path: 'a.txt' } } }] },
      done: true,
    }) + '\n');
  });
  const p = createOllama({ baseUrl: srv.url, model: 'test' });
  const out = await p.complete({ system: '', messages: [{ role: 'user', content: [{ type: 'text', text: 'read a' }] }], tools: [{ name: 'read_file', description: 'd', inputSchema: { type: 'object' } }], maxTokens: 10 });
  await srv.close();
  assert.equal(out.stopReason, 'tool_use');
  const tu = out.content.find((b) => b.type === 'tool_use');
  assert.equal(tu.name, 'read_file');
  assert.deepEqual(tu.input, { path: 'a.txt' });
});

// ---------------------------------------------------------------- openai

test('openai adapter: assembles streamed tool call fragments', async () => {
  const srv = await fakeServer((req, res) => {
    // The adapter must have translated our message shape into this dialect.
    sse(res, [
      { choices: [{ delta: { content: 'Reading ' } }] },
      { choices: [{ delta: { tool_calls: [{ index: 0, id: 'call_1', function: { name: 'read_file', arguments: '{"pa' } }] } }] },
      { choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: 'th":"x"}' } }] } }] },
      { choices: [{ delta: {}, finish_reason: 'tool_calls' }] },
      { usage: { prompt_tokens: 7, completion_tokens: 3 }, choices: [] },
    ]);
  });
  const p = createOpenAI({ baseUrl: srv.url, model: 'test' });
  const out = await p.complete({ system: 's', messages: [{ role: 'user', content: [{ type: 'text', text: 'go' }] }], tools: [{ name: 'read_file', description: 'd', inputSchema: { type: 'object' } }], maxTokens: 20 });
  await srv.close();
  assert.equal(out.stopReason, 'tool_use');
  const tu = out.content.find((b) => b.type === 'tool_use');
  assert.equal(tu.name, 'read_file');
  assert.deepEqual(tu.input, { path: 'x' });
  assert.equal(out.usage.inputTokens, 7);
});

test('openai adapter: translates tool_result into a tool-role message', async () => {
  let seen;
  const srv = await fakeServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      seen = JSON.parse(body);
      sse(res, [{ choices: [{ delta: { content: 'ok' }, finish_reason: 'stop' }] }]);
    });
  });
  const p = createOpenAI({ baseUrl: srv.url, model: 'test' });
  await p.complete({
    system: 's', tools: [], maxTokens: 10,
    messages: [
      { role: 'assistant', content: [{ type: 'tool_use', id: 'tu1', name: 'read_file', input: { path: 'a' } }] },
      { role: 'user', content: [{ type: 'tool_result', toolUseId: 'tu1', content: 'contents!' }] },
    ],
  });
  await srv.close();
  const roles = seen.messages.map((m) => m.role);
  assert.deepEqual(roles, ['system', 'assistant', 'tool']);
  assert.equal(seen.messages[2].tool_call_id, 'tu1');
  assert.equal(seen.messages[2].content, 'contents!');
  assert.equal(seen.messages[1].tool_calls[0].function.name, 'read_file');
});

// ---------------------------------------------------------------- anthropic

test('anthropic adapter: parses content_block deltas + tool json deltas', async () => {
  const srv = await fakeServer((req, res) => {
    sse(res, [
      { type: 'message_start', message: { usage: { input_tokens: 12 } } },
      { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
      { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Let me check.' } },
      { type: 'content_block_stop', index: 0 },
      { type: 'content_block_start', index: 1, content_block: { type: 'tool_use', id: 'toolu_1', name: 'read_file' } },
      { type: 'content_block_delta', index: 1, delta: { type: 'input_json_delta', partial_json: '{"path":' } },
      { type: 'content_block_delta', index: 1, delta: { type: 'input_json_delta', partial_json: '"a.txt"}' } },
      { type: 'content_block_stop', index: 1 },
      { type: 'message_delta', delta: { stop_reason: 'tool_use' }, usage: { output_tokens: 9 } },
    ]);
  });
  const p = createAnthropic({ baseUrl: srv.url, apiKey: 'k', model: 'test' });
  const out = await p.complete({ system: 's', messages: [{ role: 'user', content: [{ type: 'text', text: 'read' }] }], tools: [{ name: 'read_file', description: 'd', inputSchema: { type: 'object' } }], maxTokens: 10 });
  await srv.close();
  assert.equal(out.stopReason, 'tool_use');
  assert.equal(out.content[0].text, 'Let me check.');
  const tu = out.content.find((b) => b.type === 'tool_use');
  assert.deepEqual(tu.input, { path: 'a.txt' });
  assert.equal(out.usage.inputTokens, 12);
  assert.equal(out.usage.outputTokens, 9);
});

// ---------------------------------------------------------------- prompted tools

test('prompted tools: recovers a tool call from a fenced json block', () => {
  const tools = [{ name: 'write_file', description: 'w', inputSchema: { type: 'object' } }];
  const text = 'I will write it.\n```json\n{"tool":"write_file","input":{"path":"a","content":"b"}}\n```';
  const got = extractToolCall(text, tools);
  assert.ok(got, 'should find the call');
  assert.equal(got.name, 'write_file');
  assert.deepEqual(got.input, { path: 'a', content: 'b' });
});

test('prompted tools: ignores a tool name that does not exist', () => {
  const tools = [{ name: 'write_file', description: 'w', inputSchema: { type: 'object' } }];
  const text = '```json\n{"tool":"rm_rf","input":{}}\n```';
  assert.equal(extractToolCall(text, tools), null);
});

test('prompted tools: a model without native tools still drives a real tool_use', async () => {
  const inner = {
    id: 'fake', model: 'no-tools',
    capabilities: { streaming: true, nativeTools: false, parallelTools: false, systemRole: false, images: false, thinking: false, contextWindow: 4096 },
    async complete({ onText }) {
      const reply = 'Writing now.\n```json\n{"tool":"write_file","input":{"path":"x.txt","content":"hi"}}\n```';
      if (onText) onText(reply);
      return { content: [{ type: 'text', text: reply }], stopReason: 'end_turn', usage: {} };
    },
  };
  const p = withPromptedTools(inner);
  assert.equal(p.capabilities.nativeTools, true, 'wrapper advertises tool support upstream');
  const out = await p.complete({
    system: 'sys',
    messages: [{ role: 'user', content: [{ type: 'text', text: 'write x' }] }],
    tools: [{ name: 'write_file', description: 'w', inputSchema: { type: 'object' } }],
    maxTokens: 100,
  });
  assert.equal(out.stopReason, 'tool_use');
  const tu = out.content.find((b) => b.type === 'tool_use');
  assert.equal(tu.name, 'write_file');
  assert.deepEqual(tu.input, { path: 'x.txt', content: 'hi' });
  const txt = out.content.find((b) => b.type === 'text');
  assert.equal(txt.text, 'Writing now.');
});

// ---------------------------------------------------------------- registry

test('registry: builds every documented kind and rejects unknown ones', () => {
  for (const kind of ['anthropic', 'openai', 'ollama', 'lmstudio', 'llama.cpp', 'vllm']) {
    const p = buildProvider({ kind, model: 'm', baseUrl: 'http://127.0.0.1:1' });
    assert.equal(typeof p.complete, 'function', `${kind} must build`);
    assert.ok(p.capabilities, `${kind} must report capabilities`);
  }
  assert.throws(() => buildProvider({ kind: 'nope', model: 'm' }), /unknown provider kind/);
});

test('registry: a local model can be forced onto the prompted protocol', () => {
  const p = buildProvider({ kind: 'openai', model: 'm', baseUrl: 'http://127.0.0.1:1', nativeTools: false });
  assert.equal(p.promptedTools, true);
});

// ---------------------------------------------------------------- capabilities

test('capabilities: systemRole:false folds the system prompt into the first user turn', async () => {
  const { applyCapabilities } = await import('../src/models/capabilities.mjs');
  let seen;
  const inner = {
    id: 'nosys', model: 'm',
    capabilities: { streaming: true, nativeTools: true, parallelTools: true, systemRole: false, images: false, thinking: false, contextWindow: 8192 },
    async complete(req) { seen = req; return { content: [{ type: 'text', text: 'ok' }], stopReason: 'end_turn', usage: {} }; },
  };
  const p = applyCapabilities(inner);
  assert.equal(p.capabilities.systemRole, true, 'downstream sees a system-capable provider');

  await p.complete({
    system: 'YOU ARE XMONKEY',
    messages: [{ role: 'user', content: [{ type: 'text', text: 'hello' }] }],
    tools: [], maxTokens: 10,
  });
  assert.equal(seen.system, '', 'the system field is emptied');
  const first = seen.messages[0];
  assert.equal(first.role, 'user');
  assert.match(first.content[0].text, /YOU ARE XMONKEY/);
  assert.match(first.content[0].text, /hello/);
});

test('capabilities: a system-capable provider is passed through untouched', async () => {
  const { applyCapabilities } = await import('../src/models/capabilities.mjs');
  let seen;
  const inner = {
    id: 'sys', model: 'm',
    capabilities: { streaming: true, nativeTools: true, parallelTools: true, systemRole: true, images: false, thinking: false, contextWindow: 8192 },
    async complete(req) { seen = req; return { content: [{ type: 'text', text: 'ok' }], stopReason: 'end_turn', usage: {} }; },
  };
  const p = applyCapabilities(inner);
  assert.equal(p, inner, 'no wrapper is installed');
  await p.complete({ system: 'SYS', messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }], tools: [], maxTokens: 10 });
  assert.equal(seen.system, 'SYS');
});

test('registry: a nativeTools:false + systemRole:false model still gets the catalogue', async () => {
  const { buildProvider } = await import('../src/models/registry.mjs');
  // Build a provider that cannot do tools or system roles, and check the wrapper
  // chain did not lose the tool catalogue in the fold.
  const p = buildProvider({ kind: 'ollama', model: 'm', baseUrl: 'http://127.0.0.1:1', nativeTools: false });
  assert.equal(p.capabilities.nativeTools, true, 'prompted wrapper advertises tools');
  assert.equal(typeof p.complete, 'function');
});

// ---------------------------------------------------------------- composition regressions

test('prompted tools: the protocol\'s own placeholder block is never parsed as a call', () => {
  // The instructions contain `{"tool": "tool_name"}`. Treating that as a call
  // swallows the model's real reply and invents a tool that does not exist.
  const tools = [{ name: 'read', description: 'd', inputSchema: { type: 'object' } }];
  const protoLike = 'instructions...\n```json\n{"tool": "tool_name", "input": { }}\n```\n';
  assert.equal(extractToolCall(protoLike, tools), null, 'placeholder is not a call');
});

test('prompted tools: parses the real call that follows placeholder-like text', () => {
  const tools = [{ name: 'read', description: 'd', inputSchema: { type: 'object' } }];
  const text = '```json\n{"tool": "tool_name", "input": { }}\n```\nNow really:\n```json\n{"tool":"read","input":{"path":"a"}}\n```';
  const got = extractToolCall(text, tools);
  assert.equal(got.name, 'read');
  assert.deepEqual(got.input, { path: 'a' });
});

test('prompted tools: a provider that returns text without invoking onText still yields a tool call', async () => {
  // Non-streaming paths and some servers return the completion instead of calling
  // back. Parsing only the streamed buffer silently dropped every tool call.
  const inner = {
    id: 'quiet', model: 'm',
    capabilities: { streaming: false, nativeTools: false, parallelTools: false, systemRole: true, images: false, thinking: false, contextWindow: 8192 },
    async complete() {
      return { content: [{ type: 'text', text: '```json\n{"tool":"read","input":{"path":"x"}}\n```' }], stopReason: 'end_turn', usage: {} };
    },
  };
  const p = withPromptedTools(inner);
  const out = await p.complete({
    system: 's', messages: [{ role: 'user', content: [{ type: 'text', text: 'go' }] }],
    tools: [{ name: 'read', description: 'd', inputSchema: { type: 'object' } }], maxTokens: 50,
  });
  assert.equal(out.stopReason, 'tool_use');
  assert.equal(out.content.find((b) => b.type === 'tool_use').name, 'read');
});

test('composition: a model lacking BOTH native tools and a system role still gets instructions', async () => {
  // The case local models actually hit. Wrapper order plus capability masking
  // used to lose the tool catalogue entirely here.
  const calls = [];
  const inner = {
    id: 'worst', model: 'm',
    capabilities: { streaming: true, nativeTools: false, parallelTools: false, systemRole: false, images: false, thinking: false, contextWindow: 8192 },
    async complete(req) {
      calls.push(req);
      return { content: [{ type: 'text', text: '```json\n{"tool":"read","input":{"path":"a"}}\n```' }], stopReason: 'end_turn', usage: {} };
    },
  };
  const p = applyCapabilities(withPromptedTools(inner));
  const out = await p.complete({
    system: 'BASE SYSTEM',
    messages: [{ role: 'user', content: [{ type: 'text', text: 'do it' }] }],
    tools: [{ name: 'read', description: 'read a file', inputSchema: { type: 'object' } }],
    maxTokens: 100,
  });

  const sent = calls[0];
  assert.equal(sent.system, '', 'nothing is sent in a system role the model lacks');
  const wire = JSON.stringify(sent.messages);
  assert.match(wire, /Tool protocol/, 'the tool catalogue survived the fold');
  assert.match(wire, /BASE SYSTEM/, 'the base instructions survived the fold');
  assert.equal(out.stopReason, 'tool_use', 'the tool call was parsed back out');
});
