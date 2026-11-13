// The xMonkey command line.
//
// Two modes, one loop:
//   interactive  talk to the agent, approve its actions, watch it work
//   --print      one shot, no prompts, output on stdout (for scripting/CI)
//
// The interaction model that matters: input is a QUEUE, not a prompt call. While
// the agent is running and streaming output, the user can type the next message
// (or `y`/`n` for an approval). If we called readline.question() mid-stream we
// would fight the stream for the terminal and lose keystrokes.

import readline from 'node:readline';
import path from 'node:path';
import fs from 'node:fs/promises';

import { loadConfig, describeConfig, EXAMPLE_CONFIG } from '../config.mjs';
import { buildProvider, probeAll } from '../models/registry.mjs';
import { buildDefaultRegistry, createTodoStore } from '../tools/index.mjs';
import { runAgent } from '../core/loop.mjs';
import { buildSystemPrompt, loadMemory } from '../core/prompt.mjs';
import { SessionStore, resolveSessionId, listSessions } from '../sessions/store.mjs';
import { MODES, MODE_HELP } from '../permissions/gate.mjs';
import { loadSkills, renderSkillCatalogue, skillTool, expandSlashCommand } from '../ext/skills.mjs';
import { connectMcpServers } from '../ext/mcp.mjs';
import { runHooks, hasHooks, HOOK_EVENTS } from '../ext/hooks.mjs';
import { subagentTool } from '../ext/subagent.mjs';
import { banner, brief, c, describeToolCall, renderToolResult, spinner, symbols } from './ui.mjs';

const VERSION = '0.1.0';

export function parseArgs(argv) {
  const flags = { _: [] };
  // One canonical key form for every flag: lowercase with hyphens removed.
  // (Mixing `--list-models` and `--allowOutside` was silently dropping flags.)
  const BOOL = new Set(['print', 'yes', 'help', 'version', 'verbose', 'allowoutside', 'listmodels', 'sessions', 'init', 'doctor']);
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--') { flags._.push(...argv.slice(i + 1)); break; }
    if (a.startsWith('--')) {
      const eq = a.indexOf('=');
      const raw = eq >= 0 ? a.slice(2, eq) : a.slice(2);
      const key = raw.toLowerCase().replace(/-/g, '');
      if (eq >= 0) {
        flags[key] = a.slice(eq + 1);
      } else if (BOOL.has(key)) {
        flags[key] = true;
      } else {
        flags[key] = argv[++i];
      }
      continue;
    }
    if (a === '-p') { flags.print = true; continue; }
    if (a === '-m') { flags.model = argv[++i]; continue; }
    if (a === '-h') { flags.help = true; continue; }
    if (a === '-y') { flags.yes = true; continue; }
    flags._.push(a);
  }
  return flags;
}

const HELP = `xMonkey ${VERSION} — a model-agnostic coding agent harness

USAGE
  xmonkey                     start an interactive session
  xmonkey "fix the failing test"   start with a first message
  xmonkey -p "what does src/cli do?"   one-shot, print answer, exit

FIRST RUN
  setup                       store API keys in ~/.xmonkey/auth.json (0600) and
                              print how to pull the local uncensored model

MODEL SELECTION
  -m, --model <name>          model alias from config (or kind/model spec)
  --kind <kind>               provider kind: anthropic|openai|ollama|lmstudio|vllm
  --base-url <url>            endpoint for the provider
  --api-key <key>             API key (or use ANTHROPIC_API_KEY / OPENAI_API_KEY)
  --list-models               show configured models and whether they are reachable
  --kind deepseek             DeepSeek API (Flash = deepseek-v4-flash,
                              Pro = deepseek-v4-pro)
  doctor                      probe every configured model endpoint

PERMISSIONS
  --mode <mode>               ${MODES.map((m) => `${m} (${MODE_HELP[m]})`).join('\n                              ')}
  -y, --yes                   auto-approve every mutating call (headless-safe)
  --allow-outside             allow reads/writes outside the workspace

SESSION
  --resume [id]               resume a session (id prefix, or omit for the latest)
  --sessions                  list recent sessions
  --max-turns <n>             loop budget (default 60)

OTHER
  --init                      write an example xmonkey.config.json here
  --verbose                   show token usage and timing per turn
  -h, --help                  this text
  --version

CONFIG
  ./xmonkey.config.json, then ~/.config/xmonkey/config.json
  With no config at all, xMonkey looks for a local model server (Ollama,
  LM Studio, llama.cpp) and uses it.
`;

