// Session persistence.
//
// One JSONL file per session, append-only. Append-only is a deliberate choice:
// a crash mid-write loses at most the last record, never the whole transcript,
// and `--resume` can replay whatever survived.
//
// Layout:  ~/.xmonkey/sessions/<session-id>/transcript.jsonl
//          ~/.xmonkey/sessions/<session-id>/meta.json
//
// Record kinds written by the CLI:
//   'user'    one user prompt                    {kind:'user', content:'...'}
//   'message' one assistant/message turn          {kind:'message', role, content:[blocks]}
//
// A turn that used tools appends SEVERAL 'message' records (assistant tool_use,
// user tool_result, final assistant text). Persisting only the last one would
// make `--resume` silently drop the tool history, so the CLI persists each
// message as it is appended and replay reconstructs the whole conversation.

import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';

export function sessionsRoot() {
  return process.env.XMONKEY_HOME
    ? path.join(process.env.XMONKEY_HOME, 'sessions')
    : path.join(os.homedir(), '.xmonkey', 'sessions');
}

export function newSessionId() {
  const d = new Date();
  const stamp = d.toISOString().replace(/[-:]/g, '').replace(/\..+/, '').replace('T', '-');
  const rand = Math.random().toString(36).slice(2, 6);
  return `${stamp}-${rand}`;
}

export class SessionStore {
  /** @param {string} [id] existing session id */
  constructor(id) {
    this.id = id || newSessionId();
    this.dir = path.join(sessionsRoot(), this.id);
    this.started = false;
  }

  async ensure() {
    if (this.started) return this;
    await fs.mkdir(this.dir, { recursive: true });
    this.started = true;
    return this;
  }

  async append(record) {
    await this.ensure();
    const line = JSON.stringify({ ...record, at: new Date().toISOString() }) + '\n';
    await fs.appendFile(path.join(this.dir, 'transcript.jsonl'), line, 'utf8');
  }

  /** Write the mutable metadata (model, mode, title, counters). */
  async writeMeta(meta) {
    await this.ensure();
    const existing = (await this.readMeta()) ?? {};
    const next = { ...existing, ...meta, id: this.id, updatedAt: new Date().toISOString() };
    await fs.writeFile(path.join(this.dir, 'meta.json'), JSON.stringify(next, null, 2), 'utf8');
    return next;
  }

  async readMeta() {
    try {
      return JSON.parse(await fs.readFile(path.join(this.dir, 'meta.json'), 'utf8'));
    } catch {
      return null;
    }
  }

  /** Replay the transcript into a message array the loop can continue from. */
  async loadMessages() {
    let raw;
    try {
      raw = await fs.readFile(path.join(this.dir, 'transcript.jsonl'), 'utf8');
    } catch {
      return [];
    }
    const messages = [];
    for (const line of raw.split('\n')) {
      if (!line.trim()) continue;
      let rec;
      try {
        rec = JSON.parse(line);
      } catch {
        continue; // a torn final line from a crash: skip it, keep going
      }
      if (rec.kind === 'user' && rec.content) messages.push({ role: 'user', content: [{ type: 'text', text: rec.content }] });
      else if (rec.kind === 'message' && Array.isArray(rec.content)) {
        // The role matters: a tool_result turn is a `user` turn. Getting this
        // wrong on resume replayed tool results as assistant text.
        const role = rec.role === 'user' ? 'user' : 'assistant';
        messages.push({ role, content: rec.content });
      }
    }
    return messages;
  }
}

/** List recent sessions, newest first. Used by `xmonkey sessions`. */
export async function listSessions(limit = 20) {
  const root = sessionsRoot();
  let entries;
  try {
    entries = await fs.readdir(root, { withFileTypes: true });
  } catch {
    return [];
  }
  const rows = [];
  for (const e of entries) {
    if (!e.isDirectory()) continue;
    let meta = null;
    try {
      meta = JSON.parse(await fs.readFile(path.join(root, e.name, 'meta.json'), 'utf8'));
    } catch { /* no meta */ }
    let mtime = 0;
    try {
      mtime = (await fs.stat(path.join(root, e.name))).mtimeMs;
    } catch { /* gone */ }
    rows.push({ id: e.name, mtime, ...meta });
  }
  rows.sort((a, b) => b.mtime - a.mtime);
  return rows.slice(0, limit);
}

/** Resolve a user-supplied prefix ("12-34" or "latest") to a session id. */
export async function resolveSessionId(ref) {
  if (!ref || ref === 'latest') {
    const [first] = await listSessions(1);
    if (!first) throw new Error('no sessions to resume');
    return first.id;
  }
  const all = await listSessions(1000);
  const exact = all.find((s) => s.id === ref);
  if (exact) return exact.id;
  const matches = all.filter((s) => s.id.startsWith(ref));
  if (matches.length === 1) return matches[0].id;
  if (matches.length > 1) {
    throw new Error(`"${ref}" matches ${matches.length} sessions: ${matches.map((m) => m.id).join(', ')}`);
  }
  throw new Error(`no session matching "${ref}"`);
}
