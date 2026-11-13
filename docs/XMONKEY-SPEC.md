# xMonkey — architecture & implementation contract

**Status:** as-built, v0.1.0. Snapshot taken 2026-11-13 (refreshed against the tree at 08:35, after the
concurrent `run.mjs`/`skills.mjs`/`config.mjs` changes); full suite `node --test test/` → **113 tests,
113 pass, 0 fail, 0 skipped**, including five tests against a real Ollama `gemma4:12b-it-qat`.

**Rule of the house:** this document describes the code that exists. `src/` is the source of truth; if
this file and the code disagree, the code is right and this file is a bug. Every claim below was read
out of `src/` (not from the plan), and §12 lists the places where comments or older plans already drifted.

**Why this document exists:** so the code and the description cannot drift while work continues. It is
written to be checkable: §9 maps every major behaviour to the test that proves it, and explicitly names
the behaviours that are only asserted.

**A note on the brief.** The task brief says input-parameter permission rules, the `dontAsk`/`auto`
modes, and a tool-level `checkPermissions` hook are "NOT implemented". That was true of the plan this
started from, but not of the code. The as-built facts (`src/permissions/gate.mjs`, verified after the
file was updated during this writing) are: all **six modes** exist — `plan, default, acceptEdits,
dontAsk, bypass, auto`; input-parameter rules **are** implemented via `{field, pattern}`; `dontAsk`
**is** implemented and tested; `auto` **is accepted but is not a distinct policy** (it behaves as
`default`); the tool-level `checkPermissions` hook is **not** implemented, and neither are per-tool
result-freshness/staleness guards. §5.6 does the full gap analysis against research file 02 and says
exactly where each missing piece slots in without disturbing the current decision order.

---

## Contents

1. What xMonkey is
2. Model layer
3. Agent loop & prompt assembly
4. Tools
5. Permissions
6. Sessions
7. Extensibility (MCP, hooks, skills, subagents)
8. Deliberate differences from Claude Code
9. What is proven vs what is asserted
10. Roadmap
11. Module map (every file)
12. Doc/code drift ledger

---

## 1. What xMonkey is

xMonkey is a model-agnostic coding-agent harness: a CLI that runs an agent loop over a swappable model
backend, with a tool layer (files, search, shell, todo, skills, subagents, MCP), a permission gate, a
JSONL transcript store, and hooks.

**The one-sentence thesis:** xMonkey does the same job as Claude Code — one loop, one tool contract, one
permission pipeline — but the model is a swappable backend configured as JSON, and a model running on
the same machine (Ollama, LM Studio, llama.cpp, vLLM) is a first-class citizen rather than a degraded
fallback.

What that means concretely, and is enforced by code rather than intent:

- **No model name appears in the loop.** `runAgent` (`src/core/loop.mjs`) only sees a `Provider` object;
  vendor identity lives entirely below `src/models/`.
- **A model with no tool-calling API still works.** The prompted-JSON wrapper (`src/models/prompted.mjs`)
  emulates the tool protocol in the prompt and converts the reply back into a real `tool_use` block.
- **No configuration is required to find a local model.** With no config file at all, `src/config.mjs`
  probes Ollama and common OpenAI-compatible ports and selects a chat model that is already running.
- **Zero runtime dependencies.** Node ≥ 22 built-ins only (`fetch`, `ReadableStream`, `node:readline`,
  `node:child_process`). No SDK, no build step.

Non-goals for v1 (deliberate, see §8 and §10): a desktop shell, model-generated compaction summaries,
parallel tool execution, a web UI, OAuth MCP, background subagents.

Research basis: `research/claude-code/01-agent-loop.md` (loop), `02-tools-permissions.md` (tools and
permissions), `03-prompt-context.md` (prompt and context), `04-sessions-extensibility.md` (sessions,
MCP, hooks, skills, subagents), `research/claude-desktop/01-architecture.md` (how a desktop app embeds
a harness: Agent SDK → child process → `--output-format stream-json`). The desktop finding is why §8
lists "no stream-json embedding surface yet" as a known difference rather than an accident.

---

## 2. Model layer

**Research basis:** `research/claude-code/01-agent-loop.md` §2 (the `callModel` seam Claude hides
behind) and `research/claude-desktop/01-architecture.md` §5 (a host embeds a harness by spawning it);
the vendor-neutral `Provider` shape itself is our design.

### 2.1 The `Provider` interface, as implemented

Defined in `src/core/types.mjs`; every adapter exports `createProvider(config)` returning this shape.

```js
/**
 * @typedef {Object} Provider
 * @property {string} id                       // 'anthropic' | 'openai' | 'ollama' | ...
 * @property {string} model                    // wire model name
 * @property {Capabilities} capabilities
 * @property {(req) => Promise<Completion>} complete
 * // plus, attached by the registry:
 * @property {number} maxTokens                // buildProvider(): cfg.maxTokens || 8192
 */

// complete(req) — the only method the loop calls
complete({
  system: string,                 // already-assembled system prompt ('' allowed)
  messages: Message[],            // canonical history: [{role, content: ContentBlock[]}]
  tools: ToolSpec[],              // [{name, description, inputSchema}] (sorted, stable)
  maxTokens: number,
  temperature?: number,
  signal?: AbortSignal,
  onText?: (chunk: string) => void,     // incremental visible text
  onThinking?: (chunk: string) => void, // reasoning channel, when the model has one
}) => Promise<{
  content: ContentBlock[],
  stopReason: 'end_turn'|'tool_use'|'max_tokens'|'stop_sequence',
  usage: { inputTokens?, outputTokens?, cacheReadTokens?, cacheWriteTokens? }
}>
```

The canonical content blocks are ours, not any vendor's (`types.mjs`):

```js
| { type: 'text',        text }
| { type: 'thinking',    thinking }
| { type: 'image',       mediaType, data }
| { type: 'tool_use',    id, name, input }
| { type: 'tool_result', toolUseId, content, isError? }
```

