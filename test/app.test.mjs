// App-layer tests: the session API the desktop UI drives.
//
// The GUI itself is verified by screenshot (tools/build-app.mjs + `--smoke`), but
// the contract it depends on — createSession's shape, its event stream, and the
// permission callback — is tested here so a change to the loop cannot silently
// break the app.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';

import { createSession, probeModels, scaffoldConfig } from '../src/app/session.mjs';

async function fakeServer(turns) {
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
      for (const e of step) res.write(`data: ${JSON.stringify(e)}\n\n`);
      res.write('data: [DONE]\n\n');
      res.end();
    });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  return {
    url: `http://127.0.0.1:${server.address().port}/v1`,
    requests,
    close: () => new Promise((r) => server.close(r)),
  };
}

const toolTurn = (name, args) => [
  { choices: [{ delta: { tool_calls: [{ index: 0, id: 'call_1', function: { name, arguments: JSON.stringify(args) } }] } }] },
  { choices: [{ delta: {}, finish_reason: 'tool_calls' }] },
];
const textTurn = (t) => [
  { choices: [{ delta: { content: t } }] },
  { choices: [{ delta: {}, finish_reason: 'stop' }] },
];

async function sandbox(models) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'xmapp-'));
  const home = path.join(dir, '.xm');
  await fs.mkdir(home, { recursive: true });
  const ws = path.join(dir, 'ws');
  await fs.mkdir(ws, { recursive: true });
  if (models) {
    await fs.writeFile(path.join(ws, 'xmonkey.config.json'), JSON.stringify({
      models,
      default: Object.keys(models)[0],
      permissions: { mode: 'default', rules: [] },
      loop: { maxTurns: 20 },
    }));
  }
  return { dir, home, ws, env: { XMONKEY_HOME: home } };
}

const prevHome = process.env.XMONKEY_HOME;
function useHome(home) { process.env.XMONKEY_HOME = home; }
function restoreHome() {
  if (prevHome === undefined) delete process.env.XMONKEY_HOME;
  else process.env.XMONKEY_HOME = prevHome;
}

test('app session: reports the model, mode and capabilities the UI renders', async () => {
  const s = await sandbox({ m: { kind: 'openai', baseUrl: 'http://127.0.0.1:1/v1', model: 'test-model' } });
  useHome(s.home);
  try {
    const session = await createSession({ cwd: s.ws, onEvent: () => {} });
    try {
      assert.equal(session.model.name, 'm');
      assert.equal(session.model.model, 'test-model');
      assert.equal(session.mode, 'default');
      assert.equal(typeof session.local, 'boolean');
      assert.ok(Array.isArray(session.models), 'the model picker needs the list');
      assert.equal(session.models[0].name, 'm');
      assert.ok(session.id, 'a session id is shown in the title bar');
      assert.ok(session.capabilities, 'capabilities drive UI affordances');
    } finally {
      await session.close();
    }
  } finally {
    restoreHome();
  }
});

test('app session: an explicit modelConfig starts an auto-detected model', async () => {
  // This is the bug the packaged smoke test caught: the GUI shows a detected
  // model ("auto-local") that is not in the config file, so the entry must be
  // supplied directly or starting the session fails with "unknown model".
  const s = await sandbox({ other: { kind: 'openai', baseUrl: 'http://127.0.0.1:1/v1', model: 'x' } });
  useHome(s.home);
  try {
    const session = await createSession({
      cwd: s.ws,
      modelName: 'auto-local',
      modelConfig: { kind: 'openai', baseUrl: 'http://127.0.0.1:1/v1', model: 'detected-model' },
      onEvent: () => {},
    });
    try {
      assert.equal(session.model.model, 'detected-model');
    } finally {
      await session.close();
    }
  } finally {
    restoreHome();
  }
});

test('app session: streams the event sequence the renderer switches on', async () => {
  const s = await sandbox();
  const srv = await fakeServer([toolTurn('read', { path: 'a.txt' }), textTurn('found it')]);
  await fs.writeFile(path.join(s.ws, 'a.txt'), 'contents here\n');
  useHome(s.home);
  try {
    const session = await createSession({
      cwd: s.ws,
      modelName: 'm',
      modelConfig: { kind: 'openai', baseUrl: srv.url, model: 'fake' },
    });
    // createSession reads config for the model list; the explicit modelConfig
    // above is what actually builds the provider.
    const events = [];
    const s2 = await createSession({
      cwd: s.ws,
      modelName: 'm',
      modelConfig: { kind: 'openai', baseUrl: srv.url, model: 'fake' },
      onEvent: (e) => events.push(e.type),
      onAsk: async () => true,
    });
    await session.close();
    const out = await s2.send('read a.txt');
    await s2.close();

    assert.equal(out.stopReason, 'end_turn');
    for (const t of ['user', 'turn_start', 'tool_use', 'tool_result', 'text', 'done', 'turn_done']) {
      assert.ok(events.includes(t), `renderer expects a "${t}" event; got ${[...new Set(events)].join(',')}`);
    }
  } finally {
    restoreHome();
    await srv.close();
  }
});

