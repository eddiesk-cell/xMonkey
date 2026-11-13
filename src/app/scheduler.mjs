// Scheduled tasks: run a prompt against a project on a schedule.
//
// Claude Desktop's Scheduled runs are server-side. xMonkey has no server, so the
// honest local equivalent is a scheduler inside the app that wakes a fresh
// session, runs one prompt, records the result, and closes the session.
//
// Schedule formats, kept deliberately small and checkable:
//   { every: "15m" }                  interval, minimum 5m
//   { daily: "09:00" }                local time, every day
//   { weekday: 1..7, time: "HH:MM" }  weekly, ISO weekday (1 = Monday)
//
// State lives in ~/.xmonkey/schedules.json so it survives a restart. Each run is
// appended to the schedule's `runs` history (last 20 kept).

import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';

const MAX_RUNS_KEPT = 20;
const MIN_EVERY_MS = 5 * 60 * 1000;

export function schedulesPath() {
  const home = process.env.XMONKEY_HOME || path.join(os.homedir(), '.xmonkey');
  return path.join(home, 'schedules.json');
}

export async function loadSchedules() {
  try {
    const raw = await fs.readFile(schedulesPath(), 'utf8');
    const data = JSON.parse(raw);
    return Array.isArray(data.schedules) ? data : { schedules: [] };
  } catch {
    return { schedules: [] };
  }
}

export async function saveSchedules(state) {
  const p = schedulesPath();
  await fs.mkdir(path.dirname(p), { recursive: true });
  const tmp = `${p}.tmp`;
  await fs.writeFile(tmp, JSON.stringify(state, null, 2), 'utf8');
  await fs.rename(tmp, p);   // atomic: a crash never leaves half a file
}

/**
 * Parse "15m", "2h", "90s" or a raw number of minutes.
 * The 5-minute floor is a SCHEDULING rule (validateEvery), not a parsing one:
 * short forms are still valid durations.
 */
export function parseEvery(value) {
  if (typeof value === 'number') return value * 60_000;
  const m = String(value ?? '').trim().match(/^(\d+(?:\.\d+)?)\s*(s|m|h)?$/i);
  if (!m) throw new Error(`cannot parse interval "${value}" — use for example "15m", "2h"`);
  const n = parseFloat(m[1]);
  const unit = (m[2] || 'm').toLowerCase();
  return unit === 's' ? n * 1000 : unit === 'h' ? n * 3_600_000 : n * 60_000;
}

/** Reject intervals that would hammer a model or a filesystem. */
export function validateEvery(value) {
  const ms = parseEvery(value);
  if (ms < MIN_EVERY_MS) throw new Error(`interval must be at least 5 minutes (got "${value}")`);
  return ms;
}

function parseTime(hhmm) {
  const m = String(hhmm ?? '').match(/^(\d{1,2}):(\d{2})$/);
  if (!m) throw new Error(`cannot parse time "${hhmm}" — use "HH:MM"`);
  const h = Number(m[1]);
  const min = Number(m[2]);
  if (h > 23 || min > 59) throw new Error(`time out of range: "${hhmm}"`);
  return { h, min };
}

/** Next fire time for a schedule, from `now`. */
export function nextRun(spec, now = new Date()) {
  if (spec.every) {
    const everyMs = spec.everyMs ?? parseEvery(spec.every);
    const base = spec.lastRunAt ? new Date(spec.lastRunAt).getTime() : now.getTime();
    const next = base + everyMs;
    if (next > now.getTime()) return new Date(next);
    // The interval elapsed while the app was closed: fire once, now.
    return now;
  }

  // `weekday` must be tested BEFORE `daily`: a weekly schedule also carries a
  // `time`, and matching on `time` alone would silently turn it into a daily one.
  if (spec.weekday) {
    const { h, min } = parseTime(spec.time ?? '09:00');
    const want = Number(spec.weekday);          // ISO: 1 = Mon .. 7 = Sun
    if (!Number.isInteger(want) || want < 1 || want > 7) {
      throw new Error(`weekday must be 1 (Mon) to 7 (Sun), got "${spec.weekday}"`);
    }
    const d = new Date(now);
    d.setHours(h, min, 0, 0);
    const wantJs = want === 7 ? 0 : want;       // ISO 7 -> JS Sunday 0
    const delta = (wantJs - d.getDay() + 7) % 7;
    if (delta === 0 && d <= now) d.setDate(d.getDate() + 7);
    else d.setDate(d.getDate() + delta);
    return d;
  }

  if (spec.daily) {
    const { h, min } = parseTime(spec.daily);
    const d = new Date(now);
    d.setHours(h, min, 0, 0);
    if (d <= now) d.setDate(d.getDate() + 1);
    return d;
  }

  throw new Error('a schedule needs one of: every, daily, or weekday');
}