Token accounting is deliberately crude and provider-agnostic: `estimateTokens(text) = ceil(len / 3.6)`
(conservative vs Claude's 4.0 chars/token — code and local tokenizers tokenize denser), plus fixed
overheads per block, and 1600 tokens per image (`estimateMessages`).

### 2.2 Capabilities: declared vs. actually enforced

`CAP_DEFAULTS` = `{streaming:true, nativeTools:true, parallelTools:true, systemRole:true, images:false,
thinking:false, contextWindow:8192}`. Adapters override per model. **Only two flags are read by code
today**; the rest are declarations with no consumer (a real gap, see §10 item 8).

| flag | set by | what actually reads it | effect today |
|---|---|---|---|
| `nativeTools` | all adapters; `cfg.nativeTools` | `src/models/registry.mjs:41`, `src/models/prompted.mjs:52` | **The one flag that changes protocol.** false (or forced) ⇒ prompted-JSON wrapper |
| `contextWindow` | anthropic 200k, openai 128k, ollama 32k, config override | `src/core/loop.mjs:64` (budget + compaction), `prompted.mjs:136` (trim), `ollama.mjs:70` (`num_ctx`) | Sets when compaction fires and how much history is kept |
| `streaming` | all true | nothing branches on it | Informational; every adapter always streams (`stream:true`) |
| `parallelTools` | all true | nothing | Informational; the loop executes `tool_use` blocks sequentially |
| `systemRole` | all true | nothing | `types.mjs:28` says a model without it gets the system prompt folded into the first user turn — **not implemented** |
| `images` | anthropic true, openai `config.images !== false`, ollama false | nothing in the loop/CLI | Type-level only; the CLI has no image-input path, and ollama's translator accepts images despite reporting false |
| `thinking` | anthropic/ollama true, openai false | nothing routes on it | Adapters parse a reasoning channel whenever the server sends one; anthropic's adapter does not *request* extended thinking |

Surfaced to the user by `/model` (interactive) and used by `probeAll`/`doctor`.

### 2.3 The adapters

Three real wire adapters behind one interface, plus one protocol wrapper; `src/models/registry.mjs` maps
`kind` → module.

| kind | module | wire | framing | tool schema shape | tool result shape | notes |
|---|---|---|---|---|---|---|
| `anthropic` | `src/models/anthropic.mjs` | `POST {base}/v1/messages` | SSE | `{name, description, input_schema}` | user message with `tool_result {tool_use_id, content, is_error}` | Blocks map ~1:1; `system` sent as one text block with `cache_control:{type:'ephemeral'}`; `anthropic-beta: interleaved-thinking-2025-05-14` |
| `openai` (+ aliases `lmstudio`, `llama.cpp`, `vllm`, `openrouter`, `deepseek`, `groq`) | `src/models/openai.mjs` | `POST {base}/chat/completions` | SSE, `stream_options.include_usage` | `{type:'function', function:{name, description, parameters}}`, `tool_choice:'auto'` | one `role:'tool'` message per result keyed by `tool_call_id`, directly after the assistant `tool_calls` | Most local servers implement this API, which is why the alias list is long |
| `ollama` | `src/models/ollama.mjs` | `POST /api/chat` (default) or `/v1/chat/completions` (`dialect:'openai-compat'`) | **NDJSON**, line-delimited | `{type:'function', function:{...parameters}}` | `{role:'tool', content}` | Sends `options:{num_ctx, num_predict}`, `keep_alive`; reports `prompt_eval_count`/`eval_count`; preserves a separate `thinking` stream |
| (wrapper) `prompted` | `src/models/prompted.mjs` | none — wraps any inner provider | inherits | rendered as **text** in the system prompt | plain text fed back as the next user turn | Used when the model cannot emit structured tool calls |

Shared plumbing lives in `src/models/http.mjs`: `readSSE` (CRLF, multi-line `data:`, comment lines,
missing trailing newline), `jsonRequest`/`streamRequest` with timeout + `AbortSignal` bridging,
`truncate`, and `withRetry` — 3 attempts, 700 ms base, 20 s cap, 0.75–1.25 jitter; retries only when
`isRetryable` (408/409/429/5xx, or `ECONNRESET`/`ECONNREFUSED`/`ETIMEDOUT`/`EPIPE`/`UND_ERR_SOCKET`);
never retries `AbortError`. Retry is a provider-layer concern: the loop itself does not retry.
Connection failures are diagnosed before they escape: `jsonRequest` walks the `undici` cause chain and
throws `cannot reach <url>: <code>. <hint>` — e.g. `ECONNREFUSED` → "nothing is listening there — is the
server running and the baseUrl right?", `ENOTFOUND` → "the host name did not resolve", "bad port" →
"that port is blocked for fetch", `ETIMEDOUT` → "the endpoint did not answer in time". (A bare "fetch
failed" was the single worst local-model onboarding experience, hence the extra code.)

Adapter-specific interoperability decisions worth knowing:

- **Ollama NDJSON, not SSE.** The parser reads line-by-line and tolerates a final line without a
  newline. An empty stream is an error that names the model ("is it pulled?"), not a silent empty turn.
- **Empty turns are never returned.** A reasoning model that streams only `thinking` and never reaches
  an answer produces content blocks plus, if truly nothing arrived, the literal text
  `[the model returned no text and no tool call]`; empty assistant turns break some chat templates on
  the next request (`ollama.mjs:203-207`, `openai.mjs:151`).
- **Malformed tool arguments are data, not crashes.** Unparseable JSON becomes
  `{__raw, __parseError:true}` or is recovered by extracting the first `{...}` object
  (`ollama.mjs:295`, `openai.mjs:162`, `anthropic.mjs:150`).
- **`openai` reasoning fields vary.** `reasoning_content`, `reasoning`, or `thinking` are all accepted
  and preserved as a `thinking` block (`ollama.mjs:240`, `openai.mjs:129`).

### 2.4 Dialect mapping (canonical block → wire)

| canonical | anthropic | openai | ollama native |
|---|---|---|---|
| `text` | `{type:'text', text}` | assistant `content` string; multiple blocks joined with `\n` | `content` string, merged into the adjacent same-role message |
| `thinking` | `{type:'thinking', thinking}` | **dropped when sending back** (no channel); parsed from the response | **dropped when sending back** (some backends 400 on it) |
| `image` | `{type:'image', source:{type:'base64', media_type, data}}` | `{type:'image_url', image_url:{url:'data:<mt>;base64,<d>'}}` as a user message | base64 appended to the user message's `images[]` |
| `tool_use` | `{type:'tool_use', id, name, input}` | assistant `tool_calls[{id, type:'function', function:{name, arguments: JSON.stringify(input)}}]` | assistant `tool_calls[{function:{name, arguments: <object>}}]` |
| `tool_result` | `{type:'tool_result', tool_use_id, content, is_error}` | `{role:'tool', tool_call_id, content}` | `{role:'tool', content}` |
| system | top-level `system: [{type:'text',...}]` | `{role:'system', content}` first | `{role:'system', content}` first |
| stop reason | verbatim `stop_reason` (`tool_use` included) | `finish_reason` normalized: `tool_calls`/`function_call`→`tool_use`, `length`→`max_tokens`, `stop`→`end_turn` | `done_reason` normalized: `stop`→`end_turn`, `length`→`max_tokens`; any `tool_calls` ⇒ `tool_use` |

### 2.5 The prompted-JSON fallback (models with no native tool calling)

This is the mechanism that makes "any model" real. Selection: `cfg.nativeTools === false` **or**
`inner.capabilities.nativeTools !== true` (`registry.mjs:41`, `prompted.mjs:52`). It is a *wrapper*, not
an adapter, and it advertises `nativeTools: true` upstream so the loop cannot tell the difference.

What it does:

1. Renders the tool catalogue (name, description, input JSON schema) into the system prompt and appends
   a strict protocol: prose first, then **exactly one** fenced `json` block shaped
   `{"tool": "...", "input": {...}}`, nothing after it, one tool per reply, no invented names.
2. Passes `tools: []` down — the inner model never sees schema objects.
3. Trims history tail-first to `contextWindow - tokens(system) - 2048` (`trimForContext`).
4. Parses the reply: the *last* fenced block that names a real tool wins; a bare `{"tool": ...}` object
   is accepted as a fallback for models that forget fences; key aliases accepted are
   `tool|name|function` and `input|arguments|parameters|args`.
5. Rebuilds content so the streamed prose stays as a `text` block and the JSON block is replaced by a
   real `tool_use` block with a fresh id, `stopReason: 'tool_use'`.

If no valid call is found, the reply is ordinary text and the loop ends the turn normally.

### 2.6 Config file shape and auto-detection

`xmonkey --init` writes `EXAMPLE_CONFIG`. The shape (`src/config.mjs:26`):

```json
{
  "models": {
    "local":    { "kind": "ollama",   "baseUrl": "http://127.0.0.1:11434",    "model": "qwen2.5-coder:7b" },
    "lmstudio": { "kind": "lmstudio", "baseUrl": "http://127.0.0.1:1234/v1",  "model": "local-model" },
    "sonnet":   { "kind": "anthropic", "model": "claude-sonnet-4-5" },
    "gpt":      { "kind": "openai",    "model": "gpt-4o-mini" }
  },
  "default": "local",
  "permissions": {
    "mode": "default",
    "rules": [
      { "tool": "bash", "pattern": "^git (status|diff|log)", "action": "allow" },
      { "tool": "bash", "pattern": "^rm -rf /", "action": "deny" }
    ]
  },
  "loop": { "maxTurns": 60 },
  "mcpServers": {},
  "hooks": {}
}
```

Per-model keys: `kind` (required), `model` (required), `baseUrl`, `apiKey`, `contextWindow`,
`nativeTools` (force the prompted path with `false`), `temperature`, `maxTokens`, `dialect`
(`ollama` only: `ollama-native` | `openai-compat`), `keepAlive`.

Resolution order (first wins per key): **CLI flags → `./xmonkey.config.json` → `~/.config/xmonkey/config.json`
→ environment variables (`ANTHROPIC_API_KEY`, `ANTHROPIC_BASE_URL`, `OPENAI_API_KEY`, `OPENAI_BASE_URL`,
`OLLAMA_HOST`) → auto-detection**. Sections are shallow-merged per key, so a project file can override
one model or one loop setting without dropping the rest; hooks lists are concatenated.

Auto-detection (`detectLocalModel`): probe Ollama first — `OLLAMA_HOST` if set, else
`http://127.0.0.1:11434` — and use its chat models; embedding models are filtered out by name
(`/embed|bge|nomic-embed|minilm|e5-|rerank/i`), then a model is ranked by parameter count (larger is
better at tool calling) with a preference for names matching `coder|devstral|deepseek-coder|codeqwen`,
then `qwen|deepseek|llama|gemma|mistral|phi`. If Ollama is absent, probe OpenAI-compatible
`/v1/models` on ports **1234, 8080, 8000, 5000**. The selection is registered as model alias
`auto-local` and the reason is stored in `cfg.detected` so the banner and `doctor` can say what
happened. `describeConfig` explains files, model mapping and mode.

A malformed config is a first-class error, not a stack trace: invalid JSON in a config file throws
`<path> is not valid JSON: <parser message>` plus "fix the syntax, or delete the file and run
`xmonkey --init`" — the local-model-first promise dies if a stray comma silently disables the agent.

---

## 3. Agent loop & prompt assembly

**Research basis:** `research/claude-code/01-agent-loop.md` §2-6 (turn cycle, stop conditions, retries,
max-token recovery) and `research/claude-code/03-prompt-context.md` §1-6 (prompt sections, memory,
compaction thresholds).

### 3.1 The turn cycle (`runAgent`, `src/core/loop.mjs`)

One **turn** = one model call. The loop repeats until the model stops asking for tools, a budget runs
out, or the caller aborts. The precise cycle:

1. **Pre-flight checks** (before any spend): `signal.aborted`? → `aborted`. `turns >= maxTurns`? →
   `max_turns` (default `maxTurns` = 60, overridable via config/flag).
2. **Context budget check** (before the call, §3.4): project the cost of `messages + system + 2048`; if
   it exceeds the model's `contextWindow`, compact; if the compacted history still does not fit, stop
   with `context_budget`.
3. `turns++`; emit `turn_start {turn}`.
4. **Model call**: `provider.complete({system, messages, tools: tools.specs(), maxTokens, signal,
   onText, onThinking})`; streaming text is re-emitted as `text` events, reasoning as `thinking`.
5. Accumulate `usage` and emit a `usage` event with per-call and running totals.
6. **Append the assistant turn verbatim** — including thinking blocks, so the history sent next turn is
   what the model actually produced (`loop.mjs:118-120`).
7. If `stopReason !== 'tool_use'` or no `tool_use` block exists → finish (`end_turn`, or `max_tokens`
   with an explanatory notice).
8. **Execute tool calls sequentially**, in the order emitted, emitting `tool_use` then `tool_result` per
   call (§3.6).
9. **Append exactly one user turn containing one `tool_result` block per `tool_use`** and loop to 1.
   If the process was interrupted mid-batch, synthetic `isError` results ("Interrupted before this tool
   ran.") are added for the missing ids so the history stays balanced.

Events (`LoopEvent`): `turn_start | text | thinking | tool_use | tool_result | usage | notice | done |
error`. Return value: `{stopReason, turns, usage, finalText}` where `finalText` is the last assistant
text seen.

### 3.2 The four invariants

The header of `loop.mjs` states four invariants. They are the design constraints that keep the loop
safe to hand to a small model; three are enforced exactly as written, one is stated imprecisely.

| # | invariant | as-built status |
|---|---|---|
| 1 | **A tool result always appends exactly one `tool_result` per `tool_use`.** | **Enforced.** Every path in `executeOne` returns a block (unknown tool, validation failure, hook deny, gate deny, declined ask, tool throw, normal result). The interrupted-batch repair (`loop.mjs:146-156`) covers aborts. |
| 2 | **A refusal is a `tool_result` with `isError`, never a thrown exception.** | **Enforced.** Gate denials, declined prompts, hook denials and tool exceptions all become error results with guidance; the loop only throws on provider/transport failure. |
| 3 | *"The conversation is never mutated in place by the caller: we own it, and we hand out snapshots for persistence."* | **Stated wrongly.** `runAgent` mutates the caller's array (`messages.push(...)` at lines 120 and 158) and returns no snapshot; `src/cli/run.mjs` also pushes into the same `history` array and persists with separate record appends. The *real* invariant is: **history is append-only — assistant turns and tool results are appended verbatim, never rewritten or reordered.** Documented as such; see §12. |
| 4 | **Budgets are checked before the call**, so an expensive call is never made with no room to act on its answer. | **Enforced** (turn cap and context projection both precede the call), but the *headroom constant* is weak: see §3.4 and §5.6/§10. |

### 3.3 Stop reasons

| reason | emitted when | surfaced to the user |
|---|---|---|
| `end_turn` | model answered without requesting tools (also absorbs `stop_sequence`) | exit code 0 in `--print` |
| `max_turns` | `turns >= maxTurns` at the top of the loop | notice "stopped after N turns…", exit code 1 |
| `max_tokens` | provider reported the output limit | notice "the model hit its output token limit", exit 1 |
| `aborted` | `signal` aborted before a turn, or during a model call | `(stopped: aborted)` in interactive; exit 1 |
| `context_budget` | compaction could not free enough room | error notice, exit 1 |
| `blocked` | — | **Declared in `STOP` but never returned** (dead constant, §12) |

### 3.4 Compaction algorithm and its honesty property

```
projected = estimateMessages(messages) + estimateTokens(system) + 2048
if projected > contextWindow:
    compacted = compactMessages(messages, floor(contextWindow * 0.6))
    if estimate(compacted) + estimate(system) + 2048 > contextWindow:
        stop('context_budget')                    # honest failure, no infinite loop
    replace messages in place with compacted
    emit notice('compacted history to fit the model's N-token window')
```

`compactMessages` keeps:

- **the head:** the first two messages (the opening user task and the first assistant reply);
- **the tail:** as many recent messages as fit in the target budget, walked backwards;
- **a marker in between:** a *user* message saying exactly how many messages were dropped and that they
  are no longer available, ending with "If you need a detail from earlier, re-read the file or ask."

**The honesty property** (documented in the code, and the reason we did not copy Claude's summary
compaction): this algorithm is deliberately lossy but **never invents a summary**. A fabricated summary
is worse than an honest gap because the model cannot distinguish the fiction from fact and will act on
it. Claude Code spends a model call to summarise at `window − 20000 − 13000` tokens
(`research/claude-code/03-prompt-context.md` §6). xMonkey instead leaves a marker that tells the model
the truth and tells it what to do about it (re-read). Cost: detail is lost. Benefit: on an 8B local
model, no second model call and no confabulated context.

Known limitation of the current algorithm (no test covers it, §9.2): it is not tool-pairing aware. The
head can end with an assistant `tool_use` whose `tool_result` was dropped, and the tail can begin with a
tool result whose `tool_use` was dropped; inserting the user marker between a `tool_use` and its result
can produce a history some providers (Anthropic in particular) reject. Fix is roadmap item 7.

### 3.5 Headroom, budgets, and the cost of being late

The check is "before the call", which is correct, but the reserve is a flat `2048` tokens of formatting
overhead and the trigger is the **full** window. The model is therefore allowed to be called at ~99% of
its window with `maxTokens` (default 8192) of output requested. Research 03 §6 shows the safe rule we
have not implemented yet: trigger at `window − min(maxOutputTokens, 20000) − 13000`, and re-anchor the
estimate on real `usage` from the last response instead of a chars/3.6 estimate. Root cause of a
provider-side "input + max_tokens exceeds context" 400 under narrow windows. Roadmap item 7.

### 3.6 Tool execution inside a turn (`executeOne`, in this exact order)

1. **Resolve** the tool; unknown name → error result listing the real tool names.
2. **Validate** input against the tool's JSON schema (`tools.validate`) → error result on failure.
3. **`PreToolUse` hooks** run first, *before* the permission gate, so a project guard can refuse even in
   bypass mode. `deny` short-circuits; `updatedInput` merges into the effective input.
4. **Permission gate** `decide(...)` → `allow` / `ask` / `deny`. `deny` returns the standard refusal
   message. `ask` calls `onAsk`; no `onAsk` (headless) is itself a refusal that tells the user to use
   `--yes` or add an allow rule; a declined ask is a refusal.
5. **Run** the tool. A thrown error becomes an error result ("`<tool>` failed: …"), never a session crash.
6. **`PostToolUse` hooks** may rewrite the output (`updatedOutput`); a failure there does not fail the call.
7. **Clip** the result to 60 000 chars (`clipOutput`) and return one `tool_result` block.

Note the ordering consequence: hooks are outside the gate, so hooks can only *tighten* (deny / rewrite);
a hook cannot grant permission the gate would refuse, and a hook `ask` decision is currently ignored
(§5.6).

### 3.7 Retries, failures and abort

- Retries happen **inside provider.complete** (`withRetry` in `http.mjs`), never in the loop. A provider
  that exhausts its retries throws; the loop emits an `error` event and rethrows (unless the abort
  signal fired, in which case it returns `aborted`).
- There is **no recovery turn** for `max_tokens` (Claude Code has one, research 01 §5), and no
  malformed-tool-use retry. Both are cheap to add and listed in §10.
- Abort is cooperative: checked before every turn and before every tool call; the provider request is
  wired to the same `AbortSignal`. An interrupted batch is repaired with synthetic error results.

### 3.8 System prompt assembly (`src/core/prompt.mjs`)

Deliberately short, because local models lose accuracy as the system prompt grows. Built in this order:

1. `BASE` — role ("You are xMonkey, a coding agent running in the user's terminal"), how to work
   (don't narrate, smallest change, never invent, change approach on failure, use the todo tool for
   more than two steps, finish with what actually happened), boundaries (workspace only, no destructive
   commands unasked, no secrets, no system packages), style (user's language, terse).
2. `## Environment` — cwd, model (and provider when known), platform/arch, today's date, permission
   mode, tool names.
3. `## Project memory` — concatenated memory files, labelled as user-maintained and authoritative.
4. `## Current mode` — only when not `default`: plan / acceptEdits / bypass semantics.
5. `## Working with a local model` — only when the endpoint is local; asks for concrete, economical,
   one-small-tool-call behaviour.
6. `ctx.extra` — the skill catalogue (§7.3) and subagent instructions are supplied here, never inlined
   tool schemas.

Memory files (`loadMemory`), all read and concatenated in this order if present: `XMONKEY.md`,
`AGENTS.md`, `.xmonkey/AGENTS.md`, `CLAUDE.md`. The code comment says "first found wins"; the
implementation actually loads **all** of them (`found.push` per hit), and `run.mjs` joins them — §12.

---

## 4. Tools

**Research basis:** `research/claude-code/02-tools-permissions.md` §1-2 (tool object, 70 built-ins) and
`research/claude-code/03-prompt-context.md` §9 (per-tool result caps, persistence).

### 4.1 The tool interface (`src/tools/registry.mjs`)

A tool is a plain object; deliberately narrower than Claude's tool object (70 built-ins, ~30 members):

```js
{
  name: string,
  description: string,
  inputSchema: JSONSchema,          // validated by our own minimal validator, no dependency
  isReadOnly: boolean,              // plan mode + gate classification
  isConcurrencySafe: boolean,       // advisory today: the loop is sequential
  validate?(input, ctx) => {ok:true} | {ok:false, error},   // called before permissions
  run(input, ctx) => {content: string} | {content, isError:true}
}
```

`ToolRegistry` owns registration (duplicate names rejected), the provider-facing catalogue
(`specs()`, **sorted by name** so prompt caching stays stable), `names()`, `validate()` (catches thrown
validation as `{ok:false}`), and `run()` (normalises non-object input to `{}`). Permissions are *not*
the tool's job: tools trust they were only called after the gate said yes.

Minimal JSON-Schema subset supported: `type` object/array/string/number/boolean, `required`,
`properties`, `additionalProperties:false`, `items`, `enum`.

### 4.2 The v1 tool set

Eight built-ins, all registered by `buildDefaultRegistry` (`src/tools/index.mjs`), plus three
conditionally registered tools.

| tool | module | read-only | concurrency-safe | what it does | notable guard |
|---|---|---|---|---|---|
| `read` | `files.mjs` | yes | yes | line-numbered, paginated file read | refuses directories, binary files, and files > 2 MiB; `offset`/`limit` (max 20 000 lines) |
| `write` | `files.mjs` | no | no | create/overwrite a file, creating parents | workspace confinement; reports bytes and line count; says "Overwrote" vs "Created" |
| `edit` | `files.mjs` | no | no | replace one exact string | refuses ambiguous matches (must be unique unless `replaceAll`), refuses identical old/new, tells the model to copy exact text when not found |
| `list` | `files.mjs` | yes | yes | directory listing, optional shallow tree | skips `node_modules/.git/dist/build/.next/.cache/.venv/__pycache__`; depth ≤ 6; 3000-entry cap |
| `glob` | `search.mjs` | yes | yes | find files by pattern, newest first | own walker (no ripgrep dependency); `*`, `**`, `?`, `{a,b}`; symlinks never followed; 100 default / 1000 max results |
| `grep` | `search.mjs` | yes | yes | regex content search, `file:line: text` | skips binary and >2 MiB files; `include` glob; 200 default / 2000 max lines; invalid regex is a clean error |
| `bash` | `shell.mjs` | no | no | one command via `$SHELL -lc`, combined output | timeout 120 s default/600 s max (SIGTERM then SIGKILL), 1 MiB retained per stream, cwd confined to workspace, `[exit code: N]` marker, non-zero exit ⇒ `isError` |
| `todo` | `todo.mjs` | no | no | replace the session checklist, render status | session-scoped store; warns when more than one item is `in_progress` |
| `skill` | `ext/skills.mjs` | yes | yes | load a SKILL.md body by id, plus its directory and supporting file list | only registered when skills are installed |
| `task` | `ext/subagent.mjs` | no | yes | delegate to a fresh subagent | validation: prompt must be ≥ 20 chars and depth < 2 |
| `mcp__<server>__<tool>` | `ext/mcp.mjs` | no | no | any tools/list tool from a connected MCP server | always treated as mutating (MCP tools can do anything) |

Interfaces are intentionally different from Claude's where ours is simpler: no `outputSchema`, no
`aliases`, no `searchHint`/deferred tool loading, no render hooks, no `checkPermissions`, no
`requiresUserInteraction`, no `preparePermissionMatcher`.

### 4.3 Path policy

`resolveInWorkspace(p, ctx)` is the single choke point: resolve against `ctx.workspace || process.cwd()`,
compute the relative path, and **refuse** when it escapes (`rel.startsWith('..')` or absolute) unless
`ctx.allowOutsideWorkspace` (set by `--allow-outside`). The refusal message names the workspace and the
flag. The tree walker (`search.mjs`) never follows symlinks; `DEFAULT_IGNORES` covers
`node_modules .git dist build .next .cache .venv venv __pycache__ .idea .DS_Store .turbo target vendor`.
`bash` confines `cwd` through the same resolver but a command can still `cd ..` or use absolute paths —
the shell is a shell; the permission gate, not the path policy, is the containment story there.

### 4.4 Output clipping (three layers)

| layer | limit | where |
|---|---|---|
| per tool, configurable | `ctx.maxToolChars` = **30 000** default (set in `src/cli/run.mjs`) | `clipOutput` inside read/list/glob/grep/bash |
| hard cap at dispatch | **60 000** chars | `loop.mjs:250` (`clipOutput(content, 60_000)`) — catches tools that do not clip themselves (todo, skill, mcp, subagent) |
| per-source caps | read 2 MiB; bash 1 MiB/stream; grep 2 MiB/file, 60 000 files walked; list 3000 entries | tool implementations |

`clipOutput` keeps the **head (70%) and tail (30%)** and inserts
`… [N chars truncated by xMonkey] …`, because for a failing command the useful part (the error) is at
the end. Claude instead persists the full output to a file and returns a 2000-char preview
(research 03 §9); xMonkey's version is simpler and lossier — a roadmap candidate.

### 4.5 Consequences worth knowing

- Because `todo` and `task` declare `isReadOnly: false`, **plan mode refuses both**: a plan-mode agent
  cannot update the checklist or delegate. Defensible for `task`, awkward for `todo`.
- MCP tools are always mutating, so in `default` mode every MCP call prompts (or is refused headless).
- Sequential execution means `isConcurrencySafe` currently has no runtime effect (it is recorded for the
  future parallel executor).

---

## 5. Permissions

**Research basis:** `research/claude-code/02-tools-permissions.md` §3-6 (modes, decision pipeline,
denial texts, Bash classification).

### 5.1 Modes implemented today (`src/permissions/gate.mjs`)

`MODES = ['plan','default','acceptEdits','dontAsk','bypass','auto']`. Exposed as `--mode`, in config
`permissions.mode`, and shown by `--help`, `/mode`, and the banner. `-y/--yes` forces `bypass`.

| mode | behaviour as built | matches research 02? |
|---|---|---|
| `plan` | hard read-only wall: anything not read-only is denied, with "present the plan first" guidance | yes (Claude calls it `plan`) |
| `default` | read-only tools allowed; provably read-only shell allowed; writes/shell ask; allow rules honored | yes (`default`) |
| `acceptEdits` | `write`/`edit` allowed without asking (any path in the workspace); shell still asks unless classified read-only | yes, except Claude also requires the path to be inside the working dirs — ours is confined by the path policy instead |
| `dontAsk` | never prompts: a would-be ask becomes a **deny** whose reason says so | yes (`dontAsk`) |
| `bypass` | denies only rules; everything else allowed — no prompts. `--yes`, or explicit config. No consent gate, no root check | name differs (`bypassPermissions`); safety extras absent |
| `auto` | **accepted, but has no distinct branch** — identical to `default` today (the read-only shell classifier already applies in `default`). Declared, documented, and tested at the level "safe work allows, write asks" | **no** — Claude's `auto` is a model classifier with an ask-floor |

Precedence: `--yes` → `bypass`; else `--mode`; else config `permissions.mode`; else `default`. Unknown
modes are rejected with code 2 and the valid list. `--dangerously-skip-permissions` does not exist.

### 5.2 Rule shape

Rules are structured JSON, not a string grammar:

```js
{ tool: "bash", action: "deny" }                                    // whole tool
{ tool: "bash", pattern: "^git status", action: "allow" }           // command/content pattern (bash→input.command, grep→input.pattern)
{ tool: "read", path: "src/**", action: "allow" }                   // path glob (** across dirs, * within a segment)
{ tool: "bash", field: "command", pattern: "^rm\\s", action: "deny" } // input-parameter rule, any named field
```

`tool` may be `*`. `field` takes precedence over the legacy shorthand; the field's value is tested as a
**regular expression** (`new RegExp(rule.pattern).test(String(value))`). A rule with no `tool` never
matches. **A deny always beats an allow, the mode, and bypass mode.** Rules come from config files
(project over user, hooks concatenated) and from the interactive "always this tool" answer, which is
session-only and never persisted.

There is no rule *source* layering (Claude has 10 sources: user/project/local/flag/policy/cliArg/…), no
`ask` list separate from allow/deny ordering beyond what the mode does, and no rule specificity
resolution for path rules.

### 5.3 Decision order (the whole of `decide()`)

Verified against the current file (six modes, `gate.mjs:82-135`). Steps 2 and 4 each scan **all** deny
rules / all allow rules; the rule *shape* (whole-tool, input-parameter `field`, command/content
`pattern`, path glob) selects the matcher inside `matchesRule`, so "deny-tool" and "deny-input" are one
stage, and the same for allows.

1. Unknown mode → throw.
2. **Deny rules** (whole-tool, then input-parameter, then path — same loop) — first deny match wins,
   regardless of everything else (including bypass).
3. **Plan-mode wall** — if the tool is not read-only → deny.
4. **Allow rules** — first allow match wins.
5. **Mode defaults** — `bypass` → allow; read-only tool → allow; (`plan` here → deny, unreachable in
   practice because of step 3).
6. **Read-only shell classifier** — `bash` whose command is provably read-only → allow without a prompt.
7. **`acceptEdits`** + `write`/`edit` → allow.
8. Otherwise an `ask` is constructed; **`dontAsk` converts it to deny**; otherwise it is returned as
   `ask` and the loop resolves it via `onAsk`.

Two ordering properties are deliberate and worth stating because they are easy to "fix" wrongly:

- **The plan wall sits *above* allow rules** (step 3 before step 4). In plan mode an explicit
  `{action:"allow"}` rule for a mutating tool still loses: **plan mode is a hard read-only wall, not a
  default that rules may override.** Tested at gate level
  (`gate: every declared mode is handled`) and end-to-end
  (`loop: a denied tool call is refused and the model is told not to retry`, which asserts the file is
  never created).
- **`dontAsk` is not a pre-emptive mode check**; it only converts the **final** ask (step 8). Read-only
  tools, allow-ruled calls, provably read-only shell commands and `acceptEdits` file edits all still
  proceed under `dontAsk` — only what *would have prompted* becomes a deny. Tested by
  `gate: dontAsk never prompts — it denies and says why`, which asserts both halves: the write is denied
  **and** a read still proceeds.

The read-only classifier (`isReadOnlyCommand`) is deliberately conservative: it rejects any command
containing redirection, substitution, subshells or backgrounding; splits chains on `|| && | ;` and
requires **every** segment to match a read-only prefix allowlist (`git status|diff|log|show|branch -a|…`,
`ls cat head tail wc file stat pwd whoami date which …`, `rg grep egrep fgrep fd find tree`,
`node/python --version`, `npm/pnpm/yarn ls|outdated|version`, `sed -n`, `awk -n`, `test`); and rejects
mutating flags (`-i`, `-d/-D`, `--delete/--exec/--output/--in-place`). The rule is: a **wrong**
"read-only" verdict is an unprompted mutation, so ambiguous means not read-only.

### 5.4 How a denial and an ask reach the model

`decide()` is pure: it returns `{behavior, reason?, rule?}` and never throws, file-touches, or prompts.
It is the **loop** — `executeOne` in `src/core/loop.mjs` — that converts a `deny` into a
`tool_result` with `isError:true`, and that conversion is what makes a refusal **data rather than a
crash** (invariant 2). A refusal never propagates as an exception out of `executeOne`.

- Denial → `tool_result` with `isError:true` and `denialMessage(...)`: what was refused, the rule or
  mode reason, and an instruction — plan mode: "describe what you would do and ask the user to approve
  the plan"; otherwise "Do not retry the same call. Choose a different approach or ask the user to allow
  it." This is invariant 2: the model must see "no" and adapt.
- Ask, interactive: in-band prompt `[y]es [n]o [a]lways this tool` (default n). `a` appends
  `{tool, action:'allow'}` to the session rules, which does not survive the session.
- Ask, headless (`--print` with no `--yes`): refusal that says the session cannot ask, points at
  `--yes` and allow rules.
- `dontAsk`: deny with an explicit "(dontAsk mode denies what it cannot ask)".

### 5.5 Where approval input comes from

Interactive mode is a **queue, not a `readline.question()`**: lines typed while the model streams are
buffered and consumed either as the next user message or as the next approval answer. This is why an
approval can appear mid-stream without losing keystrokes. `Ctrl+C` interrupts the current turn when
busy, and exits at the prompt. `--print` has no approval surface by design.

### 5.6 GAP ANALYSIS vs research 02 (tools & permissions)

**The live gap list is: (1) tool-level `checkPermissions` hook, (2) the `auto`-mode classifier,
(3) per-tool result-freshness/staleness guards.** Input-parameter rules and `dontAsk` are *done* and are
documented as such (rows A and B below explain what is implemented and what tail-end details are still
missing); they are retained in the table because the original brief called them gaps and this document
must be explicit about the correction. Every row states: as-built status → what is actually missing →
exactly where the missing piece slots in **without changing the current decision order for everything
else**.

| # | gap | as-built status | what is actually missing | slot-in point (preserving current order) |
|---|---|---|---|---|
| 1 | **Tool-level `checkPermissions` hook** | **Not implemented.** The tool contract has no `checkPermissions`; the gate judges by name, `isReadOnly`, and rules only. Tools cannot express "this specific input needs a prompt" (e.g. a `bash` sandbox override, a file tool refusing its own path class, an MCP tool that requires interaction). | The research pipeline calls `tool.checkPermissions(input, ctx)` after whole-tool and field deny rules, before field ask rules, and lets it return `allow\|ask\|deny\|passthrough` with `updatedInput`/`message`/`suggestions` (research 02 §4). We have none of that. | Extend the tool object with optional `checkPermissions(input, ctx) => {behavior:'allow'\|'deny'\|'ask'\|'passthrough', reason?, updatedInput?}`. Call it in `executeOne` **after** hooks and **before** `decide`, and pass the result into `decide` as `guard`: a `deny` short-circuits before stage 2 but must not override a rule deny (deny either way); an `ask` is merged as an additional reason; `passthrough`/absent is today's behaviour. Alternatively keep `decide` pure by adding a stage **1.5** inside it (after deny rules, before the plan wall) — the rule deny stays first, which is the one ordering constraint that matters. |
| 2 | **`auto`-mode ML classifier** | **`auto` is accepted but is a name, not a policy**: `decide()` has no `auto` branch, so it runs the `default` path. The header comment and `MODE_HELP` describe it as "read-only + safe commands allowed, everything else asks", which is exactly what `default` already does. (`dontAsk` **is** implemented and tested — see row B.) | `auto` has no classifier, no acceptEdits fast-path, and no ask-floor semantics. Research 02 §3/§4: `auto` = model classifier decides, safe/acceptEdits-equivalent calls auto-allow, safety checks and ask-rules still prompt, and a hook `ask` is a floor the classifier cannot bypass. | Add a single branch **after stage 6 (read-only classifier) and before stage 8's `dontAsk` conversion**: `if (mode === 'auto')` then (i) allow `acceptEdits`-equivalent file edits inside the workspace, (ii) call an optional `permissions.classify({tool, input, rules})` callback supplied by the CLI (returns `allow\|ask\|deny`; absent ⇒ behave as today), (iii) let a hook `ask` floor force `ask` even if the classifier says allow. Deny rules and the plan wall stay ahead of it; `dontAsk` stays after it. This keeps `auto` strictly more permissive than `default` for edits and never weaker than a deny. |
| 3 | **Per-tool result-freshness / staleness guards** | **Not implemented.** Nothing in `src/` tracks what the agent has read: no `readFileState`, no mtime/size/hash record, no read-before-edit requirement. `read` returns bytes and forgets them; `write` reads the old content only to say "Created" vs "Overwrote"; `edit` checks only that `oldString` exists uniquely — so it will happily splice into a file that changed on disk since the model last saw it, and a model that never read the file can still edit it. | Research 02 §2 lists `readFileState` as part of the execution context and §4/§7 use it (and file tools funnel through one gate); research 04 §2 shows every subagent context carries its own `readFileState`. Claude's file tools refuse or re-prompt when the on-disk content no longer matches what was read. None of that exists here. | Put a session-scoped `FileStateStore` in the tool `ctx` (created in `run.mjs` next to the `todoStore`). `read` records `{absPath, mtimeMs, size, contentHash}`; `write`/`edit` compare the current stat/hash before mutating and, on mismatch, return an `isError` result telling the model to re-read ("the file changed since you read it…"), with an explicit `force`/`allowStale` input to override. This lives **inside the tools**, not the gate, so the permission order is untouched; the gate may later consume it as a fourth `ask` reason. Subagents get their own store (`subagentTool` already builds a fresh tool registry per child). |
| A | **Input-parameter rules** — *documented as done, with tail gaps* | **Implemented** as `{tool, field, pattern, action}` (`gate.mjs:169-178`), deny-first, with tests for a `bash` command and a `read` path. | (a) the Claude **string grammar** `Tool(field: pattern)` does not exist — no parser; (b) `pattern` is a raw **regex**, so a Claude-style `"rm *"` is a regex that matches `rm` anywhere, not the glob the user meant; (c) the shorthand `{tool, pattern}` only looks at `bash.command` / `grep.pattern` — a `write` content rule silently never matches; (d) no argv/prefix matcher for `bash` (research 02 §6: exact + prefix matching, `xargs` awareness); (e) no rule **source layering** (user/project/local/flag/policy) and no specificity resolution. | Keep stages 2 (deny rules) and 4 (allow rules) where they are. Add (i) a compiler `parseRule(string) → Rule` run once at config load, so string and object rules normalise to one shape; (ii) a matcher selected by `rule.glob === true` (glob→regex) instead of always regex; (iii) optionally a tool-provided `ruleFields` map so `write`/`edit` can expose `content`; (iv) optionally a `Tool.preparePermissionMatcher(input) → (ruleContent)=>bool` consulted at stage 4/2 for `bash`. Newly-created **ask rules** insert between stages 4 and 6 (outrank a mode allow, never outrank a deny). |
| B | **`dontAsk` mode** — *documented as done* | **Implemented and tested** — it never prompts and turns asks into denies with a reason (`gate.mjs:130-133`; test "gate: dontAsk never prompts — it denies and says why", plus a loop-level test proving the asker is never called). | Only cosmetic parity: Claude's fixed denial wording and `interrupt` semantics (research 02 §5). No behavioural gap. | No ordering change needed; optionally move the fixed strings into `denialMessage`. |
| D | *(not named in the brief, found while reading)* **Hook `ask` is discarded** | `runHooks` can return `decision:'ask'`, and research 02 §4 makes a hook ask a floor the auto classifier cannot bypass; `loop.mjs` only consumes `deny` and `updatedInput` (`loop.mjs:189-194`). A hook that wants to force a prompt cannot. | full hook decision semantics: `ask`, `defer`, `additionalContext`, `preventContinuation` | In `executeOne`, map `pre.decision === 'ask'` to a synthetic `behavior:'ask'` decision (with the hook's reason) that is checked **after** gate deny but **before** mode auto-allow. |
| E | *(not named in the brief)* **`requiresUserInteraction` / MCP permission floors** | absent | a per-tool "always ask" flag and MCP `effectiveMaxPermission` | Add optional `requiresUserInteraction` (boolean or predicate) to the tool contract; at stage 7.5 force `ask`; MCP tools set it from annotations when we start reading annotations. |

So: the three live gaps are **(1) `checkPermissions`, (2) `auto` classifier, (3) freshness/staleness
guards**. Input-parameter rules are built (with grammar/layering tail gaps), `dontAsk` is built, and
**none** of the missing pieces requires reordering the existing deny → plan → allow → mode chain; each
is an insertion at a named boundary.

---

## 6. Sessions

**Research basis:** `research/claude-code/04-sessions-extensibility.md` §1 (JSONL transcripts, resume,
fork, compaction records).

### 6.1 Storage layout (`src/sessions/store.mjs`)

```
$XMONKEY_HOME/sessions/<session-id>/transcript.jsonl     # append-only, one JSON object per line
$XMONKEY_HOME/sessions/<session-id>/meta.json            # mutable metadata, rewritten atomically-ish
```

`XMONKEY_HOME` overrides `~/.xmonkey`. Session id = `YYYYMMDD-HHMMSS-<4 random base36>`.
`meta.json` holds `{id, updatedAt, model, modelName, providerKind, permissionMode, cwd,
lastStopReason, turns, usage}`.

### 6.2 Record kinds

Documented in the module header: `header | user | message | tool | usage | note`. **Only two are ever
written today**: `{kind:'user', content}` for every user prompt (including expanded slash-commands) and
`{kind:'message', role:'assistant', content:[blocks]}` once per CLI turn, where `content` is the *final*
assistant message of that turn. Every record is stamped with `at: <ISO timestamp>`. `header`, `tool`,
`usage` and `note` are reserved and unused (§10 item 6).

### 6.3 Resume

`xmonkey --resume [id|prefix]`:
1. `resolveSessionId` accepts an exact id, `latest`, or a unique prefix; an ambiguous prefix is an
   **error listing the matches**, never a guess; no match is an error.
2. `loadMessages` replays the transcript: `kind:'user'` → `{role:'user', content:[{type:'text'}]}`,
   `kind:'message'` → `{role, content}`.
3. The CLI continues with that `history`, the same session id, and rewrites `meta.json`.
4. Banner/counters come from the replay: "resumed session <id> (N messages)".

**Fidelity limit (important):** because only the final assistant message per turn is persisted, a
resumed session does **not** replay prior `tool_use`/`tool_result` blocks. The model sees the earlier
user prompts and the final answers, not how they were reached. This is proven by the resume test (it
asserts the earlier *user* turn is replayed and never asserts tool history). Roadmap item 6.

### 6.4 Crash safety

Append-only JSONL, and `loadMessages` skips any line that fails `JSON.parse` — a crash mid-append loses
at most the **torn last line**, never the transcript. This is a tested property:
`sessions: a torn final line does not destroy the transcript` appends `{"kind":"user","content":"torn`
to a real transcript and asserts both complete records survive.

`meta.json` is written with `fs.writeFile` (not atomic rename), so a crash during a meta write can
corrupt metadata; `readMeta` tolerates that by returning `null`. Listing is by directory mtime, newest
first.

---

## 7. Extensibility

**Research basis:** `research/claude-code/04-sessions-extensibility.md` §2-6 and
`research/claude-desktop/01-architecture.md` §6 (MCP runtime).

### 7.1 MCP client (`src/ext/mcp.mjs`)

- **Scope implemented:** `initialize` → `notifications/initialized` → `tools/list` → `tools/call`, over
  **stdio** (newline-delimited JSON-RPC on a spawned child) and **HTTP** (single POST; accepts a direct
  JSON body or the last SSE `data:` frame). Protocol version `2024-11-05`; client info `xmonkey`.
- **Timeouts:** 20 s for connect/list, 120 s for a tool call, per-request timers with the server's
  stderr tail appended to timeout errors.
- **Resilience:** non-JSON lines on stdout are ignored (servers log); unknown fields are tolerated;
  a server that exits fails only its own pending requests; `connectMcpServers` connects all servers in
  parallel and **isolates failures** — `{clients, errors}`, one broken server never takes down a session.
- **Registration:** each tool becomes `mcp__<server>__<tool>`, registered into the same registry as
  built-ins; a name clash with a built-in keeps the built-in. Always `isReadOnly:false` /
  `isConcurrencySafe:false`, so the gate treats every MCP call as mutating.
- **Verified against a real child process**, not a mock: the test spawns
  `test/fixtures/fake-mcp-server.mjs` with `process.execPath`, does the handshake, lists `echo`/`fail`,
  calls both (success and `isError`), and asserts an unknown tool rejects.
- **Not implemented:** resources/prompts, `list_changed` refresh, server→client requests (sampling,
  elicitation, roots), OAuth, `sse`/`ws` transports, pagination, per-server policy, `ToolSearch`-style
  deferred loading.

### 7.2 Hooks (`src/ext/hooks.mjs`)

- **Declared events:** `PreToolUse, PostToolUse, SessionStart, SessionEnd, Stop, UserPromptSubmit,
  PreCompact` (7).
- **Actually dispatched:** `PreToolUse` and `PostToolUse` (in `loop.mjs`), `SessionStart` and `SessionEnd`
  (in `run.mjs`). `Stop`, `UserPromptSubmit` and `PreCompact` are declared but **never fired** — a gap,
  and a misleading contract, so §10 item 2 closes it or removes it.
- **Config:** `hooks: { "<Event>": [ {matcher?, command, timeout?, env?, cwd?} ] }`; `matcher` is a
  regex anchored over the tool name (`*` = all), omitted = all.
- **Input:** JSON on stdin (`{event, ...payload}`) plus `XMONKEY_HOOK_EVENT`, `XMONKEY_TOOL_NAME` env.
  `PreToolUse` payload: `{toolName, toolUseId, input}`; `PostToolUse` adds `{output, isError}`;
  session events carry `{sessionId, cwd}`.
- **Output/decision contract:** stdout JSON
  `{decision:'allow'|'deny'|'ask', reason?, updatedInput?, updatedOutput?}`; exit 0 with no JSON = "no
  opinion"; **non-zero exit with no JSON = deny**, reason from stderr; hook timeout 30 s (SIGKILL) does
  not block the session. A deny short-circuits (later hooks cannot undo it); `updatedInput` merges.
- **Consumed by the loop:** `deny` (blocks) and `updatedInput` (rewrites what actually runs), plus
  `updatedOutput` on `PostToolUse` (last writer wins). `ask` is **not** consumed (gaps D and 1 above).

### 7.3 Skills (`src/ext/skills.mjs`)

- **Layout:** `<name>/SKILL.md` under `~/.xmonkey/skills/` and `<cwd>/.xmonkey/skills/`; project wins
  on an id clash; anything without a readable `SKILL.md` is not a skill.
- **Format:** optional `---` frontmatter with `name` and `description` (tolerant: a plain markdown file
  still loads, id = directory name, description = first heading/line), then the body.
- **Supporting files:** every file next to `SKILL.md` (except `SKILL.md` itself) is recorded on the
  skill (`files[]`, sorted) without being read. When the `skill` tool returns the body it also returns
  `Skill directory: <dir>` and a list of those files with the hint to read them with the `read` tool, so
  a skill's `REFERENCE.md`/`FORMS.md`/scripts are resolvable. This format contract is proven against a
  real Claude-Desktop-style skill, not an invented fixture
  (`skills: a genuine Anthropic-format SKILL.md loads with its supporting files`).
- **Catalogue-only prompting:** the system prompt gets **names and descriptions only**
  (`renderSkillCatalogue`); bodies load on demand through the `skill` tool. This is the whole point: a
  small-context local model cannot afford every instruction up front, and a test asserts the body text
  never appears in the catalogue.
- **Two invocation paths:** the model calls the `skill` tool with an id; the user types `/skill-id args`
  and `expandSlashCommand` injects `Arguments: …` plus the body as the user turn.

### 7.4 Subagents (`src/ext/subagent.mjs`)

- **Tool:** `task`, `{prompt, description?, maxTurns?, mode?: 'plan'|'default'}`; prompt must be a real
  self-contained brief (≥ 20 chars validation); default child mode **plan** (read-only), default
  `maxTurns` 20.
- **Depth cap:** `MAX_SUBAGENT_DEPTH = 2`, enforced in `validate` **and** `run`; reaching it is a tool
  error, not a crash.
- **Fresh context:** the child gets a brand-new conversation containing only the prompt. There is no
  "fork" mode that inherits the parent transcript (Claude has one, research 04 §2); the tool
  description says so explicitly, which is the mitigation.
- **No prompts:** the child is run with `onAsk: undefined`, so an ask becomes a denial the child can
  read. A prompt inside a subagent would deadlock a headless parent.
- **Result:** the child's final text only, wrapped as
  `Subagent report [label] — N turn(s), stop: <reason>`; `isError` when the child did not end on
  `end_turn`. Parent never sees the child's tool calls — a test asserts the report is the only thing
  returned.

---

## 8. Deliberate differences from Claude Code

Each of these is a decision with a reason, not an omission we forgot to document.

| # | area | Claude Code (research cite) | xMonkey | why |
|---|---|---|---|---|
| 1 | **Model layer** | one vendor (Anthropic Messages API), `callModel` seam (`01 §2`) | `Provider` interface + 3 wire adapters + a prompted-JSON wrapper; `kind`-selected via JSON | The product thesis. A single seam also means the loop has zero vendor conditionals. |
| 2 | **Models with no tool API** | not a case (Claude always has tool_use) | prompted protocol: catalogue in the prompt, one fenced JSON block per reply, parsed back into `tool_use` | Most local/base models cannot emit structured calls; refusing them would make "local-first" a slogan. |
| 3 | **Tool count** | 70 built-ins, ~30 tool-object members, deferred loading via `ToolSearch` (`02 §1-2`) | 8 built-ins + 3 conditional; 6-member tool contract | Local models degrade with large tool catalogues and the schemas must be short; every member we skip is behaviour we do not have to make consistent. |
| 4 | **Compaction** | model-generated summary at `window − 20000 − 13000` with 9-section template, micro-compaction of tool results, boundary records (`03 §6-7`) | no model call: keep head + tail, insert an honest "N messages dropped, re-read if needed" marker, compact to 60% of window | A summarising call costs tokens/latency and can confabulate; a small model cannot tell a fabricated summary from fact. Honesty over fidelity. (Trade-off: detail loss — §10.7.) |
| 5 | **Permission modes** | 6 modes incl. `bypassPermissions` with consent/root checks and an `auto` **classifier** (`02 §3`) | 6 names; `bypass` via `--yes`/config with no extra consent; `auto` = `default` today | v1 keeps the mode set small and the safety story auditable in one file; the classifier is a later, separable add (§5.6-B). |
| 6 | **Rule language** | `Tool(field: pattern)` string grammar, glob `*`, 10 rule sources, two matchers per tool (`02 §4`) | structured JSON `{tool, field, pattern, path, action}` with regex matching | No parser to get wrong in v1; JSON is easy to write and to validate. Gap vs Claude documented (§5.6-A) instead of pretending parity. |
| 7 | **Tool execution** | streaming tool executor runs tools *during* the assistant stream, parallel when concurrency-safe (`01 §2.5`) | strictly sequential, one `tool_result` batch appended after the response | Keeps invariant 1 trivial to prove and makes the transcript deterministic — the two things that matter most across 20+ local backends. Parallelism is roadmap. |
| 8 | **Transcripts** | `parentUuid` linked list, 30+ record types, fork/subagent files, compaction boundary records (`04 §1`) | flat append-only JSONL, 2 record kinds written, id/prefix resume | Flat append is trivially crash-safe (torn last line) and greppable; we do not need a message tree until we need forks. |
| 9 | **Denial text** | long fixed strings per case (interactive reject, permission deny, non-interactive, dontAsk) (`02 §5`) | one `denialMessage` composer with mode-aware guidance | One place to change the model's instruction; the essential content (why + don't retry + alternative) is preserved. |
| 10 | **Hooks** | 31 events, 5 hook types incl. prompt/agent/http/mcp_tool, matcher semantics, policy gating (`04 §3`) | 7 declared / 4 dispatched, one `command` type, regex matcher, JSON decisions | A hook surface we can fully test beats a wide one we cannot; the contract shape is deliberately compatible so scripts can migrate. |
| 11 | **MCP** | full SDK: resources, prompts, list-changed, OAuth, 6 transports, per-server policy (`04 §6`) | `initialize`/`tools/list`/`tools/call` over stdio + HTTP | That is the entire surface an agent needs to consume tools; everything else is server management the CLI does not do. |
| 12 | **Embedding** | Desktop embeds the harness by spawning the CLI as a child with `--output-format stream-json` over stdio, Agent SDK building the args (`desktop 01 §5`) | CLI-first; headless is `--print` (plain text out), no stream-json input/output protocol | v1 has no embedder to serve. This is the single most valuable interop addition and is roadmap item 9. |
| 13 | **System prompt** | six core sections + ~24 dynamic sections, static/dynamic cache boundary, `# Memory`, identity/billing blocks (`03 §1-5`) | 6 sections, no cache boundary, no identity/billing, ~600 tokens base | Local models lose accuracy as the prompt grows; every line must earn its place. Token caching is a cloud-only optimisation we do not need locally. |
| 14 | **Memory files** | managed/user/project ancestors/local/auto-memory, `.claude/rules/`, override semantics (`03 §5`) | 4 filenames, all concatenated in a fixed order | Repos already carry `AGENTS.md`/`CLAUDE.md`; reading all of them means no second convention. |
| 15 | **Sessions** | `--fork-session`, `--continue`, worktree isolation, transcript search | id/prefix resume only; no fork, no worktree | Not required to do the job; every extra session mode is another way for history to become inconsistent. |

---

## 9. What is proven vs what is asserted

Run everything with `node --test test/` (5 real-Ollama tests self-skip when no local model is
available; on this machine `gemma4:12b-it-qat` ran and the suite reported **108/108 pass, 0 skipped**).

### 9.1 Behaviour → the test that proves it

| behaviour | test file | test case (exact name) |
|---|---|---|
| Plain answer ends the loop in one turn; assistant turn appended; usage accumulated | `test/loop.test.mjs` | `loop: finishes on a plain text answer with no tools` |
| Tool call → result appended → second call → finish; canonical history shape | `test/loop.test.mjs` | `loop: executes a tool call, appends the result, then finishes` |
| Tool failure becomes an `isError` result (invariant 2) | `test/loop.test.mjs` | `loop: a tool failure becomes an error tool_result, not a throw` |
| Unknown tool is reported with the real tool list | `test/loop.test.mjs` | `loop: unknown tool is reported to the model with the real tool list` |
| Turn cap stops the loop and says why | `test/loop.test.mjs` | `loop: respects maxTurns and says why` |
| Abort before a turn: no model call | `test/loop.test.mjs` | `loop: abort before a turn returns aborted` |
| Plan-mode write refused, file never created, model told not to retry | `test/loop.test.mjs` | `loop: a denied tool call is refused and the model is told not to retry` |
| Ask→approved runs; ask→declined refuses and nothing is written | `test/loop.test.mjs` | `loop: ask -> approved runs the tool, ask -> declined refuses` |
| Headless ask is an actionable refusal (`--yes` hint) | `test/loop.test.mjs` | `loop: headless with no asker refuses with an actionable message` |
| Compaction keeps head/tail and emits the honest marker | `test/loop.test.mjs` | `compactMessages: keeps the head, the tail, and marks the gap honestly` |
| Compaction fires instead of overflowing a small window | `test/loop.test.mjs` | `loop: compacts instead of overflowing a small context window` |
| Prompt assembly: environment, mode, memory, local-model section | `test/loop.test.mjs` | `system prompt: carries environment, mode and project memory` |
| Deny rule beats bypass mode | `test/loop.test.mjs` | `gate: deny rule beats bypass mode` |
| Read-only shell classifier: allow/ask split | `test/loop.test.mjs` | `gate: read-only shell commands are allowed without a prompt` |
| Input-parameter rule denies one command, not the tool | `test/loop.test.mjs` | `gate: an input-parameter rule denies one command without denying the tool` |
| `dontAsk` denies and never calls the asker | `test/loop.test.mjs` | `gate: dontAsk never prompts — it denies and says why` |
| `auto` accepts safe work and asks for a write | `test/loop.test.mjs` | `gate: auto mode allows safe work and asks for the rest` |
| `PreToolUse` deny beats bypass mode and the file is untouched | `test/loop.test.mjs` | `loop: a PreToolUse hook blocks the call even in bypass mode` |
| `PreToolUse` `updatedInput` changes what runs | `test/loop.test.mjs` | `loop: a PreToolUse hook can rewrite the input that actually runs` |
| Line numbering, offset/limit pagination | `test/tools.test.mjs` | `read: returns line numbers and respects offset/limit` |
| Path escape refused by `read` | `test/tools.test.mjs` | `read: refuses a path outside the workspace` |
| Ambiguous `edit` refused, file untouched | `test/tools.test.mjs` | `edit: refuses an ambiguous match instead of guessing` |
| Glob semantics `**` vs `*` vs `{a,b}` | `test/tools.test.mjs` | `globToRegExp: ** crosses directories, * does not` |
| Bash timeout kills the process | `test/tools.test.mjs` | `bash: timeout kills the process` |
| Tool catalogue is sorted and stable (prompt-cache friendly) | `test/tools.test.mjs` | `registry: specs are stable and sorted (prompt-cache friendly)` |
| Ollama NDJSON → tool_use blocks | `test/models.test.mjs` | `ollama adapter: parses native tool_calls into tool_use blocks` |
| OpenAI streamed tool-call fragments assembled | `test/models.test.mjs` | `openai adapter: assembles streamed tool call fragments` |
| Anthropic content-block + input_json deltas | `test/models.test.mjs` | `anthropic adapter: parses content_block deltas + tool json deltas` |
| Prompted fallback drives a real `tool_use` for a no-tools model | `test/models.test.mjs` | `prompted tools: a model without native tools still drives a real tool_use` |
| `nativeTools:false` forces the prompted protocol | `test/models.test.mjs` | `registry: a local model can be forced onto the prompted protocol` |
| End-to-end binary: flag parsing → adapter → loop → tool → exit code | `test/cli.test.mjs` | `cli: a full one-shot turn reads a file through a real tool call` |
| Plan mode through the real CLI: refused, no file | `test/cli.test.mjs` | `cli: a write is refused in plan mode and the file is never created` |
| `--yes` lets a write land on disk | `test/cli.test.mjs` | `cli: --yes lets a write through and the file lands on disk` |
| Session persisted and resumed; earlier user turn replayed | `test/cli.test.mjs` | `cli: a session is persisted and can be resumed` |
| Unreachable endpoint fails fast with a useful error | `test/cli.test.mjs` | `cli: an unreachable model endpoint fails fast with a clear error` |
| **Interactive mode**: answer a message, tool call, then `/exit` cleanly | `test/interactive.test.mjs` | `interactive mode answers a message and exits cleanly on /exit` |
| **Interactive approval**: the prompt appears and a refusal prevents the write | `test/interactive.test.mjs` | `interactive mode asks for approval and honours a refusal` |
| **Interactive `/help`**: local command, zero model calls | `test/interactive.test.mjs` | `interactive mode /help lists the commands without calling the model` |
| `doctor` probes each configured endpoint and reports reachability | `test/cli.test.mjs` | `cli: doctor reports each endpoint and gives an actionable pull command` |
| Project config overrides user config per key | `test/config-sessions.test.mjs` | `config: project file overrides user file, per key` |
| Torn final transcript line survives | `test/config-sessions.test.mjs` | `sessions: a torn final line does not destroy the transcript` |
| Ambiguous session prefix refused | `test/config-sessions.test.mjs` | `sessions: an ambiguous prefix is refused rather than guessed` |
| MCP over a real stdio child: handshake, list, call, error | `test/ext.test.mjs` | `mcp: connects over stdio, lists tools, calls one` |
| One broken MCP server isolated | `test/ext.test.mjs` | `mcp: a broken server is reported, healthy servers still connect` |
| Hook can deny a tool call | `test/ext.test.mjs` | `hooks: a PreToolUse hook can deny a tool call` |
| Catalogue never leaks skill bodies | `test/ext.test.mjs` | `skills: catalogue advertises names without dumping bodies` |
| Skill tool loads a body; unknown id errors | `test/ext.test.mjs` | `skills: the skill tool loads a body and errors on unknown ids` |
| Subagent returns only its report, not its tool calls | `test/ext.test.mjs` | `subagent: returns the child report and never leaks child tool calls` |
| Subagent depth cap enforced | `test/ext.test.mjs` | `subagent: depth is capped so agents cannot spawn forever` |
| Real Anthropic-format `SKILL.md`: frontmatter, body, sibling files recorded | `test/ext.test.mjs` | `skills: a genuine Anthropic-format SKILL.md loads with its supporting files` |
| **Real local model**: reads a real file to answer | `test/e2e-local.test.mjs` | `local model: real tool call against a real file` |
| **Real local model**: two-step, two-tool task | `test/e2e-local.test.mjs` | `local model: drives a multi-step task with two tools` |
| **Real local model**: reasoning stream preserved, never empty | `test/e2e-local.test.mjs` | `local model: a reasoning model keeps its thinking and still answers` |

### 9.2 Behaviours with **no** test (asserted only — treat as unproven)

- **Interactive mode, partially covered.** Three CLI tests now drive the real binary with piped stdin:
  one tool turn + `/exit`, an approval prompt answered "n" (write must not land), and `/help` making
  zero model calls. Still untested: the `[a]lways` answer, `/model /mode /session /skills /clear`, the
  spinner lifecycle, and Ctrl+C interrupt/exit handling.
- **Real cloud providers.** Anthropic and OpenAI adapters are proven only against local fake servers, no
  real API call, no auth failure, no rate-limit/backoff path, no streaming-idle behaviour.
- **MCP HTTP transport.** Only stdio is tested; the POST/SSE parsing path is unexercised.
- **`PostToolUse` output rewriting at the loop level.** `runHooks` returning `updatedOutput` is not
  tested through `runAgent`; only the hook unit returns it.
- **`SessionStart`/`SessionEnd` hooks** are wired but never tested.
- **Resume fidelity with tool history** — untested because the behaviour is lossy by design (§6.3).
- **Auto-detection** (`detectLocalModel`) — used by the CLI but no unit test stubs the probes or asserts
  the ranking/filtering rules.
- **`--allow-outside` flag plumbing.** The tool-context flag is tested in `tools.test.mjs`; the CLI flag
  path is not. (`--init`, its overwrite refusal, `doctor`, and `--list-models` *are* tested now.)
- **Compaction + tool pairing** (§3.4): no test asserts the compacted history is accepted by a
  tool_use-sensitive provider.
- **Capability flags other than `nativeTools`/`contextWindow`** (§2.2): no test asserts any behaviour
  changes, because none does.
- **Subagents with a real provider**: only a scripted provider is used; no test proves a real model
  completes a delegated job within the turn budget.
- **`max_tokens` stop path** in the loop: no test drives a provider that returns `max_tokens`.
- **File freshness/staleness guards** (§5.6-3): the behaviour does not exist, so there is nothing to
  test — a `read`, an out-of-band change, then an `edit` currently applies silently.

---

## 10. Roadmap

Ordered by (risk closed ÷ effort). Each item names the gap it closes and the check that would prove it.

| # | next step | gap closed | acceptance check |
|---|---|---|---|
| 1 | Interactive-mode coverage completion: `[a]lways` rules, `/model /mode /session /skills /clear`, Ctrl+C interrupt vs exit, spinner start/stop | §9.2 — the partially-tested surface users touch first (turn, refusal and `/help` already covered) | extend `test/interactive.test.mjs`: assertions for each command; Ctrl+C mid-turn returns to the prompt; no orphaned spinner |
| 2 | Hook contract completion: dispatch `Stop`, `UserPromptSubmit`, `PreCompact`; consume hook `ask` (and optionally `additionalContext`) in `executeOne` | §7.2 declared-but-never-fired events; §5.6-D (hook ask dropped) | hook `ask` forces a prompt; `Stop` can block a finish; tests for each |
| 3 | Input-parameter rule completion: `parseRule("Bash(command: \"git *\")")`, glob matching, `write`/`edit` content field, bash argv/prefix matcher, rule `source` layering | §5.6-A | string-rule and object-rule forms are equivalent; a `"rm *"` glob rule denies `rm -rf /` and allows `npm run rm-check` |
| 4 | `auto` as a real policy: acceptEdits fast path + optional classifier callback in `decide`, ask-floor for hooks, deny still first | §5.6-2 (`auto` is nominal) | `auto` allows an in-workspace edit that `default` asks about; a deny rule and a plan wall still win |
| 5 | Tool-level `checkPermissions` hook in the tool contract, merged into `decide` as `guard` | §5.6-1 | a tool returning `ask` forces a prompt; `deny` short-circuits; existing order tests still pass |
| 6 | Transcript fidelity: persist tool turns (`kind:'tool'`/full block arrays), replay them on resume; fix the role-mislabel when a turn stops on `max_turns` | §6.3, §6.2 (2 of 6 kinds written) | pause after a tool-using turn, resume, and the replayed history equals the in-memory history |
| 7 | Compaction correctness + headroom: trigger at `window − min(maxOutput, 20000) − 13000`; re-anchor estimate on last real `usage`; compact only at tool boundaries so `tool_use`/`tool_result` pairs stay adjacent | §3.4 limitation, §3.5 narrow-window overflow | compacted history passes a strict pairing validator; a 400-test with a fake provider at 99% window is gone |
| 8 | Capability enforcement: fold system into the first user turn when `systemRole:false`; gate image blocks on `images`; optional parallel executor when `parallelTools` | §2.2 declared-vs-enforced | a `systemRole:false` fake provider receives no system message; a `parallelTools:false` model never sees two concurrent calls |
| 9 | `--output-format stream-json` (input and output), the surface the Claude Desktop uses to embed the harness (`desktop 01 §5`) | §8 item 12 — no embedding surface | a driver script starts `xmonkey`, feeds one prompt as a stream-json event, parses assistant/tool events, gets a terminal `result` event |
| 10 | Prompt caching for cloud adapters: static/dynamic split + cache breakpoints at block ends (research 03 §8); today only the system block is cached | §8 item 13, cost/latency for API users | a fake server asserts ≥2 `cache_control` breakpoints and a stable prefix across turns |
| 11 | Output overflow: persist oversized tool output to a file and return a preview instead of head/tail clipping (research 03 §9) | §4.4 lossiness | output > limit is on disk and the model receives the path + preview |
| 12 | Tests for auto-detection, `doctor`, MCP HTTP, and a real Anthropic/OpenAI smoke test behind an env flag | §9.2 remaining holes | those tests exist and skip cleanly without credentials |
| 13 | File freshness/staleness guards: session `FileStateStore` in the tool ctx (`read` records mtime/size/hash; `write`/`edit` refuse a stale target and tell the model to re-read; `force` to override) | §5.6-3 — a live gap named in the roadmap's own gap list (numbered last only to keep existing cross-references stable; treat as priority 3) | editing a file changed after the last read returns an `isError` instructing a re-read; unchanged files still edit; a subagent's store is independent |

---

## 11. Module map (every file)

`src/` is 24 files / ~4 200 lines; `bin/` is one entry point; `test/` is 8 suites + one fixture.
Each worker can own a disjoint set.

| file | one-line responsibility | spec section |
|---|---|---|
| `src/core/types.mjs` | canonical ContentBlock/Message/Capabilities/ToolSpec/Completion/Provider types, `CAP_DEFAULTS`, `newId`, token estimators | §2.1, §2.2 |
| `src/core/loop.mjs` | the agent loop: turn cycle, invariant enforcement, tool dispatch, four budget/abort stops, compaction | §3 |
| `src/core/prompt.mjs` | system prompt assembly (BASE/env/memory/mode/local/extra) and memory-file loading | §3.8 |
| `src/models/http.mjs` | shared HTTP/SSE plumbing: `readSSE`, `jsonRequest`, `streamRequest`, retry/backoff, `truncate` | §2.3 |
| `src/models/anthropic.mjs` | Anthropic Messages adapter: SSE parse (text/thinking/tool json deltas), block mapping, `probe` | §2.3, §2.4 |
| `src/models/openai.mjs` | OpenAI-compatible adapter (also LM Studio/llama.cpp/vLLM/OpenRouter/DeepSeek/Groq): SSE, `tool_calls`, `role:'tool'`, `probe` | §2.3, §2.4 |
| `src/models/ollama.mjs` | Ollama adapter, both `ollama-native` NDJSON and `openai-compat` dialects, `num_ctx`, thinking stream, `probe` | §2.3, §2.4 |
| `src/models/prompted.mjs` | prompted-JSON protocol wrapper: catalogue rendering, fenced-block extraction, context trimming | §2.5 |
| `src/models/registry.mjs` | `kind` → adapter map (incl. aliases), `buildProvider` (wraps prompted, sets `maxTokens`), `probeAll` | §2.3, §2.6 |
| `src/tools/registry.mjs` | tool contract helpers: `ToolError`, `ToolRegistry`, `DEFAULT_IGNORES`, `resolveInWorkspace`, `clipOutput`, `validateSchema`, `humanSize`, `isBinary` | §4.1, §4.3, §4.4 |
| `src/tools/files.mjs` | `read`, `write`, `edit`, `list` | §4.2 |
| `src/tools/search.mjs` | `glob`, `grep`, the symlink-safe walker, `globToRegExp` | §4.2 |
| `src/tools/shell.mjs` | `bash`: one command, timeout, bounded buffers, exit-code marker, cwd confinement | §4.2 |
| `src/tools/todo.mjs` | `todo` tool + `createTodoStore` (session checklist, render, warnings) | §4.2 |
| `src/tools/index.mjs` | `buildDefaultRegistry` (compose + disable list), re-exports | §4.2 |
| `src/permissions/gate.mjs` | modes, rule matching, decision order, read-only shell classifier, denial message | §5 |
| `src/sessions/store.mjs` | `SessionStore` (append/meta/load), `sessionsRoot`, `listSessions`, `resolveSessionId` | §6 |
| `src/ext/mcp.mjs` | MCP client: stdio + HTTP, `initialize`/`tools/list`/`tools/call`, namespacing, isolated failures | §7.1 |
| `src/ext/hooks.mjs` | hook config/matching/spawn, JSON decision contract, `HOOK_EVENTS`, `hasHooks` | §7.2 |
| `src/ext/skills.mjs` | SKILL.md discovery/parse, catalogue rendering, `skill` tool, `/skill` expansion | §7.3 |
| `src/ext/subagent.mjs` | `task` tool: depth cap, fresh context, no prompts, report extraction | §7.4 |
| `src/config.mjs` | config loading/merging/precedence, `EXAMPLE_CONFIG`, `detectLocalModel`, `describeConfig` | §2.6 |
| `src/cli/run.mjs` | `main`: flag parsing, provider/session/extension wiring, `runOneShot` (`--print`), `runInteractive` (queue + approvals + slash commands), subcommands (`init`, `models`, `doctor`, `sessions`) | §1, §5.5, §6 |
| `src/cli/ui.mjs` | dependency-free terminal rendering: colours (TTY-aware), symbols, `describeToolCall`, `renderToolResult`, `spinner`, `banner`, `brief` | §5.5 |
| `bin/xmonkey.mjs` | executable entry: `main(argv)`, exit code, fatal error printing | §1 |
| `test/fixtures/fake-mcp-server.mjs` | minimal MCP stdio server (initialize/list/call) used by the MCP tests | §7.1, §9 |

Test suites: `test/loop.test.mjs` (loop, compaction, prompt, gate units, hooks), `test/models.test.mjs`
(three adapters + prompted + registry against fake HTTP servers), `test/tools.test.mjs` (every tool pass
and fail), `test/cli.test.mjs` (real binary + fake model server), `test/config-sessions.test.mjs`
(config precedence, transcripts, resume), `test/ext.test.mjs` (MCP child process, hooks, skills,
subagents), `test/interactive.test.mjs` (real binary, piped stdin: a turn, an approval refusal,
`/help`), `test/e2e-local.test.mjs` (real Ollama, self-skipping).

---

## 12. Doc/code drift ledger

Places where a comment, a plan, or an older brief says one thing and the code does another. These are
deliberately listed rather than quietly fixed in prose.

1. **`loop.mjs` invariant 3** claims "the conversation is never mutated in place by the caller: we own
   it, and we hand out snapshots for persistence". The loop mutates the caller's array in place and hands
   out no snapshot. Real invariant: append-only, verbatim history (§3.2).
2. **`prompt.mjs` `loadMemory`** comment says memory files are read "in that order, first found wins";
   the code reads **all** of them and `run.mjs` concatenates them. Actual behaviour: all found files are
   loaded, in candidate order (§3.8).
3. **`config.mjs` merge comments** say "`configs` is ordered user-then-project"; it is built
   project-then-user and then reversed before applying, so project wins. The behaviour is correct, the
   two comments describing the order are backwards (§2.6).
4. **`sessions/store.mjs` header** lists six record kinds (`header|user|message|tool|usage|note`); only
   `user` and `message` are ever written by the CLI (§6.2).
5. **`STOP.blocked`** is declared and never returned (§3.3).
6. **Capability flags** `streaming`, `parallelTools`, `systemRole`, `images`, `thinking` are declared and
   documented in `types.mjs` as if they route behaviour; only `nativeTools` and `contextWindow` are read
   (§2.2). The `systemRole` folding promised in the type comment is not implemented.
7. **`gate.mjs` JSDoc** types `isReadOnly` as a function; the loop passes a boolean, and the function
   form is never used (§2.2/§4.1).
8. **The brief for this document** listed three missing permission features. After the mid-write
   correction: all six modes exist, input-parameter rules and `dontAsk` are implemented, `auto` exists in
   name only, and `checkPermissions` plus freshness/staleness guards are absent. The gap list in §5.6 is
   the corrected one; this ledger entry records that the brief was stale, not the code.
9. **Two interactive-mode defects were present in the snapshot this document started from and were fixed
   while it was being written**: `src/cli/ui.mjs`'s `spinner` factory was called as `spinner.start()`
   (a `TypeError` on the first interactive turn), and `runInteractive` referenced `skills` without it
   being in scope (a `ReferenceError` on the first typed line). Both are corrected in the current tree
   (`run.mjs` destructures `skills` from the session; one spinner instance per turn), and three
   interactive tests were added afterwards (`test/interactive.test.mjs`) specifically so these two classes
   of failure cannot return silently. The episode is recorded because it is the strongest argument for §9.2.
10. **`meta.json`** is not written atomically (plain `writeFile`); a crash during a meta write can leave
    invalid JSON, which `readMeta` reports as `null` (§6.4).

### 12.1 Resolution status (after the drift audit)

The lead reviewed this ledger, reproduced each defect with a test, and fixed the ones that were real
bugs rather than documentation. This section records what changed, because a ledger that only grows is
a ledger nobody acts on. Current suite: **121 tests, 0 failures**.

| # | status | resolution |
|---|---|---|
| 1 | **fixed (comment)** | `loop.mjs` invariant 3 now states the real contract: history is append-only and verbatim. |
| 2 | **fixed (comment)** | `prompt.mjs` now documents that ALL memory files load, in candidate order. |
| 3 | **fixed (comment)** | `config.mjs` merge-order comments corrected to match the reversed application. |
| 4 | **fixed (comment)** | `sessions/store.mjs` header now lists only the two record kinds the CLI writes. |
| 5 | **fixed (code)** | `STOP.blocked` is now returned when compaction cannot free enough room — the honest outcome. |
| 6 | **fixed (code)** | Capability flags are no longer decorative: new `src/models/capabilities.mjs` applies `systemRole:false` by folding the prompt into the first user turn, wired in `registry.mjs`. The `prompted.mjs` wrapper also folds when the model lacks a system role. Regression tests cover the combination. |
| 7 | **fixed (comment)** | `gate.mjs` JSDoc now types `isReadOnly` as the boolean the loop passes. |
| 8 | n/a | records a stale brief, not a code defect. |
| 9 | **fixed (code + tests)** | Both interactive defects fixed; `test/interactive.test.mjs` exists and covers the path. |
| 10 | **open** | `meta.json` is still a plain `writeFile`. Low impact (a lost meta degrades to a session with no metadata, not a lost transcript) and intentionally deferred. |

Bugs found by auditing this ledger that were **not** in it, and are now fixed with regression tests:

| bug | impact | fix |
|---|---|---|
| Compaction could orphan a `tool_use` and leave an unanswered call | a strict provider returns 400; the session wedges | `compactMessages` is now tool-pair aware, repairs the cut boundary, and refuses to return a structurally invalid history |
| `--resume` persisted only the final assistant message per turn | a resumed session lost every tool call and result, so the model answered as if it had never read anything | the CLI now persists each appended message with its real role; replay rebuilds the full turn. Test asserts the resumed request contains the `tool_calls` and the `tool` role message |
| Plan mode denied `todo` and `task` | a planning agent could not keep a checklist or delegate — the two things plan mode is for | `todo` is now declared read-only (session state only); `task` runs its child in plan mode |
| A `PreToolUse` hook returning `ask` was discarded | a project guard that says "ask me" was silently ignored | `executeOne` honours the hook's `ask`; headless sessions refuse with an actionable message |
| The prompted-tools protocol's own example block `{"tool":"tool_name"}` parsed as a tool call | the model's real reply was swallowed and a nonexistent tool was invoked | extraction requires a real tool name; the placeholder is rejected by construction |
| A provider that returned text instead of calling `onText` lost every tool call | silent no-op on non-streaming paths | the wrapper falls back to the returned content |
| `Stop` hook declared but never dispatched | "you forgot something" hooks never ran | fired on a normal end-of-turn, output surfaced as a notice |

Still genuinely open, and listed rather than hidden: the per-tool `checkPermissions` hook, the
`auto`-mode classifier (the name exists, the classifier does not), result freshness/staleness guards,
atomic `meta.json` writes, and image input in the tool layer.