export async function main(argv) {
  const flags = parseArgs(argv);
  const cmd = flags._[0];

  if (flags.help || cmd === 'help') { process.stdout.write(HELP); return 0; }
  if (flags.version || cmd === 'version') { process.stdout.write(`xmonkey ${VERSION}\n`); return 0; }
  if (flags.init || cmd === 'init') return initConfig();
  if (cmd === 'setup') return runSetup(flags);

  const cfg = await loadConfig({ cwd: process.cwd(), flags });

  if (flags.listmodels || cmd === 'models') return showModels(cfg);
  // A bare `--model X` with no prompt is still a session start; only the explicit
  // listing commands short-circuit here.
  if (cmd === 'doctor' || flags.doctor) return doctor(cfg);
  if (flags.sessions || cmd === 'sessions') return showSessions();

  // ---- resolve the provider -------------------------------------------
  let provider;
  try {
    provider = resolveProvider(cfg, flags);
  } catch (err) {
    process.stderr.write(`${symbols.fail} ${err.message}\n\n`);
    process.stderr.write(describeConfig(cfg) + '\n\n');
    process.stderr.write(`Run \`xmonkey --list-models\` to see configured models, or \`xmonkey --init\` to create a config.\n`);
    process.stderr.write(`No local model server was found either. Start one with \`ollama serve\`,\n`);
    process.stderr.write(`or point xMonkey at any endpoint:  xmonkey --kind openai --base-url <url> --model <name>\n`);
    return 2;
  }

  const local = /^(ollama|lmstudio|llama\.cpp|vllm|openai)$/.test(cfg.models[cfg.selected]?.kind ?? '') && isLocalUrl(cfg.models[cfg.selected]?.baseUrl);
  const permissionMode = flags.yes ? 'bypass' : (flags.mode || cfg.permissions.mode || 'default');
  if (!MODES.includes(permissionMode)) {
    process.stderr.write(`${symbols.fail} unknown mode "${permissionMode}". Valid: ${MODES.join(', ')}\n`);
    return 2;
  }

  // ---- session ---------------------------------------------------------
  const resumeRef = flags.resume;
  let store;
  let history = [];
  let resumedMeta = null;
  if (resumeRef !== undefined) {
    const id = await resolveSessionId(typeof resumeRef === 'string' ? resumeRef : 'latest').catch((err) => {
      process.stderr.write(`${symbols.fail} ${err.message}\n`);
      return null;
    });
    if (!id) return 2;
    store = new SessionStore(id);
    history = await store.loadMessages();
    resumedMeta = await store.readMeta();
  } else {
    store = new SessionStore();
  }

  const cwd = process.cwd();
  const memory = await loadMemory(cwd);
  const todoStore = createTodoStore();
  const toolCtx = {
    workspace: cwd,
    todos: todoStore,
    maxToolChars: 30_000,
    allowOutsideWorkspace: !!flags.allowoutside,
  };
  const tools = buildDefaultRegistry(toolCtx);

  // ---- extensions: skills, MCP servers, subagents, hooks ----
  const skills = await loadSkills(cwd);
  if (skills.length) tools.register(skillTool(async () => skills));

  let mcpClients = [];
  const mcpErrors = [];
  if (cfg.mcpServers && Object.keys(cfg.mcpServers).length) {
    const { clients, errors } = await connectMcpServers(cfg.mcpServers);
    mcpClients = clients;
    mcpErrors.push(...errors);
    for (const client of clients) {
      for (const t of client.asXmonkeyTools()) {
        try { tools.register(t); } catch { /* name clash with a built-in: keep the built-in */ }
      }
    }
  }

  // Delegation is useful enough to be on by default, but it must not be able to
  // recurse without bound, and in one-shot mode a subagent that needs approval
  // would deadlock — so it is registered with plan mode as the child default.
  tools.register(subagentTool({
    getProvider: () => resolveProvider(cfg, flags),
    getTools: () => buildDefaultRegistry(toolCtx),
    workspace: cwd,
    depth: 0,
  }));

  const hooks = cfg.hooks && hasHooks(cfg.hooks) ? cfg.hooks : undefined;

  const system = buildSystemPrompt({
    cwd,
    model: provider.model,
    providerId: provider.id,
    permissionMode,
    toolNames: tools.names(),
    memory: memory.map((m) => `### ${m.path}\n${m.text}`).join('\n\n'),
    extra: renderSkillCatalogue(skills) || undefined,
    local,
  });

  const oneShot = flags.print === true;

  if (!oneShot) {
    banner(`${provider.model} ${c.grey(`(${provider.id})`)}${local ? c.grey(' · local') : ''}`, cwd, permissionMode);
    if (cfg.detected) process.stdout.write(`  ${symbols.info} ${c.grey(cfg.detected)}\n\n`);
    if (resumedMeta) process.stdout.write(`  ${symbols.info} ${c.grey(`resumed session ${store.id} (${history.length} messages)`)}\n\n`);
    if (memory.length) process.stdout.write(`  ${symbols.info} ${c.grey(`loaded memory: ${memory.map((m) => m.path).join(', ')}`)}\n\n`);
    if (skills.length) process.stdout.write(`  ${symbols.info} ${c.grey(`skills: ${skills.map((s) => s.id).join(', ')}`)} \n\n`);
    if (mcpClients.length) process.stdout.write(`  ${symbols.info} ${c.grey(`mcp: ${mcpClients.map((c) => `${c.name} (${c.tools.length} tools)`).join(', ')}`)}\n\n`);
    for (const e of mcpErrors) process.stdout.write(`  ${symbols.warn} ${c.yellow(`mcp ${e.server} failed: ${e.error.split('\n')[0]}`)}\n`);
    if (mcpErrors.length) process.stdout.write('\n');
    if (permissionMode === 'bypass') {
      process.stdout.write(`  ${symbols.warn} ${c.yellow('bypass mode: xMonkey will run mutating tools without asking')}\n\n`);
    }
  }

  await store.writeMeta({
    model: cfg.selected,
    modelName: provider.model,
    providerKind: cfg.models[cfg.selected]?.kind,
    permissionMode,
    cwd,
  });

  const firstMessage = flags._.slice(cmd && !isKnownCommand(cmd) ? 0 : 1).join(' ').trim();
  const initial = (typeof flags.message === 'string' ? flags.message : firstMessage) || '';

  const session = {
    provider, tools, system, store, history, permissionMode, cfg, flags,
    oneShot, verbose: !!flags.verbose, todoStore,
    hooks, skills, mcpClients, cwd,
  };

  if (hooks) {
    await runHooks(hooks, 'SessionStart', { sessionId: store.id, cwd }, { cwd });
  }

  const cleanup = async () => {
    if (hooks) await runHooks(hooks, 'SessionEnd', { sessionId: store.id, cwd }, { cwd }).catch(() => {});
    await Promise.all(mcpClients.map((c) => c.close().catch(() => {})));
  };

  try {
    if (oneShot) return await runOneShot(session, initial);
    return await runInteractive(session, initial);
  } finally {
    await cleanup();
  }
}

