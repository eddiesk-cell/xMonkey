// Interactive-mode tests.
//
// Interactive is the primary way people use xMonkey. It is split into its own
// file because it needs a different harness (drive stdin, read stdout) and
// because two fatal bugs were once hiding here: an undefined `skills` binding in
// runInteractive, and a spinner factory called as if it were an instance. Both
// would have been caught by these tests.

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
    { choices: [{ delta: { content: 'Working. ' } }] },
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

async function sandbox() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'xmint-'));
  const home = path.join(dir, '.xmonkey-home');
  await fs.mkdir(home, { recursive: true });
  const workspace = path.join(dir, 'work');
  await fs.mkdir(workspace, { recursive: true });
  return { dir, home, workspace, env: { XMONKEY_HOME: home } };
}

function runCliInteractive(args, input, opts) {
  return new Promise((resolve) => {
    const child = execFile(
      process.execPath,
      [BIN, ...args],
      { cwd: opts.cwd, timeout: 90_000, env: { ...process.env, ...opts.env } },
      (err, stdout, stderr) => resolve({ code: err?.code ?? 0, stdout, stderr })
    );
    child.stdin.end(input);
  });
}

// Interactive is the primary way people use this, so it gets real coverage: the
// two fatal bugs found in manual testing (undefined `skills`, spinner called on
// the factory) would both have been caught here.

test('interactive mode answers a message and exits cleanly on /exit', async () => {
  const s = await sandbox();
  await fs.writeFile(path.join(s.workspace, 'note.txt'), 'secret: BANANA\n');
  const srv = await fakeModelServer([
    toolCallTurn('read', { path: 'note.txt' }),
    textTurn('The secret word is BANANA.'),
  ]);
  try {
    const r = await runCliInteractive(
      ['--kind', 'openai', '--base-url', srv.url, '--api-key', 't', '--model', 'fake', '--mode', 'plan'],
      'Read note.txt and tell me the secret word.\n/exit\n',
      { cwd: s.workspace, env: s.env }
    );
    assert.equal(r.code, 0, `stderr: ${r.stderr}`);
    assert.doesNotMatch(r.stderr, /fatal:/, 'interactive mode must not crash');
    assert.match(r.stdout, /BANANA/);
    assert.match(r.stdout, /session .* — resume with/);
  } finally {
    await srv.close();
  }
});

test('interactive mode asks for approval and honours a refusal', async () => {
  const s = await sandbox();
  const srv = await fakeModelServer([
    toolCallTurn('write', { path: 'asked.txt', content: 'should not exist' }),
    textTurn('I was not allowed to write it.'),
  ]);
  try {
    // "n" answers the approval prompt; /exit then leaves.
    const r = await runCliInteractive(
      ['--kind', 'openai', '--base-url', srv.url, '--api-key', 't', '--model', 'fake'],
      'write a file\nn\n/exit\n',
      { cwd: s.workspace, env: s.env }
    );
    assert.equal(r.code, 0, `stderr: ${r.stderr}`);
    assert.match(r.stdout, /approve/, 'the user was actually asked');
    await assert.rejects(fs.access(path.join(s.workspace, 'asked.txt')), 'refused write must not land');
  } finally {
    await srv.close();
  }
});

test('interactive mode /help lists the commands without calling the model', async () => {
  const s = await sandbox();
  const srv = await fakeModelServer([textTurn('unused')]);
  try {
    const r = await runCliInteractive(
      ['--kind', 'openai', '--base-url', srv.url, '--api-key', 't', '--model', 'fake'],
      '/help\n/exit\n',
      { cwd: s.workspace, env: s.env }
    );
    assert.equal(r.code, 0);
    assert.match(r.stdout, /\/skills/);
    assert.equal(srv.requests.length, 0, 'no model call for a local command');
  } finally {
    await srv.close();
  }
});
