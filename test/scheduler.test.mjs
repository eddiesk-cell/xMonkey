// Scheduler tests: interval parsing, next-run maths, and a real run.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';

import {
  Scheduler, parseEvery, validateEvery, nextRun, loadSchedules, saveSchedules, schedulesPath,
} from '../src/app/scheduler.mjs';

async function sandbox() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'xmsched-'));
  return { dir, home: path.join(dir, '.xm') };
}

const prevHome = process.env.XMONKEY_HOME;
function useHome(home) { process.env.XMONKEY_HOME = home; }
function restoreHome() {
  if (prevHome === undefined) delete process.env.XMONKEY_HOME;
  else process.env.XMONKEY_HOME = prevHome;
}

test('scheduler: parseEvery parses durations; validateEvery enforces the floor', () => {
  assert.equal(parseEvery('15m'), 15 * 60_000);
  assert.equal(parseEvery('2h'), 2 * 3_600_000);
  assert.equal(parseEvery('90s'), 90_000);
  assert.equal(parseEvery(10), 10 * 60_000);
  assert.throws(() => parseEvery('banana'), /cannot parse interval/);
  // The 5-minute floor is a scheduling rule, not a parsing rule.
  assert.equal(validateEvery('5m'), 5 * 60_000);
  assert.throws(() => validateEvery('30s'), /at least 5 minutes/);
});

test('scheduler: nextRun for an interval fires after the interval', () => {
  const now = new Date('2026-01-01T10:00:00');
  const spec = { every: '15m', everyMs: 15 * 60_000, lastRunAt: '2026-01-01T10:00:00' };
  const next = nextRun(spec, now);
  assert.equal(next.getTime(), new Date('2026-01-01T10:15:00').getTime());
});

test('scheduler: a missed interval fires immediately, not 15 minutes later', () => {
  const now = new Date('2026-01-01T12:00:00');
  const spec = { every: '15m', everyMs: 15 * 60_000, lastRunAt: '2026-01-01T09:00:00' };
  assert.equal(nextRun(spec, now).getTime(), now.getTime());
});

test('scheduler: daily schedules roll to tomorrow when the time has passed', () => {
  const now = new Date('2026-01-01T10:00:00');
  const later = nextRun({ daily: '18:30' }, now);
  assert.equal(later.getDate(), 1);
  assert.equal(later.getHours(), 18);
  assert.equal(later.getMinutes(), 30);

  const passed = nextRun({ daily: '08:00' }, now);
  assert.equal(passed.getDate(), 2, 'tomorrow');
  assert.equal(passed.getHours(), 8);
});

test('scheduler: weekly schedules land on the requested ISO weekday', () => {
  // 2026-01-01 is a Thursday (getDay() === 4).
  const now = new Date('2026-01-01T10:00:00');
  const next = nextRun({ weekday: 1, time: '09:00' }, now);   // ISO Monday = JS 1
  assert.equal(next.getDay(), 1, 'Monday');
  assert.ok(next > now);
  assert.equal(next.getHours(), 9);
});

test('scheduler: state persists and reloads', async () => {
  const s = await sandbox();
  useHome(s.home);
  try {
    const sched = new Scheduler({ createSession: async () => { throw new Error('unused'); } });
    await sched.upsert({ cwd: s.dir, prompt: 'say hi', every: '15m' });
    sched.stop();

    const state = await loadSchedules();
    assert.equal(state.schedules.length, 1);
    assert.equal(state.schedules[0].prompt, 'say hi');
    assert.equal(state.schedules[0].mode, 'dontAsk', 'scheduled runs default to no-prompt mode');
    assert.equal(await schedulesPath(), path.join(s.home, 'schedules.json'));
  } finally {
    restoreHome();
  }
});

test('scheduler: a bad schedule is rejected before it reaches the timer', async () => {
  const s = await sandbox();
  useHome(s.home);
  try {
    const sched = new Scheduler({ createSession: async () => { throw new Error('unused'); } });
    await assert.rejects(() => sched.upsert({ cwd: s.dir, prompt: 'x' }), /needs one of/);
    await assert.rejects(() => sched.upsert({ cwd: s.dir }), /needs cwd and prompt/);
    await assert.rejects(() => sched.upsert({ cwd: s.dir, prompt: 'x', daily: '99:99' }), /out of range/);
    sched.stop();
  } finally {
    restoreHome();
  }
});

test('scheduler: enable, disable and remove', async () => {
  const s = await sandbox();
  useHome(s.home);
  try {
    const sched = new Scheduler({ createSession: async () => { throw new Error('unused'); } });
    const rec = await sched.upsert({ cwd: s.dir, prompt: 'p', every: '15m' });
    assert.equal(sched.list()[0].enabled, true);

    await sched.setEnabled(rec.id, false);
    assert.equal(sched.list()[0].enabled, false);

    await sched.remove(rec.id);
    assert.equal(sched.list().length, 0);
    sched.stop();
  } finally {
    restoreHome();
  }
});

test('scheduler: a due schedule really runs a session and records the result', async () => {
  const s = await sandbox();
  useHome(s.home);
  // A fake model server so the run is a real end-to-end turn.
  const server = http.createServer((req, res) => {
    req.resume();
    req.on('end', () => {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: 'scheduled ok' } }] })}\n\n`);
      res.write(`data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: 'stop' }] })}\n\n`);
      res.write('data: [DONE]\n\n');
      res.end();
    });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const baseUrl = `http://127.0.0.1:${server.address().port}/v1`;

  try {
    // A "due" schedule: interval long past.
    const sched = new Scheduler({
      createSession: async ({ cwd, mode, autoApprove }) => {
        const { createSession } = await import('../src/app/session.mjs');
        return createSession({
          cwd,
          modelName: 'fake',
          modelConfig: { kind: 'openai', baseUrl, model: 'fake-model' },
          mode,
          autoApprove,
          onEvent: () => {},
        });
      },
    });
    await fs.mkdir(s.dir, { recursive: true });
    await fs.writeFile(path.join(s.dir, 'xmonkey.config.json'), JSON.stringify({
      models: { fake: { kind: 'openai', baseUrl, model: 'fake-model' } },
      default: 'fake',
    }));
    const rec = await sched.upsert({ cwd: s.dir, prompt: 'run it', every: '5m' });
    // Force it due.
    const st = sched.state.schedules.find((x) => x.id === rec.id);
    st.lastRunAt = new Date(Date.now() - 60 * 60_000).toISOString();

    await sched.tick();
    // Wait for the run to finish.
    for (let i = 0; i < 100 && sched.pending.size; i++) await new Promise((r) => setTimeout(r, 50));

    const after = sched.state.schedules.find((x) => x.id === rec.id);
    assert.ok(after.runs.length >= 1, 'a run was recorded');
    assert.equal(after.runs.at(-1).ok, true);
    assert.match(after.runs.at(-1).text, /scheduled ok/);
    sched.stop();
  } finally {
    restoreHome();
    await new Promise((r) => server.close(r));
  }
});
