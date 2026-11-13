// Tests for the capability set added to close the gap with the reference harness:
// web tools, multi-file edits, notebooks, plan mode, task lists, background jobs.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';

import { buildDefaultRegistry } from '../src/tools/index.mjs';
import { createTodoStore } from '../src/tools/todo.mjs';
import { htmlToText, normalizeResults } from '../src/tools/web.mjs';
import { killAllBackgroundJobs } from '../src/tools/extra.mjs';

async function ws(files = {}) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'xmextra-'));
  for (const [rel, content] of Object.entries(files)) {
    const abs = path.join(dir, rel);
    await fs.mkdir(path.dirname(abs), { recursive: true });
    await fs.writeFile(abs, content, 'utf8');
  }
  return dir;
}
function reg(dir) {
  return buildDefaultRegistry({ workspace: dir, todos: createTodoStore(), maxToolChars: 30000 });
}

// ---------------------------------------------------------------- html → text

test('web: htmlToText strips scripts/styles and keeps block structure', () => {
  const html = `<!doctype html><html><head><title>Test Page</title>
    <style>body{color:red}</style><script>alert('x')</script></head>
    <body><h1>Heading</h1><p>First para.</p><ul><li>One</li><li>Two</li></ul>
    <p>Text with &amp; entity &lt;tag&gt;</p></body></html>`;
  const text = htmlToText(html);
  assert.match(text, /Test Page/);
  assert.match(text, /# Heading/);
  assert.match(text, /First para\./);
  assert.match(text, /- One/);
  assert.doesNotMatch(text, /alert\(/);
  assert.doesNotMatch(text, /color:red/);
  assert.match(text, /& entity <tag>/);
});

// ---------------------------------------------------------------- web_fetch

test('web_fetch: fetches a real local server and returns readable text', async () => {
  const server = http.createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'text/html' });
    res.end('<html><head><title>Local Doc</title></head><body><h1>API</h1><p>Get /users returns a list.</p></body></html>');
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const url = `http://127.0.0.1:${server.address().port}/docs`;
  try {
    const dir = await ws();
    const out = await reg(dir).run('web_fetch', { url });
    assert.match(out.content, /Local Doc/);
    assert.match(out.content, /Get \/users returns a list/);
    assert.doesNotMatch(out.content, /<html>/);
  } finally {
    await new Promise((r) => server.close(r));
  }
});

test('web_fetch: a 404 is a clean tool error', async () => {
  const server = http.createServer((req, res) => { res.writeHead(404); res.end('nope'); });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const url = `http://127.0.0.1:${server.address().port}/missing`;
  try {
    const dir = await ws();
    await assert.rejects(() => reg(dir).run('web_fetch', { url }), /HTTP 404/);
  } finally {
    await new Promise((r) => server.close(r));
  }
});

test('web_fetch: rejects a non-http URL and a malformed URL', async () => {
  const dir = await ws();
  const r = reg(dir);
  const v1 = await r.validate('web_fetch', { url: 'file:///etc/passwd' });
  assert.equal(v1.ok, false);
  assert.match(v1.error, /only http\(s\)/);
  const v2 = await r.validate('web_fetch', { url: 'not a url' });
  assert.equal(v2.ok, false);
});

// ---------------------------------------------------------------- web_search

test('web_search: without an endpoint it explains how to configure one', async () => {
  const dir = await ws();
  await assert.rejects(
    () => reg(dir).run('web_search', { query: 'anything' }),
    /no endpoint configured[\s\S]*webSearch/
  );
});

test('web_search: normalizes each backend shape', () => {
  const searx = normalizeResults('searxng', { results: [{ title: 'A', url: 'https://a', content: 'sa' }] }, 5);
  assert.deepEqual(searx, [{ title: 'A', url: 'https://a', snippet: 'sa' }]);
  const brave = normalizeResults('brave', { web: { results: [{ title: 'B', url: 'https://b', description: 'sb' }] } }, 5);
  assert.deepEqual(brave, [{ title: 'B', url: 'https://b', snippet: 'sb' }]);
  const tavily = normalizeResults('tavily', { results: [{ title: 'C', url: 'https://c', content: 'sc' }] }, 5);
  assert.equal(tavily[0].title, 'C');
});

