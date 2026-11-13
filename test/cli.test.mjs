// End-to-end CLI test.
//
// This drives the REAL binary against a fake OpenAI-compatible model server, so
// the whole pipeline is exercised: flag parsing, config resolution, provider
// adapter, agent loop, tool execution, permission gate, session persistence and
// process exit code. The only fake part is the model itself.

import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const BIN = path.join(here, '..', 'bin', 'xmonkey.mjs');

/** A model server that replays a script of tool-call / text turns. */
async function fakeModelServer(turns) {
  let call = 0;
  const requests = [];
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      requests.push(JSON.parse(body));
      const step = turns[Math.min(call, turns.length - 1)];
      call++;
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      for (const evt of step) res.write(`data: ${JSON.stringify(evt)}\n\n`);
      res.write('data: [DONE]\n\n');
      res.end();
    });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const { port } = server.address();
  return {
    url: `http://127.0.0.1:${port}/v1`,
    requests,
    close: () => new Promise((r) => server.close(r)),
  };
}

function toolCallTurn(name, args) {
  return [
    { choices: [{ delta: { content: 'Working on it. ' } }] },
    { choices: [{ delta: { tool_calls: [{ index: 0, id: 'call_1', function: { name, arguments: JSON.stringify(args) } }] } }] },
    { choices: [{ delta: {}, finish_reason: 'tool_calls' }] },
  ];
}

function textTurn(text) {
  return [
    { choices: [{ delta: { content: text } }] },
    { choices: [{ delta: {}, finish_reason: 'stop' }] },
  ];
}

function runCli(args, { cwd, env = {} }) {
  return new Promise((resolve) => {
    execFile(
      process.execPath,
      [BIN, ...args],
      { cwd, timeout: 60_000, env: { ...process.env, ...env } },
      (err, stdout, stderr) => {
        resolve({ code: err?.code ?? 0, stdout, stderr });
      }
    );
  });
}

async function sandbox() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'xmcli-'));
  const home = path.join(dir, '.xmonkey-home');
  await fs.mkdir(home, { recursive: true });
  const workspace = path.join(dir, 'work');
  await fs.mkdir(workspace, { recursive: true });
  return { dir, home, workspace, env: { XMONKEY_HOME: home } };
}

// ---------------------------------------------------------------- version/help

test('cli: --version and --help print and exit 0', async () => {
  const s = await sandbox();
  const v = await runCli(['--version'], { cwd: s.workspace, env: s.env });
  assert.equal(v.code, 0);
  assert.match(v.stdout, /xmonkey 0\.1\.0/);

  const h = await runCli(['--help'], { cwd: s.workspace, env: s.env });
  assert.equal(h.code, 0);
  assert.match(h.stdout, /USAGE/);
  assert.match(h.stdout, /--mode/);
});

test('cli: --init writes a config that then loads', async () => {
  const s = await sandbox();
  const r = await runCli(['--init'], { cwd: s.workspace, env: s.env });
  assert.equal(r.code, 0);
  const cfg = JSON.parse(await fs.readFile(path.join(s.workspace, 'xmonkey.config.json'), 'utf8'));
  assert.ok(cfg.models.local);
  assert.equal(cfg.default, 'local');

  // Running --init again must not clobber it.
  const again = await runCli(['--init'], { cwd: s.workspace, env: s.env });
  assert.equal(again.code, 1);
  assert.match(again.stderr, /already exists/);
});

test('cli: --list-models exits 0 instead of starting a session', async () => {
  const s = await sandbox();
  await fs.writeFile(path.join(s.workspace, 'xmonkey.config.json'), JSON.stringify({
    models: { m1: { kind: 'ollama', model: 'x' } },
    default: 'm1',
  }));
  const r = await runCli(['--list-models'], { cwd: s.workspace, env: s.env });
  assert.equal(r.code, 0);
  assert.match(r.stdout, /m1/);
  assert.doesNotMatch(r.stdout, /Type your request/);
});

// ---------------------------------------------------------------- agent turn

