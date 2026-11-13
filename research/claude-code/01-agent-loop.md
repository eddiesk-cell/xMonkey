# 01 — Claude Code harness: the agent loop

**Target:** `research/claude-code/cli.js` — Claude Code `2.1.231`, Bun CJS bundle (62,954 lines, minified).
All citations are line numbers in that file, e.g. `cli.js:3741`. The bundle is minified, so some lines
contain several functions and `cli.js:N` identifies the line, not a function offset.
Identifiers below are the *build's* minified names given as evidence; the behaviour is described in our own words.

---

## 1. Entry chain: `query` → observer tap → loop

- The public query generator is `jhe(e)` (`cli.js:3741`). It is a thin lifecycle wrapper: it delegates to
  `_Ib(e,t)` when the "observer tap" path is enabled, otherwise to `iyp(e,t)`, and in `finally` records a
  `subagent_exit` checkpoint when `toolUseContext.agentId` is set.
- After the inner generator finishes, `jhe` emits `{type:"command_lifecycle", state:"completed"|"cancelled"}`
  messages for tracked commands, then classifies the result with `EKo(reason)` (aborted?) and
  `fua(reason)` (failure vs normal stop) and records a "turn" telemetry event (`cli.js:3741`).
- `_Ib` is `queryWithObserverTap` (`cli.js:3741`): it wraps the loop iterator, flushes a telemetry segment on
  each `stream_request_start`, captures every yielded message, and rethrows if the inner generator ends
  without a terminal value ("queryWithObserverTap: missing terminal after completion").
- `iyp(e,t)` (`cli.js:3741`) is **the actual agent loop** — one `async function*` with a `while(!0)` and a
  per-turn state object `h`. It receives `systemPrompt`, `userContext`, `systemContext`, `canUseTool`,
  `fallbackModel` (string or array), `querySource`, `spawnedBySkill`, `maxTurns`, `forkPointUuid`,
  and `deps`. `deps` defaults to `wgp()`, which returns the model seam as `callModel: WOr`
  (`cli.js:3730`).
- The loop's mutable turn accumulator is `wt = bgp({createStreamingToolExecutor, onReset})` (`cli.js:3730`).
  It owns `assistantMessages` (`Rt`), `toolResults` (`pt`), `toolUseBlocks` (`ft`) and the booleans
  `needsFollowUp`, `toolRequestedEndTurn`, `shouldPreventContinuation`, `toolWasDeferred`. Every turn starts
  from `h.turnCount` and re-enters the same `while` body (`cli.js:3741`).

## 2. One turn: request → stream → dispatch → feed back

1. **Turn start.** Each iteration yields `{type:"stream_request_start"}` (`cli.js:3741`) — this is the boundary
   the UI and observer use to start a new assistant message.
2. **Model call.** The loop does
   `for await (msg of Qfp(f.callModel({messages, systemPrompt, thinkingConfig:Y6t(F), tools, signal,
   options:{... model: Bt, fallbackModel: H[M+1], fastMode, toolChoice, onStreamingFallback ... }}),
   () => wt.streamingToolExecutor))` (`cli.js:3741`). `H` is the fallback-model chain built from
   `fallbackModel`; `M` is the chain index and is advanced when a fallback error is thrown.
3. **Model seam.** `callModel` is `WOr` (`cli.js:21956`), which passes the request through `_Pa`
   (`cli.js:18481`; a record/replay seam whose `hdi()` gate is hard-coded `false` in this build,
   `cli.js:18480`, so it is a passthrough)
   into `DFf`, the streaming request builder + HTTP client. `DFf` is also the place where the request body
   is assembled (`cli.js:21958`).
4. **HTTP.** `DFf` issues `ma.beta.messages.create({...body, stream:true}, {signal, headers})
   .withResponse()` (`cli.js:21958`). The request id and response headers are recorded; a request-start
   telemetry marker (`query_api_request_sent`) and a TTFT marker (`query_first_chunk_received`) bracket it.
5. **Stream/executor multiplexing.** `Qfp(stream, getExecutor)` (`cli.js:3407`) races the model stream's
   `next()` against the streaming tool executor's `waitForDrainable()`; when tools have finished results it
   yields `{type:"tool_drain_tick"}`, which the loop turns into `yield* sr()` (`cli.js:3741`). This is how
   tool calls can execute *while* the assistant is still streaming.
6. **Stream events.** The loop consumes normalised events: raw `stream_event`s are re-yielded for live
   rendering, `message_delta` copies `delta.stop_reason` (and `usage`, `stop_details`) into the in-flight
   assistant message buffer, and `message_stop` finalises usage/credits (`cli.js:3741`, `cli.js:21958`).
