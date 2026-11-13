# R2 — Claude Code 2.1.231: tool registry, tool interface, permission model

Source of truth: `research/claude-code/cli.js` (Bun CJS bundle, 62,954 lines) recovered from
Claude Code **2.1.231**; contract cross-check: `/opt/homebrew/lib/node_modules/@anthropic-ai/claude-code/sdk-tools.d.ts`
(same package version 2.1.231). Every claim below carries a `cli.js:<line>` cite that was checked by
reading only that identifier / bounded window — no line was copied wholesale.

## 1. How tools are built and registered

Tools are **factory objects**: `Oi(e) = Object.defineProperties({...En_, userFacingName:()=>e.name}, descriptors(e))`
(`cli.js:430`). `En_` supplies the defaults every tool inherits: `isEnabled:()=>!0`,
`isConcurrencySafe:()=>!1`, `isReadOnly:()=>!1`, `isDestructive:()=>!1`,
`checkPermissions:()=>Promise.resolve({behavior:"allow",updatedInput:e})`, `toAutoClassifierInput:()=>""`,
`userFacingName:()=>""` (`cli.js:430`). So *unset* means "mutating, not concurrency-safe, auto-allow at
the tool layer" — the blanket allow is then constrained by the central rule/mode engine (§4).

The registry is assembled in three stages:

1. **`getAllBaseTools` (`zK`, `cli.js:21302`)** returns a literal array of built-in tool objects,
   with feature/platform conditionals inline (e.g. Bash only when `Cf()` — true on macOS/Linux,
   Windows needs git-bash, `cli.js:1238`; task tools when `sN()` — `CLAUDE_CODE_ENABLE_TASKS!==false`,
   `cli.js:3409`; LSP behind `fn("true")`; PowerShell only when `MX()`).
2. **`getTools` (`GG`, `cli.js:21302`)** drops tools whose `isEnabled()` is false, strips REPL-only
   tools in REPL mode, and applies deny rules (`filterToolsByDenyRules`/`Gce`, same line); a
   `CLAUDE_CODE_SIMPLE` path exposes only a small core (Read/Edit/Write plus Bash or PowerShell;
   coordinator mode adds Agent/TaskStop/SendMessage; REPL mode substitutes REPL for Bash).
3. **`assembleToolPool` (`Yne`, `cli.js:21302`)** = `getTools` ∪ skills' declared tools
   (`.claude/skills` `allowed-tools`), each filtered by deny rules, sorted by name. MCP tools are merged
   into the session tool list by the MCP connection layer (described in §7), and the same deny filter drops
   MCP tools whose `mcpInfo.effectiveMaxPermission==="blocked"`.

### 1.1 Base tool inventory — **70 named built-ins**

Counted by expanding `getAllBaseTools` (`cli.js:21302`); the array indirects some entries through
`wCf` (3 memory tools, `cli.js:19532`), `a7S` (3 cron tools, `cli.js:19814`), `l7S` (9 self-hosted
runner tools, `cli.js:19815`), and tool-returning helpers `f$a()`/`g7S()`/`oUr`/`T1f`/`w1f`/`E1f`/`C1f`.
Exact command (run inside `research/claude-code/`; this is the script I ran, saved as `/tmp/verify-tools.py`):

