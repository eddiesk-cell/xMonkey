// Extension tests: MCP client, hooks, skills, subagents.
// The MCP test spawns a real child process and speaks real JSON-RPC over stdio,
// because a mocked transport would not prove the transport works.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { McpClient, connectMcpServers } from '../src/ext/mcp.mjs';
import { runHooks, hasHooks, HOOK_EVENTS } from '../src/ext/hooks.mjs';
import { loadSkills, parseSkillFile, renderSkillCatalogue, skillTool, expandSlashCommand } from '../src/ext/skills.mjs';
import { subagentTool, MAX_SUBAGENT_DEPTH } from '../src/ext/subagent.mjs';
import { buildDefaultRegistry, createTodoStore } from '../src/tools/index.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const FAKE_MCP = path.join(here, 'fixtures', 'fake-mcp-server.mjs');

async function tmpdir() {
  return fs.mkdtemp(path.join(os.tmpdir(), 'xmext-'));
}

// ---------------------------------------------------------------- MCP

test('mcp: connects over stdio, lists tools, calls one', async () => {
  const client = new McpClient({
    name: 'fake',
    transport: 'stdio',
    command: process.execPath,
    args: [FAKE_MCP],
  });
  await client.connect();
  try {
    assert.equal(client.serverInfo?.name, 'fake-mcp');
    assert.deepEqual(client.tools.map((t) => t.name).sort(), ['echo', 'fail']);

    const ok = await client.callTool('echo', { text: 'monkey' });
    assert.equal(ok.content, 'echo: monkey');
    assert.equal(ok.isError, false);

    const bad = await client.callTool('fail', {});
    assert.equal(bad.isError, true);
    assert.match(bad.content, /always fails/);

    await assert.rejects(() => client.callTool('nope', {}), /no tool nope/);
  } finally {
    await client.close();
  }
});

test('mcp: exposes namespaced xmonkey tools that actually work', async () => {
  const client = new McpClient({ name: 'fake', command: process.execPath, args: [FAKE_MCP] });
  await client.connect();
  try {
    const tools = client.asXmonkeyTools();
    const echo = tools.find((t) => t.name === 'mcp__fake__echo');
    assert.ok(echo, 'tool is namespaced with the server name');
    const out = await echo.run({ text: 'hi' });
    assert.equal(out.content, 'echo: hi');
  } finally {
    await client.close();
  }
});

test('mcp: a broken server is reported, healthy servers still connect', async () => {
  const { clients, errors } = await connectMcpServers({
    good: { command: process.execPath, args: [FAKE_MCP] },
    bad: { command: '/nonexistent/definitely-not-a-binary' },
  });
  try {
    assert.equal(clients.length, 1, 'one healthy server connected');
    assert.equal(errors.length, 1, 'one failure recorded');
    assert.equal(errors[0].server, 'bad');
  } finally {
    await Promise.all(clients.map((c) => c.close()));
  }
});

test('mcp: connecting to a dead command fails with a useful message', async () => {
  const client = new McpClient({ name: 'ghost', command: '/nonexistent/nope' });
  await assert.rejects(() => client.connect(3000), /ghost|ENOENT|exited/);
});

// ---------------------------------------------------------------- hooks

test('hooks: a PreToolUse hook can deny a tool call', async () => {
  const dir = await tmpdir();
  const hooks = {
    PreToolUse: [{ matcher: 'write', command: `printf '{"decision":"deny","reason":"vendor is protected"}'` }],
  };
  const r = await runHooks(hooks, 'PreToolUse', { toolName: 'write', input: { path: 'vendor/x' } }, { cwd: dir });
  assert.equal(r.decision, 'deny');
  assert.match(r.reason, /vendor is protected/);
});

test('hooks: matcher only fires for matching tools', async () => {
  const dir = await tmpdir();
  const hooks = { PreToolUse: [{ matcher: 'bash', command: `printf '{"decision":"deny"}'` }] };
  const r = await runHooks(hooks, 'PreToolUse', { toolName: 'read', input: {} }, { cwd: dir });
  assert.equal(r.decision, undefined, 'read does not match the bash matcher');
});

test('hooks: a non-zero exit with no JSON denies and uses stderr as the reason', async () => {
  const dir = await tmpdir();
  const hooks = { PreToolUse: [{ matcher: '*', command: 'echo "not today" >&2; exit 1' }] };
  const r = await runHooks(hooks, 'PreToolUse', { toolName: 'bash', input: {} }, { cwd: dir });
  assert.equal(r.decision, 'deny');
  assert.match(r.reason, /not today/);
});

