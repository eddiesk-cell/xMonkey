// Config + session persistence tests.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { loadConfig, describeConfig, EXAMPLE_CONFIG } from '../src/config.mjs';
import { SessionStore, listSessions, resolveSessionId, sessionsRoot } from '../src/sessions/store.mjs';

async function tmpdir() {
  return fs.mkdtemp(path.join(os.tmpdir(), 'xmcfg-'));
}

// ---------------------------------------------------------------- config

test('config: project file overrides user file, per key', async () => {
  const home = await tmpdir();
  const cwd = await tmpdir();
  const prevHome = process.env.HOME;
  const prevXm = process.env.XMONKEY_HOME;
  process.env.HOME = home;
  delete process.env.XMONKEY_HOME;
  try {
    await fs.mkdir(path.join(home, '.config/xmonkey'), { recursive: true });
    await fs.writeFile(path.join(home, '.config/xmonkey/config.json'), JSON.stringify({
      models: { a: { kind: 'ollama', model: 'user-a' }, b: { kind: 'openai', model: 'user-b' } },
      default: 'a',
      permissions: { mode: 'default' },
      loop: { maxTurns: 10 },
    }));
    await fs.writeFile(path.join(cwd, 'xmonkey.config.json'), JSON.stringify({
      models: { b: { kind: 'openai', model: 'project-b' } },
      loop: { maxTurns: 99 },
    }));

    const cfg = await loadConfig({ cwd });
    assert.equal(cfg.models.a.model, 'user-a', 'user-only model survives');
    assert.equal(cfg.models.b.model, 'project-b', 'project overrides user for the same model');
    assert.equal(cfg.loop.maxTurns, 99, 'project overrides loop budget');
    assert.equal(cfg.default, 'a', 'default inherited from user config');
    assert.equal(cfg.sources.length, 2, 'both files reported');
  } finally {
    process.env.HOME = prevHome;
    if (prevXm !== undefined) process.env.XMONKEY_HOME = prevXm;
  }
});

test('config: CLI flags win over files', async () => {
  const home = await tmpdir();
  const cwd = await tmpdir();
  const prevHome = process.env.HOME;
  process.env.HOME = home;
  try {
    await fs.writeFile(path.join(cwd, 'xmonkey.config.json'), JSON.stringify({
      models: { a: { kind: 'ollama', model: 'file-a' } },
      permissions: { mode: 'plan' },
      loop: { maxTurns: 5 },
    }));
    const cfg = await loadConfig({ cwd, flags: { model: 'a', mode: 'bypass', maxturns: 42 } });
    assert.equal(cfg.selected, 'a');
    assert.equal(cfg.permissions.mode, 'bypass');
    assert.equal(cfg.loop.maxTurns, 42);
  } finally {
    process.env.HOME = prevHome;
  }
});

test('config: the example config builds every model entry', async () => {
  const { buildProvider } = await import('../src/models/registry.mjs');
  for (const [name, entry] of Object.entries(EXAMPLE_CONFIG.models)) {
    const p = buildProvider({ ...entry, baseUrl: entry.baseUrl ?? 'http://127.0.0.1:1', apiKey: 'x' });
    assert.equal(typeof p.complete, 'function', `${name} builds`);
  }
});

test('config: describeConfig explains what was used', async () => {
  const cfg = { sources: ['/a', '/b'], selected: 'm', models: { m: { kind: 'ollama', model: 'x' } }, permissions: { mode: 'plan' } };
  const text = describeConfig(cfg);
  assert.match(text, /config: \/a, \/b/);
  assert.match(text, /model: m -> ollama\/x/);
  assert.match(text, /permission mode: plan/);
});

// ---------------------------------------------------------------- sessions