7. **Tool-use discovery.** When a completed `assistant` message arrives, the loop filters its content for
   `type:"tool_use"`; if any exist it pushes them into `ft`, sets `wt.needsFollowUp = true`, and calls
   `wt.streamingToolExecutor.addTool(block, assistantMessage)` for each (`cli.js:3741`).
   `addTool` (`class oca`, `cli.js:3407`) resolves the tool by name/alias, `safeParse`s the tool
   `inputSchema`, classifies `isConcurrencySafe(input)`, and queues execution. Unknown tools immediately
   become a completed `<tool_use_error>No such tool available: ...</tool_use_error>` result instead of
   crashing the turn.
8. **Tool execution.** `executeTool` calls the per-call generator `U0t(block, assistantMessage, canUseTool,
   ctx, now)` (`cli.js:2196`). It re-resolves the tool (aliases, MCP names), checks abort state and the
   isolation latch, then goes through the permission pipeline in `$9_` (`cli.js:2203`): JSON-parse guard,
   `coerceInput`, zod validation, hook/permission decision, and finally
   `await tool.call(input, {...ctx, toolUseId}, canUseTool, assistantMessage, onProgress)`
   (`cli.js:2203`). The return value is converted with `tool.mapToolResultToToolResultBlockParam(...)` into
   `{type:"tool_result", tool_use_id, content, is_error}` and wrapped in a synthetic *user* message.
9. **Result feedback.** `sr()` drains `streamingToolExecutor.getCompletedResults()` and re-yields each result
   message; `tr(message, ctx)` converts it to user-message form and appends it to `pt` (`cli.js:3741`).
   Errors are converted the same way: when the query itself fails, `pIb` synthesises `is_error:true`
   `tool_result` blocks for any unmatched `tool_use` ids so the conversation stays well-formed
   (`cli.js:3737`).
10. **Continuation.** If tool blocks existed, the loop runs the explicit tool phase
    (`eb("query_tool_execution_start")`), drains the remaining results
    (`streamingToolExecutor.getRemainingResults()`, `cli.js:3741`), runs `PostToolBatch` stop hooks, then
    rebinds the turn state:
    `h = {messages:[..._e, ...Rt, ...pt], turnCount: turnCount+1, transition:{reason:"next_turn"}, ...}`
    (`cli.js:3741`). `_e` is the pre-request message list, `Rt` the assistant messages from this turn, and
    `pt` the tool results — this concatenation is exactly the "feed `tool_result` blocks back to the model"
    step, and `while(!0)` starts the next API request.

## 3. Streaming vs non-streaming

- The harness **always streams by default.** The non-streaming path `RFf` exists only as a fallback
  (`cli.js:21956`); it sets `isNonStreamingRequest:!0` in its retry options and does a single
  `.beta.messages.create(...).withResponse()`.
- Fallback is entered from `DFf` when the stream fails before or during delivery: stream creation 404
  (`fallback_cause:"404_stream_creation"`), an empty/malformed stream, "Stream completed without receiving
  message_start event", or a stream-idle watchdog abort. The loop then yields
  `{type:"streaming_fallback_began"}`, tombstones the orphaned assistant/tool messages, aborts in-flight
  tools (`discardAndAbortInFlight`), and calls `yield* RFf(...)`; the `initialConsecutive529Errors` counter
  is carried across so overload accounting is continuous (`cli.js:21958`, `cli.js:3741`).
- Idle handling: `jia()` computes `max(CLAUDE_STREAM_IDLE_TIMEOUT_MS, 300000)`; `DFf` arms a warning timer at
  half the deadline and a hard timer ("Streaming idle timeout: no chunks received ... aborting stream"),
  which raises `Error("Stream idle timeout - no chunks received")` and triggers the non-streaming fallback
  (`cli.js:2983`, `cli.js:21958`, `cli.js:3741`).
- **Partial output.** While streaming, each `stream_event` is yielded upward so the UI renders text deltas
  incrementally. If the user aborts (or `querySource==="sdk"`), `DFf` can return a *partial* assistant
  message built from the accumulated text block when `keepPartialMessageOnAbort` is set
  (`cli.js:21958`); otherwise the aborted stream yields no partial assistant message and the loop reports an
  abort reason (section 5).

## 4. Retries, backoff, overload / rate limit

- Every request goes through `Czo(createClient, performRequest, options)` (`cli.js:2856`), a generator that
  retries `for (attempt = 1 .. n+1)`. Attempt budget `n = Elb(options)` = `options.maxRetries ?? GQs()`, where
  `GQs()` reads `CLAUDE_CODE_MAX_RETRIES` (default 10, clamped to 15; 300 when the retry watchdog env flag is
  on). Non-streaming path pins `maxRetries:0` on the inner client and lets `Czo` own the retry loop
  (`cli.js:21956`).