/**
 * Persist every message a turn appended, in order, with the correct role, so a
 * resumed session rebuilds exactly the conversation that happened — tool calls
 * and tool results included. Persisting only the final assistant message loses
 * the tool history and makes the model answer as if it had never read anything.
 */
async function persistTurn(store, history, fromIndex) {
  for (const m of history.slice(fromIndex)) {
    await store.append({ kind: 'message', role: m.role, content: m.content });
  }
}

function isKnownCommand(cmd) {
  return ['help', 'version', 'init', 'models', 'doctor', 'sessions'].includes(cmd);
}

function isLocalUrl(url) {
  if (!url) return false;
  try {
    const h = new URL(url).hostname;
    return h === '127.0.0.1' || h === 'localhost' || h === '::1' || h.endsWith('.local');
  } catch {
    return false;
  }
}

function resolveProvider(cfg, flags) {
  // Explicit kind on the command line wins: `xmonkey --kind ollama --model llama3.1`
  if (flags.kind) {
    return buildProvider({
      kind: flags.kind,
      model: flags.model || cfg.models[cfg.selected]?.model || 'default',
      baseUrl: flags.baseurl,
      apiKey: flags.apiKey,
    });
  }
  const name = flags.model || cfg.selected;
  if (!name) {
    throw new Error('no model configured and no local model server detected');
  }
  const entry = cfg.models[name];
  if (!entry) {
    const names = Object.keys(cfg.models);
    if (!names.length) throw new Error(`no models configured. Run \`xmonkey --init\` to create one.`);
    throw new Error(`unknown model "${name}". Configured: ${names.join(', ')}`);
  }
  return buildProvider({ ...entry, apiKey: flags.apiKey || entry.apiKey });
}