/**
 * The scheduler. It owns one timer and re-arms itself after each tick, so a
 * schedule edit takes effect on the next tick without a restart.
 */
export class Scheduler {
  /**
   * @param {object} deps
   * @param {(opts:object) => Promise<object>} deps.createSession
   * @param {(e:object) => void} [deps.onEvent]
   */
  constructor(deps) {
    this.deps = deps;
    this.timer = null;
    this.running = false;
    this.state = { schedules: [] };
    this.pending = new Map();   // id -> Promise while running
  }

  async start() {
    this.state = await loadSchedules();
    await this.tick();
    return this;
  }

  stop() {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }

  async upsert(spec) {
    if (!spec?.prompt || !spec?.cwd) throw new Error('a schedule needs cwd and prompt');
    if (!spec.every && !spec.daily && !spec.weekday) {
      throw new Error('a schedule needs one of: every, daily, or weekday');
    }
    // Validate eagerly so a bad schedule never reaches the timer.
    if (spec.every) validateEvery(spec.every);
    nextRun(spec);

    const id = spec.id || `sched_${Date.now().toString(36)}`;
    const record = {
      id,
      cwd: spec.cwd,
      prompt: String(spec.prompt).slice(0, 4000),
      modelName: spec.modelName || null,
      mode: spec.mode || 'dontAsk',
      every: spec.every,
      everyMs: spec.every ? validateEvery(spec.every) : undefined,
      daily: spec.daily,
      weekday: spec.weekday ? Number(spec.weekday) : undefined,
      time: spec.time,
      enabled: spec.enabled !== false,
      lastRunAt: spec.lastRunAt ?? null,
      runs: [],
      createdAt: spec.createdAt ?? new Date().toISOString(),
    };
    const i = this.state.schedules.findIndex((s) => s.id === id);
    if (i >= 0) this.state.schedules[i] = { ...this.state.schedules[i], ...record };
    else this.state.schedules.push(record);
    await saveSchedules(this.state);
    this.rearm();
    return record;
  }

  async remove(id) {
    this.state.schedules = this.state.schedules.filter((s) => s.id !== id);
    await saveSchedules(this.state);
    this.rearm();
  }

  async setEnabled(id, enabled) {
    const s = this.state.schedules.find((x) => x.id === id);
    if (!s) throw new Error(`no schedule ${id}`);
    s.enabled = !!enabled;
    await saveSchedules(this.state);
    this.rearm();
  }

  list() {
    return this.state.schedules.map((s) => ({
      ...s,
      next: safeNext(s),
      isRunning: this.pending.has(s.id),
    }));
  }

  rearm() {
    this.stop();
    this.scheduleNextTick();
  }

  scheduleNextTick() {
    const enabled = this.state.schedules.filter((s) => s.enabled);
    let soonest = Infinity;
    for (const s of enabled) {
      const n = safeNext(s);
      if (n) soonest = Math.min(soonest, n.getTime());
    }
    // Wake at the earliest due time, but at least every 30s so schedule edits and
    // clock changes are picked up promptly.
    const delay = Number.isFinite(soonest)
      ? Math.max(500, Math.min(30_000, soonest - Date.now()))
      : 30_000;
    this.timer = setTimeout(() => this.tick().catch(() => this.scheduleNextTick()), delay);
    this.timer.unref?.();
  }

  async tick() {
    if (this.running) { this.scheduleNextTick(); return; }
    this.running = true;
    try {
      const now = new Date();
      for (const s of this.state.schedules) {
        if (!s.enabled) continue;
        const due = safeNext(s);
        if (!due || due > now) continue;
        if (this.pending.has(s.id)) continue;
        this.pending.set(s.id, this.runOnce(s).finally(() => this.pending.delete(s.id)));
      }
    } finally {
      this.running = false;
      this.scheduleNextTick();
    }
  }

  async runOnce(spec) {
    const started = new Date().toISOString();
    let result = { ok: false };
    try {
      const session = await this.deps.createSession({
        cwd: spec.cwd,
        modelName: spec.modelName || undefined,
        mode: spec.mode || 'dontAsk',
        autoApprove: true,       // a scheduled run has nobody to approve anything
      });
      try {
        const out = await session.send(spec.prompt);
        result = { ok: true, stopReason: out.stopReason, text: String(out.finalText ?? '').slice(0, 2000) };
      } finally {
        await session.close().catch(() => {});
      }
    } catch (err) {
      result = { ok: false, error: err.message };
    }
    const run = { at: started, ...result };
    spec.lastRunAt = started;
    spec.runs = [...(spec.runs ?? []), run].slice(-MAX_RUNS_KEPT);
    await saveSchedules(this.state).catch(() => {});
    this.deps.onEvent?.({ type: 'scheduled_run', scheduleId: spec.id, run });
    return run;
  }
}

function safeNext(spec) {
  try {
    return nextRun(spec);
  } catch {
    return null;
  }
}
