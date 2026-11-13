# R4 — Sessions, subagents, hooks, skills, slash commands, MCP, settings

Target: `research/claude-code/cli.js` (Claude Code 2.1.231, 25.4 MB Bun CJS, 62,954 lines).
All identifiers below are the *minified* names as they appear in the bundle, because in a minified
bundle the identifier is the only stable handle. Line cites are `cli.js:<line>` and were verified
with `sed -n '<n>p' cli.js | grep -c '<pattern>'`. Nothing here is copied code — behaviour only.

---

## 1. Session persistence (transcript store, resume, fork)

**Entry points**
- `tU(sessionId)` → transcript path for the current session; `xS()` → same but for the live session;
  `eS(cwd)` / `pE()` / `xv()` → per-project dir; `UC(agentId)` → subagent transcript path (all on one line, `cli.js:2846`, `cli.js:21717`).
- `Wt()` → current session id (`cli.js:12`). `eJi({setCurrentAsParent})` → rotate to a brand-new
  session id (`cli.js:12`). `EA(x)` → UUID validator used before any path is built.
- `tU` is defined as: if `e === Wt()` return the live session file, else
  `path.join(projectDir(_n()), e + ".jsonl")` (`cli.js:21717`).
- `resolveSessionFilePath` (`set`), `readSessionLite` (`n4t`), `readTranscriptForLoad` (`ian`),
  `writeEntriesToJsonlFile` (`W6e`) are the exported transcript-tools surface (`cli.js:161`).

**On-disk layout**

```
<configDir>/projects/<sanitized-cwd>/<sessionId>.jsonl
<configDir>/projects/<sanitized-cwd>/<mainSessionId>/subagents/agent-<agentId>.jsonl
```

- `<configDir>` = `CLAUDE_CONFIG_DIR` ?? `~/.claude`, NFC-normalised — `Sn()` (`cli.js:39`).
- Projects root = `<configDir>/projects` (`pE`, `xv`, both `cli.js:2846`); per-project dir name is
  the cwd with every non-alphanumeric char replaced by `-`; over-long paths are truncated and suffixed
  with a base36 hash of the original path — `zmo` / `Rv` (`cli.js:167`).
- Subagent transcripts live one level *below* the session file: `<projectDir>/<sessionId>/subagents/`
  — `iCn()`, `UC()` (`cli.js:2846`).
- A sibling `<id>.meta.json` exists for agent metadata (`yUa`, `cli.js:21717`); `cleanupPeriodDays`
  (default 30) drives transcript GC.

**JSONL record shape.** One JSON object per line (`JSON.stringify(entry) + "\n"`, `W6e`/`w2c`).
Records are a *tagged union* on `type`. The router table at `cli.js:21746` enumerates the full
vocabulary: `user`, `assistant`, `attachment`, `system`, `progress`, `summary`, `custom-title`,
`ended-by-model`, `ai-title`, `last-prompt`, `tag`, `relocated`, `agent-name`, `agent-color`,
`agent-setting`, `pr-link`, `frame-link`, `bridge-session`, `history-suppression`,
`file-history-snapshot`, `file-history-delta`, `attribution-snapshot`, `mode`, `permission-mode`,
`isolation-latch`, `worktree-state`, `queue-operation`, `marble-origami-commit`,
`marble-origami-snapshot`, `marble-origami-reset`, `content-replacement`, `fork-context-ref`,
`observer-ref`.

Conversation line sketch (from the fork writer, `cli.js:5993`):

```
{ type:"user"|"assistant"|"system"|"attachment"|"progress",
  uuid, parentUuid,              // linked list, not an array
  isSidechain:false, sessionId, sessionKind,
  message:{ role, content:[{type:"text"|"tool_use"|"tool_result", ...}] },
  cwd, userType, entrypoint, version, gitBranch, timestamp,
  forkedFrom:{ sessionId, messageUuid },   // fork only
  isMeta, isCompactSummary, toolUseResult, sourceToolAssistantUUID }
```

Compaction is itself a record: `{type:"system", subtype:"compact_boundary", compactMetadata:{preservedSegment|preservedMessages}}`
— sniffed by `R2c` (`cli.js:167`). `queue-operation` records store queued prompts
`{type:"queue-operation", operation, timestamp, sessionId, content}` (`cli.js:2203`).