// ---------------------------------------------------------------- modes

async function initConfig() {
  const target = path.join(process.cwd(), 'xmonkey.config.json');
  try {
    await fs.access(target);
    process.stderr.write(`${symbols.warn} ${target} already exists — not overwriting\n`);
    return 1;
  } catch { /* good */ }
  await fs.writeFile(target, JSON.stringify(EXAMPLE_CONFIG, null, 2) + '\n', 'utf8');
  process.stdout.write(`${symbols.ok} wrote ${c.bold('xmonkey.config.json')}\n\n`);
  process.stdout.write(`Next: start a local model with Ollama (\`ollama pull qwen2.5-coder:7b\`) or set an API key,\nthen run \`xmonkey\`.\n`);
  return 0;
}

/**
 * Interactive credential + model setup.
 * Keys are typed at a hidden prompt, written to ~/.xmonkey/auth.json (0600), and
 * never touch the project config or the shell history.
 */
async function runSetup(flags) {
  const readline = await import('node:readline');
  const { saveAuth, loadAuth } = await import('../config.mjs');
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: true });

  const ask = (q) => new Promise((res) => rl.question(q, res));
  const askHidden = (q) => new Promise((res) => {
    const onData = (char) => {
      if (['\n', '\r', '\u0004'].includes(char)) {
        process.stdin.removeListener('data', onData);
        process.stdin.setRawMode?.(false);
        process.stdout.write('\n');
        res(buf);
      } else if (char === '\u0003') {
        process.exit(1);
      } else if (char === '\u007f') {
        buf = buf.slice(0, -1);
      } else {
        buf += char;
      }
    };
    let buf = '';
    process.stdin.setRawMode?.(true);
    process.stdin.resume();
    process.stdin.on('data', onData);
    process.stdout.write(q);
  });

  process.stdout.write(`${c.bold('xMonkey setup')}\n\n`);
  const auth = await loadAuth();

  process.stdout.write('DeepSeek API key (Flash + Pro models). Leave empty to skip.\n');
  process.stdout.write(c.grey('  Get one at https://platform.deepseek.com/api_keys\n'));
  const deepseek = (await askHidden('  key: ')).trim();
  if (deepseek) {
    auth.deepseek = deepseek;
    process.stdout.write(`  ${symbols.ok} DeepSeek key saved\n`);
  }

  if (await ask(`Add an Anthropic key too? [y/N] `).then((a) => /^y/i.test(a.trim()))) {
    const k = (await askHidden('  key: ')).trim();
    if (k) { auth.anthropic = k; process.stdout.write(`  ${symbols.ok} Anthropic key saved\n`); }
  }

  const where = await saveAuth(auth);
  rl.close();
  process.stdout.write(`\n${symbols.ok} credentials written to ${where} (0600)\n`);
  process.stdout.write(`\nNext:\n`);
  process.stdout.write(`  xmonkey --list-models          # confirm the roster\n`);
  process.stdout.write(`  xmonkey doctor                 # verify each endpoint answers\n`);
  process.stdout.write(`  xmonkey -m deepseek-flash      # use Flash\n`);
  process.stdout.write(`  xmonkey -m deepseek-pro        # use Pro\n`);
  process.stdout.write(`\nLocal uncensored model:\n`);
  process.stdout.write(`  ollama pull huihui_ai/qwen3.8-27b-abliterated\n`);
  process.stdout.write(`  xmonkey -m qwen-uncensored\n`);
  return 0;
}

