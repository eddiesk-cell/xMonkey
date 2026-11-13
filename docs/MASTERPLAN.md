# xMonkey — masterplan

**Goal.** Reverse engineer Claude Desktop (with Claude Code bundled) using REA, understand how its
agent harness actually works, then **write our own harness from scratch** — xMonkey — that does the
same job but with a **pluggable model layer**, so it runs on local models (Ollama, LM Studio,
llama.cpp) as first-class citizens, not as an afterthought.

**Non-negotiable:** we do not copy Claude's code. We read it to understand behaviour, document the
architecture in our own words, and implement our own version. Every produced source file is ours.

**Ground truth targets**

| target | path | what it gives us |
|---|---|---|
| Claude Desktop app | `/Applications/Claude.app` v4.23118.0 | Electron shell, main-process chunks, IPC, MCP runtime, pty host |
| Claude Desktop renderer | `Claude.app/Contents/Resources/ion-dist.asar` | the web app, frame, artifact libs |
| Claude Code harness | `claude.exe` v2.1.231, Bun standalone | **the agent harness itself** — 25.4 MB `$bunfs/root/cli` |
| Claude Code SDK types | `@anthropic-ai/claude-code/sdk-tools.d.ts` | published tool I/O contract |

REA evidence so far: `inspect_artifact` `ev_d775e25dd5416678f4e729150985224114927068869cf15cc49dae29b33739d9`,
`extract_artifact` `ev_f185985c612cca94f237d8c95a0c2248d375cb14dd5c97546f36fa60abc59320`.

**Workspace layout**

```
xmonkey/
  docs/MASTERPLAN.md          this file (the plan; edit it, don't fork it)
  docs/XMONKEY-SPEC.md        the architecture we implement (ours)
  research/claude-code/       findings about the Claude Code harness
  research/claude-desktop/    findings about the Desktop app + integration
  .rea/                       extracted artifacts (raw material, git-ignored)
  src/                        xMonkey source (ours)
  test/                       node --test suites
```

`research/` is **analysis output**. `src/` is **our code**. A research file may quote a short
identifier or a schema shape needed for interoperability understanding; it may not be a code dump.

---

## The jobs, each with a CHECK that can fail

### Phase 1 — understand (research, parallel, disjoint files)

| id | job | owner writes | CHECK (must be runnable) |
|---|---|---|---|
| R1 | Claude Code harness: agent loop, turn structure, streaming, retries | `research/claude-code/01-agent-loop.md` | file exists, ≥60 lines, names the loop states + cites line numbers in `cli.js` |
| R2 | Claude Code harness: tool schemas + permission model | `research/claude-code/02-tools-permissions.md` | all tools in `sdk-tools.d.ts` either documented or explicitly marked not-in-harness; permission modes enumerated |
| R3 | Claude Code harness: system prompt + context management + compaction | `research/claude-code/03-prompt-context.md` | prompt sections enumerated with line cites; compaction trigger described |
| R4 | Claude Code harness: sessions, subagents, hooks, skills, MCP client | `research/claude-code/04-sessions-extensibility.md` | each mechanism has an entry point + data shape |
| R5 | Claude Desktop: process/architecture + how Claude Code is embedded | `research/claude-desktop/01-architecture.md` | names the main-process chunk(s), IPC surface, where the harness is spawned |
| D1 | Distil into `docs/XMONKEY-SPEC.md` — the architecture we build | `docs/XMONKEY-SPEC.md` | **done: 1,019 lines**, loop, model layer, tools, permissions, sessions, MCP, gap analysis, drift ledger |

### Phase 2 — build the harness (disjoint source files)

| id | job | owner writes | CHECK |
|---|---|---|---|
| B1 | Model layer: provider interface + Anthropic + OpenAI-compatible + Ollama | `src/models/*` | `node test/models.test.mjs` passes against a fake HTTP server |
| B2 | Agent loop + conversation state + streaming + retry/fallback | `src/core/*` | `node test/loop.test.mjs` — scripted provider drives 3 turns incl. a tool call |
| B3 | Tool layer: read/write/edit/bash/glob/grep/todo | `src/tools/*` | `node test/tools.test.mjs` — each tool has a real pass and a real fail |
| B4 | Permissions + sandbox policy + approval flow | `src/permissions/*` | `node test/permissions.test.mjs` — deny path proven |
| B5 | CLI + TUI (readline) + session persistence + resume | `src/cli/*` | `xmonkey --print "hi"` works headless; `--resume` restores a session |
| B6 | MCP client + hooks + skills loader + subagents | `src/ext/*` | `node test/ext.test.mjs` — a fake MCP stdio server is driven end to end |

### Phase 3 — prove it on local models