**`--resume` / `--continue` / fork**
- Argv classification happens up front: `GMc(argv)` returns `"resume"` when `-r`/`--resume`/`--from-pr`
  (or `=` forms) is present, `"continue"` for `-c`/`--continue`, else `"fresh"` (`cli.js:148`).
- `--resume` takes a session id, a `.jsonl` path, or a URL (`SYi`, `cli.js:12`); the loader walks
  candidate project dirs (`resolveSessionFilePath`, cross-worktree scan) and falls back to
  `invalid-resume-id.jsonl` for non-UUIDs (`cli.js:167`).
- `--continue` = "most recent transcript in this project": session listing sorts by `mtime` descending
  and hides daemon/entrypoint-filtered sessions (`isHiddenFromSessionPicker`/`hus` `cli.js:161`;
  mtime sort `cli.js:3483`).
- `--fork-session` (+ `--resume-session-at`, `--resume-drops-turn`, `--session-id`,
  `--no-session-persistence`) are composed into child launch args by `_5f` (`cli.js:22147`).
- Fork writer (`cli.js:5993`–`5994`): allocates a new session id, replays the source transcript line by
  line into the new `<id>.jsonl`, rewrites `sessionId`, rebuilds the `parentUuid` chain, forces
  `isSidechain:false`, and stamps each copied line with `forkedFrom:{sessionId,messageUuid}`; then
  appends the new extra prompts and any `content-replacement` / `relocated` bookkeeping lines.
- `/clear` and in-session resets call `eJi({setCurrentAsParent:true})`: new `randomUUID()` session id
  plus `parentId = previous id`, so sessions form a tree (`cli.js:12`).

---

## 2. Subagents (the `Agent` tool, aliased `Task`)

**Entry points**
- Tool object: `sgi` — `name: bi` ("Agent"), `aliases:[s5]` ("Task"), `searchHint:"delegate work to a subagent"`,
  `description()` → `"Launch a new agent"` (`cli.js:19174`; the two name constants are declared at `cli.js:554`).
- Input schema `i2a()` / `g5S()` (`cli.js:19174`); output schema `_5S()` (`cli.js:19174`).
- Spawn/governor: depth check `xR(agentContext)` vs `EK()`; registration `bGe(...)`; transcript
  binding `SGe(agentId, UC(...))` (`cli.js:1200`, `cli.js:2853`, `cli.js:2846`).
- Result-size cap for the tool result: `maxResultSizeChars: 1e5`.

**Input shape** (`cli.js:19174`)

```
{ description: string,          // 3-5 words
  prompt: string,
  subagent_type?: string,       // agent definition name; "fork" = clone the caller
  model?: "sonnet"|"opus"|"haiku"|"fable",
  run_in_background?: boolean,  // background is the default
  name?: string,                // addressable via SendMessage({to:name})
  isolation?: "worktree"|"remote",
  cwd?: string }
```

**Context handed down** — `r8e(ctx)` returns exactly what a child execution inherits:
`{systemPrompt, userContext, systemContext, toolUseContext, forkContextMessages: ctx.messages, stickyBetas}`
(`cli.js:3100`). So the child always gets the parent's system prompt + user/system context + tool
context; it only gets the *message history* when `subagent_type:"fork"`
(`forkContextMessages`). The Agent tool description states forks "inherit your full conversation
context and always run on your model — a `model` override is ignored"; any other type "starts a fresh
agent" (`cli.js:3994`). Subagents inherit the parent's permission mode (`mode` field is deprecated
and ignored, `cli.js:19174`). Nesting depth is capped by `EK()` = `CLAUDE_CODE_MAX_SUBAGENT_SPAWN_DEPTH`
or a feature gate default **3** (`cli.js:1200`); exceeding it throws `AgentPreconditionError`
("Subagent nesting limit reached…").

**Agent definitions.** Built-ins are plain objects `{agentType, whenToUse, tools:["*"], source:"built-in", baseDir}`
(`general-purpose`, `Explore`, `Plan`, `fork`; `cli.js:1866`). User/project agents are markdown files
(`.claude/agents/*.md` with frontmatter), scopes `["user","project","local"]` (`cli.js:1733`), loaded by
the generic markdown-dir loader (see §4).

**Result return.** Synchronous run → `{status:"completed", prompt, worktreePath?, worktreeBranch?}`.
Background run → `{status:"async_launched", agentId, description, resolvedModel, modelsUsed, prompt, outputFile, canReadOutputFile}`
(`_5S`, `cli.js:19174`); the parent is notified on completion and can poll the `outputFile` (or use the
`TaskOutput` / `TaskStop` / `TaskList` tools).