test('web_search: a custom endpoint is actually called', async () => {
  const server = http.createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ results: [{ title: 'Found', url: 'https://example.com/x', snippet: 'snip' }] }));
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const endpoint = `http://127.0.0.1:${server.address().port}`;
  try {
    const dir = await ws();
    const r = buildDefaultRegistry({
      workspace: dir, todos: createTodoStore(),
      webConfig: { webSearch: { kind: 'searxng', endpoint } },
    });
    const out = await r.run('web_search', { query: 'monkeys', limit: 3 });
    assert.match(out.content, /Found/);
    assert.match(out.content, /example\.com\/x/);
  } finally {
    await new Promise((r) => server.close(r));
  }
});

// ---------------------------------------------------------------- multi_edit

test('multi_edit: applies several edits across several files', async () => {
  const dir = await ws({ 'a.js': 'const x = 1;\nconst y = 2;\n', 'b.js': 'export const z = 3;\n' });
  const out = await reg(dir).run('multi_edit', {
    edits: [
      { path: 'a.js', oldString: 'const x = 1;', newString: 'const x = 10;' },
      { path: 'a.js', oldString: 'const y = 2;', newString: 'const y = 20;' },
      { path: 'b.js', oldString: 'z = 3', newString: 'z = 30' },
    ],
  });
  assert.match(out.content, /3 edit\(s\) across 2 file/);
  assert.equal(await fs.readFile(path.join(dir, 'a.js'), 'utf8'), 'const x = 10;\nconst y = 20;\n');
  assert.equal(await fs.readFile(path.join(dir, 'b.js'), 'utf8'), 'export const z = 30;\n');
});

test('multi_edit: one bad edit means NO file changes (atomicity)', async () => {
  const dir = await ws({ 'a.js': 'alpha\n', 'b.js': 'beta\n' });
  await assert.rejects(
    () => reg(dir).run('multi_edit', {
      edits: [
        { path: 'a.js', oldString: 'alpha', newString: 'ALPHA' },
        { path: 'b.js', oldString: 'nonexistent', newString: 'X' },
      ],
    }),
    /oldString not found/
  );
  assert.equal(await fs.readFile(path.join(dir, 'a.js'), 'utf8'), 'alpha\n', 'a.js must be untouched');
  assert.equal(await fs.readFile(path.join(dir, 'b.js'), 'utf8'), 'beta\n');
});

test('multi_edit: an ambiguous match is refused, not guessed', async () => {
  const dir = await ws({ 'dup.js': 'x\nx\n' });
  await assert.rejects(
    () => reg(dir).run('multi_edit', { edits: [{ path: 'dup.js', oldString: 'x', newString: 'y' }] }),
    /ambiguous/
  );
});

// ---------------------------------------------------------------- notebook

test('notebook_edit: replaces, inserts and deletes cells', async () => {
  const dir = await ws();
  const nb = { cells: [{ cell_type: 'code', source: ['print(1)'], outputs: [], metadata: {}, execution_count: null }], metadata: {}, nbformat: 4, nbformat_minor: 5 };
  await fs.writeFile(path.join(dir, 'n.ipynb'), JSON.stringify(nb));
  const r = reg(dir);

  await r.run('notebook_edit', { path: 'n.ipynb', action: 'replace', cellIndex: 0, source: 'print(2)' });
  let read = JSON.parse(await fs.readFile(path.join(dir, 'n.ipynb'), 'utf8'));
  assert.deepEqual(read.cells[0].source, ['print(2)']);

  await r.run('notebook_edit', { path: 'n.ipynb', action: 'insert', cellIndex: 1, source: '# note', cellType: 'markdown' });
  read = JSON.parse(await fs.readFile(path.join(dir, 'n.ipynb'), 'utf8'));
  assert.equal(read.cells.length, 2);
  assert.equal(read.cells[1].cell_type, 'markdown');

  await r.run('notebook_edit', { path: 'n.ipynb', action: 'delete', cellIndex: 0 });
  read = JSON.parse(await fs.readFile(path.join(dir, 'n.ipynb'), 'utf8'));
  assert.equal(read.cells.length, 1);
  assert.equal(read.cells[0].cell_type, 'markdown');
});