async function showModels(cfg) {
  const names = Object.keys(cfg.models);
  if (!names.length) {
    process.stdout.write('No models configured.\n\nRun `xmonkey --init` to create xmonkey.config.json.\n');
    return 0;
  }
  process.stdout.write(`${c.bold('Configured models')}${cfg.selected ? c.grey(`  (default: ${cfg.selected})`) : ''}\n\n`);
  for (const n of names) {
    const m = cfg.models[n];
    const mark = n === cfg.selected ? c.cyan('*') : ' ';
    process.stdout.write(`${mark} ${c.bold(n)}  ${c.grey(`${m.kind} / ${m.model}${m.baseUrl ? ` @ ${m.baseUrl}` : ''}`)}\n`);
  }
  if (cfg.sources.length) process.stdout.write(`\n${c.grey(`config: ${cfg.sources.join(', ')}`)}\n`);
  return 0;
}

async function doctor(cfg) {
  process.stdout.write(`${c.bold('xMonkey doctor')}\n\n`);
  process.stdout.write(describeConfig(cfg) + '\n\n');
  const results = await probeAll(cfg.models);
  if (!results.length) {
    process.stdout.write(`${symbols.warn} no models configured — nothing to probe\n`);
    process.stdout.write(`Local servers checked: Ollama :11434, LM Studio :1234, llama.cpp :8080\n`);
    return 1;
  }
  let bad = 0;
  for (const r of results) {
    if (r.ok) {
      const listed = r.models?.slice(0, 4).join(', ') || '(no models listed)';
      process.stdout.write(`${symbols.ok} ${c.bold(r.name)} ${c.grey(`${r.kind}`)} reachable — ${listed}${(r.models?.length ?? 0) > 4 ? ', …' : ''}\n`);
      if (r.hasModel === false) {
        const want = cfg.models[r.name]?.model ?? '';
        process.stdout.write(`   ${symbols.warn} "${want}" is not on the server — pull it: ${c.bold(`ollama pull ${want}`)}\n`);
        const chat = (r.models ?? []).filter((m) => !/embed|nomic|minilm|rerank/i.test(m));
        if (chat.length) {
          process.stdout.write(`   ${c.grey('chat-capable models present:')} ${chat.join(', ')}\n`);
        }
      }
    } else {
      bad++;
      process.stdout.write(`${symbols.fail} ${c.bold(r.name)} ${c.grey(`${r.kind}`)} unreachable — ${r.error}\n`);
    }
  }
  process.stdout.write(`\n${bad ? c.yellow(`${bad} of ${results.length} endpoint(s) unreachable`) : c.green('all endpoints reachable')}\n`);
  return bad ? 1 : 0;
}

async function showSessions() {
  const rows = await listSessions(20);
  if (!rows.length) {
    process.stdout.write('No sessions yet.\n');
    return 0;
  }
  process.stdout.write(`${c.bold('Recent sessions')}\n\n`);
  for (const r of rows) {
    const when = new Date(r.mtime).toISOString().replace('T', ' ').slice(0, 16);
    process.stdout.write(`  ${c.cyan(r.id)}  ${c.grey(when)}  ${r.modelName ?? r.model ?? ''}  ${r.permissionMode ?? ''}\n`);
  }
  process.stdout.write(`\nResume with: ${c.bold('xmonkey --resume <id-prefix>')}\n`);
  return 0;
}

// ---------------------------------------------------------------- running

async function runOneShot(session, promptText) {
  if (!promptText) {
    process.stderr.write(`${symbols.fail} --print needs a prompt: xmonkey -p "your question"\n`);
    return 2;
  }
  const { provider, tools, system, store, history, permissionMode } = session;
  history.push({ role: 'user', content: [{ type: 'text', text: promptText }] });
  await store.append({ kind: 'user', content: promptText });

  const ac = new AbortController();
  const onSigint = () => ac.abort(new Error('interrupted'));
  process.once('SIGINT', onSigint);

  try {
    const persistFrom = history.length;
    const out = await runAgent({
      provider, tools, messages: history, system,
      permissions: { mode: permissionMode, rules: session.cfg.permissions.rules ?? [], hooks: session.hooks, cwd: session.cwd },
      maxTurns: session.cfg.loop.maxTurns,
      signal: ac.signal,
      onEvent: (e) => {
        if (e.type === 'text') process.stdout.write(e.text);
        else if (e.type === 'notice' && e.level === 'error') process.stderr.write(`\n${symbols.fail} ${e.message}\n`);
        else if (e.type === 'tool_use' && session.verbose) process.stderr.write(`${symbols.tool} ${describeToolCall(e.name, e.input)}\n`);
      },
    });
    await persistTurn(store, history, persistFrom);
    await store.writeMeta({ lastStopReason: out.stopReason, turns: out.turns, usage: out.usage });
    process.stdout.write('\n');
    if (session.verbose) {
      process.stderr.write(c.grey(`\n${out.turns} turn(s), ${out.usage.inputTokens} in / ${out.usage.outputTokens} out tokens\n`));
    }
    return out.stopReason === 'end_turn' ? 0 : 1;
  } finally {
    process.off('SIGINT', onSigint);
  }
}