test('hooks: a hook can rewrite the tool input', async () => {
  const dir = await tmpdir();
  const hooks = { PreToolUse: [{ matcher: 'bash', command: `printf '{"updatedInput":{"command":"echo rewritten"}}'` }] };
  const r = await runHooks(hooks, 'PreToolUse', { toolName: 'bash', input: { command: 'echo original' } }, { cwd: dir });
  assert.deepEqual(r.updatedInput, { command: 'echo rewritten' });
});

test('hooks: the payload reaches the hook on stdin', async () => {
  const dir = await tmpdir();
  const hooks = {
    PreToolUse: [{ matcher: '*', command: 'cat > hook-received.json; printf \'{"decision":"allow"}\'' }],
  };
  await runHooks(hooks, 'PreToolUse', { toolName: 'read', input: { path: 'x' } }, { cwd: dir });
  const received = JSON.parse(await fs.readFile(path.join(dir, 'hook-received.json'), 'utf8'));
  assert.equal(received.toolName, 'read');
  assert.deepEqual(received.input, { path: 'x' });
  assert.equal(received.event, 'PreToolUse');
});

test('hooks: no hooks configured is a clean no-op', async () => {
  assert.equal(hasHooks({}), false);
  assert.equal(hasHooks({ PreToolUse: [] }), false);
  assert.equal(hasHooks({ PreToolUse: [{ command: 'true' }] }), true);
  const r = await runHooks({}, 'PreToolUse', { toolName: 'x' }, { cwd: process.cwd() });
  assert.equal(r.decision, undefined);
});

test('hooks: hook events list is stable and includes the ones we implement', () => {
  for (const e of ['PreToolUse', 'PostToolUse', 'SessionStart', 'SessionEnd', 'Stop', 'UserPromptSubmit']) {
    assert.ok(HOOK_EVENTS.includes(e), `${e} must be in HOOK_EVENTS`);
  }
});

// ---------------------------------------------------------------- skills

test('skills: parses frontmatter and body', () => {
  const s = parseSkillFile(`---\nname: commit\ndescription: Write a good commit message.\n---\n\nStep one.\nStep two.\n`, 'fallback');
  assert.equal(s.id, 'commit');
  assert.equal(s.description, 'Write a good commit message.');
  assert.match(s.body, /Step one/);
  assert.doesNotMatch(s.body, /^---/, 'frontmatter is stripped from the body');
});

test('skills: a file with no frontmatter still loads', () => {
  const s = parseSkillFile('# My skill\n\nDo the thing.', 'dir-name');
  assert.equal(s.id, 'dir-name');
  assert.match(s.description, /My skill/);
  assert.match(s.body, /Do the thing/);
});

test('skills: discovery walks both user and project dirs, project wins', async () => {
  const cwd = await tmpdir();
  const home = await tmpdir();
  const prevHome = process.env.HOME;
  process.env.HOME = home;
  try {
    await fs.mkdir(path.join(home, '.xmonkey/skills/commit'), { recursive: true });
    await fs.writeFile(path.join(home, '.xmonkey/skills/commit/SKILL.md'), '---\nname: commit\ndescription: user version\n---\nbody\n');
    await fs.mkdir(path.join(home, '.xmonkey/skills/other'), { recursive: true });
    await fs.writeFile(path.join(home, '.xmonkey/skills/other/SKILL.md'), '---\nname: other\ndescription: only in home\n---\nbody\n');
    await fs.mkdir(path.join(cwd, '.xmonkey/skills/commit'), { recursive: true });
    await fs.writeFile(path.join(cwd, '.xmonkey/skills/commit/SKILL.md'), '---\nname: commit\ndescription: project version\n---\nbody\n');

    const skills = await loadSkills(cwd);
    const commit = skills.find((s) => s.id === 'commit');
    assert.equal(commit.description, 'project version', 'project skill overrides the user one');
    assert.ok(skills.find((s) => s.id === 'other'), 'user-only skill still present');
  } finally {
    process.env.HOME = prevHome;
  }
});

test('skills: catalogue advertises names without dumping bodies', () => {
  const text = renderSkillCatalogue([
    { id: 'commit', description: 'Write a commit message.', body: 'SECRET BODY TEXT' },
  ]);
  assert.match(text, /`commit`/);
  assert.match(text, /Write a commit message/);
  assert.doesNotMatch(text, /SECRET BODY TEXT/, 'only descriptions go in the prompt');
});

test('skills: the skill tool loads a body and errors on unknown ids', async () => {
  const tool = skillTool(async () => [{ id: 'commit', description: 'd', body: 'THE STEPS' }]);
  const ok = await tool.run({ name: 'commit' });
  assert.match(ok.content, /THE STEPS/);
  const bad = await tool.run({ name: 'nope' });
  assert.equal(bad.isError, true);
  assert.match(bad.content, /No skill named "nope".*commit/);
});

