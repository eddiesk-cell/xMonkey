# Parity with Claude Code / Claude Desktop

An honest inventory. This document exists because "we matched everything" is a
claim that should be checkable, not asserted.

## What was actually examined

| target | size | examined how |
|---|---|---|
| Claude Code harness | 62,954 lines, 25.4 MB | REA `inspect_artifact` + `extract_artifact` recovered the whole Bun bundle; 4 workers analysed it with grep/sed and verified every line cite |
| Claude Desktop main | 991 files, 88 MB | read `package.json`, `.vite/build/*.js` (main chunks), `mcp-runtime`, `pty-host`, `resources/`, `compile-cache` |
| Claude Desktop renderer | 5,039 files, 204 MB | REA `analyze_javascript_application` (graph on the entry chunk); read `index.html`, CSS tokens, **all of `i18n/en-US.json` (42,695 strings)**, `frame/` artifact runtimes |
| Cowork Linux VM | `smol-bin.arm64.img` | **not examined** |
| `@ant/claude-native` addon | native binary | **not examined** |

Not claimed: a line-by-line read of all 62,954 harness lines. The research docs
record what was established and what was not (`docs/EVIDENCE.md`).

## Feature parity today

| surface | Claude Code | xMonkey | status |
|---|---|---|---|
| tools | ~70 declared | 21 + skill/task/MCP | core set matched; vendor tools deliberately absent |
| hook events | 31 | 31 declared, **25 dispatched** | 6 accepted-but-not-fired, listed by `undispatchedEvents()` |
| permission modes | 6 | 6 | matched |
| permission pipeline | deny-tool → deny-input → ask-tool → tool check → ask-input → interaction → mode | same, minus per-tool `checkPermissions` | one gap |
| sessions | JSONL transcript + fork | JSONL transcript, resume | fork not implemented |
| compaction | window − min(maxOut,20k) − 13k | same shape, honest marker | no summary model |
| subagents | depth 3, fork mode | depth 2, fresh context | fork mode absent |
| skills | SKILL.md + slash command | same format, catalogue-only prompting | matched |
| MCP | stdio/sse/http | stdio/http | sse absent |
| streaming | yes | yes | matched |
| prompt caching | cache_control breakpoints | Anthropic adapter sets one | not tuned |
| UI | Electron + web app | Electron + same design system | matched surface, different internals |

### Tools: what maps to what

| Claude Code | xMonkey | notes |
|---|---|---|
| `Read` `Write` `Edit` | `read` `write` `edit` | matched |
| `MultiEdit` | `multi_edit` | matched, atomic (all-or-nothing) |
| `NotebookEdit` | `notebook_edit` | matched |
| `Glob` `Grep` `LS` | `glob` `grep` `list` | matched |
| `Bash` | `bash` | matched |
| `BashOutput` `KillBash` | `bash_background` `bash_output` `bash_kill` | matched |
| `WebFetch` `WebSearch` | `web_fetch` `web_search` | matched |
| `TodoWrite` | `todo` | matched |
| `TaskCreate/Get/Update/List` | `task_*` | matched |
| `Agent` (`Task`) | `task` | matched |
| `EnterPlanMode` `ExitPlanMode` | `plan` | matched |
| `AskUserQuestion` | `ask_user` | matched |
| `Skill` | `skill` | matched |
| `ListMcpResources` `ReadMcpResource` | `mcp__*` tools only | resources/prompts absent |
| `LSP` | — | **absent** |
| `Workflow` `REPL` | — | **absent** (vendor orchestration) |
| `Artifact` `Project` `DesignSync` | — | **absent** (claude.ai services) |
| `SendMessage` `SendFile` `ListAgents` | — | **absent** (teams, needs a server) |
| `Cron*` `ScheduleWakeup` `RemoteTrigger` | `Scheduled` in the app | different mechanism, same intent |
| `Monitor` `PushNotification` `EndConversation` | — | **absent** |

## Honest summary

- **The core agent is matched**: loop, streaming, tools, permissions, sessions,
  compaction, subagents, skills, MCP, hooks, plan mode.
- **The UI surface is matched**: same design tokens, same fonts, same 30 core
  labels, same navigation.
- **It is not a byte-for-byte clone and cannot be**: the vendor-only tools depend
  on Anthropic's servers (projects, artifacts, teams, remote sessions), and those
  have no local equivalent.
- **Six hook events are accepted but never fired.** `undispatchedEvents()` names
  them at runtime rather than pretending they work.
- **Not examined**: the Cowork VM image and the native addon. Anything they do is
  unknown, not matched.