**Background task registry.** Spawned work is registered as a typed task record
(`cli.js:2853`): `{type:"local_agent", status:"running", agentId, ownerAgentId, parentAgentId,
spawnDepth, prompt, model, effort, cwd, selectedAgent, agentType, abortController, isBackgrounded,
isObserver, forkedSkillName, pendingMessages, retain, keepaliveReasons}`. Sibling task types are
`local_bash` (background shells) and `remote_agent` — all three share `TaskOutput`/`TaskStop`.

---

## 3. Hooks (events, config, decisions)

**Entry points**
- Event name list: `Fj` (`cli.js:152`). Validator: `Mps(cfg)` rejects unknown events with the full
  list (`cli.js:207`). Config resolution (policy gating): `CPs()` (`cli.js:432`).
- Input builder: `hg(session, cwd, permissionMode, ctx)` (`cli.js:21789`). Dispatcher: `V2`
  (`executeHooks`); per-event wrappers exported at `cli.js:21785`. Pre-tool path:
  `executePreToolHooks` = `J6t` (`cli.js:608`), consumed by `nwn` (`cli.js:2196`).

**Event names — exactly 31, enum order** (`cli.js:152`):

```
PreToolUse, PostToolUse, PostToolUseFailure, PostToolBatch, Notification, UserPromptSubmit, UserPromptExpansion, SessionStart, SessionEnd, Stop, StopFailure, SubagentStart, SubagentStop, PreCompact, PostCompact, PermissionRequest, PermissionDenied, Setup, TeammateIdle, TaskCreated, TaskCompleted, Elicitation, ElicitationResult, ConfigChange, WorktreeCreate, WorktreeRemove, InstructionsLoaded, CwdChanged, FileChanged, DirectoryAdded, MessageDisplay
```

`SessionEnd` reasons are a separate enum `DNc = ["clear","resume","logout","prompt_input_exit","other","bypass_permissions_disabled"]`
(same line).

**Config shape** — `settings.json` key `hooks`, schema `Jpe()` (`cli.js:207`):

```
"hooks": {
  "<EventName>": [
    { "matcher": "Edit|Write",              // tool name, pipe list, "" = all; omitted = all
      "hooks": [ { hook }, ... ] }
  ]
}
```

Hook variants (all in one union at `cli.js:207`): `{type:"command", command, ...}`,
`{type:"prompt", prompt}`, `{type:"agent", prompt, model}`, `{type:"http", url, headers, allowedEnvVars}`,
`{type:"mcp_tool", server, tool, input}`. Common options: `if` (permission-rule filter, e.g.
`"Bash(git *)"`), `timeout` (seconds), `statusMessage`, `once`, `async` (fire-and-forget).
Matcher semantics are documented inline in the settings-error tips: tool name, `"Edit|Write"`, or empty
to match all (`cli.js:207`). Hook sources: settings layers, plugins (`hooks/hooks.json` + manifest
`hooks`), SDK session hooks, and `hooks:` frontmatter on skills/commands. Policy can disable
everything (`disableAllHooks`), restrict to managed hooks (`allowManagedHooksOnly`), or block
command-sourced plugin hooks (`disableCommandPluginSources`) — `CPs()` (`cli.js:432`).

**Hook input.** Stdin JSON = common base + event-specific fields. Base: `{session_id, transcript_path,
cwd, prompt_id, permission_mode, agent_id, agent_type, effort}` (`hg`, `cli.js:21789`).
`PreToolUse` adds `{hook_event_name:"PreToolUse", tool_name, tool_input, tool_use_id}` (`cli.js:608`).