```bash
python3 - <<'PY'
import re
src=open('cli.js').read()
p=src.index('return[',src.index('function zK()'))+6
d=0
for i in range(p,len(src)):
    if src[i]=='[': d+=1
    elif src[i]==']':
        d-=1
        if d==0: arr=src[p+1:i]; break
EXP={'wCf':['dCf','yCf','TCf'],'a7S':['gqS','bqS','TqS'],
     'l7S':['Skf','Tkf','Ekf','Akf','Rkf','Pkf','Dkf','Nkf','Ukf'],
     'f$a()':['vIf'],'g7S()':['PIf'],'oUr':['RjS'],'T1f':['h9S'],
     'w1f':['w9S'],'E1f':['A9S'],'C1f':['x9S']}
M={'sgi':'Agent','M0f':'TaskOutput','Hd':'Bash','rce':'Glob','bhe':'Grep','UG':'ExitPlanMode',
'dE':'Read','VM':'Edit','ZO':'Write','TIe':'NotebookEdit','dCf':'hr','yCf':'memory_read',
'TCf':'memory_write','Xce':'WebFetch','Y0f':'TodoWrite','q0f':'ReportFindings','$0f':'WebSearch',
'mgi':'TaskStop','JBr':'AskUserQuestion','XCf':'SendFeedback','ZBr':'Skill','Lhi':'EnterPlanMode',
'f7S':'DesignSync','h7S':'Projects','I0f':'ScheduleWakeup','k2a':'REPL','gqS':'CronCreate',
'bqS':'CronDelete','TqS':'CronList','WEf':'ShowOnboardingRolePicker','zEf':'ReadNotifications',
'h0f':'SendUserMessage','u7S':'SendUserFile','d7S':'propose_skills','p7S':'ProposeGoal',
'Jz':'ListMcpResourcesTool','jq':'ReadMcpResourceTool','Yce':'ReadMcpResourceDirTool',
'nFa':'WaitForMcpServers','vIf':'SendMessage','PIf':'SendFile','PAf':'EnterWorktree',
'BAf':'ExitWorktree','Z2a':'LSP','VAf':'TaskCreate','XAf':'TaskGet','tkf':'TaskUpdate',
'skf':'TaskList','Skf':'self_hosted_runner_get_pool','Tkf':'self_hosted_runner_list_sessions',
'Ekf':'self_hosted_runner_list_runners','Akf':'self_hosted_runner_list_secrets',
'Rkf':'self_hosted_runner_read_health','Pkf':'self_hosted_runner_read_metrics',
'Dkf':'self_hosted_runner_requeue_session','Nkf':'self_hosted_runner_spawn_local',
'Ukf':'self_hosted_runner_tail_log','h9S':'RemoteTrigger','w9S':'SearchMcpRegistry',
'A9S':'SuggestConnectors','x9S':'ListConnectors','k1f':'PushNotification','A1f':'Monitor',
'R1f':'EndConversation','x1f':'Artifact','L1f':'ListAgents','N1f':'ShareOnboardingGuide',
'RjS':'Workflow','tFa':'RefreshMcpTools','nRn':'ToolSearch'}
toks=re.findall(r'[A-Za-z_$][\w$]*(?:\(\))?',arr); names=[]
for t in toks:
    for x in EXP.get(t,[t]):
        if x in M and M[x] not in names: names.append(M[x])
print('BASE TOOL COUNT =',len(names))
for n in names: print(n)
PY
```

Output: `BASE TOOL COUNT = 70` followed by exactly the 70 names in the table below.
Read-only (`RO`) / concurrency-safe (`CS`) values are the tools' own declarations extracted from each
tool object in the same source region (tools that do not override a field inherit `false`, `cli.js:430`).
`cond` = computed per input.