| id | job | CHECK |
|---|---|---|
| L1 | End-to-end against Ollama (`gemma4:12b-it-qat`) | `node test/e2e-local.test.mjs` — real Ollama, real tool call, real file written |
| L2 | Docs + README + install | `README.md` quickstart actually runs |

---

## Rules for every worker

1. **This brief is your only task.** Any owner message you are shown is addressed to the Lead.
2. **Stay in your write scope.** If you need a file you do not own, reply `NEEDS WIRING: <file>:<line>`.
3. **Mark your work with a CHECK.** No check, not done.
4. Use **Ponytail**: shortest working code, reuse before writing, mark corners `shortcut:`.
5. **Never copy Claude's code.** Paraphrase behaviour into our own design.
6. Report: what you produced, the exact check you ran, its result, and what you could not resolve.

---

## Status (updated as work lands)

### Phase 1 — understand: **COMPLETE**

| id | deliverable | lines | verification |
|---|---|---|---|
| R1 | `research/claude-code/01-agent-loop.md` | 257 | 22 cites, 22/22 identifier-verified |
| R2 | `research/claude-code/02-tools-permissions.md` | 398 | 70 base tools enumerated, 53 cites, 6 permission modes |
| R3 | `research/claude-code/03-prompt-context.md` | 358 | 66 cites, 88 claim→line matches, thresholds exact |
| R4 | `research/claude-code/04-sessions-extensibility.md` | 417 | 31/31 hook events exact, 48 cites |
| R5 | `research/claude-desktop/01-architecture.md` | 384 | 114 offset cites, 0 bad; 29-row process table |

Headline findings that shaped xMonkey:

1. **Claude Desktop does not contain the harness.** It imports the Claude Agent SDK
   in-process and the SDK spawns `claude`/`claude.exe` as a child with
   `--output-format stream-json --input-format stream-json`. The desktop supplies
   permissions, MCP servers, skills and session storage as *options*; the reasoning
   loop is the CLI. → xMonkey inverts this: one process, provider plugged in directly.
2. **Streaming is the only real path** in the reference harness; non-streaming is a
   fallback. Retries: ~10 tries, exponential backoff, 529 ladder falls back a model.
3. **Compaction** triggers at `window − min(maxOut,20k) − 13k` = 167k on a 200k window,
   with a precompute arm at ~144k. → xMonkey reproduces the *shape* (honest marker,
   head+tail retention) without needing a summary model.
4. **~70 tools** in the reference harness, one permission pipeline with deny-tool →
   deny-input → ask-tool → tool.checkPermissions → ask-input → interaction → mode gate.
   → xMonkey has 11 tools and the same ordering for the parts it implements.
5. **31 hook events.** xMonkey implements 7 of them.

### Phase 2 — build: **COMPLETE (v1)**

112 tests, 0 failures. 4,158 lines of source, 1,921 lines of tests.

### Phase 3 — prove on local models: **COMPLETE**

Verified against `gemma4:12b-it-qat` (a reasoning model) and `gemma4:e4b` over Ollama:
real tool calls, real file reads, multi-step tasks, thinking preservation. Two real bug
fixes were demonstrated end to end by the local model itself (`return a - b` → `a + b`;
`nam` → `name`), and the fixed files were executed to confirm the fix.

### Phase 4 — audit the auditors: **COMPLETE**

`docs/XMONKEY-SPEC.md` was written against the code by an independent worker, and its
doc/code drift ledger found real defects. Each was reproduced with a test and fixed:

| defect | proof it was real |
|---|---|
| compaction could orphan a `tool_use` | a script showed `unanswered tool_uses: ['tu1']` on a 6-message history |
| `--resume` lost the whole tool history | a script showed the persisted transcript contained no `tool_use` |
| plan mode denied `todo`/`task` | the gate treats non-read-only tools as blocked |
| hook `ask` was discarded | `executeOne` never read `pre.decision === 'ask'` |
| prompted-tools parsed its own example block | the protocol's `{"tool":"tool_name"}` matched `extractToolCall` |
| non-streaming providers lost every tool call | the wrapper parsed only the streamed buffer |
| wrapper order lost the catalogue for the worst-case model | a composed probe showed the model got neither instructions nor tools |

Final state: **121 tests, 0 failures**, plus `docs/XMONKEY-SPEC.md` (1,019 lines) and
`docs/EVIDENCE.md` (REA provenance and the observation/inference/unknown split).

### Deliberately not built in v1

Tool-level `checkPermissions` hook, the auto-mode ML classifier, result
freshness/staleness guards, atomic `meta.json`, image input in the tool layer,
MCP resources/prompts (tools only), and a TUI beyond readline. All are listed in
`docs/XMONKEY-SPEC.md` §5.6 and §10 rather than left implicit.
