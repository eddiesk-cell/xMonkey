# R3 — Claude Code system prompt, memory files & context management

Source: `research/claude-code/cli.js` (Claude Code 2.1.231, Bun CJS bundle, 62,954 lines).
All line numbers below are `cli.js:<n>` and were verified with `sed -n`. Findings are paraphrased;
only short identifying fragments are quoted.

**Build identity found in the bundle** — version `2.1.231`, build time `2026-08-13T07:25:27Z`,
git sha `bbff368…` (embedded in the CLI feedback text, line 21852 region). Useful for saying which
harness we are mirroring.

---

## 1. Where the system prompt is assembled

There is one main builder, `kq(...)` (`cli.js:21877`), which returns an **array of strings** (the
`lf()` helper is literally the identity function, `cli.js:3378`, so a "system prompt" is just
`string[]` throughout). It:

1. builds a **dictionary of named, feature-gated section builders** (`fN(name, fn)` entries,
   `cli.js:21878`) — each entry is skipped (null) when its flag/condition is off;
2. awaits the enabled ones in order (`h = await RAf(m)`);
3. concatenates the fixed core block, then the dynamic sections, then an attachment reminder
   (`L2f`, `cli.js:21878`).

Top-level call path: `dge({...customSystemPrompt, defaultSystemPrompt, appendSystemPrompt,
overrideSystemPrompt})` (`cli.js:5109`) chooses, in priority order:

- `overrideSystemPrompt` → prompt is exactly that one string;
- coordinator/comms mode → coordinator prompt + append text;
- subagent/main-thread agent definition → the agent's own `getSystemPrompt()` (+ append);
- otherwise the default `kq()` output, then `customSystemPrompt` replaces it (if no agent),
  then `appendSystemPrompt` is appended last (`cli.js:5109`).

Static SDK options are `systemPrompt` / `appendSystemPrompt` (`--system-prompt`,
`--append-system-prompt`, flag parsing near `cli.js:23248`, merge at `cli.js:5109`).
A `CLAUDE_CODE_SIMPLE` mode degrades the whole prompt to two lines, `CWD: …` and `Date: …`
(`cli.js:21877`), which is a handy pointer to what the harness considers irreducible.

## 2. Core sections (fixed order, `cli.js:21877`, definitions at listed lines)