- **Backoff.** `MLe(attempt, retryAfterHeader, cap=32000)` = `min(500 * 2^(attempt-1), cap)` plus 0–25%
  random jitter; if a `retry-after` header exists, `max(retryAfterSeconds*1000, backoff)` wins (`cli.js:285`,
  `cli.js:2856`). For 429s the unified rate-limit reset header is also honoured, capped at six hours, and a
  process-wide cooldown is recorded. Delays longer than 60 s are labelled "persistent retry wait", sliced in
  30 s chunks, and can be interrupted by `subscribeRetryWake` (`cli.js:2856`).
- **Error classes.** `ps` = HTTP/API error; `O5` (`name:"RetryError"`) wraps a retry-exhausted error with its
  `retryContext`; `dQ` (`name:"FallbackTriggeredError"`) carries `originalModel`, `fallbackModel`, `reason`
  (`overloaded` / `server_error` / `model_not_found` / `permission_denied` / `last_resort`); `Tv` is the
  abort error (`cli.js:2856`, `cli.js:39`).
- **Classification.** `Ahe(e)` = overloaded (HTTP 529 or body contains `"type":"overloaded_error"`);
  `Yab(e)` = rate limited (429 or `"type":"rate_limit_error"`). Retryable: 408, 409, 401 (after token
  refresh), 429, any 5xx, plus explicit `x-should-retry` headers; non-retryable types are enumerated in
  `ylb` (`invalid_request_error`, `authentication_error`, `billing_error`, `permission_error`,
  `not_found_error`, `request_too_large`, `rate_limit_error`, `timeout_error`, `api_error`,
  `overloaded_error`). A non-retryable error with a configured fallback model becomes a `dQ`
  "last_resort" fallback (`cli.js:2856`).
- **Overload ladder.** Consecutive 529s are counted (seeded by `initialConsecutive529Errors`); at 3 the
  harness switches to the fallback model if one exists, else fails with a dedicated overload error.
  Background query sources drop the 529 immediately instead of retrying. Auth 401s trigger OAuth/host token
  recovery and retry the *same* attempt; 407 proxy auth likewise. The per-class retry caps are
  `slb/llb/clb/ulb/dlb/plb` (2 attempts each); `alb`/`Clb`/`klb` are delay bounds (`cli.js:2856`).