test('notebook_edit: refuses a file that is not a notebook', async () => {
  const dir = await ws({ 'x.json': '{"not":"cells"}' });
  await assert.rejects(
    () => reg(dir).run('notebook_edit', { path: 'x.json', action: 'replace', cellIndex: 0, source: 'a' }),
    /not a Jupyter notebook/
  );
});

// ---------------------------------------------------------------- plan mode

test('plan: enter switches to plan mode; exit proposes and clears on approval', async () => {
  const dir = await ws();
  const ctx = { workspace: dir, todos: createTodoStore() };
  let asked = null;
  const r = buildDefaultRegistry({
    ...ctx,
    onPlan: async (plan) => { asked = plan; return true; },
  });

  const entered = await r.run('plan', { action: 'enter' }, ctx);
  assert.match(entered.content, /plan mode active/i);

  const exit = await r.run('plan', { action: 'exit', plan: '1. read\n2. edit' }, ctx);
  assert.equal(asked, '1. read\n2. edit');
  assert.match(exit.content, /approved/i);
});

test('plan: a rejected plan is an error the model can react to', async () => {
  const dir = await ws();
  const ctx = { workspace: dir, todos: createTodoStore() };
  const r = buildDefaultRegistry({ ...ctx, onPlan: async () => false });
  const out = await r.run('plan', { action: 'exit', plan: 'do a bad thing' }, ctx);
  assert.equal(out.isError, true);
  assert.match(out.content, /rejected/);
});

// ---------------------------------------------------------------- ask_user

test('ask_user: forwards the question and returns the answer', async () => {
  const dir = await ws();
  let seen = null;
  const r = buildDefaultRegistry({
    workspace: dir, todos: createTodoStore(),
    onAsk: async (q) => { seen = q; return 'Postgres'; },
  });
  const out = await r.run('ask_user', {
    question: 'Which database?',
    options: [{ label: 'Postgres' }, { label: 'SQLite' }],
  });
  assert.equal(seen.question, 'Which database?');
  assert.equal(seen.options.length, 2);
  assert.match(out.content, /Postgres/);
});

test('ask_user: with no user available it reports that honestly', async () => {
  const dir = await ws();
  const out = await reg(dir).run('ask_user', { question: 'which?' });
  assert.equal(out.isError, true);
  assert.match(out.content, /No user is available/);
});

// ---------------------------------------------------------------- background jobs

test('bash_background: starts a job, reads its output, kills it', async () => {
  const dir = await ws();
  const r = reg(dir);
  const started = await r.run('bash_background', { command: 'echo hello-from-job; sleep 30' });
  const id = /started (job_\w+)/.exec(started.content)?.[1];
  assert.ok(id, `expected a job id in: ${started.content}`);

  await new Promise((res) => setTimeout(res, 400));
  const out = await r.run('bash_output', { id });
  assert.match(out.content, /hello-from-job/);
  assert.match(out.content, /running/);

  const killed = await r.run('bash_kill', { id });
  assert.match(killed.content, /stopped/);
});
test('bash_output: "all" lists jobs and an unknown id is an error', async () => {
  const dir = await ws();
  const r = reg(dir);
  const all = await r.run('bash_output', { id: 'all' });
  assert.match(all.content, /no background jobs|job_/);
  await assert.rejects(() => r.run('bash_output', { id: 'job_nope' }), /no such job/);
});

// ---------------------------------------------------------------- task list

test('tasks: create, get, update and list', async () => {
  const dir = await ws();
  const r = reg(dir);
  const created = await r.run('task_create', { subject: 'Fix the parser', description: 'no crash on empty input' });
  assert.match(created.content, /task #1/);

  const got = await r.run('task_get', { id: 1 });
  assert.match(got.content, /Fix the parser/);
  assert.match(got.content, /"status": "pending"/);

  const updated = await r.run('task_update', { id: 1, status: 'in_progress' });
  assert.match(updated.content, /in_progress/);

  const listed = await r.run('task_list', {});
  assert.match(listed.content, /#1 \[in_progress\] Fix the parser/);
});

test('tasks: unknown ids are reported, not silently created', async () => {
  const dir = await ws();
  const r = reg(dir);
  const got = await r.run('task_get', { id: 99 });
  assert.equal(got.isError, true);
  const upd = await r.run('task_update', { id: 99, status: 'completed' });
  assert.equal(upd.isError, true);
});

test.after(() => killAllBackgroundJobs());