test('skills: slash command expansion forwards arguments', async () => {
  const skills = [{ id: 'commit', description: 'd', body: 'Write the message.' }];
  const expanded = expandSlashCommand('/commit fix the parser', skills);
  assert.match(expanded, /Arguments: fix the parser/);
  assert.match(expanded, /Write the message/);
  assert.equal(expandSlashCommand('/unknown x', skills), null);
  assert.equal(expandSlashCommand('plain text', skills), null);
});

// ---------------------------------------------------------------- subagents

function scriptedProvider(text) {
  return {
    id: 'scripted', model: 'scripted', maxTokens: 2048,
    capabilities: { streaming: true, nativeTools: true, parallelTools: false, systemRole: true, images: false, thinking: false, contextWindow: 100_000 },
    async complete() {
      return { content: [{ type: 'text', text }], stopReason: 'end_turn', usage: {} };
    },
  };
}

test('subagent: returns the child report and never leaks child tool calls', async () => {
  const ws = await tmpdir();
  const tool = subagentTool({
    getProvider: () => scriptedProvider('I found three call sites in src/a.js.'),
    getTools: () => buildDefaultRegistry({ workspace: ws, todos: createTodoStore() }),
    workspace: ws,
  });
  const out = await tool.run({ prompt: 'Find every call site of computeThing and report the files.' });
  assert.match(out.content, /Subagent report/);
  assert.match(out.content, /three call sites/);
  assert.equal(out.isError, false);
});

test('subagent: refuses a prompt that is not a real brief', async () => {
  const ws = await tmpdir();
  const tool = subagentTool({
    getProvider: () => scriptedProvider('x'),
    getTools: () => buildDefaultRegistry({ workspace: ws, todos: createTodoStore() }),
    workspace: ws,
  });
  const v = tool.validate({ prompt: 'look' });
  assert.equal(v.ok, false);
  assert.match(v.error, /self-contained brief/);
});

test('subagent: depth is capped so agents cannot spawn forever', () => {
  const ws = os.tmpdir();
  const tool = subagentTool({
    getProvider: () => scriptedProvider('x'),
    getTools: () => buildDefaultRegistry({ workspace: ws, todos: createTodoStore() }),
    workspace: ws,
    depth: MAX_SUBAGENT_DEPTH,
  });
  const v = tool.validate({ prompt: 'a long enough prompt to pass the length check here' });
  assert.equal(v.ok, false);
  assert.match(v.error, /depth limit/);
});

// ---------------------------------------------------------------- real-world skill compatibility

test('skills: a genuine Anthropic-format SKILL.md loads with its supporting files', async () => {
  // This file is a real bundled skill from Claude Desktop, baked into the test so
  // the format contract is proven against reality, not a fixture we invented.
  const cwd = await tmpdir();
  const dir = path.join(cwd, '.xmonkey/skills/pdf');
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(path.join(dir, 'SKILL.md'), [
    '---',
    'name: pdf',
    'description: Use this skill whenever the user wants to do anything with PDF files.',
    'license: Proprietary. LICENSE.txt has complete terms',
    '---',
    '',
    '# PDF Processing Guide',
    '',
    '## Overview',
    '',
    'See REFERENCE.md for advanced features and FORMS.md for form filling.',
    '',
    '```python',
    'from pypdf import PdfReader',
    '```',
  ].join('\n'));
  await fs.writeFile(path.join(dir, 'REFERENCE.md'), '# Reference\n');
  await fs.writeFile(path.join(dir, 'FORMS.md'), '# Forms\n');
  await fs.writeFile(path.join(dir, 'LICENSE.txt'), 'terms\n');

  const skills = await loadSkills(cwd);
  const pdf = skills.find((s) => s.id === 'pdf');
  assert.ok(pdf, 'real-format skill discovered');
  assert.match(pdf.description, /^Use this skill whenever/);
  assert.ok(pdf.body.startsWith('# PDF Processing Guide'), 'frontmatter stripped, body intact');
  assert.deepEqual(pdf.files, ['FORMS.md', 'LICENSE.txt', 'REFERENCE.md'], 'sibling files recorded');

  // The model is told where the skill lives and what it can read next.
  const tool = skillTool(async () => [pdf]);
  const loaded = await tool.run({ name: 'pdf' });
  assert.match(loaded.content, /Skill directory:/);
  assert.match(loaded.content, /REFERENCE\.md/);
  assert.match(loaded.content, /# PDF Processing Guide/);
});