| # | section | heading | where | intent (paraphrased) |
|---|---------|---------|-------|----------------------|
| 1 | preamble | none | `21847` | "You are an interactive agent…": role, that instructions below + tools are the mechanism, and a hard rule never to guess URLs. |
| 2 | system mechanics | `# System` | `21851` | Output is markdown rendered in a terminal; permission-mode semantics (denied call ⇒ change approach, don't retry verbatim); `<system-reminder>` tags come from the harness; tool results may be external data ⇒ flag suspected prompt injection; and: the conversation is **not** limited by the context window because earlier messages get compressed. |
| 3 | coding behaviour | `# Doing tasks` | `21852` | The bulk of the behavioural rules: minimal change, no speculative abstraction, comments only for non-obvious *why*, verify before claiming done, security baseline (OWASP), no back-compat shims, accurate "verified vs assumed" reporting, and how to give feedback / `/help`. |
| 4 | risky actions | `# Executing actions with care` | `21853` | Reversibility + blast-radius policy: local reversible work needs no confirmation; destructive/shared-state actions (force-push, deletes, PR/issue writes, third-party uploads) are confirm-first; authorisation is scoped, not global. |
| 5 | tool policy | `# Using your tools` | `21863` | Prefer dedicated file/search tools over shell; use the todo tool to track work; independent tool calls in one response can be parallel; shell only for shell-only operations; interactive-login fallback is telling the user about `! <cmd>`. |
| 6 | output style | `# Tone and style` | `21866` | Short, concise answers; reference code as `file_path:line_number`; emojis only on request; no "colon before a tool call". |

If an *output style* is configured, the entire core block above is replaced by a different
preamble (`bZS`, `cli.js:21867`) whose first hand-written section is `# Harness` (`cli.js:21872`).

## 3. Dynamic sections (`cli.js:21878`)

Registered in this order (names are the literal registry keys):

`communication` (brief/progress-update policy) → `pronouns` → `action_caution` →
`task_continuity` → `fable_identity` (model identity) → `tool_param_json` (when to call tools as
raw JSON) → `session_guidance` (`yZS`, `21865`: shell-vs-tool hints, subagent/fork guidance,
skill invocation rules, `!`-command hint, ultrareview note) → `memory` (`Shn`, `529`) →
`env_info_simple` (`CZS`, `21891`) → `language` → `output_style` → `bg-session` → `scratchpad` →
`context_management` (`xZS`, `21931`) → `brief` → `focus_mode` → `act_dont_rederive` →
`delivering_work_max` → `overcorrection` → `subagent_steer_delegation` → `heron_brook` →
`autonomy_append` → `endconv_deferred_hint`.

`context_management` is a two-sentence promise (`cli.js:21931`): when the conversation grows long,
part or all of it is summarised and the summary plus unsummarised remainder is carried into the
next window, so the model never has to "wrap up early".

A second, "static" env variant exists (`AZS`, `cli.js:21892`) used when
`excludeDynamicSections` is requested — i.e. SDK/embedding callers can ask for the cache-stable
subset only (`cli.js:21878`).

## 4. Static vs dynamic — what actually changes per session

The assembled prompt is explicitly **split at a sentinel**:
`__SYSTEM_PROMPT_DYNAMIC_BOUNDARY__` (`cli.js:152`), injected by the `bSt()` branch of the assembly
(`cli.js:21878`). The cache splitter `G3a` (`cli.js:21937`) then emits up to three blocks:

- billing header block → `cacheScope: null` (never cached);
- the identity strings ("You are Claude Code, …" — the set is built at `cli.js:430`) → also no
  cache scope (`cli.js:21937`, set membership at `430`);
- everything **before** the boundary → `cacheScope: "global"` (identical across users);
- everything **after** the boundary → `cacheScope: "org"` (`cli.js:21941`).

What is dynamic (after the boundary / in `# Environment`, `cli.js:21891`):
**primary working directory, git-worktree note, "is a git repository", additional working
directories, platform (`Q.platform`), shell (`z3a`, `cli.js:21894`), OS version (`q3a`,
`cli.js:21894`), model name/id, knowledge cutoff (`j3a`, `cli.js:21894`), the current model-family
blurb (`D2f`, `cli.js:21934`), CLI/desktop/web/IDE availability line, and the fast-mode note.**
An optional note injected from settings via `pIo()` also lands here (`pIo` → `Nju.note`,
`cli.js:430`).

Date is **not** in the system prompt: it arrives as a `userContext` block
`currentDate: "Today's date is …"` (`cli.js:3082`), alongside `claudeMd`, `userEmail`,
`attachedProject`.

Git state is a separate `systemContext` block, not the system prompt: `Scp` (`cli.js:3072`) runs
`git status --short` (with `--no-optional-locks`), `git log --oneline -n 5`, resolves current/main
branch and `user.name`, and labels the result "a snapshot in time". Status is truncated at
**2,000 characters** (`Esa=2000`, `cli.js:3077`).

Both contexts are delivered as an injected **system-reminder**, not as chat turns: `byp`
(`cli.js:21946`) renders `<system-reminder>\nAs you answer … # <key>\n<value> …`, and the query
loop prepends it to the message list (`cli.js:3741`).

## 5. Memory files: CLAUDE.md and friends

Path function `r6t(type)` (`cli.js:403`):

| type | path | meaning |
|---|---|---|
| `Managed` | `<managed dir>/CLAUDE.md` | organisation policy |
| `User` | `<config dir>/CLAUDE.md` | personal global instructions |
| `Project` | `<dir>/CLAUDE.md` (and `<dir>/.claude/CLAUDE.md`) | checked-in project instructions |
| `Local` | `<dir>/CLAUDE.local.md` | private, not checked in |
| `AutoMem` | `<memory dir>/MEMORY.md` (`rNe`, `cli.js:378`) | the model's own persistent memory index |

`<config dir>` = `CLAUDE_CONFIG_DIR` or `~/.claude` (`cli.js:39`); the managed dir is
`/Library/Application Support/ClaudeCode` on macOS, `C:\Program Files\ClaudeCode` on Windows,
`/etc/claude-code` otherwise (`Fny`, `cli.js:207`).

Loader `CEb` (`cli.js:3062`) accumulates files in this precedence order (later groups do **not**
overwrite earlier ones — everything is concatenated, so ordering defines salience, not override):

1. **Managed** — managed `CLAUDE.md`, plus a virtual managed blob, plus policy-settings
   `claudeMd` text, plus `<managed>/.claude/rules/*.md` (`cli.js:3062`);
2. **User** (if user settings enabled) — `~/.claude/CLAUDE.md`, plus `~/.claude/rules/*.md`
   (`cli.js:3062`, rules helper `oIo` at `cli.js:403`);
3. **Project/Local**, walking from filesystem root **down to cwd** (`f.reverse()`, `cli.js:3062`):
   for each ancestor dir — `CLAUDE.md`, `.claude/CLAUDE.md`, `.claude/rules/` (Project), then
   `CLAUDE.local.md` (Local); ancestors belonging to the *main repo* of a worktree are skipped to
   avoid duplicates (`bRn`/`_Rn`, `cli.js:3062`);
4. **Additional directories** (`CLAUDE_CODE_ADDITIONAL_DIRECTORIES_CLAUDE_MD`) — the same
   three-file + rules pattern per extra dir (`cli.js:3062`);
5. **AutoMem** — `MEMORY.md` index (and pinned-memory entries) last (`cli.js:3062`, path `378`).

Suppression knobs verified in the same function: `CLAUDE_CODE_DISABLE_CLAUDE_MDS`, per-settings
`Dg("userSettings"|"projectSettings"|"localSettings"|"policySettings")`, and the
`claudeMdExcludes` schema option (settings schema, `cli.js:207`).

Rendering (`FGo`, `cli.js:3066`): every file becomes one paragraph
`Contents of <abs path> (<descriptor>)` followed by the file body, joined in load order. The
descriptors are exactly: project instructions checked into the codebase / user's private project
instructions not checked in / user's auto-memory / organisation-managed policy instructions /
user's private global instructions for all projects (`cli.js:3066`). The whole blob arrives as the
`claudeMd` key of the injected system-reminder (`cli.js:3082`).

Separately, there is a **memory tool** prompt section: `# Memory` (`cli.js:448`), `# auto memory`
(`cli.js:484`, used when managed memory guidelines exist), and `# Memory` with private + team
store description (`cli.js:517`), built by `Shn` (`cli.js:529`) and wired into the prompt registry
as `memory` (`cli.js:21878`). Auto-memory path helpers live next to `rNe` (`cli.js:378`).

## 6. Context management & auto-compaction

### Token accounting
- Char-based estimator: `vS(str, t=4)` = `round(len/4)` — **4 chars/token** default; JSON/JSONL
  files use **2 chars/token** (`Z1_`, `cli.js:981`).
- Multimodal estimator counts each **image or document as 2,000 tokens** (`cli.js:981`).
- Authoritative usage comes from API responses: `G2e(usage)` =
  `input_tokens + cache_creation_input_tokens + cache_read_input_tokens + output_tokens`
  (`cli.js:1679`).
- Conversation size `lI(messages)` = usage of the **last message that carries `usage`** plus a
  char estimate of every message after that anchor (`jvd`/`lI`, `cli.js:1679`) — i.e. real usage is
  re-anchored each response, estimates only cover the tail.

### Trigger thresholds (concrete)
Gate: `ex()` (`cli.js:2856`) returns false if `DISABLE_COMPACT` or `DISABLE_AUTO_COMPACT` is set,
else the `autoCompactEnabled` setting (default on).

Definitions (`cli.js:2856`):
- `xhe(model, window)` = `window − min(maxOutputTokens, 20000)`; the 20,000 reserve is `_Gd=20000`.
- `xzo(window, cfg)` = `window − 13000` (**13,000-token headroom**, `uGd=13000`), or
  `floor(window × pct/100)` if `CLAUDE_AUTOCOMPACT_PCT_OVERRIDE` is set.
- `_Vt(model, window)` = `xzo(xhe(...))` — **this is the auto-compact threshold** attached to the
  compaction request (`autoCompactThreshold:_Vt(...)`, `cli.js:3381`).
- `JQs(window, cfg)` = `min(window − round(window × precomputeBufferFraction), xzo(window,cfg))`;
  default buffer fraction `Rzo=0.2` (`cli.js:2856`). The **precompute/background compactor arms at
  this earlier point** (`vGd`, `cli.js:2856`).
- `XQs(used, window, cfg)` returns levels: `warn` at `threshold−20000`, `compact` at threshold,
  `blocked` at `window−3000` (`dGd=3000`, `cli.js:2856`) — or hard overrides
  `CLAUDE_CODE_BLOCKING_LIMIT_OVERRIDE`.

With the default window `hfe=200000` (`cli.js:284`), so:
- predictive arm ≈ `min(180000×0.8, 180000−13000)` = **144,000 tokens**;
- auto-compact fires at **167,000 tokens** used (180,000 − 13,000);
- `warn` UI level at **147,000**; hard `blocked` at **197,000**.
Windows are clamped to `Izo=100000 … eZs=1000000` (`cli.js:2856`); per-model overrides exist, e.g.
`claude-sonnet-5` default **967,000** (remote-cowork/local-agent 500,000) (`cli.js:2856`).
Auto-compact is re-evaluated every loop iteration from live usage (`_aa(...)`, called at
`cli.js:3741`), with guards: no compaction on the first turn after a fork, no reactive compaction
after one already failed, compaction paths skip `prompt_suggestion`/`away_summary`/`agent_summary` query sources
(`yAt`/`Plb`, `cli.js:2856`), and a `rapid_refill` breaker after **3** rapid refills
(`Fup=3`, `cli.js:3378`).

### What compaction keeps vs drops
`C8o` (`cli.js:3380`) is the compaction driver: trigger is `compact_auto` or `compact_manual`, and
it runs the model with one of the summary templates (below), then builds the new context as
`[boundaryMarker, summaryMessages, (messagesToKeep), attachments, hookResults]`
(`qst`/`xaa`, `cli.js:3378`). So compaction **drops** all raw pre-boundary turns and their tool
outputs, and **keeps**: (a) the summary, (b) a `<system>`-recorded boundary marker
`type:"system", subtype:"compact_boundary"` (`cli.js:167`) so the transcript UI can hide pre-
boundary content, (c) optionally a preserved recent segment recorded as
`compactMetadata.preservedSegment {headUuid, anchorUuid, tailUuid}` (`Zsa`, `cli.js:3378`), plus
attachments and hook results. Media that cannot be stripped makes compaction fail with
`media_unstrippable` (`cli.js:5109`-region driver, `Xsa`, `cli.js:3100`).

### Where the summary is produced
Three prompt templates (all in `cli.js:3134–3315`):
- **full** summary (`T0b`, `cli.js:3134`): "create a detailed summary of the conversation so far";
  requires an `<analysis>` block first, then 9 sections — Primary Request and Intent; Key Technical
  Concepts; Files and Code Sections; Errors and fixes; Problem Solving; **All user messages**
  (with an explicit anti-spoofing rule: only real user-role turns count); Pending Tasks; Current
  Work; Optional Next Step. Security-relevant constraints must be preserved verbatim.
- **recent-only** summary (`w0b`, `cli.js:3230`) — used when earlier context is retained intact.
- **prefix** summary (`E0b`, `cli.js:3303`) — summary placed at the *start* of a continuing
  session, for precomputed compaction.
Custom instructions can be appended per user config: the templates tell the model to honour
`## Compact Instructions` / `# Summary instructions` blocks supplied in context
(`cli.js:3220`). The summary request itself runs with `querySource:"compact"` and a
`customInstructions` passthrough (`cli.js:3381`), and post-compact `PreCompact` hooks can block
compaction (`w8o`, `cli.js:3378`).

## 7. Micro-compaction (tool-result eviction before full compaction)

Separate cheaper pass, `sdp` (`cli.js:3381`): keep the **last 5** tool-result ids
(`keepRecent:SFf`, `SFf=5`, `cli.js:21956`), and *if* clearing the older ones saves
**≥ 20,000 tokens** (`Haa=20000`, `cli.js:3381`), replace their content with the literal
`[Old tool result content cleared]` (`O8o`, `cli.js:3381`). Large cleared results can instead be
persisted to a file and referenced by path (`persist` hook → `<persisted-output>` preview,
`cli.js:21956`). Purely textual replacement — no model call.

## 8. Prompt-cache breakpoints

Caching is present and central. The breakpoint marker builder is `Jhe({scope, ttl})`
(`cli.js:21956`): `{type:"ephemeral", ttl?, scope?}`. Placement:

- `Tev` (`cli.js:21958`) maps each **system-prompt block** from `G3a` to a text block and attaches
  `cache_control` only when the section has a non-null `cacheScope` — so breakpoints sit at the end
  of the static `global` block and at the end of the dynamic `org` block, while the billing header
  and identity strings get **none** (`cli.js:21937`).
- **Messages**: the breakpoint moves — cache_control is put on the *last content block* of the last
  user and last assistant message (`cli.js:21956`, `s===o.length-1` logic), i.e. one rolling
  breakpoint at the conversation frontier.
- TTL policy: 1h TTL is enabled only for an allowlist of query sources
  (`repl_main_thread*`, `sdk`, `auto_mode`, `memdir_relevance`), 5m forced by
  `FORCE_PROMPT_CACHING_5M`, off under `DISABLE_PROMPT_CACHING*` (`JIe`, `cli.js:21956`).
- For cache-key/diagnostics the code strips `cache_control` (`rup`, `cli.js:3084`), showing the
  marker is treated as pure transport metadata.

## 9. Tool-result truncation, persistence, and budgets

Per-tool declaration `maxResultSizeChars` (chars). Verified values:
`Read` = **Infinity** (`1/0`, `cli.js:3864` — grows via pagination instead);
`Bash` = **30,000** (`cli.js:3848`); `PowerShell` = 30,000 (name constants `di`=`Bash` / `Hs`=`PowerShell`, `cli.js:285`, `cli.js:295`);
`Grep` = **20,000** (`cli.js:2399`); `Glob`, `Edit`, `Write`, `Skill`, `TodoWrite`, `Agent`,
`EnterPlanMode` = **100,000** (`maxResultSizeChars:1e5`, e.g. `cli.js:2392`, `2395`, `19500`);
`ListMcpResources` and `StructuredOutput` = 100,000 (`cli.js:981`, `cli.js:1247`);
some narrow tools declare 1,000 or 256 chars (`cli.js:19294`, `19322`).

Effective limit `pFo(tool)` (`cli.js:1636`): if `maxResultSizeChars` is finite, use
`min(maxResultSizeChars, persistenceThresholdCeiling)`, unless the tool is exempt from the
aggregate budget; default ceiling `M_n=50000` chars (`cli.js:806`); a growth-book value can
override per tool (`cli.js:1636`).

Enforcement `ybd` (`cli.js:1643`): empty results become `(ToolName completed with no output)`;
non-text content bypasses; otherwise if `len > limit` the **full** output is written to
`.claude/tool-results/<tool_use_id>.txt|json` and the message is replaced by a
`<persisted-output>` wrapper containing a **2,000-char** preview (`WCr=2000`, `cli.js:1644`) plus
the note "Output too large (<n>). Full output saved to: <path>" (`cli.js:1644`).
Hard fallback cap when no per-tool limit: `Und=400000` chars (`cli.js:806`).
Independent aggregate budget: `ZN_` (`cli.js:1644`) groups results per assistant turn and, if the
sum exceeds **`jnd=200000` chars**, drops the largest fresh results first (`JN_`) until under
budget, persisting each (`cli.js:1644`). Token estimates for telemetry use `H_n=4` chars/token
(`cli.js:806`).

Bash has its own output cap independent of tools: `BASH_MAX_OUTPUT_LENGTH` default **30,000**
chars, max 150,000 (`gXs=30000`, `hXs=150000`, `cli.js:2406`). MCP output is capped in tokens:
default **25,000** tokens (`YkS=25000`, `cli.js:18485`), converted to chars as `tokens×4`
(`ect()`, `cli.js:18481`), truncated with an explicit
`[OUTPUT TRUNCATED - exceeded <n> token limit]` notice (`JkS`, `cli.js:18481`); an image inside an
MCP payload is costed at 1,600 tokens (`Oaf=1600`, `cli.js:18485`).

## 10. Media encoding (images, PDFs, notebooks)

- **Images**: `q$` (`cli.js:2816`) decodes, resizes and re-encodes, then emits Anthropic's
  `{type:"image", source:{type:"base64", media_type, data}}`; dimensions are tracked. Limits:
  `maxWidth/maxHeight 2000×2000`, `maxBase64Size 5,242,880`, `targetRawSize 3,932,160`
  (`TK`, `cli.js:958`), then a **512,000-byte** post-resize budget with iterative compression
  (`K0r=512000`, `cli.js:958`). Unprocessable images degrade to a text block
  `[Image could not be processed: …]` (`cli.js:2816`).
- **PDFs**: if the model advertises native PDF support, the *whole file* is sent as one
  `{type:"document", source:{type:"base64", media_type:"application/pdf"}}` meta message
  (`cli.js:3860`). Otherwise pages are rasterised by poppler (`pdftoppm`-style, needs
  `brew install poppler` / `poppler-utils`) to numbered `.jpg` files and each becomes an image
  block with `mediaType:"jpeg"` (`cli.js:3860`). Page policy: a PDF with **more than 10 pages**
  (`hNo=10`, `cli.js:958`) must be read with a `pages` range; at most **20 pages per request**
  (`L9e=20`, `cli.js:958`).
- **Notebooks**: `NotebookRead` renders each `.ipynb` cell as
  `<cell id="…"><cell_type>…</cell_type>[<language>…</language>]<source></cell id="…">`
  (`cli.js:2834`); output cells are appended as text blocks or, for embedded images, as
  base64 image blocks (`nab`, `cli.js:2834`). Notebook size cap **100 MB**
  (`lne=104857600`, `cli.js:2836`); oversized/over-output notebooks error with a `jq`/PowerShell
  recipe for partial reads (`cli.js:2836`). `NotebookEdit` is gated on the notebook having been
  read first in the same conversation (`cli.js:2836`).

## 11. Number sheet (all verified in-bundle)

| what | value | cite |
|---|---|---|
| chars per token (text) | 4 | `cli.js:981` |
| chars per token (JSON) | 2 | `cli.js:981` |
| image/document token cost in estimator | 2000 | `cli.js:981` |
| default context window | 200,000 | `cli.js:284` |
| output-token reserve considered | min(maxOutputTokens, 20000) | `cli.js:2856` |
| compaction headroom | 13,000 | `cli.js:2856` |
| blocking margin | 3,000 | `cli.js:2856` |
| precompute buffer fraction | 0.2 | `cli.js:2856` |
| window clamp | 100,000 … 1,000,000 | `cli.js:2856` |
| microcompact minimum saving | 20,000 tokens | `cli.js:3381` |
| microcompact recent tool results kept | 5 | `cli.js:21956` |
| per-tool default persistence ceiling | 50,000 chars | `cli.js:806` |
| fallback per-result cap | 400,000 chars | `cli.js:806` |
| aggregate tool-result budget / turn | 200,000 chars | `cli.js:806` |
| persisted-output preview | 2,000 chars | `cli.js:1644` |
| Bash output default / max | 30,000 / 150,000 chars | `cli.js:2406` |
| MCP output token cap default | 25,000 | `cli.js:18485` |
| git snapshot status truncation | 2,000 chars | `cli.js:3077` |
| PDF pages needing a range / max per read | 10 / 20 | `cli.js:958` |
| image box / base64 / raw targets | 2000px / 5,242,880 / 3,932,160 | `cli.js:958` |
| image post-resize budget | 512,000 bytes | `cli.js:958` |
| notebook max bytes | 104,857,600 | `cli.js:2836` |

## 12. What xMonkey should copy (design implications, ours)

1. Keep the system prompt a **pure `string[]`** assembled from named, independently gated section
   builders — easy to diff, test and cache.
2. Split at an explicit dynamic boundary and put **cache breakpoints at block ends**, not on every
   block; identity/billing prefixes stay uncached so they never invalidate user caches.
3. Estimate tokens as `chars/4` for budgeting, but always **re-anchor on real API usage** from the
   last response before deciding to compact.
4. Compact at `window − output_reserve − 13k`, warn earlier, and pre-arm the summary at
   `min(0.8·effective, effective−13k)` so the model call happens before the wall.
5. Memory = ordered concatenation of *managed → user → project(ancestors root→cwd) → local →
   auto-memory*, rendered as "Contents of PATH (descriptor)" in one injected context block; no
   override semantics to reason about.
6. Tool output overflow → persist to file, return a 2,000-char preview; enforce both per-call and
   per-turn budgets; never truncate tool *media* silently.

## 13. Unresolved / bounded claims

- The `autoCompactEnabled` GrowthBook/settings plumbing is only partially visible (feature-flag
  names `tengu_amber_*`, `tengu_sepia_moth` are opaque; quoted as-is).
- Whether `# Environment` ever includes the date on other entrypoints: not found in this build —
  date is a `userContext` block (`cli.js:3082`), quoted as such.
- Exact `Z1_` JSON token ratio is per-extension (`json/jsonl/jsonc` → 2), not a global rule.
- Compaction "preserved segment" heuristic (`s7t`) was not fully decompiled; only the metadata
  record shape (`preservedSegment`, `preservedMessages`) is confirmed.