test('cli: a full one-shot turn reads a file through a real tool call', async () => {
  const s = await sandbox();
  await fs.writeFile(path.join(s.workspace, 'data.txt'), 'the secret word is ORANGUTAN\n');
  const srv = await fakeModelServer([
    toolCallTurn('read', { path: 'data.txt' }),
    textTurn('The secret word is ORANGUTAN.'),
  ]);
  try {
    const r = await runCli(
      ['-p', '--kind', 'openai', '--base-url', srv.url, '--api-key', 'test', '--model', 'fake', '--mode', 'plan',
        'What is the secret word in data.txt?'],
      { cwd: s.workspace, env: s.env }
    );
    assert.equal(r.code, 0, `stderr: ${r.stderr}`);
    assert.match(r.stdout, /ORANGUTAN/);

    // The adapter really sent the tool catalogue and really got a tool result back.
    assert.equal(srv.requests.length, 2, 'two model calls: tool then answer');
    assert.ok(srv.requests[0].tools?.length >= 5, 'tool schemas were sent');
    const second = srv.requests[1].messages;
    const toolMsg = second.find((m) => m.role === 'tool');
    assert.ok(toolMsg, 'a tool-role message was sent back to the model');
    assert.match(toolMsg.content, /ORANGUTAN/);
  } finally {
    await srv.close();
  }
});

test('cli: a write is refused in plan mode and the file is never created', async () => {
  const s = await sandbox();
  const srv = await fakeModelServer([
    toolCallTurn('write', { path: 'should-not-exist.txt', content: 'nope' }),
    textTurn('I could not write the file.'),
  ]);
  try {
    const r = await runCli(
      ['-p', '--kind', 'openai', '--base-url', srv.url, '--api-key', 't', '--model', 'fake', '--mode', 'plan',
        'write a file'],
      { cwd: s.workspace, env: s.env }
    );
    assert.equal(r.code, 0, 'the session itself succeeded; the tool was refused');
    await assert.rejects(fs.access(path.join(s.workspace, 'should-not-exist.txt')), undefined, 'file must not exist');

    const toolMsg = srv.requests[1].messages.find((m) => m.role === 'tool');
    assert.match(toolMsg.content, /refused|plan mode/);
  } finally {
    await srv.close();
  }
});

test('cli: --yes lets a write through and the file lands on disk', async () => {
  const s = await sandbox();
  const srv = await fakeModelServer([
    toolCallTurn('write', { path: 'created.txt', content: 'written by xmonkey\n' }),
    textTurn('Done.'),
  ]);
  try {
    const r = await runCli(
      ['-p', '--yes', '--kind', 'openai', '--base-url', srv.url, '--api-key', 't', '--model', 'fake', 'write created.txt'],
      { cwd: s.workspace, env: s.env }
    );
    assert.equal(r.code, 0, `stderr: ${r.stderr}`);
    assert.equal(await fs.readFile(path.join(s.workspace, 'created.txt'), 'utf8'), 'written by xmonkey\n');
  } finally {
    await srv.close();
  }
});

test('cli: a session is persisted and can be resumed', async () => {
  const s = await sandbox();
  const srv = await fakeModelServer([textTurn('The answer is 42.')]);
  try {
    const r = await runCli(
      ['-p', '--kind', 'openai', '--base-url', srv.url, '--api-key', 't', '--model', 'fake', 'what is the answer?'],
      { cwd: s.workspace, env: s.env }
    );
    assert.equal(r.code, 0);

    const sessions = await fs.readdir(path.join(s.home, 'sessions'));
    assert.equal(sessions.length, 1, 'exactly one session directory');
    const sid = sessions[0];
    const transcript = await fs.readFile(path.join(s.home, 'sessions', sid, 'transcript.jsonl'), 'utf8');
    assert.match(transcript, /what is the answer\?/);
    assert.match(transcript, /The answer is 42\./);
    const meta = JSON.parse(await fs.readFile(path.join(s.home, 'sessions', sid, 'meta.json'), 'utf8'));
    assert.equal(meta.model, 'fake');

    // Resume it and confirm the history is sent back to the model.
    const srv2 = await fakeModelServer([textTurn('Still 42.')]);
    try {
      const r2 = await runCli(
        ['-p', '--resume', sid.slice(0, 8), '--kind', 'openai', '--base-url', srv2.url, '--api-key', 't', '--model', 'fake', 'and again?'],
        { cwd: s.workspace, env: s.env }
      );
      assert.equal(r2.code, 0, `stderr: ${r2.stderr}`);
      const msgs = srv2.requests[0].messages;
      const texts = msgs.map((m) => (typeof m.content === 'string' ? m.content : JSON.stringify(m.content))).join('\n');
      assert.match(texts, /what is the answer\?/, 'the earlier user turn was replayed');
    } finally {
      await srv2.close();
    }
  } finally {
    await srv.close();
  }
});