- **max_tokens overflow recovery** (server 400 "input length and `max_tokens` exceed context limit:
  x + y > z") is special-cased: the driver parses the token numbers and retries with
  `maxTokensOverride = contextLimit - inputTokens - 1000`, refusing to loop if the adjustment makes no
  progress (`cli.js:2856`).
- Retry progress is surfaced to the UI as `{type:"system", subtype:"api_error", retryInMs, retryAttempt,
  maxRetries, source}` (`mCn`, `cli.js:21662`) and mirrored through `onRetryStatus`/`subscribeRetryWake`.
- When `Czo` throws a `dQ`, the main loop advances the fallback chain (`M++`, picks the next usable model
  from `H`), tombstones messages produced by the failed model, resets per-attempt state, and continues the
  same turn with the new model (`cli.js:3741`).

## 5. Finish conditions

`fua(reason)` (`cli.js:3730`) is the authoritative terminal-reason enumeration. Failures:
`api_error`, `model_error`, `prompt_too_long`, `image_error`, `blocking_limit`, `rapid_refill_breaker`,
`malformed_tool_use_exhausted`, `budget_exhausted`, `structured_output_retry_exhausted`,
`tool_deferred_unavailable`, `turn_setup_failed`. Normal stops: `completed`, `max_turns`, `hook_stopped`,
`stop_hook_prevented`, `tool_deferred`, `background_requested`, `aborted_streaming`, `aborted_tools`.
`E8e` = the two aborted reasons; `EKo` = "cancelled or failed"; `Agp` maps a reason to the telemetry label.

Where the loop actually returns:

- **No tool use** (`!wt.needsFollowUp`, `cli.js:3741`): the loop handles error/compaction paths and then
  returns `{reason:"completed"}` — after `Stop`/`SubagentStop` hook handling. A blocking stop hook injects
  messages and `continue`s with `stopHookBlockingCount+1` and `transition.reason:"stop_hook_blocking"`; the
  block cap defaults to 8 (`CLAUDE_CODE_STOP_HOOK_BLOCK_CAP`) after which it returns `completed` with a
  warning (`cli.js:3741`).
- **`end_turn` / `stop_sequence` with no visible text**: treated as a "thinking-only" response; the loop
  injects a meta user nudge and re-enters instead of ending the turn (`cli.js:3741`).
- **`stop_reason:"tool_use"` with zero parsed tool blocks**: malformed-tool-use recovery — tombstone the bad
  assistant message, inject a corrective user message, retry once (`transition.reason:"malformed_tool_use_retry"`),
  then return `{reason:"malformed_tool_use_exhausted"}` (`cli.js:3741`).
- **`stop_reason:"max_tokens"`**: a recovery turn is attempted with the partial transcript plus a
  "Pick up mid-thought" user message (`transition.reason:"max_output_tokens_recovery"`); the stream itself
  also yields an `api_error:"max_output_tokens"` message (`cli.js:3741`, `cli.js:21958`).
- **`model_context_window_exceeded`** → the same max-output-token error surface (`cli.js:21958`).
- **`stop_reason:"refusal"`** is a first-class stop reason: it can trigger a refusal fallback to a
  `refusalFallbackModel`, or a `refusal_no_fallback` message; it never silently ends the turn
  (`cli.js:21958`, `cli.js:3741`).
- **Tool phase exits**: abort → `{reason:"aborted_tools"}` (with `max_turns_reached` message if over the
  limit); `toolWasDeferred` → `tool_deferred`; `shouldPreventContinuation` → `hook_stopped`; a tool that
  requested end-of-turn → `mIb(...)` (PostToolBatch hooks) then `{reason:"completed"}`
  (`cli.js:3741`, `cli.js:3737`).
- **`max_turns`**: the loop computes `nextTurn = turnCount+1` and, when `maxTurns` is set and
  `nextTurn > maxTurns`, yields `{type:"max_turns_reached"}` and returns `{reason:"max_turns"}` before
  recursing (`cli.js:3741`).
- Prompt-too-long / 413 responses are routed into auto-compact / reactive-compact before returning
  `prompt_too_long`, with a rapid-refill breaker (`Ee.consecutiveRapidRefills`) that can terminate as
  `rapid_refill_breaker` (`cli.js:3741`).

## 6. Request parameters: max_tokens, thinking, temperature, stop sequences

- **max_tokens.** `SVt(model)` (`cli.js:21958`) resolves the model's default and upper limit and applies
  `CLAUDE_CODE_MAX_OUTPUT_TOKENS` when set. The streaming body uses
  `max_tokens = min(per-call override || maxOutputTokensOverride || SVt, SVt)` (`cli.js:21958`); the
  non-streaming path additionally clamps with `Eev(body, wev)` where `wev = 64000` (`cli.js:21956`,
  `cli.js:21958`), and `Eev` (`cli.js:21958`) also reduces `thinking.budget_tokens` to `max_tokens - 1` when
  needed. The streaming path exposes the resolved value as `nt` for telemetry and error messages
  (`cli.js:21958`).
- **Extended thinking.** The config comes from `Y6t(toolUseContext)` (`cli.js:590`): `options.thinkingConfig`,
  overridable by a `max_thinking_tokens` permission layer, where `0` means `{type:"disabled"}` and any other
  value becomes `{type:"enabled", budgetTokens}`. Per request the streaming builder (`cli.js:21958`):
  disables thinking when `CLAUDE_CODE_DISABLE_THINKING` is set; uses `{type:"adaptive"}` on models that
  support adaptive thinking; otherwise builds `{type:"enabled", budget_tokens: max(1024, min(max_tokens-1,
  modelBudget)), display?}` where `modelBudget` defaults to `modelUpperLimit - 1` (`ZAu`, `cli.js:284`);
  sends `{type:"disabled"}` only on models that require it (`Qbr`); and, when thinking is active, demotes a
  forced `tool_choice:{type:"tool"}` to `auto` because forced tool choice is incompatible with extended
  thinking (`cli.js:21958`). Thinking-capable models are detected by `o0s` (`cli.js:284`).
- **temperature.** Sent only when thinking is disabled *and* the model still accepts sampling temperature
  (`Y0o`, legacy claude-3 / opus-4-0..4-6 / sonnet-4-0..4-6 / haiku-4-5): value is `temperatureOverride`
  or `1`, otherwise the field is omitted entirely (`cli.js:21958`, `cli.js:284`). There is **no** `top_p` /
  `top_k` in the main-loop request body.
- **stop_sequences.** Not used by the main loop. The only request bodies that set it are auxiliary
  "side queries" via `xce(...)`, which also default to `max_tokens:1024` and `maxRetries:2` (`cli.js:21958`).
- **Other fields.** `system` (array of text blocks, cache-control annotated), `messages`, `tools` (schemas
  with `defer_loading` for dynamic tool loading), `tool_choice`, `metadata`, `betas` (sticky per query
  source; fast-mode, cache-TTL, thinking round-trip and refusal-fallback betas are added conditionally),
  `output_config` (effort / format), `speed` for fast mode, and `context_management` (`cli.js:21958`).
- **Max turns / budget.** `maxTurns` is optional on the main loop (unbounded unless set) and normally comes from the
  agent definition for subagents; a `taskBudget` and a USD `maxBudgetUsd` are also checked at tool-dispatch time
  (`cli.js:19174`, `cli.js:3741`).

## 7. Subagent recursion (Task / Agent tool)

- The delegate tool is the `Agent` object with internal name `bi` and alias `s5`, `searchHint:"delegate work
  to a subagent"`, description "Launch a new agent", and `maxResultSizeChars:1e5` (`cli.js:19174`). Its
  input shape is `{prompt, subagent_type?, description?, model?, run_in_background?, name?, isolation?:
  "worktree"|"remote", cwd?}`; `name` makes the agent addressable via `SendMessage`.
- **Caps** are enforced in `call`: nesting `xR(agentContext)` (depth, 0 for main) must stay below `EK()`
  (`CLAUDE_CODE_MAX_SUBAGENT_SPAWN_DEPTH`, default 3 from a feature flag) — else it throws a
  "Subagent nesting limit reached" tool error (`cli.js:300`, `cli.js:1200`, `cli.js:19174`). Concurrency is
  capped by `CLAUDE_CODE_MAX_CONCURRENT_SUBAGENTS` via `taskRegistry.getConcurrentSubagents()`, and a budget
  check refuses to start new agents once `maxBudgetUsd` is spent (`cli.js:19174`).
- **The subagent runs the same loop.** The subagent runner `Nq` (`cli.js:6594`) builds a child
  `toolUseContext` (`agentId`, `agentContext` with `agentType:"subagent"` and `spawnDepth`,
  `queryTracking.depth+1`, its own `abortController`/`readFileState`) and then iterates
  `for await (msg of jhe({messages, systemPrompt, ..., toolUseContext, querySource:"agent:custom",
  maxTurns: override ?? agentDefinition.maxTurns, forkPointUuid, stickyBetas}))`. So there is one
  implementation of the loop; subagents are the same `jhe → iyp` machine with a different context and turn
  budget, not a separate mini-loop.
- **Differences from the main loop:** the subagent's messages are filtered for the parent UI (`t7t` events
  are consumed for spinner/API metrics instead of being rendered); its transcript is written under its own
  agent id; a `SubagentStop` hook and a large cleanup pipeline (MCP teardown, session hooks, todos,
  read-file state, shell tasks, OTel span) run in `finally`; and instead of returning a `reason` enum to the
  REPL, its final assistant text/result becomes the tool result block of the `Agent` tool call
  (`cli.js:6594`).
