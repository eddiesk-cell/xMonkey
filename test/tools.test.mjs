// Tool layer tests. Every tool gets a real pass AND a real fail, because a test
// that only proves the happy path proves nothing about the guard rails.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { buildDefaultRegistry, createTodoStore } from '../src/tools/index.mjs';
import { validateSchema } from '../src/tools/registry.mjs';
import { globToRegExp } from '../src/tools/search.mjs';

async function workspace(files = {}) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'xmtools-'));
  for (const [rel, content] of Object.entries(files)) {
    const abs = path.join(dir, rel);
    await fs.mkdir(path.dirname(abs), { recursive: true });
    await fs.writeFile(abs, content, 'utf8');
  }
  return dir;
}

function registryFor(ws, over = {}) {
  return buildDefaultRegistry({ workspace: ws, todos: createTodoStore(), maxToolChars: 30_000, ...over });
}

// ---------------------------------------------------------------- read

test('read: returns line numbers and respects offset/limit', async () => {
  const ws = await workspace({ 'a.txt': 'one\ntwo\nthree\nfour\n' });
  const r = registryFor(ws);
  const all = await r.run('read', { path: 'a.txt' });
  assert.match(all.content, /1\tone/);
  assert.match(all.content, /4\tfour/);

  const page = await r.run('read', { path: 'a.txt', offset: 2, limit: 2 });
  assert.match(page.content, /2\ttwo/);
  assert.match(page.content, /3\tthree/);
  assert.doesNotMatch(page.content, /1\tone/);
  assert.match(page.content, /truncated/);
});

test('read: refuses a missing file with a useful message', async () => {
  const ws = await workspace();
  const r = registryFor(ws);
  await assert.rejects(() => r.run('read', { path: 'nope.txt' }), /file not found: nope.txt/);
});

test('read: refuses to dump a binary file', async () => {
  const ws = await workspace();
  await fs.writeFile(path.join(ws, 'bin.dat'), Buffer.from([0x00, 0x01, 0x02, 0x03, 0xff]));
  const r = registryFor(ws);
  const out = await r.run('read', { path: 'bin.dat' });
  assert.match(out.content, /binary file/);
});

test('read: refuses a path outside the workspace', async () => {
  const ws = await workspace();
  const r = registryFor(ws);
  await assert.rejects(() => r.run('read', { path: '../../etc/passwd' }), /outside the workspace/);
});

test('read: --allow-outside widens the boundary deliberately', async () => {
  const ws = await workspace();
  const outside = await workspace({ 'x.txt': 'outside data' });
  const r = registryFor(ws, { allowOutsideWorkspace: true });
  const out = await r.run('read', { path: path.join(outside, 'x.txt') });
  assert.match(out.content, /outside data/);
});

// ---------------------------------------------------------------- write

test('write: creates parents and reports the change', async () => {
  const ws = await workspace();
  const r = registryFor(ws);
  const out = await r.run('write', { path: 'deep/nested/f.txt', content: 'hello\nworld\n' });
  assert.match(out.content, /Created deep\/nested\/f.txt \(12 bytes, 3 lines\)/);
  assert.equal(await fs.readFile(path.join(ws, 'deep/nested/f.txt'), 'utf8'), 'hello\nworld\n');
});

test('write: overwrites and says so', async () => {
  const ws = await workspace({ 'a.txt': 'old' });
  const r = registryFor(ws);
  const out = await r.run('write', { path: 'a.txt', content: 'new' });
  assert.match(out.content, /Overwrote a.txt/);
  assert.equal(await fs.readFile(path.join(ws, 'a.txt'), 'utf8'), 'new');
});

test('write: refuses to escape the workspace', async () => {
  const ws = await workspace();
  const r = registryFor(ws);
  await assert.rejects(() => r.run('write', { path: '../escape.txt', content: 'x' }), /outside the workspace/);
});

// ---------------------------------------------------------------- edit

test('edit: replaces a unique string', async () => {
  const ws = await workspace({ 'code.js': 'const a = 1;\nconst b = 2;\n' });
  const r = registryFor(ws);
  const out = await r.run('edit', { path: 'code.js', oldString: 'const b = 2;', newString: 'const b = 42;' });
  assert.match(out.content, /replaced 1 occurrence/);
  assert.match(await fs.readFile(path.join(ws, 'code.js'), 'utf8'), /const b = 42;/);
});