test('sessions: round-trips messages and metadata', async () => {
  const dir = await tmpdir();
  const prev = process.env.XMONKEY_HOME;
  process.env.XMONKEY_HOME = dir;
  try {
    const store = new SessionStore('test-session-1');
    await store.append({ kind: 'user', content: 'hello' });
    await store.append({ kind: 'message', role: 'assistant', content: [{ type: 'text', text: 'hi there' }] });
    await store.writeMeta({ model: 'gemma4', turns: 1 });

    const reopened = new SessionStore('test-session-1');
    const messages = await reopened.loadMessages();
    assert.equal(messages.length, 2);
    assert.equal(messages[0].role, 'user');
    assert.equal(messages[0].content[0].text, 'hello');
    assert.equal(messages[1].role, 'assistant');
    assert.equal(messages[1].content[0].text, 'hi there');

    const meta = await reopened.readMeta();
    assert.equal(meta.model, 'gemma4');
    assert.equal(meta.turns, 1);
    assert.equal(meta.id, 'test-session-1');
  } finally {
    if (prev === undefined) delete process.env.XMONKEY_HOME;
    else process.env.XMONKEY_HOME = prev;
  }
});

test('sessions: a torn final line does not destroy the transcript', async () => {
  const dir = await tmpdir();
  const prev = process.env.XMONKEY_HOME;
  process.env.XMONKEY_HOME = dir;
  try {
    const store = new SessionStore('torn');
    await store.append({ kind: 'user', content: 'first' });
    await store.append({ kind: 'user', content: 'second' });
    // Simulate a crash mid-write.
    const file = path.join(store.dir, 'transcript.jsonl');
    await fs.appendFile(file, '{"kind":"user","content":"torn');

    const messages = await new SessionStore('torn').loadMessages();
    assert.equal(messages.length, 2, 'complete lines survive');
    assert.deepEqual(messages.map((m) => m.content[0].text), ['first', 'second']);
  } finally {
    if (prev === undefined) delete process.env.XMONKEY_HOME;
    else process.env.XMONKEY_HOME = prev;
  }
});

test('sessions: listing is newest first and resolution accepts a prefix', async () => {
  const dir = await tmpdir();
  const prev = process.env.XMONKEY_HOME;
  process.env.XMONKEY_HOME = dir;
  try {
    const a = new SessionStore('20260101-000000-aaaa');
    await a.append({ kind: 'user', content: 'a' });
    await new Promise((r) => setTimeout(r, 15));
    const b = new SessionStore('20260102-000000-bbbb');
    await b.append({ kind: 'user', content: 'b' });

    const rows = await listSessions();
    assert.equal(rows[0].id, '20260102-000000-bbbb', 'newest first');
    assert.equal(await resolveSessionId('20260101'), '20260101-000000-aaaa');
    assert.equal(await resolveSessionId('latest'), '20260102-000000-bbbb');
    await assert.rejects(() => resolveSessionId('nope'), /no session matching/);
  } finally {
    if (prev === undefined) delete process.env.XMONKEY_HOME;
    else process.env.XMONKEY_HOME = prev;
  }
});

test('sessions: an ambiguous prefix is refused rather than guessed', async () => {
  const dir = await tmpdir();
  const prev = process.env.XMONKEY_HOME;
  process.env.XMONKEY_HOME = dir;
  try {
    for (const id of ['20260101-aaaa', '20260101-bbbb']) {
      const s = new SessionStore(id);
      await s.append({ kind: 'user', content: 'x' });
    }
    await assert.rejects(() => resolveSessionId('20260101'), /matches 2 sessions/);
  } finally {
    if (prev === undefined) delete process.env.XMONKEY_HOME;
    else process.env.XMONKEY_HOME = prev;
  }
});

test('sessions: sessionsRoot honours XMONKEY_HOME', () => {
  const prev = process.env.XMONKEY_HOME;
  process.env.XMONKEY_HOME = '/tmp/xm-home-test';
  try {
    assert.equal(sessionsRoot(), '/tmp/xm-home-test/sessions');
  } finally {
    if (prev === undefined) delete process.env.XMONKEY_HOME;
    else process.env.XMONKEY_HOME = prev;
  }
});