async function runInteractive(session, initial) {
  const { provider, tools, system, store, history, permissionMode, todoStore, skills } = session;
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: process.stdin.isTTY });
  readline.emitKeypressEvents(process.stdin, rl);

  /** Queue of typed lines, so input never fights the stream. */
  const pending = [];
  const waiters = [];
  rl.on('line', (line) => {
    if (waiters.length) waiters.shift()(line);
    else pending.push(line);
  });
  rl.on('close', () => {
    while (waiters.length) waiters.shift()(null);
  });

  function nextLine() {
    if (pending.length) return Promise.resolve(pending.shift());
    return new Promise((resolve) => waiters.push(resolve));
  }

  let busy = false;
  let aborter = null;

  /** Approval prompt: consumes the next line, so the user answers in-band. */
  async function askApproval({ tool, input, reason }) {
    process.stdout.write(`\n  ${symbols.warn} ${c.yellow('approve')} ${describeToolCall(tool, input)}\n`);
    process.stdout.write(`     ${c.grey(reason ?? '')}\n  ${c.bold('[y]')}es  ${c.bold('[n]')}o  ${c.bold('[a]')}lways this tool  ${c.grey('(default: n)')} `);
    const answer = (await nextLine())?.trim().toLowerCase();
    process.stdout.write('\n');
    if (answer === 'a') {
      session.cfg.permissions.rules.push({ tool, action: 'allow' });
      process.stdout.write(`  ${symbols.ok} ${c.grey(`${tool} allowed for the rest of this session`)}\n`);
      return true;
    }
    return answer === 'y' || answer === 'yes';
  }

  process.on('SIGINT', () => {
    if (busy && aborter) {
      process.stdout.write(`\n  ${symbols.warn} ${c.yellow('interrupting…')}\n`);
      aborter.abort(new Error('interrupted by user'));
    } else {
      process.stdout.write(`\n${c.grey('bye')}\n`);
      rl.close();
      process.exit(0);
    }
  });

  async function runTurn(text) {
    busy = true;
    aborter = new AbortController();
    const sp = spinner();   // one instance per turn: start/stop are on it, not on the factory
    sp.start();

    let streamedThisTurn = false;
    let printedAssistantHeader = false;
    const started = Date.now();

    const persistFrom = history.length;
    try {
      const out = await runAgent({
        provider, tools, messages: history, system,
        permissions: { mode: permissionMode, rules: session.cfg.permissions.rules ?? [], hooks: session.hooks, cwd: session.cwd },
        maxTurns: session.cfg.loop.maxTurns,
        signal: aborter.signal,
        onAsk: askApproval,
        onEvent: (e) => {
          switch (e.type) {
            case 'turn_start':
              if (e.turn > 1) sp.update(`turn ${e.turn}`);
              break;
            case 'text':
              if (!printedAssistantHeader) {
                sp.stop();
                process.stdout.write(`\n${symbols.assistant} `);
                printedAssistantHeader = true;
              }
              process.stdout.write(e.text);
              streamedThisTurn = true;
              break;
            case 'tool_use':
              sp.stop();
              if (streamedThisTurn) process.stdout.write('\n');
              process.stdout.write(`\n${symbols.tool} ${c.blue(describeToolCall(e.name, e.input))}\n`);
              printedAssistantHeader = false;
              streamedThisTurn = false;
              sp.start();
              break;
            case 'tool_result':
              sp.stop();
              process.stdout.write(renderToolResult(e.name, e.content, e.isError) + '\n');
              if (todoStore.items.length) process.stdout.write(c.grey(todoStore.render().replace(/^/gm, '  ')) + '\n');
              sp.start();
              break;
            case 'notice':
              sp.stop();
              process.stdout.write(`  ${e.level === 'error' ? symbols.fail : e.level === 'warn' ? symbols.warn : symbols.info} ${c.grey(e.message)}\n`);
              sp.start();
              break;
            case 'usage':
              if (session.verbose) {
                sp.stop();
                process.stdout.write(c.grey(`  tokens: ${e.usage.inputTokens ?? '?'} in / ${e.usage.outputTokens ?? '?'} out\n`));
                sp.start();
              }
              break;
            default:
              break;
          }
        },
      });

      sp.stop();
      if (streamedThisTurn) process.stdout.write('\n');
      await persistTurn(store, history, persistFrom);
      await store.writeMeta({ lastStopReason: out.stopReason, turns: out.turns, usage: out.usage });
      if (session.verbose) {
        process.stdout.write(c.grey(`  ${out.turns} turn(s) · ${((Date.now() - started) / 1000).toFixed(1)}s\n`));
      }
      if (out.stopReason !== 'end_turn') {
        process.stdout.write(c.grey(`  (stopped: ${out.stopReason})\n`));
      }
    } catch (err) {
      sp.stop();
      process.stdout.write(`\n  ${symbols.fail} ${c.red(err.message)}\n`);
      if (session.verbose) process.stdout.write(c.grey(String(err.stack) + '\n'));
    } finally {
      busy = false;
      aborter = null;
    }
  }

  process.stdout.write(`${c.grey('Type your request. Ctrl+C interrupts a turn; Ctrl+C at the prompt exits.')}\n\n`);

  if (initial) {
    process.stdout.write(`${symbols.user} ${initial}\n`);
    history.push({ role: 'user', content: [{ type: 'text', text: initial }] });
    await store.append({ kind: 'user', content: initial });
    await runTurn(initial);
  }

  for (;;) {
    process.stdout.write(`\n${symbols.user} `);
    const line = await nextLine();
    if (line === null) break;
    const text = line.trim();
    if (!text) continue;
    // A skill is invocable as /<skill-id>; expand it before it reaches the model.
    const expanded = expandSlashCommand(text, skills);
    if (expanded && !text.startsWith('/exit')) {
      process.stdout.write(`  ${symbols.info} ${c.grey(`expanded skill ${text.split(/\s+/)[0]}`)}\n`);
      history.push({ role: 'user', content: [{ type: 'text', text: expanded }] });
      await store.append({ kind: 'user', content: expanded });
      await runTurn(expanded);
      continue;
    }

    if (text === '/exit' || text === '/quit') break;
    if (text === '/help') {
      process.stdout.write(`${c.grey('Commands: /exit  /model  /mode  /session  /clear  /skills  /help')}\n`);
      if (skills.length) process.stdout.write(`${c.grey('Skills: ')}${skills.map((x) => `/${x.id}`).join('  ')}\n`);
      continue;
    }
    if (text === '/model') {
      process.stdout.write(`  ${c.grey(`model: ${provider.model} (${provider.id}) · capabilities: ${Object.entries(provider.capabilities).filter(([, v]) => v === true).map(([k]) => k).join(', ')}`)}\n`);
      continue;
    }
    if (text === '/mode') {
      process.stdout.write(`  ${c.grey(`mode: ${permissionMode} — ${MODE_HELP[permissionMode]}`)}\n`);
      continue;
    }
    if (text === '/skills') {
      if (!skills.length) process.stdout.write(`  ${c.grey('no skills installed (add .xmonkey/skills/<name>/SKILL.md)')}\n`);
      else for (const sk of skills) process.stdout.write(`  ${c.cyan('/' + sk.id)}  ${c.grey(sk.description)}\n`);
      continue;
    }
    if (text === '/session') {
      process.stdout.write(`  ${c.grey(`session: ${store.id} · ${history.length} messages · ${store.dir}`)}\n`);
      continue;
    }
    if (text === '/clear') {
      history.length = 0;
      process.stdout.write(`  ${symbols.ok} ${c.grey('conversation cleared (session file kept)')}\n`);
      continue;
    }
    history.push({ role: 'user', content: [{ type: 'text', text }] });
    await store.append({ kind: 'user', content: text });
    await runTurn(text);
  }

  rl.close();
  process.stdout.write(`\n${c.grey(`session ${store.id} — resume with: xmonkey --resume ${store.id}`)}\n`);
  return 0;
}