test('edit: refuses an ambiguous match instead of guessing', async () => {
  const ws = await workspace({ 'dup.txt': 'x\nx\nx\n' });
  const r = registryFor(ws);
  await assert.rejects(
    () => r.run('edit', { path: 'dup.txt', oldString: 'x', newString: 'y' }),
    /occurs 3 times/
  );
  assert.equal(await fs.readFile(path.join(ws, 'dup.txt'), 'utf8'), 'x\nx\nx\n', 'file untouched');
});

test('edit: replaceAll does change every occurrence', async () => {
  const ws = await workspace({ 'dup.txt': 'x\nx\nx\n' });
  const r = registryFor(ws);
  const out = await r.run('edit', { path: 'dup.txt', oldString: 'x', newString: 'y', replaceAll: true });
  assert.match(out.content, /replaced 3 occurrence/);
  assert.equal(await fs.readFile(path.join(ws, 'dup.txt'), 'utf8'), 'y\ny\ny\n');
});

test('edit: missing oldString fails with guidance', async () => {
  const ws = await workspace({ 'a.txt': 'hello' });
  const r = registryFor(ws);
  await assert.rejects(() => r.run('edit', { path: 'a.txt', oldString: 'zzz', newString: 'y' }), /oldString not found/);
});

test('edit: identical old and new is rejected by validation', async () => {
  const ws = await workspace({ 'a.txt': 'hello' });
  const r = registryFor(ws);
  const v = await r.validate('edit', { path: 'a.txt', oldString: 'a', newString: 'a' });
  assert.equal(v.ok, false);
  assert.match(v.error, /identical/);
});

// ---------------------------------------------------------------- list