| # | tool | one-line purpose (from the tool's own `searchHint`/description) | RO | CS | def line |
|---|---|---|---|---|---|
| 1 | `Agent` | delegate work to a subagent (alias `Task`) | Y | Y | 19174 |
| 2 | `TaskOutput` | read output/logs from a background task | Y | cond | 19298 |
| 3 | `Bash` | execute shell commands | cond | cond | 18753 |
| 4 | `Glob` | find files by name pattern or wildcard | Y | Y | 2395 |
| 5 | `Grep` | search file contents with regex (ripgrep) | Y | Y | 2399 |
| 6 | `ExitPlanMode` | present plan for approval and start coding | N | Y | 6631 |
| 7 | `Read` | read files, images, PDFs, notebooks | Y | Y | 3864 |
| 8 | `Edit` | modify file contents in place | N | N | 2392 |
| 9 | `Write` | create or overwrite files | N | N | 2395 |
| 10 | `NotebookEdit` | edit Jupyter notebook cells (.ipynb) | N | N | 2842 |
| 11 | `hr` | list connected project-memory stores + documents | Y | Y | 19512 |
| 12 | `memory_read` | read a document from a memory store | Y | Y | 19524 |
| 13 | `memory_write` | save a document to a memory store | N | N | 19527 |
| 14 | `WebFetch` | fetch and extract content from a URL | Y | Y | 18958 |
| 15 | `TodoWrite` | manage the session task checklist | N | N | 19500 |
| 16 | `ReportFindings` | report code-review findings as a structured list | Y | Y | 19322 |
| 17 | `WebSearch` | search the web for current information | Y | Y | 19313 |
| 18 | `TaskStop` | kill a running background task (aliases `KillShell`,`KillBash`) | N | Y | 19195 |
| 19 | `AskUserQuestion` | prompt the user with a multiple-choice question | Y | Y | 18838 |
| 20 | `SendFeedback` | draft product/model-behavior feedback report queue | N | Y | 19559 |
| 21 | `Skill` | invoke a slash-command skill | N | N | 18940 |
| 22 | `EnterPlanMode` | switch to plan mode to design an approach | Y | Y | 18930 |
| 23 | `DesignSync` | sync design-system components to claude.ai/design | cond | N | 19835 |
| 24 | `Projects` | read/write the attached claude.ai project | cond | N | 19853 |
| 25 | `TaskCreate` | create a task in the task list | N | N | 19683 |
| 26 | `TaskGet` | retrieve a task by ID | Y | Y | 19705 |
| 27 | `TaskUpdate` | update a task | N | Y | 19780 |
| 28 | `TaskList` | list all tasks | Y | Y | 19813 |
| 29 | `Artifact` | render HTML/Markdown to a claude.ai web page | cond | cond | 20124 |
| 30 | `LSP` | code intelligence (definitions, refs, symbols, hover) | Y | Y | 19578 |
| 31 | `EnterWorktree` | create an isolated git worktree and switch into it | N | N | 19614 |
| 32 | `ExitWorktree` | exit worktree session, return to original directory | N | N | 19644 |
| 33 | `SendMessage` | send messages to agent teammates | cond | N | 19930 |
| 34 | `SendFile` | send files to another Claude Code session | N | N | 19958 |
| 35 | `ListAgents` | list agents you can SendMessage to (alias `ListPeers`) | Y | Y | 20168 |
| 36 | `ShareOnboardingGuide` | upload ONBOARDING.md, get a team share link | N | N | 20170 |
| 37 | `REPL` | execute JavaScript with programmatic tool access | N | N | 19283 |
| 38 | `Workflow` | orchestrate subagents with deterministic JS workflow | N | Y | 19136 |
| 39 | `CronCreate` | schedule a recurring or one-shot prompt | N | N | 19814 |
| 40 | `CronDelete` | cancel a scheduled cron job | N | N | 19814 |
| 41 | `CronList` | list active cron jobs | Y | Y | 19814 |
| 42 | `self_hosted_runner_get_pool` | read environment aggregates + queue counts | Y | Y | 19815 |
| 43 | `self_hosted_runner_list_sessions` | list queued/assigned sessions in an environment | Y | Y | 19815 |
| 44 | `self_hosted_runner_list_runners` | list registered runners for an environment | Y | Y | 19815 |
| 45 | `self_hosted_runner_list_secrets` | list environment secrets (metadata only) | Y | Y | 19815 |
| 46 | `self_hosted_runner_read_health` | probe local runner `/healthz` | Y | Y | 19815 |
| 47 | `self_hosted_runner_read_metrics` | read runner Prometheus gauges from `/metrics` | Y | Y | 19816 |
| 48 | `self_hosted_runner_requeue_session` | requeue a stuck session onto another runner | N | N | 19816 |
| 49 | `self_hosted_runner_spawn_local` | start a local runner process for try-it-out | N | N | 19816 |
| 50 | `self_hosted_runner_tail_log` | tail runner log with secret redaction | Y | Y | 19816 |
| 51 | `ScheduleWakeup` | schedule a one-shot wakeup prompt | N | N | 19294 |
| 52 | `RemoteTrigger` | manage scheduled cloud agent routines | cond | Y | 19824 |
| 53 | `SearchMcpRegistry` | discover MCP connectors by keyword | Y | Y | 19828 |
| 54 | `SuggestConnectors` | resolve connector payloads by `directoryUuid` | Y | Y | 19828 |
| 55 | `ShowOnboardingRolePicker` | show the Cowork onboarding role picker | Y | Y | 19195 |
| 56 | `ReadNotifications` | read queued external notifications | Y | Y | 19195 |
| 57 | `ListConnectors` | list the user's installed MCP connectors | Y | Y | 19828 |
| 58 | `Monitor` | watch a process/log/command, stream stdout lines | N | N | 19159 |
| 59 | `SendUserMessage` | send a message to the user (alias `Brief`) | Y | Y | 19201 |
| 60 | `SendUserFile` | deliver files (screenshots, reports, artifacts) | Y | Y | 19828 |
| 61 | `propose_skills` | propose skills from recurring procedures | Y | Y | 19834 |
| 62 | `ProposeGoal` | propose a session goal condition for approval | Y | N | 19835 |
| 63 | `PushNotification` | terminal/mobile notification to the user | Y | Y | 19835 |
| 64 | `EndConversation` | end the conversation (abuse / explicit request only) | Y | N | 19896 |
| 65 | `ListMcpResourcesTool` | list resources from connected MCP servers | Y | Y | 981 |
| 66 | `ReadMcpResourceTool` | read a specific MCP resource by URI | Y | Y | 18497 |
| 67 | `ReadMcpResourceDirTool` | list children of an MCP directory resource | Y | Y | 18493 |
| 68 | `RefreshMcpTools` | re-sync tool lists from connected MCP servers | Y | Y | 19578 |
| 69 | `ToolSearch` | deferred-tool discovery (name / `mcp__server` prefix / `+required` keyword scoring over name+description+searchHint) | Y | Y | 2989 |
| 70 | `WaitForMcpServers` | wait until pending MCP servers have connected | Y | N | 19578 |