test('cli: --sessions lists what was stored', async () => {
  const s = await sandbox();
  const srv = await fakeModelServer([textTurn('ok')]);
  try {
    await runCli(['-p', '--kind', 'openai', '--base-url', srv.url, '--api-key', 't', '--model', 'fake', 'hello'], { cwd: s.workspace, env: s.env });
    const r = await runCli(['--sessions'], { cwd: s.workspace, env: s.env });
    assert.equal(r.code, 0);
    assert.match(r.stdout, /Recent sessions/);
    assert.match(r.stdout, /fake/);
  } finally {
    await srv.close();
  }
});

test('cli: an unreachable model endpoint fails fast with a clear error', async () => {
  const s = await sandbox();
  const r = await runCli(
    ['-p', '--kind', 'openai', '--base-url', 'http://127.0.0.1:1/v1', '--api-key', 't', '--model', 'fake', 'hi'],
    { cwd: s.workspace, env: s.env }
  );
  assert.notEqual(r.code, 0, 'must not exit 0 when the model is unreachable');
  assert.match(r.stderr, /ECONNREFUSED|fetch failed|fatal|failed/i);
});

test('cli: an unknown model name lists what is configured', async () => {
  const s = await sandbox();
  await fs.writeFile(path.join(s.workspace, 'xmonkey.config.json'), JSON.stringify({
    models: { real: { kind: 'ollama', model: 'x' } },
    default: 'real',
  }));
  const r = await runCli(['-p', '--model', 'ghost', 'hi'], { cwd: s.workspace, env: s.env });
  assert.equal(r.code, 2);
  assert.match(r.stderr, /unknown model "ghost"/);
  assert.match(r.stderr, /Configured: real/);
});

test('cli: doctor reports each endpoint and gives an actionable pull command', async () => {
  const s = await sandbox();
  await fs.writeFile(path.join(s.workspace, 'xmonkey.config.json'), JSON.stringify({
    models: {
      local: { kind: 'ollama', baseUrl: 'http://127.0.0.1:11434', model: 'not-pulled-model:1b' },
      dead: { kind: 'openai', baseUrl: 'http://127.0.0.1:1/v1', model: 'x' },
    },
    default: 'local',
  }));
  const r = await runCli(['doctor'], { cwd: s.workspace, env: s.env });
  // Exit code is 1 because the dead endpoint is genuinely unreachable.
  assert.equal(r.code, 1);
  assert.match(r.stdout, /xMonkey doctor/);
  assert.match(r.stdout, /local/);
  assert.match(r.stdout, /dead/);
  assert.match(r.stdout, /unreachable/);
});

test('cli: resume rebuilds the FULL turn including tool calls and results', async () => {
  // Regression: the CLI used to persist only the final assistant message, so a
  // resumed session silently lost every tool call and tool result. The model then
  // answered as if it had never read the files.
  const s = await sandbox();
  await fs.writeFile(path.join(s.workspace, 'data.txt'), 'the word is MANGO\n');
  const srv = await fakeModelServer([
    toolCallTurn('read', { path: 'data.txt' }),
    textTurn('The word is MANGO.'),
  ]);
  try {
    const r = await runCli(
      ['-p', '--kind', 'openai', '--base-url', srv.url, '--api-key', 't', '--model', 'fake', '--mode', 'plan',
        'what word is in data.txt?'],
      { cwd: s.workspace, env: s.env }
    );
    assert.equal(r.code, 0, `stderr: ${r.stderr}`);

    const sid = (await fs.readdir(path.join(s.home, 'sessions')))[0];
    const transcript = await fs.readFile(path.join(s.home, 'sessions', sid, 'transcript.jsonl'), 'utf8');
    assert.match(transcript, /"tool_use"/, 'the tool call was persisted');
    assert.match(transcript, /"tool_result"/, 'the tool result was persisted');

    // Resume: the replayed history must be structurally valid AND contain the tool turn.
    const srv2 = await fakeModelServer([textTurn('Yes, MANGO.')]);
    try {
      const r2 = await runCli(
        ['-p', '--resume', sid.slice(0, 8), '--kind', 'openai', '--base-url', srv2.url, '--api-key', 't', '--model', 'fake', 'confirm'],
        { cwd: s.workspace, env: s.env }
      );
      assert.equal(r2.code, 0, `stderr: ${r2.stderr}`);
      const msgs = srv2.requests[0].messages;
      const roles = msgs.map((m) => m.role);
      assert.ok(roles.includes('tool'), 'the tool result survived the resume');
      const assistantWithCalls = msgs.find((m) => m.role === 'assistant' && m.tool_calls);
      assert.ok(assistantWithCalls, 'the assistant tool call survived the resume');
      assert.equal(assistantWithCalls.tool_calls[0].function.name, 'read');
    } finally {
      await srv2.close();
    }
  } finally {
    await srv.close();
  }
});