test('list: shows directories first and skips vendor dirs', async () => {
  const ws = await workspace({ 'src/a.js': '', 'node_modules/junk.js': '', 'README.md': 'hi' });
  const r = registryFor(ws);
  const out = await r.run('list', { path: '.' });
  assert.match(out.content, /src\//);
  assert.match(out.content, /README\.md/);
  assert.doesNotMatch(out.content, /node_modules/);
});

// ---------------------------------------------------------------- glob

test('glob: finds by pattern and sorts newest first', async () => {
  const ws = await workspace({ 'src/a.js': '', 'src/b.ts': '', 'docs/c.md': '' });
  await new Promise((r) => setTimeout(r, 10));
  await fs.writeFile(path.join(ws, 'src/d.js'), 'newer');
  const r = registryFor(ws);
  const out = await r.run('glob', { pattern: '**/*.js' });
  assert.match(out.content, /src\/a\.js/);
  assert.match(out.content, /src\/d\.js/);
  assert.doesNotMatch(out.content, /b\.ts/);
  const lines = out.content.split('\n').filter((l) => l.includes('.js'));
  assert.match(lines[0], /d\.js/, 'newest first');
});

test('glob: reports no matches honestly', async () => {
  const ws = await workspace({ 'a.txt': '' });
  const r = registryFor(ws);
  const out = await r.run('glob', { pattern: '**/*.zzz' });
  assert.match(out.content, /No files matched/);
});

test('globToRegExp: ** crosses directories, * does not', () => {
  assert.ok(globToRegExp('src/**/*.ts').test('src/a/b/c.ts'));
  assert.ok(globToRegExp('*.md').test('README.md'));
  assert.ok(!globToRegExp('*.md').test('docs/README.md'));
  assert.ok(globToRegExp('**/*.{js,ts}').test('a/b/c.ts'));
});

// ---------------------------------------------------------------- grep

test('grep: finds content with file:line form', async () => {
  const ws = await workspace({
    'a.js': 'const needle = 1;\nconst other = 2;\n',
    'b.md': 'no match here\n',
  });
  const r = registryFor(ws);
  const out = await r.run('grep', { pattern: 'needle' });
  assert.match(out.content, /a\.js:1: const needle = 1;/);
  assert.doesNotMatch(out.content, /b\.md/);
});

test('grep: include filter and case sensitivity work', async () => {
  const ws = await workspace({
    'a.js': 'Needle\n', 'b.md': 'Needle\n',
  });
  const r = registryFor(ws);
  const jsOnly = await r.run('grep', { pattern: 'Needle', include: '*.js' });
  assert.match(jsOnly.content, /a\.js/);
  assert.doesNotMatch(jsOnly.content, /b\.md/);

  const ci = await r.run('grep', { pattern: 'needle', ignoreCase: true });
  assert.match(ci.content, /a\.js/);
});

test('grep: an invalid regex is a clean error, not a crash', async () => {
  const ws = await workspace({ 'a.txt': 'x' });
  const r = registryFor(ws);
  await assert.rejects(() => r.run('grep', { pattern: '([' }), /invalid regular expression/);
});

test('grep: binary files are skipped', async () => {
  const ws = await workspace();
  await fs.writeFile(path.join(ws, 'blob.bin'), Buffer.concat([Buffer.from('needle'), Buffer.from([0, 1, 2])]));
  await fs.writeFile(path.join(ws, 'text.txt'), 'needle\n');
  const r = registryFor(ws);
  const out = await r.run('grep', { pattern: 'needle' });
  assert.match(out.content, /text\.txt/);
  assert.doesNotMatch(out.content, /blob\.bin/);
});

// ---------------------------------------------------------------- bash

test('bash: captures stdout and reports a zero exit code', async () => {
  const ws = await workspace();
  const r = registryFor(ws);
  const out = await r.run('bash', { command: 'echo hello' });
  assert.match(out.content, /hello/);
  assert.match(out.content, /exit code: 0/);
  assert.equal(out.isError, false);
});

test('bash: a non-zero exit is flagged as an error but still returns output', async () => {
  const ws = await workspace();
  const r = registryFor(ws);
  const out = await r.run('bash', { command: 'echo boom >&2; exit 3' });
  assert.match(out.content, /boom/);
  assert.match(out.content, /exit code: 3/);
  assert.equal(out.isError, true);
});

test('bash: timeout kills the process', async () => {
  const ws = await workspace();
  const r = registryFor(ws);
  const started = Date.now();
  const out = await r.run('bash', { command: 'sleep 5', timeoutMs: 1000 });
  assert.match(out.content, /timed out/);
  assert.equal(out.isError, true);
  assert.ok(Date.now() - started < 4000, 'must not wait for the full sleep');
});

test('bash: runs in the workspace by default', async () => {
  const ws = await workspace();
  const r = registryFor(ws);
  const out = await r.run('bash', { command: 'pwd' });
  assert.ok(out.content.includes(await fs.realpath(ws)) || out.content.includes(ws));
});

// ---------------------------------------------------------------- todo

test('todo: replaces the list and renders status', async () => {
  const ws = await workspace();
  const r = registryFor(ws);
  const out = await r.run('todo', {
    todos: [
      { content: 'read the code', status: 'completed' },
      { content: 'fix the bug', status: 'in_progress' },
      { content: 'run tests', status: 'pending' },
    ],
  });
  assert.match(out.content, /1\/3 complete/);
  assert.match(out.content, /✔ read the code/);
  assert.match(out.content, /▶ fix the bug/);
  assert.match(out.content, /○ run tests/);
});

test('todo: warns when more than one item is in progress', async () => {
  const ws = await workspace();
  const r = registryFor(ws);
  const out = await r.run('todo', {
    todos: [
      { content: 'a', status: 'in_progress' },
      { content: 'b', status: 'in_progress' },
    ],
  });
  assert.match(out.content, /more than one item is in_progress/);
});

// ---------------------------------------------------------------- registry

test('registry: unknown tool is rejected by validate and run', async () => {
  const ws = await workspace();
  const r = registryFor(ws);
  const v = await r.validate('teleport', {});
  assert.equal(v.ok, false);
  assert.match(v.error, /unknown tool "teleport"/);
  await assert.rejects(() => r.run('teleport', {}), /unknown tool/);
});

test('registry: specs are stable and sorted (prompt-cache friendly)', async () => {
  const ws = await workspace();
  const r = registryFor(ws);
  const names = r.specs().map((s) => s.name);
  assert.deepEqual(names, [...names].sort());
  assert.deepEqual(r.specs(), r.specs(), 'stable across calls');
});

test('registry: disable list removes tools', async () => {
  const ws = await workspace();
  const r = buildDefaultRegistry({ workspace: ws, todos: createTodoStore() }, { disable: ['bash'] });
  assert.equal(r.get('bash'), undefined);
  assert.ok(r.get('read'));
});

test('validateSchema: catches missing required and wrong type', () => {
  const schema = {
    type: 'object',
    properties: { path: { type: 'string' }, n: { type: 'number' } },
    required: ['path'],
    additionalProperties: false,
  };
  assert.deepEqual(validateSchema(schema, { path: 'a' }), []);
  assert.match(validateSchema(schema, {})[0], /path is required/);
  assert.match(validateSchema(schema, { path: 5 })[0], /must be a string/);
  assert.match(validateSchema(schema, { path: 'a', extra: 1 })[0], /not an allowed property/);
});