- **Forked internal agents.** `Sq({promptMessages, cacheSafeParams, querySource, forkLabel, maxTurns,
  skipTranscript, ...})` (`cli.js:3102`) builds a child context with `c8o`, calls `jhe` directly, collects
  messages + token usage and returns them. Default `maxTurns` for a fork is `oaa = 50`; internal uses pass
  tiny budgets (e.g. 1 for agent summaries, 5 for memory extraction). These are used for background
  housekeeping (memory extraction, "dream", agent summaries) and are never shown as chat turns.
- **Background subagents.** `Eyp` (`cli.js:3741`) registers a `local_agent` task via `wIb`, then runs `jhe`
  in the background, mirroring token/tool counters and recent activities into the task registry and
  appending every message to the transcript; completion/failure updates the task status. `run_in_background`
  defaults to true for the `Agent` tool (`cli.js:19174`).

## 8. Open questions / limits of this reading

- `WOr`/`DFf`/`RFf` and the retry driver `Czo` are heavily intertwined with refusal fallback, server-side
  "rotunda pennant" fallbacks and credit tokens; their exact precedence order is only partially clear from
  a minified bundle, and those paths are out of scope for xMonkey.
- The Task tool's synchronous result extraction was followed to the subagent runner but not to the exact
  place the final text is trimmed into the tool result; the result shape is
  `{status, prompt, ...}` per `_5S` (`cli.js:19174`).
- The `stop_reason` used by the loop is `message.stop_reason ?? streamedStopReason` (`cli.js:3741`); when a
  server fallback rewrites messages, the streamed value is the one stitched in from `message_delta`, so the
  final assistant message may not carry it.