Tools built by the same factory but **not** in `getAllBaseTools` (registered contextually, not part of
the model's default pool): `StructuredOutput` (`cli.js:1247`, structured-output sessions),
`ClaudeDesign` (`cli.js:19852`, design plugin), `ObserverReport` (`cli.js:19896`), `TestingPermission`
(`cli.js:19500`, test-only), `SuggestPluginInstall`/`SuggestSkills` (`cli.js:18816/18818`, UI cards),
`mcp` template + synthesized `mcp__<server>__authenticate` / `__complete_authentication`
(`cli.js:18485`), self-hosted-runner/plugin skill tools that are appended dynamically (`cli.js:21302`).

## 2. The common tool object interface (and what the runtime does with each member)

| member | shape | runtime use |
|---|---|---|
| `name` | string | tool identity; permission rule subject; model-facing name (`cli.js:430`) |
| `aliases` | string[] | resolved by `$a(tool,name)` = `name===t || aliases.includes(t)` (`cli.js:430`); lets permissions and transcripts use legacy names (e.g. `TaskOutput` accepts `BashOutputTool`/`AgentOutput`, `cli.js:19298`; `Agent` accepts `Task`, `cli.js:19174`) |
| `searchHint` | short string | indexed by `ToolSearch` to score deferred tools alongside description/name tokens (`cli.js:2989`) |
| `inputSchema` | zod getter | parsed/validated before permission check and before execution: `inputSchema.parse` in the central check (`cli.js:18828`), `safeParse` in executor/dispatcher (`cli.js:3407`), coercion helper `sX` (`cli.js:430`) |
| `outputSchema` / `inputJSONSchema` | schema | result validation/telemetry; MCP tools supply raw JSON-Schema form (`cli.js:18593`) |
| `description()` / `prompt()` | async string | model-facing docs, cached per session (both used by `ToolSearch` describe call, `cli.js:2989`) |
| `call(input, ctx, canUseTool, parentMsg, toolUseID)` | async | executes after permission pass; result mapped via `mapToolResultToToolResultBlockParam` (`cli.js:2203`) |
| `checkPermissions(input, ctx)` | `{behavior: allow/ask/deny/passthrough, updatedInput?, message?, decisionReason?, suggestions?}` | invoked by the central pipeline; a `deny` short-circuits, `ask` becomes a prompt unless mode/rules allow (`cli.js:18828`) |
| `validateInput(input, ctx)` | `{result:boolean, message?, errorCode?, behavior?}` | invoked *before* permissions in the executor; `result:false` becomes an errored tool_result (`cli.js:2202`) |
| `isEnabled()` | boolean | filtered out of the pool when false (`cli.js:21302`) |
| `isReadOnly(input)` | boolean | plan-mode gating, sandbox auto-allow, concurrency derivation for Bash (`cli.js:18753`, `cli.js:18828`) |
| `isConcurrencySafe(input)` | boolean | scheduler: a queued tool runs only if every currently executing tool is concurrency-safe (`canExecuteTool`, `cli.js:3407`); Bash derives it from read-only (`cli.js:18753`) |
| `isDestructive(input)` | boolean | auto-mode/MCP policy floors (`cli.js:18828`); MCP maps `annotations.destructiveHint` (`cli.js:18593`) |
| `isOpenWorld()` | boolean | classifier/telemetry; MCP maps `annotations.openWorldHint` |
| `toAutoClassifierInput(input)` | string | compact representation for the `auto`-mode classifier (`cli.js:4564`) |
| `requiresUserInteraction()` | boolean | forces an `ask` even in bypass/auto (`cli.js:18828`); e.g. ExitPlanMode (`cli.js:6631`) |
| `ruleContentField` | string (`file_path`,`command`,`url`) | names the input field that permission-rule content matches; skipped as a rule field (`cli.js:18826`) |
| `preparePermissionMatcher(input)` | async `(ruleContent)=>boolean` | custom rule-content matcher; Bash builds one from the parsed command incl. `xargs` (`cli.js:18753`) |
| `maxResultSizeChars` (+ `persistenceThresholdCeiling`, `skipAggregateToolResultBudget`) | number | oversized results are persisted to a file and replaced by a preview (`cli.js:1643`, `cli.js:2203`) |
| `strict` | boolean | schema strictness for input validation (e.g. Bash/Edit, `cli.js:18753`) |
| `shouldDefer` / `alwaysLoad` | boolean | deferred (ToolSearch-loaded) vs always-present tool (`cli.js:2989`, `cli.js:18593`) |
| `userFacingName(input)` | string | UI label; default is `name` (`cli.js:430`) |
| `renderToolUseMessage` / `renderToolResultMessage` | UI renderers | transcript rendering only (102/104 occurrences) |
| `suppressAlwaysAllowRule(input)`, `ignoresWholeToolAllowRule(input)` | boolean | forbids "always allow" for a call; used by runner requeue (`cli.js:19816`) and surfaced in the approval request (`cli.js:18845`) |
| `isMcp` + `mcpInfo{serverName,toolName,scope,effectiveMaxPermission,...}` | MCP metadata | MCP identity/naming and permission ceilings (§7) |
| `getPath(input)`, `coerceInput(input)`, `stripForStorage(result)`, `mapToolResultToToolResultBlockParam` | helpers | file-path extraction for rules, input normalization, storage trimming, result block conversion |

## 3. Permission modes

Mode enum is defined once, with descriptions, in the SDK-facing schema (`cli.js:61003`):
`["default","acceptEdits","bypassPermissions","plan","dontAsk","auto"]`.

| mode | behaviour (verified) |
|---|---|
| `default` | standard: rule engine + tool `checkPermissions` decide; unresolved asks prompt the user (`cli.js:61003`, `cli.js:18828`) |
| `acceptEdits` | file-edit tools auto-allow when the path is in the working dir/additional dirs: `if(r.mode==="acceptEdits"&&d)return{behavior:"allow"...}` where `d=Zae(path,ctx,dirs)` (`cli.js:21746`); used as the "would be allowed" fast-path in auto mode (`cli.js:18828`) |
| `bypassPermissions` | all asks auto-allow unless a protected condition applies (`cli.js:18828`); requires consent/`allowDangerouslySkipPermissions` and is refused for root (`cli.js:62104`); can be disabled by settings `permissions.disableBypassPermissionsMode:"disable"` or org flag (`cli.js:572`) |
| `plan` | read-only tools pass; writes ask ("Cannot write to X while in plan mode", `cli.js:21746`); MCP non-read-only tools ask ("Cannot call X while in plan mode", `cli.js:18828`); ExitPlanMode asks "Exit plan mode?" and restores `prePlanMode` on approval (`cli.js:6631`) |
| `dontAsk` | no prompts: an ask becomes `deny` with message "Permission to use X has been denied because Claude Code is running in don't ask mode..." (`cli.js:18828` + `zBr` at `cli.js:21399`) |
| `auto` | model classifier decides; safe/acceptEdits-equivalent calls auto-allow, safety checks and ask-rules still prompt or fall back to ask (`cli.js:18828`) |

Mode resolution precedence (`xWu`, `cli.js:572`): CLI `--dangerously-skip-permissions` / `--permission-mode`
> agent frontmatter `permissionMode` > settings `permissions.defaultMode`; `CLAUDE_CODE_SUBPROCESS_ENV_SCRUB`
forces `default`; bypass mode can be disabled/require consent. `S$a` (`cli.js:21303`) is the CLI-facing
wrapper that also emits notifications when a mode is downgraded. Per-MCP-server overrides live in
`toolPermissionContext.mcpPermissionModeOverrides` and are applied by `fnt` (`cli.js:806`).

## 4. Where the decision is made

Central entry is `hasPermissionsToUseTool` (`gI`, `cli.js:18828`) / `hasPermissionsToUseToolWithSink`
(`$Zt`). Its synchronous-ish core is `T4S` (`cli.js:18828`), in this order:

1. abort check;
2. **deny rule for the whole tool** → `{behavior:"deny", decisionReason:{type:"rule"}}`
   (`getDenyRuleForTool`/`A$`, rules collected from five settings layers by `collectRules`/`qBr`, `cli.js:18826`);
3. **deny rule on an input field** (`getInputParamRule`/`FFn`, e.g. `Bash(command:rm *)`,
   `Read(file_path:secrets/**)`) → deny with the rule echoed back (`cli.js:18828`);
4. **ask rule for the whole tool** (`getAskRuleForTool`/`M2e`) → `ATf` builds an `ask` (unless Bash is
   sandboxed and auto-allowed, `cli.js:18828`);
5. **tool-specific** `checkPermissions(input, ctx)`; `deny` short-circuits, `passthrough` continues;
6. **ask rule on an input field** → ask;
7. `requiresUserInteraction()` → ask; MCP `effectiveMaxPermission==="ask"` → ask;
8. **mode gate**: `bypassPermissions` (or `plan` with bypass available) converts remaining asks to allow
   unless blocked by safety checks; `dontAsk` converts them to deny (all `cli.js:18828`).

`F0t` (`checkRuleBasedPermissions`, `cli.js:18828`) is the same pipeline without the bypass/dontAsk mode
gates — used where only rules matter. The tool-level `checkPermissions` implementations are where
domain logic lives: file tools funnel through `ZCt` (`cli.js:21746`), Bash through `IFn` (`cli.js:18765`),
ExitPlanMode/EnterPlanMode at `cli.js:6631`/`cli.js:18930`, MCP tools at `cli.js:18593`.

Outcome schema (`PermissionResult`, `cli.js:61003`): either `{behavior:"allow", updatedInput?, updatedPermissions?, toolUseID?, decisionClassification?}`
or `{behavior:"deny", message, interrupt?, toolUseID?, decisionClassification?}`; internal code also uses
`passthrough` and `defer` (hook deferral, `cli.js:61003`, `cli.js:2196`). `decisionReason.type` values
observed in the bundle: `rule`, `mode`, `other`, `safetyCheck`, `sandboxOverride`, `workingDir`,
`asyncAgent`, `hook`, `classifier`, `subcommandResults`.

Host override: SDK hosts can supply `canUseTool`; the CLI sends a `can_use_tool` control request carrying
tool name/input/suggestions/blockedPath/decisionReason/matched ask rule and the host's answer replaces the
local dialog (`cli.js:22113`). PreToolUse hooks are a third decider: hook `allow`/`ask`/`deny`/`defer`
results are merged in `cli.js:2196`; a hook `ask` cannot be bypassed by the auto classifier (`hookAskFloor`).

Rule matching is **two different matchers**, which matters for interop:

* **tool-name + simple glob** (`cg`/`Xps`, `cli.js:207`): a rule string parses to `toolName(ruleContent)`
  (`Tool(*)` → whole tool); `*` expands to `.*` and the match is anchored — this is what matches
  `Bash(command:git *)`, `WebFetch(url:https://example.com/*)`.
* **path ignore-file semantics** for file tools (`jR`/`t3a`, `cli.js:21746`): path rules are matched with
  gitignore-style pattern maps; deny is checked before ask before allow, and two rules on the same path
  resolve by specificity.

Rules come from layers; the source list is
`PERMISSION_RULE_SOURCES = ["userSettings","projectSettings","localSettings","flagSettings","policySettings",
"cliArg","command","session","toolsNarrowing","mcpServerPolicy"]` (`cli.js:18826`, base settings names at
`cli.js:207`). Approving "always allow" produces a `PermissionUpdate`
(`addRules`/`replaceRules`/`removeRules`/`setMode`/`addDirectories`/`removeDirectories`) with a
`destination` of `userSettings|projectSettings|localSettings|session|cliArg` (`cli.js:61003`);
`stripWholeToolGrantsForAsk`/`S$e` prevents an always-allow from silently erasing an ask rule
(`cli.js:18826`).

## 5. How a denial reaches the model

A denied call is not thrown away; it becomes an **errored `tool_result` in the next user turn**, plus an
optional `toolDenialKind` recorded on the message (`cli.js:3407` for user-interrupt; `toolDenialKind`
plumbed through the transcript at `cli.js:4561`). Denial texts are fixed strings:

* interactive reject: "The user doesn't want to proceed with this tool use. The tool use was rejected
  (eg. if it was a file edit, the new_string was NOT written to the file). STOP what you are doing and
  wait for the user to tell you how to proceed." (`cli.js:21667`, `Vhe`/`F$e`);
* permission/rule deny: "...Permission for this tool use was denied... Try a different approach or report
  the limitation to complete your task." (`cli.js:21667`, `ZPe`/`qhi`);
* non-interactive (async agent / no prompt surface): "Permission for this tool use was denied: it requires
  interactive approval, and permission prompts are not available in this session... Do not claim it
  succeeded, and do not retry it..." (`cli.js:21399`, `ITf`);
* `dontAsk` deny: "...running in don't ask mode..." (`cli.js:21399`, `zBr`);
* denied plan: `B$n` at `cli.js:21667`.

The pipeline returns `behavior:"ask"` with the user's rejection message from the dialog bridge
(`onReject` → `{behavior:"ask",message:`${qhi}${feedback}`}`, `cli.js:19167`), and the executor turns the
refusal into `content:[{type:"tool_result",content:<message>,is_error:true}]`; the model therefore learns
why and is instructed not to retry blindly.

## 6. Bash: parsing, classification, read-only

`Bash` is the most safety-sensitive built-in (`cli.js:18753`). It uses a **real bash AST parser**
(`Q3().parse`, `parseCommand` at `cli.js:18757`; splitting/normalization in `Urt`/`cTt`, `cli.js:671`)
rather than regex heuristics:

* `cTt` decomposes a script into simple commands and flags "too-complex" cases: subshells, `&`
  backgrounding, unquoted variable expansion, lone surrogates/control chars/Unicode whitespace, escaped
  whitespace, zsh-specific expansions (`~[`, `=cmd`, `<N-M>`), brace+quote obfuscation, parse
  abort/over-length (`cli.js:671`; per-command AST children incl. redirects/env vars are visited).
* compound-command safety: a compound that mixes `cd` with `git` returns `passthrough` ("requires
  permission checks"), as does a `.git` file/symlink it cannot verify; bare-repo indicators
  (HEAD/objects/refs outside `.git`) force git approval, and sandboxed git outside the original cwd also
  needs approval (`cli.js:18741`).
* **read-only classification** `TSf`/`OBr` (`cli.js:18741`, `cli.js:18765`): a command is read-only only
  if every simple command in the compound is safe, redirects are limited to safe ops/targets (e.g.
  `/dev/null`, no `/dev/tcp|udp`), env assignments are allowlisted, and argv passes a per-command option
  whitelist. The core read-only command set is `ls,cat,head,tail,wc,stat,grep,egrep,fgrep,diff,du,df,echo,
  strings,hexdump,od,nl,cut,column,tr,tac,rev,cmp,basename,dirname,realpath,readlink,sha256sum,sha1sum,md5sum,cd`
  (`V$S`, `cli.js:18741`), plus arg-shape rules (`W$S`, `cli.js:18738`) that reject write-ish flags
  (e.g. `find -delete/-exec`, `git -c/--exec-path/--config-env`); `rm`/`rmdir`/`sed` are in an explicit
  mutating set (`_Sf`) and `sed -i` is parsed separately by `LZt` (`cli.js:18741`).
* `Bash.isReadOnly(input)` is literally "does the classifier return allow" — `TSf(...).behavior==="allow"`
  (`cli.js:18753`); `isConcurrencySafe` returns that same value (`cli.js:18753`). Mutating or unparseable
  commands are therefore *both* non-read-only and serialized.
* `Bash.checkPermissions` (`cli.js:18765`) runs rule matching in two passes — **exact** argv match and
  **prefix** match (`fct(e,t,"exact"|"prefix")`, `cli.js:18760`), so `Bash(git status:*)`-style prefix
  rules approve `git status`, `git status -s`, etc., while exact rules match one argv; the matcher built by
  `preparePermissionMatcher` (`cli.js:18753`) additionally understands `xargs`. Deny beats ask beats allow.
  Sandbox interplay: `MG` decides sandboxability (`cli.js:18765`), `dangerouslyDisableSandbox` escalates to
  an `ask` with `decisionReason:{type:"sandboxOverride"}` (`cli.js:18753`), and an agent can be clamped to
  fixed command forms via `bashCommandClamp` (deny by default, `cli.js:18765`).
* Windows `PowerShell` has its own AST + path-argument validator (compound `cd`/location changes force ask,
  `cli.js:3758`), i.e. the same design with a different parser.

## 7. MCP tools registered alongside built-ins

MCP tools are built at runtime from each server's `tools/list`, not statically declared:

* The template `AFr = Oi({name:"mcp", isMcp:!0, ...})` (`cli.js:18485`) is spread per tool and renamed
  `mcp__<server>__<tool>` (`vV`/`SC`/`pW`, `cli.js:207`), with `mcpInfo:{serverName,scope,serverType,toolName,
  effectiveMaxPermission,...}` (`cli.js:18593`, `cli.js:18600`).
* MCP annotations drive the tool interface: `isReadOnly`/`isConcurrencySafe` ← `annotations.readOnlyHint`,
  `isDestructive` ← `destructiveHint`, `isOpenWorld` ← `openWorldHint`; `_meta["anthropic/maxResultSizeChars"]`,
  `_meta["anthropic/requiresUserInteraction"]`, `_meta["anthropic/searchHint"]`, `_meta["anthropic/alwaysLoad"]`
  override defaults (`cli.js:18593`).
* MCP `checkPermissions` returns `passthrough` (let rules/mode decide) or `ask` when the tool requires user
  interaction; it offers an `addRules` suggestion on approval (`cli.js:18593`).
* Per-server policy can clamp permissions: server config `permission_policy: always_allow|always_ask|always_deny`
  is compiled into rules for `mcp__server__tool` (`Kps`, `cli.js:207`), and reflected as
  `effectiveMaxPermission` (`blocked` tools are filtered out of the pool by `filterToolsByDenyRules`,
  `cli.js:21302`); per-server mode overrides are applied in `fnt` (`cli.js:806`).
* The pool is hydrated asynchronously: MCP connections call `getMcpToolsCommandsAndResources` and apply
  tools/commands/resources into app state (`cli.js:23592`, `cli.js:61003`); `RefreshMcpTools` (`cli.js:19578`)
  and `WaitForMcpServers` (`cli.js:19578`) are the model-visible recovery/waiter tools, and `ToolSearch`
  can defer-load MCP tools (`cli.js:2989`).
* Unauthenticated servers still expose two synthesized tools, `mcp__<server>__authenticate` and
  `mcp__<server>__complete_authentication` (`cli.js:18485`, `cli.js:18493`), both `isMcp`, non-read-only,
  non-concurrency-safe.

## 8. Contract cross-check vs `sdk-tools.d.ts`

The published `ToolInputSchemas` union has **45 input types** (46 union members counting the generated
self-reference `ToolOutputSchemas`). Mapping is 1:1 to harness tools and all are documented above:
`AgentInput→Agent, BashInput→Bash, TaskOutputInput→TaskOutput, ExitPlanModeInput→ExitPlanMode,
FileEditInput→Edit, FileReadInput→Read, FileWriteInput→Write, GlobInput→Glob, GrepInput→Grep,
TaskStopInput→TaskStop, ListMcpResourcesInput→ListMcpResourcesTool, RefreshMcpToolsInput→RefreshMcpTools,
McpInput→generic mcp__* tool, NotebookEditInput→NotebookEdit, ReadMcpResourceDirInput→ReadMcpResourceDirTool,
ReadMcpResourceInput→ReadMcpResourceTool, ReportFindingsInput→ReportFindings, TodoWriteInput→TodoWrite,
WebFetchInput→WebFetch, WebSearchInput→WebSearch, AskUserQuestionInput→AskUserQuestion,
SendFeedbackInput→SendFeedback, ClaudeDesignInput→ClaudeDesign, ProjectsInput→Projects,
EnterPlanModeInput→EnterPlanMode, TaskCreateInput/TaskGetInput/TaskUpdateInput/TaskListInput→Task*,
REPLInput→REPL, WorkflowInput→Workflow, CronCreateInput/CronDeleteInput/CronListInput→Cron*,
ScheduleWakeupInput→ScheduleWakeup, RemoteTriggerInput→RemoteTrigger,
ShowOnboardingRolePickerInput→ShowOnboardingRolePicker, ReadNotificationsInput→ReadNotifications,
MonitorInput→Monitor, ProposeSkillsInput→propose_skills, ProposeGoalInput→ProposeGoal,
ArtifactInput→Artifact, PushNotificationInput→PushNotification, EnterWorktreeInput/ExitWorktreeInput→Worktree`.
Harness tools **not present** in the published d.ts (they are Claude-Code-internal or plugin/UX specific):
`Skill, ToolSearch, WaitForMcpServers, SendMessage, SendFile, SendUserMessage, SendUserFile, ListAgents,
ListConnectors, SearchMcpRegistry, SuggestConnectors, DesignSync, EndConversation, ObserverReport, LSP,
ShareOnboardingGuide, hr, memory_read, memory_write, self_hosted_runner_* (9), StructuredOutput,
TestingPermission, SuggestPluginInstall, SuggestSkills`, plus all dynamic MCP/plugin-skill tools. No d.ts
input type is absent from the harness.

## 9. Notes for xMonkey (interop takeaways)

1. A tool is a declarative object; permission logic is **not** per-tool ad hoc — it is one pipeline with
   two injection points (`checkPermissions`, `validateInput`) and one override hook (`canUseTool`).
2. Rules must support both `Tool(*)` and `Tool(field:pattern)`, with `*` = glob, plus per-tool custom
   matchers for argv-style tools (Bash prefix/`xargs`) and path-specific matchers for file tools.
3. Modes are few but orthogonal to rules: rules produce allow/ask/deny; the mode gate then decides whether
   an `ask` becomes a prompt, an auto-allow, or a deny (`dontAsk`).
4. Denials must be returned as `is_error` tool results carrying a human-readable reason, never as a thrown
   tool failure, so the model can adapt.
5. Concurrency is derived per call from `isConcurrencySafe`; read-only classification is the gate for
   parallel Bash and for plan-mode/sandbox allowances.

## Unresolved / caveats

* Minified identifiers are cited by line, not name: several symbol names above are the bundle's mangled
  names (`zK`, `GG`, `T4S`, `gI`, `ZCt`, `IFn`); the meaning was derived from call sites and export maps.
* `auto` mode's classifier prompt and thresholds live in a large unmapped region; only the fast-path
  (acceptEdits equivalence), the ask/floors logic, and circuit-breaking entry points (line 18828) are
  characterised here — full classifier internals belong to a separate pass.
* The `ToolOutputSchemas` union in the d.ts includes a generated self-reference member (46 vs 45 inputs);
  `McpInput` is a single generic shape for all `mcp__*` tools.
* Base-registry count is the *static* array (70). The effective model-facing pool differs per session by
  `isEnabled()`, deny rules, REPL/simple mode, skills, and MCP servers (`cli.js:21302`).