test('app session: a denied approval stops the write and the loop still finishes', async () => {
  const s = await sandbox();
  const srv = await fakeServer([toolTurn('write', { path: 'nope.txt', content: 'x' }), textTurn('could not write')]);
  useHome(s.home);
  try {
    const session = await createSession({
      cwd: s.ws,
      modelName: 'm',
      modelConfig: { kind: 'openai', baseUrl: srv.url, model: 'fake' },
      onEvent: () => {},
      onAsk: async () => false,
    });
    const out = await session.send('write nope.txt');
    await session.close();
    assert.equal(out.stopReason, 'end_turn', 'the session must not die on a refusal');
    await assert.rejects(fs.access(path.join(s.ws, 'nope.txt')), 'the denied write must not happen');
  } finally {
    restoreHome();
    await srv.close();
  }
});

test('app session: an approved write happens', async () => {
  const s = await sandbox();
  const srv = await fakeServer([toolTurn('write', { path: 'yes.txt', content: 'approved' }), textTurn('done')]);
  useHome(s.home);
  try {
    const session = await createSession({
      cwd: s.ws,
      modelName: 'm',
      modelConfig: { kind: 'openai', baseUrl: srv.url, model: 'fake' },
      onEvent: () => {},
      onAsk: async () => true,
    });
    await session.send('write yes.txt');
    await session.close();
    assert.equal(await fs.readFile(path.join(s.ws, 'yes.txt'), 'utf8'), 'approved');
  } finally {
    restoreHome();
    await srv.close();
  }
});

test('app session: abort stops a turn without corrupting the session', async () => {
  const s = await sandbox();
  const srv = await fakeServer([toolTurn('read', { path: 'a.txt' }), textTurn('never')]);
  await fs.writeFile(path.join(s.ws, 'a.txt'), 'x');
  useHome(s.home);
  try {
    const session = await createSession({
      cwd: s.ws,
      modelName: 'm',
      modelConfig: { kind: 'openai', baseUrl: srv.url, model: 'fake' },
      onEvent: () => {},
    });
    const p = session.send('read a.txt');
    setTimeout(() => session.abort(), 10);
    const out = await p;
    assert.ok(['aborted', 'end_turn'].includes(out.stopReason));
    await session.close();
  } finally {
    restoreHome();
    await srv.close();
  }
});

test('app session: probeModels reports a resolved config for the selected model', async () => {
  const s = await sandbox({ dead: { kind: 'openai', baseUrl: 'http://127.0.0.1:1/v1', model: 'x' } });
  useHome(s.home);
  try {
    const r = await probeModels(s.ws);
    assert.ok(Array.isArray(r.results));
    assert.equal(r.selected, 'dead');
    assert.ok(r.selectedConfig, 'the welcome screen needs the resolved entry to start a session');
    assert.equal(r.selectedConfig.model, 'x');
  } finally {
    restoreHome();
  }
});

test('app session: scaffoldConfig creates a usable config once', async () => {
  const s = await sandbox();
  useHome(s.home);
  try {
    const first = await scaffoldConfig(s.ws);
    assert.equal(first.created, true);
    const cfg = JSON.parse(await fs.readFile(path.join(s.ws, 'xmonkey.config.json'), 'utf8'));
    assert.ok(cfg.models.local);

    const second = await scaffoldConfig(s.ws);
    assert.equal(second.created, false, 'never clobbers an existing config');
  } finally {
    restoreHome();
  }
});

test('app session: a missing model gives an actionable error, not a crash', async () => {
  const s = await sandbox({ real: { kind: 'openai', baseUrl: 'http://127.0.0.1:1/v1', model: 'x' } });
  useHome(s.home);
  try {
    await assert.rejects(
      () => createSession({ cwd: s.ws, modelName: 'ghost', onEvent: () => {} }),
      /unknown model "ghost".*real/s
    );
  } finally {
    restoreHome();
  }
});