**Hook output.** Common envelope `$Db` (`cli.js:4130`): `{continue, suppressOutput, stopReason,
decision:"approve"|"block", reason, systemMessage, terminalSequence, hookSpecificOutput:{...}}`.
`PreToolUse`'s `hookSpecificOutput` = `{hookEventName:"PreToolUse", permissionDecision:"allow"|"deny"|"ask"|"defer",
permissionDecisionReason, updatedInput, additionalContext}` with the `permissionDecision` enum declared
right next to it (`cli.js:4130`). Other events carry `additionalContext`, `sessionTitle`,
`updatedToolOutput` (PostToolUse), `watchPaths` (SessionStart/CwdChanged/FileChanged),
`reloadSkills` (SessionStart), `retry` (PermissionDenied), and `decision:{behavior:"allow"|"deny",
updatedInput?, updatedPermissions?}` for `PermissionRequest` (`cli.js:4130`).

**How a decision is applied (PreToolUse).** `nwn` (`cli.js:2196`) consumes the hook event stream and
maps it onto the permission pipeline:
- `blockingError` → synthesize `{behavior:"deny", message, decisionReason:{type:"hook", hookName, reason}}`.
- `updatedInput` → re-validate against the tool's own `inputSchema`; schema failure is itself a deny,
  otherwise the tool runs with the rewritten input.
- `permissionBehavior` (`allow`/`deny`/`ask`) → `hookPermissionResult` with that behaviour; `allow`
  carries `updatedInput`, `ask` forces the prompt, `deny` short-circuits the call.
- `defer` is print-mode only and only when a single tool call is in the batch.
- `preventContinuation` + `stopReason` stop the turn; `additionalContexts` are injected as a
  `hook_additional_context` attachment; cancellation yields `hook_cancelled` and stops.
Post-tool hooks can rewrite the tool output (`updatedToolOutput`); `Stop`/`SubagentStop` can block
continuation, and `PermissionDenied` can retry.

---

## 4. Skills (`SKILL.md`)

**Entry points**
- `fFe(kind, cwd, ctx)` → all markdown files of a kind (`commands|agents|output-styles|skills|workflows|routines`,
  `OAp` at `cli.js:21304`); implementation `k7S` (`cli.js:21304`).
- `loadSkillsAsPlugins` = `PUo` (`cli.js:2190`), which enumerates skill folders via `fbd`
  (`cli.js:1636`). User skills root `G5s()` = `<configDir>/skills` (`cli.js:1636`).
- Reload after `SessionStart` hooks that set `reloadSkills`: `C5()` (`cli.js:608` region).

**Discovery paths** (verified in `fbd`/`k7S`):
- user: `~/.claude/skills/<name>/SKILL.md` (gated by `userSettings` being an allowed source).
- project: `<cwd>/.claude/skills/<name>/SKILL.md`, scanning every directory from cwd up to `$HOME`
  (`iYt`), plus additional working directories; source label `projectSettings`.
- managed/policy: `<managedDir>/.claude/skills/...`; plugin skills (`<plugin>/skills/`); synced
  memory/team skills; MCP-provided prompts. A bare `.claude/skills/SKILL.md` (no skill dir) and
  deeper nesting are not discovered. Symlinked skill folders are rejected; hooks ignore symlinked
  files; a `SKILL.md` over 128 KB is skipped (`cli.js:521` memory-skill text).

**`SKILL.md` format.** Markdown with YAML frontmatter. The recognised frontmatter key whitelist is
`Ci_` (`cli.js:440`):

```
name, description, model, allowed-tools, argument-hint, arguments, disable-model-invocation,
user-invocable, effort, shell, version, when_to_use, paths, hooks, context, agent, created_by,
improved_by, mcpServers, lspServers, agents, outputStyles, themes, workflows, channels, monitors,
settings, experimental, commands, skills, dependencies, userConfig, metadata, displayName, defaultEnabled
```

Body is the prompt. `allowed-tools` restricts the tool set while the skill runs; `model` pins the
model; `paths` scopes it; `hooks` attaches skill-local hooks.

**Invocation as a slash command.** A skill directory is turned into a plugin, and its `SKILL.md`
becomes a *prompt command* of `type:"prompt"` registered into the command list `Mo` (`Mu()` builds the
command object, `cli.js:1722`). Calling `/skill-name args` runs `getPromptForCommand(args, ctx)`, which:
1. expands `$ARGUMENTS` / `$1..$n` (argument substitution `cEt`),
2. prepends `Base directory for this skill: <dir>` so the model can read shipped scripts/resources,
3. substitutes `${CLAUDE_SKILL_DIR}`, `${CLAUDE_PROJECT_DIR}`, `${CLAUDE_SESSION_ID}`, `${CLAUDE_EFFORT}`
   (see the two `getPromptForCommand` bodies at `cli.js:3854` and `cli.js:2128`),
4. returns text blocks that are injected as the user turn (no tool call needed).
`disable-model-invocation: true` keeps it out of the model-facing `Skill` tool; `user-invocable: false`
hides it from the `/` menu.

---

## 5. Slash commands

**Mechanism.** Every command is an object discriminated by `type`:
- `type:"local"` — plain function, works headless (`supportsNonInteractive:true`), e.g. `clear`
  with `aliases:["reset","new"]` (`cli.js:5009`, `cli.js:4918`).
- `type:"local-jsx"` — React/Ink UI command, e.g. `add-dir` (`cli.js:1583`), `artifacts`,
  `auto-mode-setup` (`cli.js:4918`).
- `type:"prompt"` — markdown/prompt command (built-in bundled skills, `.claude/commands/*.md`, plugin
  commands, MCP prompts, memory skills); object built by `Mu()` (`cli.js:1722`) / the markdown loader
  (`cli.js:3854`) with `{name, description, aliases, argumentHint, argNames, whenToUse, model,
  allowedTools, getAllowedTools, disallowedTools, disableModelInvocation, userInvocable, context,
  agent, background, effort, paths, declaredFields, contentLength, contentHash, source, loadedFrom,
  hooks, skillRoot, getPromptForCommand}`.

**Dispatch.** On submit, if the input starts with `/`, it is normalised, split into `{name, args}`,
and resolved against `Mo` by exact `name`, any `alias`, or display name; the command's `type`
selects execute / render / prompt-expansion (`cli.js:60769`). Unknown commands fall through as plain
text. Markdown command discovery covers `~/.claude/commands`, every `<dir>/.claude/commands` up to
`$HOME`, plugin command dirs, and additional dirs (`oDb`, `cli.js:3858`).

**Built-in name sample** (113 `local`/`local-jsx` names extracted; not exhaustive):
`clear, compact, config, context, hooks, mcp, memory, model, permissions, resume, fork, branch, plan,
export, status, help, exit, login, logout, agents, skills, plugin, tasks, list-agents, rename, session,
effort, fast, brief, diff, add-dir, cd, install, update, upgrade, version, usage, theme, feedback,
background, remote-control, teleport, privacy-settings, terminal-setup, voice, workflows, design,
daemon, desktop, import, mobile, goal, loops, recap, stop, subtask, ultraplan, ultrareview`.
(`/agents` is a tombstone: it prints "the /agents wizard has been removed" and points at
`.claude/agents/` and `~/.claude/agents/`, `cli.js:6664`.)

---

## 6. MCP client

**Entry points**
- Config schemas: scopes `Hps = ["local","user","project","dynamic","enterprise","claudeai","managed","agent"]`,
  transports `s0E = ["stdio","sse","sse-ide","http","ws","sdk"]`, server config union `oze`, and the
  settings-level `mcpServers` object schema `a0E` (`cli.js:207`).
- Transport classes come from the bundled MCP SDK: `StdioClientTransport`, `SSEClientTransport`,
  `StreamableHTTPClientTransport`, and the `Client` with `_setupListChangedHandlers`
  (`cli.js:958`, `cli.js:18589`).
- Name mangling: `CO(server)` = ``mcp__${sanitize(server)}__`` and `vV(server,tool)` = that prefix + tool;
  `SC(name)` parses it back (`cli.js:207`).

**Config shape**

```
"mcpServers": {
  "github": { "type":"stdio", "command":"npx", "args":["-y","@modelcontextprotocol/server-github"],
              "env":{...}, "timeout": 300000, "alwaysLoad": true },
  "linear": { "type":"http", "url":"https://…", "headers":{...}, "timeout": 300000 },
  "legacy": { "type":"sse",  "url":"https://…/sse" }
}
```

Omitted `type` defaults to `stdio`; an unknown type is rejected with
`Valid types are: stdio, sse, http (or streamable-http), ws, sdk` (`cli.js:2191`). OAuth fields
(`clientId`, `callbackPort`, `authServerMetadataUrl`) live on http/sse entries (`cli.js:207`).
Config locations: project `.mcp.json` (approved via `enabledMcpjsonServers` /
`disabledMcpjsonServers` / `enableAllProjectMcpServers`), user+local scopes in the global
`~/.claude.json` (`kv()`/`CMg()`, `cli.js:119`), plugin manifests, and managed policy
(`allowedMcpServers`/`deniedMcpServers`, `allowManagedMcpServersOnly`).

**Discovery + lifecycle.** After `initialize` the client records server capabilities
(`tools/prompts/resources` with `listChanged`, `logging`, `sampling`, `elicitation`, `roots`,
`tasks`, `experimental`, `extensions`) and then:
- `listTools()` / `listPrompts()` / `listResources()` per capability, cursor-paginated, cached; called
  with `{cacheMode:"refresh"}` on invalidation (`cli.js:958`).
- `_setupListChangedHandlers` subscribes to `notifications/tools/list_changed`,
  `notifications/prompts/list_changed`, `notifications/resources/list_changed` and refreshes the cache.
- `tools/call` is the invocation path; a stale-tool-definition error triggers an auto-eviction of the
  `tools/list` cache and a retry (`cli.js:958`).
- Connection status union: `connected` / `cached` / `disabled` / `needs-auth` (+ transient failures);
  `Nf`/`sgo` gate on these (`cli.js:207`). Per-server default request timeout is 300000 ms (`aoy`,
  `cli.js:207`); `alwaysLoad` pins a server's tools into context.
- Each MCP tool becomes a normal tool named `mcp__<server>__<tool>` and can be permissioned
  individually (`mcp__server__tool`) or via server policy (`always_allow` / `always_ask` /
  `always_deny`, `cli.js:207`).

---

## 7. settings.json hierarchy (layers, precedence, keys)

**Entry points.** Precedence list `hbc()` = `["userSettings","projectSettings","localSettings","flagSettings","policySettings"]`
(`cli.js:12`). Loader `rjf(opts)` returns `{effective, sources[]}` where each source carries
`{source, settings, path}` (`cli.js:22119`). Per-source path resolver `ize(source, ctx)` (`cli.js:209`)
and the root schema factory `nfs(ctx)` (`cli.js:207`).

**Precedence and files** (later wins; managed/policy always wins):

| layer | file |
|---|---|
| userSettings | `~/.claude/settings.json` (`cowork_settings.json` in cowork mode) |
| projectSettings | `<project>/.claude/settings.json` |
| localSettings | `<project>/.claude/settings.local.json` |
| flagSettings | `--settings <path>` / SDK-supplied |
| policySettings | `<managedDir>/managed-settings.json` + `managed-settings.d/*.json` (Windows registry/HKLM on Win/WSL) |

`ize`/`Cln` implement this switch (`cli.js:209`); `policyHelper`/`policyHelpers` let an admin
*compute* managed settings at startup (managed sources only).

**Main keys** (from `nfs`, `cli.js:207`; `permissions` shape from `L3c`):
`$schema`, `model`, `fallbackModel`, `availableModels`, `enforceAvailableModels`, `env`,
`apiKeyHelper`/`awsCredentialExport`/`awsAuthRefresh`/`gcpAuthRefresh`, `permissions`
(`{allow, deny, ask, defaultMode, disableBypassPermissionsMode, additionalDirectories}`),
`hooks`, `disableAllHooks`, `allowManagedHooksOnly`, `allowedHttpHookUrls`, `httpHookAllowedEnvVars`,
`disableCommandPluginSources`, `mcpServers`, `enableAllProjectMcpServers`, `enabledMcpjsonServers`,
`disabledMcpjsonServers`, `allowedMcpServers`, `deniedMcpServers`, `allowManagedMcpServersOnly`,
`enabledPlugins`, `extraKnownMarketplaces`, `strictKnownMarketplaces`, `blockedMarketplaces`,
`strictPluginOnlyCustomization`, `skillOverrides`, `disableBundledSkills`,
`disableSkillShellExecution`, `sandbox`, `statusLine`, `subagentStatusLine`, `outputStyle`,
`cleanupPeriodDays`, `includeCoAuthoredBy`, `attribution`, `worktree`, `defaultShell`, `language`,
`autoCompactWindow`, `alwaysThinkingEnabled`, `effortLevel`, `fastMode`, `theme`, `spinnerVerbs`,
`forceLoginMethod`, `parentSettingsBehavior`, `wslInheritsWindowsSettings`.
`hooks` is literally `Jpe()` inside the settings schema: "Custom commands to run before/after tool
executions" (`cli.js:207`).

---

## Citations (all verified present on the cited line)

| subsystem | cite | what it proves |
|---|---|---|
| hooks | `cli.js:152` | exact 31-event enum `Fj` + `SessionEnd` reason enum |
| hooks | `cli.js:207` | matcher+hooks config, hook type union, `Jpe()` settings key |
| hooks | `cli.js:4130` | common output envelope + per-event `hookSpecificOutput` + allow/deny/ask/defer |
| hooks | `cli.js:21789` | hook stdin base `{session_id, transcript_path, cwd, permission_mode, agent_id, agent_type}` |
| hooks | `cli.js:21785` | exported per-event executors (`executePreToolHooks` … `executeWorktreeRemoveHook`) |
| hooks | `cli.js:2196` | how blockingError / updatedInput / permissionBehavior are applied |
| hooks | `cli.js:432` | policy gating (`disableAllHooks`, `allowManagedHooksOnly`) |
| sessions | `cli.js:21717` | `tU()` → `projectDir/<id>.jsonl` |
| sessions | `cli.js:2846` | `xS`/`eS`/`UC` project dir + `subagents/agent-<id>.jsonl` |
| sessions | `cli.js:167` | `zmo` path sanitiser, `Rv` truncation+hash |
| sessions | `cli.js:39` | `Sn()` = `CLAUDE_CONFIG_DIR` ?? `~/.claude` |
| sessions | `cli.js:5993` | fork writer: `forkedFrom:{sessionId,messageUuid}`, `parentUuid` rebuild |
| sessions | `cli.js:12` | `Wt()` current id; `eJi()` new id + `parentId`; `hbc()` precedence |
| sessions | `cli.js:148` | `--resume`/`--continue` argv classification |
| sessions | `cli.js:3483` | session listing sorted by mtime |
| subagents | `cli.js:554` | tool name constants `Agent` / `Task` |
| subagents | `cli.js:19174` | Agent tool object, input/output schemas, depth check, 1e5 result cap |
| subagents | `cli.js:3994` | `subagent_type:"fork"` inherits conversation + model |
| subagents | `cli.js:3100` | `r8e()` = handed-down `{systemPrompt,userContext,systemContext,toolUseContext,forkContextMessages}` |
| subagents | `cli.js:1200` | `EK()` max spawn depth default 3 |
| subagents | `cli.js:2853` | background `local_agent` task record shape |
| subagents | `cli.js:1866` | built-in agent definition shape |
| skills | `cli.js:1636` | `~/.claude/skills` root + skill-dir enumeration |
| skills | `cli.js:2190` | skills loaded as plugins (`loadSkillsAsPlugins`) |
| skills | `cli.js:440` | SKILL.md frontmatter key whitelist |
| skills | `cli.js:21304` | markdown-kind discovery (`OAp`) + `fFe`/`k7S` |
| slash | `cli.js:60769` | `/`-prefix parse + name/alias/display-name lookup |
| slash | `cli.js:4918` | `type:"local"` / `type:"local-jsx"` command objects |
| slash | `cli.js:5009` | `/clear` with aliases `reset,new` |
| slash | `cli.js:1722` | prompt-command object + `Base directory for this skill:` prefix |
| slash | `cli.js:3854` | `getPromptForCommand` variable expansion (`${CLAUDE_SKILL_DIR}` etc.) |
| MCP | `cli.js:207` | scopes, transport enum, stdio/http schema, `mcp__server__tool` naming, status union |
| MCP | `cli.js:2191` | default stdio + "Valid types are: stdio, sse, http…" |
| MCP | `cli.js:958` | SDK client, `_setupListChangedHandlers`, `listTools/listPrompts/listResources` |
| settings | `cli.js:12` | precedence order `hbc()` |
| settings | `cli.js:209` | per-layer file paths |
| settings | `cli.js:22119` | `rjf()` effective settings + source list |
| settings | `cli.js:207` | root settings schema keys (incl. `hooks`, `permissions`, `env`, `mcpServers`) |

## Open / unresolved

- The transcript *writer* for normal turns is spread across async storage backends; the `appendEntry`
  path is visible but the exact "one record per token-block" flush cadence was not pinned down (R1
  territory).
- `marble-origami-*` and `content-replacement` records are bookkeeping for output-side editing; their
  full semantics belong to R3 (context management), not documented here.
- Hook `terminalSequence` OSC allowlist is documented in the schema text but not exercised; no test path found.
- The 113 slash-command names are those declared as inline `local`/`local-jsx` objects plus bundled
  prompt commands seen in the registry; MCP prompts and plugin commands are dynamic and not enumerable statically.
