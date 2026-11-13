# Claude Desktop 4.23118.0 — process architecture and Claude Code embedding

R5 deliverable. Primary source: `.rea/extracted-app/` (the unpacked `app.asar`, `package.json:5` says version
`4.23118.0`; `package.json:8` says `main = .vite/build/index.pre.js`). Secondary: the installed bundle at
`/Applications/Claude.app` (Info.plist `CFBundleShortVersionString = 4.23118.0`), and
`.rea/extracted-ion/` (the `ion-dist` web app). Everything below was verified with `grep -c/-o`,
`grep -Fob`, byte-slicing and `wc`; no file was dumped whole.

**Citation convention.** The main-process bundles are minified to one physical line, so a line number is
useless. Cites in this file use `path:line@charOffset`, where the offset is the byte offset printed by
`grep -Fob '<literal>' <path>` in `.vite/build/` (e.g. `:7@3403310`). Files that really have lines
(`package.json`, `mcp-runtime/nodeHost.js`, `index.pre.js`'s 2nd line) are cited as `path:line`.
The offset identifies the start of the quoted literal, not the whole statement.

**Correction to the brief.** The brief guessed the main process is "largely NOT recoverable" bytecode.
That is wrong for this build: `index.pre.js` is 1,038,343 bytes of plain ASCII JavaScript (2 lines,
first chars `"use strict";(function(){...` — verified with `head -c` and `xxd`), and the real app bundle
`index.chunk-BBUaTQ8d.js` is 7,168,821 bytes of plain JS. The three files in `compile-cache/`
(`index.js.arm64.jsc`, `index.chunk-B9r6aBXl.js.arm64.jsc`, `index.chunk-BBUaTQ8d.js.arm64.jsc`,
largest 7.5 MB) are V8 *code caches* of those same readable chunks — `index.pre.js` generates them
(`index.pre.js:1@1038231` "compile cache generation failed", tail calls the writer at
`index.pre.js:1@1037989` right after `require("./index.js")`). So no application logic is lost to bytecode;
the .jsc files are redundant machine code, not an alternate source.

## 1. What is actually in the box

- `index.pre.js` — Electron main entry, 1,038,343 B / 2 lines. Sentry bootstrap
  (`SENTRY_RELEASE` id at byte 0), telemetry/IPC plumbing, compile-cache orchestration, then
  `require("./index.js")` (`index.pre.js:1@1037989`).
- `index.js` — 638 B, one line: `require("./index.chunk-B9r6aBXl.js"),require("./index.chunk-BBUaTQ8d.js")`.
- `index.chunk-BBUaTQ8d.js` — 7,168,821 B: the main application bundle (windows, IPC registry,
  Claude Code manager, MCP hosts, SDK callers; all the `ipcMain`/`BrowserWindow`/`pathToClaudeCodeExecutable`
  hits below are here).
- 536 entries in `.vite/build/`, of which 511 are root `index.chunk-*.js` lazy chunks (e.g. the Claude
  Agent SDK is one: `index.chunk-CqnLpjST.js`, lazily required by a named-chunk loader at
  `index.chunk-BBUaTQ8d.js:7@3403310`).
- 7 renderer roots under `.vite/renderer/`: `main_window`, `quick_window`, `buddy_window`, `about_window`,
  `find_in_page`, `file_viewer`, `local_exec_consent` (each is an HTML file + assets; `main_window/index.html:1`
  states it is only the load-error UI — "everything else gets loaded from claude.ai").
- ~15 preload bundles live at `.vite/build/*.js` next to the main chunks: `mainWindow.js` (89,105 B),
  `mainView.js` (274,600 B), `quickWindow.js`, `aboutWindow.js` (87,130 B each), `buddy.js`,
  `findInPage.js`, `localExecConsent.js`, `mcpAppView.js`, `artifactShell.js`, `coworkArtifact.js`,
  `claudePagePreview.js`, `designWindow.js`, `computerUseTeach.js`, `computerUseWatchRecord.js`,
  `watchRecordChooser.js` (see each file's `//# sourceMappingURL=` tail and the `contextBridge` cites in §4).
- Worker entry points: `pty-host/ptyHostWorker.js` (7,299 B), `mcp-runtime/{nodeHost,directMcpHost}.js`
  (15,824 B / 626,689 B), `file-index-worker/`, `frame-local-worker/`, `heavy-work-worker/`,
  `shell-path-worker/`, `stall-sampler-worker/`, `transcript-search-worker/`.
- `resources/`: `bundled-skills/` (6 `.skill` ZIPs + `manifest.json`), `office365-mcp/` (3 `.mjs` files),
  `frame/` (runtime/shell/types), `artifact-libs/` (mermaid/gridjs/chart UMD bundles), `quick-actions/`,
  `claude-browser-shim.js`, `i18n/`.
- `.rea/extracted-ion/` is the `ion-dist` renderer web app (`index.html`, `assets/v1/` ≈ 4,896 files,
  `frame-shell.html`, `frame-connect.html`, `frame-manage.html`). It is not what the retail build loads
  from disk: the installed app serves it only for third-party (`custom-3p`) builds over a custom `app://`
  protocol handler, which logs `[custom-3p] the app's bundled web pages (ion-dist.asar) are missing…`
  (`index.chunk-BBUaTQ8d.js:7@4506706`); the retail main window loads the web UI from `claude.ai`
  (`main_window/index.html:1`; the web/hybrid preloads' origin guards accept `https://claude.ai`, e.g. `mainWindow.js:1@1031`).
- The installed bundle also carries `Resources/ion-dist.asar` and a 27 MB `Resources/smol-bin.arm64.img`
  (the Cowork workspace-VM disk image; the VM code copies `smol-bin.<platform>.vhdx`
  `index.chunk-BBUaTQ8d.js:7@4682436`).
- `.vite/build/index.chunk-BBUaTQ8d.js` alone (7.2 MB) is bigger than `ion-dist.asar`, and the main build
  splits into 511 chunks; the SDK chunk is also `require`d from `index.chunk-CiqX2Dtw.js` and
  `index.chunk-BesUTfsb.js` (so several chunks are part of the same dependency graph, not copies of app code).

## 2. Process architecture

Electron 3-process model, plus out-of-process workers for everything that can block or crash.

| Process / window | Kind | Purpose | Evidence |
|---|---|---|---|
| Main process | Electron browser process | Loads `index.pre.js`; owns `BrowserWindow`s, the typed IPC registry, Claude Code install/launch manager, Agent SDK sessions, MCP config, autoupdate | `package.json:8`; `index.pre.js:1@1037989` |
| `main_window` | BrowserWindow + renderer | Shell window (`titleBarStyle:"hidden"`, custom traffic lights); preload `mainWindow.js`; loads claude.ai web app, local HTML is the load-error screen | `index.chunk-BBUaTQ8d.js:7@6766460`; `.vite/renderer/main_window/index.html:1` |
| `CLAUDE_AI_WEB` contents | `WebContentsView` inside main window | The actual chat/agent UI (claude.ai origin), sandboxed (`sandbox:!0, contextIsolation:!0, nodeIntegration:!1`) | `index.chunk-BBUaTQ8d.js:7@581114` |
| `quick_window` | BrowserWindow panel (always-on-top, frameless, non-activating) | Quick-entry launcher, `quick-window.html` | `index.chunk-BBUaTQ8d.js:7@4522615`, `:7@4523527` |
| `buddy_window` | BrowserWindow | "Hardware Buddy & Maker Devices" pairing screen, `buddy.html` | `index.chunk-B9-bfNdr.js:1@12093`, `:1@12357` |
| `about_window` | BrowserWindow | About/build/help page, `about.html` | `index.chunk-BBUaTQ8d.js:7@4571564` |
| `find_in_page` | `WebContentsView` overlay | Chromium-style find-in-page UI attached to the main window | `index.chunk-BBUaTQ8d.js:7@4461887`, `:7@4462173` |
| `file_viewer` | renderer | Built-in document viewer for Cowork previews; strict CSP `script-src 'self'` | `index.chunk-CtTkjocZ.js:1@1894`, `:1@1894` |
| `local_exec_consent` | modal BrowserWindow | Consent dialog for local-execution / direct-connector grant decisions (grant stores `confirmDirectMcpChatGrant`, `clearAllDirectMcpChatGrants`); preload exposes `LocalExecConsent.choose` | `index.chunk-B5nNN37d.js:1@9267`, `:1@9468`; `localExecConsent.js:1@1056` |
| MCP app views | sandboxed view, `claude-mcp-app:` protocol | Hosts MCP-UI/widget HTML from MCP servers, bridge preload `mcpAppView.js` | `index.chunk-D_KsI5qZ.js:1@7724`; `mcpAppView.js:1@627` |
| Artifact shell | sandboxed view, `cowork-artifact://shell` | Sandbox for Cowork-generated HTML artifacts; preload `artifactShell.js` | `index.chunk-BBUaTQ8d.js:7@1032142`; `artifactShell.js:1@745` |
| Cowork artifact page | view, `cowork-artifact:` | Renders a Cowork artifact; preload exposes `window.cowork` (`callMcpTool`, `askClaude`, `runScheduledTask`) | `coworkArtifact.js:1@689` |
| Design window | BrowserWindow | Artifact "Design" pop-out, `designWindow.js` preload adds `printFrameToPdf` | `index.chunk-BBUaTQ8d.js:7@5339393`; `designWindow.js:1@675` |
| `claudePagePreview` view | view | Embedded preview of claude.ai pages, preload `claudePagePreview.js`; `nodeIntegrationInSubFrames` enabled only for this view | `index.chunk-BBUaTQ8d.js:7@5105580` |
| Computer-use overlays | frameless always-on-top panels | Screen recording/teach HUD, record chooser; preloads `computerUse*.js` expose `claude.internal.computerUse` | `index.chunk-DtA4QrIY.js:1@15668`, `:1@34902`; `computerUseTeach.js:1@3637` |
| pty-host | Electron `utilityProcess` | Owns node-pty terminals for session terminal tabs; MessagePort protocol | `index.chunk-DzI0vi6x.js:1@9464`; `pty-host/ptyHostWorker.js:1@4898` |
| MCP node host | `utilityProcess` running `mcp-runtime/nodeHost.js` | Bundled Node runtime that executes user Node-based stdio MCP servers | `index.chunk-BBUaTQ8d.js:7@1509817` |
| custom-3P MCP host | `utilityProcess` running `mcp-runtime/directMcpHost.js` | HTTP/SSE ("direct") MCP connectors, isolated from main | `index.chunk-BBUaTQ8d.js:7@2288426`, `:7@2288961` |
| shell-path worker | `utilityProcess` | Captures the login shell environment (`PATH`) so CLI children inherit it | `index.chunk-CgxHA8Bn.js:1@3895`, `:1@3934` |
| file-index worker | `utilityProcess` | File search index / skill & project file indexing | `index.chunk-BBUaTQ8d.js:7@4103621` |
| transcript-search worker | `utilityProcess` | Session transcript search (`serviceName:"Claude Desktop Transcript Search"`) | `index.chunk-DebYelP7.js:1@2624` |
| heavy-work worker | `utilityProcess` | Off-main-thread CPU work (zip, crypto, hashing) | `index.chunk-BBUaTQ8d.js:7@2907182` |
| stall-sampler worker | `utilityProcess` | Samples main-thread stalls for diagnostics | `index.chunk-BBUaTQ8d.js:7@5501586` |
| frame-local worker | `utilityProcess` | Serves the `.frame.localhost` artifact/iframe host with CSP + headers | `index.chunk-BBUaTQ8d.js:7@6092657`, `.frame.localhost` scheme at `:7@1032142`; `frame-local-worker/frameLocalWorker.js:1@19425` |
| claude / claude.exe | child process | The actual Claude Code agent harness, spawned by the Agent SDK (see §5) | `.vite/build/index.chunk-CqnLpjST.js:1@200180` |
| Cowork workspace VM | native VM (Apple Virtualization/other) | Linux guest that runs Cowork sessions; disk image `smol-bin.arm64.img` | `index.chunk-BBUaTQ8d.js:7@4682436`; `Resources/smol-bin.arm64.img` |
| `@ant/claude-native` | native Node addon | Native helpers (window/vibrancy/etc.) loaded from `app.asar.unpacked` | `/Applications/Claude.app/Contents/Resources/app.asar.unpacked/node_modules/@ant/claude-native/claude-native-binding.node` |

Explicitly forked workers go through a shared supervised host class; its generic path logs `worker bundle not
found … requests will reject as worker_unavailable` (`index.chunk-BBUaTQ8d.js:7@2903808`). The pty-host and
MCP hosts get an explicit `MessageChannelMain` port (`utilityProcess` + `port1/port2`), while the CPU workers
use ordinary `utilityProcess` message passing.

## 3. Boot and main-process composition

1. Electron loads `index.pre.js` (compiled with the app's V8 code cache if present). It initialises Sentry
   (`SENTRY_RELEASE` at byte 0), exits early on failure when generating the compile cache
   (`index.pre.js:1@1038231`), then requires `index.js` and both root chunks (`index.pre.js:1@1037989`).
2. `index.chunk-BBUaTQ8d.js` runs the window manager. Windows come from `@loc/electron-window`, which has
   its own generated IPC namespace/uuid: `$eipc_message$_fcb91d11-…_$_electron_window_$_WindowManager_$_RegisterWindow`
   (`index.chunk-Dvh-ps5P.js:1@16583`). Its window-role enum includes `MAIN_WINDOW`, `CLAUDE_AI_WEB`
   (`index.chunk-BBUaTQ8d.js:7@581114`), `QUICK_ENTRY` (`:7@4522615`), `ABOUT` (`:7@4571564`).
3. Named chunks load on demand: the loader `Jdr("sdk", … require("./index.chunk-CqnLpjST.js") …)`
   (`index.chunk-BBUaTQ8d.js:7@3403310`) shows the Claude Agent SDK chunk is only pulled in when a session
   starts, keeping cold start small.
4. Sentry wraps `utilityProcess.fork` so utility-process crashes/errors are reported
   (`index.pre.js:1@332045`). Note: that log string says "SDK started in utility process" but it is the
   **Sentry SDK**, not Claude Code — do not read it as the agent harness running out-of-process.

## 4. The IPC surface

**Mechanism.** Every preload uses `contextBridge.exposeInMainWorld(<namespace>, {<Interface>: methods})`;
the renderer never touches `electron.ipcRenderer` directly (all windows are `sandbox:!0,
contextIsolation:!0, nodeIntegration:!1`, e.g. `index.chunk-BBUaTQ8d.js:7@581114`). Channels are generated
from a fixed prefix + namespace + interface + method:

```
$eipc_message$_6cd24b5f-c775-4127-8fb3-5689cc5d9ef1_$_claude.hybrid_$_<Interface>_$_<method>
```

(the prefix literal is in every preload, e.g. `mainWindow.js:1@629`; `@loc/electron-window` uses its own
uuid `fcb91d11-…`). Methods are request/response over `ipcRenderer.invoke`; server→renderer pushes use
`ipcRenderer.on` on the same string (e.g. `ClaudeCode_$_resolvedSettingsChanged`,
`mainView.js:55@152170`). The UI store sync helper uses a `…_$store$_update` suffix
(`index.chunk-BBUaTQ8d.js:7@576799`).

**Authorization.** The main-side handler wrapper removes and re-registers each channel per webContents and
rejects callers whose `senderFrame` is not the expected frame (`"Invalid IPC sender"`,
`index.chunk-BBUaTQ8d.js:7@6654221`). Preloads additionally gate exposure on `frameToken` / routing id and
allowed origins (`claude.ai`, `preview.claude.ai`, `app://localhost`, `localhost`, `file:`), e.g.
`mainWindow.js:1@1031`, `localExecConsent.js:1@1056`. The consent window only accepts packaged
`file:` or dev `localhost` frames (`index.chunk-B5nNN37d.js:1@5609`).

**Exposed API surface (from preloads).** `mainView.js` is the richest preload and it adds 90 classes under
`window["claude.web"]`, plus `claude.settings`, `claude.hybrid`, `claude.buddy`, `claude.skills`,
`claude.officeAddin`, `claude.engineSurface`, `claude.windowVibrancy`, `claude.simulator`
(`mainView.js:1@3366` shows the `claude.settings` prefix; class list extracted from the file). Interface
call-counts across `mainView.js`/`mainWindow.js`/`quickWindow.js`/`aboutWindow.js`/`buddy.js`/`findInPage.js`/
`localExecConsent.js` (grep of `"<Interface>_$_<method>"` literals): `LocalSessions` 374 methods,
`LocalAgentModeSessions` 139, `Launch` 121, `Simulator` 79, `CCDScheduledTasks` 13,
`ClaudeVM` 16, `ClaudeCode` 11, `MCP` 9, `Skills` 1 (the only channel is the `previewSkillFile` push).

Channels are `${prefix}_$_<namespace>_$_<Interface>_$_<method>`; the table gives namespace / interface and
one or two real channel tails.

| Namespace / interface | Example channel(s) seen in preload | Direction | Evidence |
|---|---|---|---|
| `claude.hybrid` / `DesktopIntl`, `MainWindowTitleBar` | `…_$_claude.hybrid_$_DesktopIntl_$_…` on main/quick/about windows | RPC | `mainWindow.js:1@629`; `buddy.js:1@2072` |
| `claude.internal.ui` / `MainWindowTitleBar` (+ store) | window chrome, store updates via `…_$store$_update` | RPC + push | `index.chunk-BBUaTQ8d.js:7@576799` |
| `claude.settings` / `AppConfig` | `…_$_claude.settings_$_AppConfig_$_getAppConfig` | RPC | `mainView.js:1@3366` |
| `claude.web` / `ClaudeCode` | `…_$_ClaudeCode_$_prepare`, `…_$_ClaudeCode_$_getStatus`, push `…_$_resolvedSettingsChanged` | RPC + push | `mainView.js:55@151916`, `:55@152170` |
| `claude.web` / `LocalSessions` | `…_$_LocalSessions_$_start`, `…_$_LocalSessions_$_respond` | RPC + push | `mainView.js:55@206482`, `:55@214722` |
| `claude.web` / `LocalAgentModeSessions` | `…_$_start`, `…_$_sendMessage`, `…_$_respondToToolPermission`, `…_$_setPermissionMode` | RPC + push | `mainView.js:55` (`LocalAgentModeSessions_$_…` literals) |
| `claude.web` / `MCP` | `…_$_MCP_$_getMcpServersConfigWithStatus`, push `…_$_mcpStatusChanged`, `…_$_mcpConfigChange` | RPC + push | `mainView.js:1@5207` |
| `claude.skills` / `Skills` | push `…_$_claude.skills_$_Skills_$_previewSkillFile` | push | `mainView.js:1@33863` |
| `claude.internal.findInPage` / `FindInPage` | `…_$_FindInPage_$_…` | RPC | `findInPage.js:1@2375` |
| `claude.internal.localExecConsent` / `LocalExecConsent` | `…_$_LocalExecConsent_$_choose` | RPC | `localExecConsent.js:1@1056` |
| `claude.internal.computerUse` / `CuTeach`, `CuWatchRecordChooser`, `CuWatchRecordPill` | computer-use HUD/record chooser | RPC + push | `computerUseTeach.js:1@629`, `:1@3637` |
| `claude.artifactShell` / `ArtifactShellTransport` | `…_$_ArtifactShellTransport_$_hello` | RPC | `artifactShell.js:1@745` |
| `claude.mcpAppView` / `McpAppViewBridge` | `…_$_McpAppViewBridge_$_post` | RPC | `mcpAppView.js:1@627` |
| `claude.designPdf` / `DesignPdf` | `…_$_DesignPdf_$_printFrameToPdf` | RPC | `designWindow.js:1@675` |
| `electron_window` / `WindowManager` | `…_$_WindowManager_$_RegisterWindow` | RPC | `index.chunk-Dvh-ps5P.js:1@16583` |

The IPC vocabulary is what makes the harness drivable: the claude.ai renderer can start/stop sessions,
send messages, answer permission prompts and change permission modes purely through
`LocalSessions` / `LocalAgentModeSessions` — it does not run any agent code itself.

## 5. How Claude Code is embedded — definitive answer

**The desktop imports the Claude Agent SDK in-process, and that SDK spawns the downloaded `claude` /
`claude.exe` executable as a child process speaking `stream-json` over stdio. The desktop also runs local
MCP hosts of its own and injects them into the same session as `sdk`-type MCP servers.** It does **not**
shell out to a CLI by hand for normal sessions, and the CLI binary is **not shipped inside `app.asar`** —
it is downloaded (or preseeded by an enterprise installer) at runtime.

Evidence chain, strongest first:

1. **The SDK is a bundle chunk.** `index.chunk-CqnLpjST.js` exports its public API:
   `exports.query=og`, `exports.createSdkMcpServer=gg`, `exports.tool=…`, `exports.startup=…`,
   `exports.deleteSession=…` (`index.chunk-CqnLpjST.js:1@299922`, export list also at `:1@188009`).
   The main bundle loads it lazily by name: `qdr("sdk", …, () => require("./index.chunk-CqnLpjST.js")…)`
   (`index.chunk-BBUaTQ8d.js:7@3403310`).
2. **The SDK's spawner is present and visible.** `spawnLocalProcess(...)` does
   `spawn(command, args, {cwd, stdio:["pipe","pipe","pipe"], signal, env, windowsHide:!0})`
   (`index.chunk-CqnLpjST.js:1@200180`); `getDefaultExecutable()` returns `"bun"` or `"node"`
   (`:1@200132`); the argument vector it builds is
   `["--output-format","stream-json","--verbose","--input-format","stream-json"]` plus thinking/limit
   flags (`:1@202147`). The `initialize()` option object includes `pathToClaudeCodeExecutable`,
   `executableArgs`, `mcpServers`, `permissionMode`, `allowDangerouslySkipPermissions`, `cwd`, `model`,
   `hooks`, `resume`, `settingSources`, `skills`, `tools` (`:1@201522`). The SDK even ships the error
   strings for a missing/bad binary: "Claude Code native binary not found at … specify a valid path with
   options.pathToClaudeCodeExecutable" (`index.chunk-CqnLpjST.js:1@212094`).
3. **The desktop calls that SDK `query()` with those options.** The clearest call shape is the usage probe:
   `[{query:M},…]=await Promise.all([…])` then
   `r=M({prompt:S(), options:{pathToClaudeCodeExecutable:j.cmd, executableArgs:j.args, cwd, …,
   canUseTool: async()=>({behavior:"deny",…}), env, stderr}})`
   (`index.chunk-Dx5ElPFh.js:1@3741`). The local-agent ("HostLoop") path builds the same option object,
   logs `[HostLoop] Starting Claude Code through the host CLI launcher at: <binaryPath>`
   (`index.chunk-D6Y0BUdo.js:1@324370`) and logs the final options including
   `executable`, `executableArgs`, `hasSpawnClaudeCodeProcess` (`:1@337021`). One-shot/auxiliary queries
   use the identical shape (`index.chunk-ngidyMUT.js:1@7209`; `index.chunk-cfjwas5i.js:1@2437`).
4. **The desktop supplies the binary path from its own install manager.** `ClaudeCodeManager` (log prefix
   `[CCD]`, class at `index.chunk-BBUaTQ8d.js:7@4376048`) reads a pinned manifest embedded as JSON:
   `version 2.1.317`, `manifestSignatureEnforcement:"flag"`, per-platform `claude.zst` /
   `claude.exe.zst` with sha256+size, optional macOS `bundle`, `sdkCompat.testedWrapperVersions`
   (0.3.284–0.3.306), `baseUrl https://downloads.claude.ai/claude-code-releases`,
   `sdkWrapperVersion 0.3.317` (`index.chunk-BBUaTQ8d.js:7@1693896`, `:7@1694183`, `:7@1694226`).
   Binaries install under `app.getPath("userData")/claude-code/<version>/<sha256-prefix>/…`
   (`Tmi()` at `:7@4365773`; `installDirFor`/`getBinaryPathForTarget` at `:7@4377921`/`:7@4378016`),
   on macOS as a bundle `claude.app/Contents/MacOS/claude` (`Ehi="claude.app"`, `:7@4374859`), and on
   Windows as `claude.exe` (`binaryName` choice in `getHostTarget`, `:7@4376964`). An enterprise/preseed
   path exists at `process.resourcesPath/preseed/claude-code/<platform>/<binary>` (`:7@4371242`,
   `getHostPreseedInPlacePath` at `:7@4376875`); on this machine `/Applications/Claude.app/Contents/Resources/`
   has **no `preseed/` directory**, no file whose name matches `claude*` under `Resources` (checked with
   `find … -iname '*claude*'`), and no non-asar file over 50 MB, so the retail path is the runtime download.
5. **Desktop-side tools are injected into the session as an SDK MCP server.** The desktop uses
   `createSdkMcpServer({name,version,tools})` and `tool(...)` to expose its own tools (web-fetch proxy,
   `workspace_bash`, session listing, "request access to a directory", local/plugin MCP proxies, …)
   (`index.chunk-D6Y0BUdo.js:1@339306`, `:1@231401`, `:1@292593`; `index.chunk-D415ffKh.js:1@1731`;
   `index.chunk-BhhME2hr.js:1@56235`; `index.chunk-Byk1RdXg.js:1@5461` and `index.chunk-C0Okj9uQ.js:4@19388`
   for `LocalMcpServerManager.createSdkServer`). The SDK accepts `mcpServers` entries of type `sdk`
   (`index.chunk-C7EkX3z-.js:1@40768` counts stdio/sdk/http configs).
6. **The tool preset handed to the CLI is the Claude Code preset.** The HostLoop options list
   `tools:["Task",…,"Bash","Glob","Grep","Read","Edit","Write","NotebookEdit","WebFetch",…,
   "WebSearch","Skill","REPL","JavaScript","AskUserQuestion",…,"ToolSearch",…]`
   (`index.chunk-D6Y0BUdo.js:1@365182`), and the desktop renames some tools for the model
   (`toolAliases:{Bash:t.V7, WebFetch:t.H7}`, `:1@324370` region). Spawn env carries
   `CLAUDE_CODE_SPAWN_TIMESTAMP_MS` and an optional fourth stdio fd
   (`index.chunk-D6Y0BUdo.js:1@77032`), i.e. the desktop supervises the child directly.

**Session modes** (all use the same SDK + CLI, different execution surfaces):

- **Local agent mode / HostLoop** — CLI runs on the host, supervised by main
  (`index.chunk-D6Y0BUdo.js:1@324370`), file work is path-gated by the desktop.
- **Cowork** — CLI runs inside the workspace VM: "spawning in the workspace VM as …" with
  `cliRunsOnThisHost:!1` and a custom `spawnClaudeCodeProcess` (`index.chunk-cfjwas5i.js:1@3108`).
  If the VM is not running the session is skipped (`:1@3008`). The VM image is `smol-bin.arm64.img`
  (27 MB) under `Resources/`.
- **Remote / CCD / SSH** — a host CLI launcher and SSH reattach path exist
  (`index.chunk-CuH_hqMe.js:1@533055` builds `pathToClaudeCodeExecutable` from `S.hostCliLauncher` and
  passes `executableArgs`; sessions can be adopted, `registerForAdoption`, `sshReattach` in the same
  region), plus a separate `claude-ssh` binary manifest
  (`index.chunk-BBUaTQ8d.js:7@1694183` second manifest, `claude-ssh-releases`).

**What the desktop itself contributes to the agent**: permissions/sandbox policy, skills plugin, MCP
configuration, session persistence/transcripts, title bars and UI, tool aliases, the `Skill` tool and
`skills` option, and the SDK MCP servers above. The reasoning loop, tool execution and permission engine
are the CLI harness (analyzed in `research/claude-code/`; note the workspace copy `research/claude-code/cli.js`
is a Bun-compiled 25.4 MB `@bun @bytecode` bundle stamped 2.1.231, while this installation pins 2.1.317 —
two different CLI builds, so version-specific claims must say which one they came from).

## 6. MCP runtime

**Configuration + transports.** MCP servers are user/enterprise config with these `type` values:
`stdio`, `sdk`, `http` (aliases `streamable-http`), `sse`, `ws`, `sse-ide`, `ws-ide`, `claudeai-proxy`
(`index.chunk-riZ8KHeT.js:1@990`; schema transforms at `index.chunk-BBUaTQ8d.js:7@631520`; config counts
computed per type at `index.chunk-C7EkX3z-.js:1@40768`). The renderer edits them via `MCP_$_*`
(`mainView.js:1@5207`); main parses them, and extension/plugin servers can be marked `isMcpb`
(desktop extensions) or `command`-based (`index.chunk-D415ffKh.js:1@1063`).

**`mcp-runtime/nodeHost.js` — the Node runtime host.** It is a standalone Node script
(`#!/usr/bin/env node`, `mcp-runtime/nodeHost.js:1`) that main forks through its
`utilityProcess.fork` wrapper with `[serverEntryPoint, ...args]`, `stdio:"pipe"`,
`allowLoadingUnsignedLibraries:!0`, `disclaim:!0`, and a `MessageChannelMain` port posted as
`{type:"init"}` (`index.chunk-BBUaTQ8d.js:7@1509817`; wrapper at `:7@1499401` adds proxy/CA env).
Inside the child, `process.parentPort.once("message", …)` takes the port, starts the server module
(rewriting `process.argv` and `import()`ing it, `mcp-runtime/nodeHost.js:55`), and forwards stdio/stdout+
stderr frames back to main. It deliberately blocks spawning itself: if a server tries to `fork`/`execPath`
the built-in Node runtime it throws `SelfExecBlockedError` (`ERR_MCP_NODE_HOST_NOT_NODE`) whose message
tells the user to install Node or turn off "Use built-in Node.js for MCP"
(`mcp-runtime/nodeHost.js:54@10824`, `:54@10954`). That setting is exposed as
`AppConfig_$_setIsUsingBuiltInNodeForMcp` (`mainView.js:1` method literal). Main's side buffers the child's
stdout into newline frames, maps `fatal-error`/`self-exec-blocked` messages, applies a spawn timeout, and
tears down deferred procs on close (`index.chunk-BBUaTQ8d.js:7@1509817` region).

**`mcp-runtime/directMcpHost.js` — the "direct"/custom-3P connector host.** Main spawns it as a utility
process with a fresh cacheless session partition, `serviceName:"Custom 3P MCP Host"`, 5 s spawn timeout,
90 s `READY_TIMEOUT_MS` per server, and a dedicated `MessageChannelMain` per server; it can restart the
host on unexpected exit and fires close on active connections (`index.chunk-BBUaTQ8d.js:7@2288426`,
`:7@2288961`; exports in that region are `spawnUtilityClient`, `disposeDirectMcpHost`,
`READY_TIMEOUT_MS`). Inside, it builds an MCP client over `SSEClientTransport` for `transport:"sse"` and the
streamable-HTTP client otherwise, performs the MCP `initialize` handshake (with an older-handshake retry),
`tools/list` discovery, `tools/call`, elicitation round-trips and auth-retry callbacks
(`mcp-runtime/directMcpHost.js:13@625517`; its MessagePort bridge class at `:13@626386`).
Direct connectors are user-authorized: the consent UI and grant store live in
`index.chunk-B5nNN37d.js:1@5609` (`LocalExecConsent.choose`, `confirmDirectMcpChatGrant`,
`clearAllDirectMcpChatGrants`), and `LocalAgentModeSessions` exposes
`authorizeDirectMcpServer`, `directMcpCallTool/ListResources/ReadResource`, `disconnectDirectMcpServer…`
(`mainView.js:1` method literals).

**Lifecycle summary.** Configure (`MCP_$_setMcpServerConfigs`) → consent if local/direct
(`LocalExecConsent`) → on session start, main resolves the server list and either (a) passes
`stdio`/`http` entries to the CLI in `mcpServers`, (b) starts the nodeHost utility per Node stdio server,
(c) asks the directMcpHost utility to `addServer` for HTTP/SSE, or (d) registers an in-process
`sdk` server built with `createSdkMcpServer`. Status changes are pushed to the UI
(`MCP_$_mcpStatusChanged`, `mcpConfigChange`); hosts are disposed on session end/quit
(`disposeDirectMcpHost`, nodeHost `SIGTERM/SIGINT` handlers at `mcp-runtime/nodeHost.js:55`).

## 7. pty-host worker

`node-pty` is an **optional** dependency (`package.json:29`, `node-pty 1.2.0-beta.14`) because it is only
needed for terminal tabs. `pty-host/ptyHostWorker.js` is a plain Node/Electron utility-process script that
requires `node-pty` (`pty-host/ptyHostWorker.js:1@758`), handles `spawn`/`write`/`resize`/`data`/`exit`
messages, keeps a replay buffer per pty, and on Windows can respawn through a fallback binary
(`spawn-fallback`) when the primary backend cannot start (`:1@4898` region). Its entry is the same
`process.parentPort` port handshake, and it exits on `shutdown` (`:1@7210`). The main-process controller
forks it as service `dh` with `stdio:"pipe"` (`index.chunk-DzI0vi6x.js:1@9464`), exposes a
`spawn(cols,rows)` / `write` / `resize` / `onData` / `onExit` API (`:1@8391`), and runs a two-stage
watchdog that pings and force-kills an unresponsive worker so it can be re-forked rather than wedging the
app (`:1@8191` region). Session records carry `terminalTab`, `shellPtyLink`, `shellPtyHost` fields
(`index.chunk-BBUaTQ8d.js:7@1961909`), which is what ties this to the Claude Code terminal UI.

## 8. Bundled skills

**Manifest.** `resources/bundled-skills/manifest.json` lists 6 skills — `docx`, `pdf`, `pdf-reading`,
`pptx`, `xlsx`, `frontend-design` — each with a `name`, a long trigger `description`, and
`tier:"always"`; top-level `agentSkillsRef:"1793832186"` (`manifest.json:1`, first entries at `:4`).

**Archive format.** Each `<name>.skill` is a ZIP (verified with `file` and `unzip -l`): a
`<name>/` directory containing `SKILL.md`, `LICENSE.txt`, optional `REFERENCE.md` / `FORMS.md`, and
optional `scripts/` (Python + XML templates). `SKILL.md` is YAML front-matter (`name`, `description`,
`license`) followed by markdown instructions; e.g. `docx/SKILL.md` front-matter has `name: docx` and the
same trigger description as the manifest, then prose like "A `.docx` is a ZIP archive of XML files…"
(`resources/bundled-skills/docx.skill` via `unzip -p`). `frontend-design.skill` is just SKILL.md + LICENSE.

**How they install.** The skills plugin reads the manifest from
`path.join(app.getAppPath(), "resources", "bundled-skills")` (`index.chunk-D88DnBD9.js:1@13071`),
exposes each as `skillId: "bundled:<name>", creatorType:"anthropic", source:"anthropic",
enabled: tier !== "default_false"` (`:1@13306`, `:1@13439`), and seeds a bundled skill by reading the `.skill` bytes out
of the asar and extracting them with `{archiveKind:"skill", moveExistingAside:true}`
(`:1@13752`), into the per-user skill store `userData/<x>/skills-plugin` (path built at
`index.chunk-BBUaTQ8d.js:7@2457967`); an additional lazy extraction path writes into the `appdata`
storage root with a 2,000-entry cap (`index.chunk-D88DnBD9.js:1@14296`). Skills are then surfaced to
sessions by mounting them at `.claude/skills` — for Cowork the host maps
`<skillsPluginPath>/skills` into the VM (`index.chunk-D6Y0BUdo.js:1@288795`) — and by telling the model
about them: the prompt text includes a `<skills>` section instructing Claude to read
`{{skillsDir}}/skills/<name>/SKILL.md` (`index.chunk-CiPVc5sM.js:1@27961`). Skill text is sanitised and
scanned before being shown to the model (`<<<SKILL-SCAN FILE BEGIN` markers,
`index.chunk-D88DnBD9.js:1@15661`). User "skills" are a settings surface too (`claude.skills`
preload, `Skills.serverName` handling `index.chunk-BhhME2hr.js:1@51332`).

## 9. Not recoverable / not determined (explicit)

- **Original TypeScript sources / source maps.** Bundles end with a `//# sourceMappingURL=…map` comment but
  **no `.map` file sits next to the chunks** in `.vite/build/` (`ls .vite/build/*.map` → 0). All source-level
  reasoning above is from minified JS, so internal function names are minifier artefacts.
- **`compile-cache/*.jsc`** are V8 code caches, not decompilable source. They are redundant: the same
  chunks exist as readable JS. Do not treat them as hidden bytecode.
- **The `claude` / `claude.exe` harness binary is not in the asar.** It is fetched from
  `downloads.claude.ai/claude-code-releases` (pinned 2.1.317, zstd, sha256-verified) or preseeded under
  `Resources/preseed/` by an enterprise installer. On this machine neither a preseed directory nor a
  downloaded `claude` binary was found (checked `/Applications/Claude.app/Contents/Resources`,
  `~/Library/Application Support/Claude/claude-code` absent). Its internals are therefore not recoverable
  from the desktop extraction; the workspace's `research/claude-code/cli.js` (Bun `@bytecode` bundle,
  stamped 2.1.231) is the separate harness artifact.
- **Native code.** `app.asar.unpacked/node_modules/@ant/claude-native/claude-native-binding.node` is a
  native addon (no symbols/TS source in the asar). Other `@ant/*` packages (`computer-use-mcp`,
  `claude-for-chrome-mcp`, `claude-swift`, `imagine-server`) are dependencies in `package.json:18-26`
  but their implementations are not part of this extraction beyond what is bundled into chunks.
- **The Cowork VM image** (`Resources/smol-bin.arm64.img`, 27 MB) was not parsed or mounted here; its
  contents and guest-side agent code are outside this analysis.
- **Encrypted/large binary blobs in `ion-dist.asar`** were not searched exhaustively beyond the files in
  `.rea/extracted-ion/`; the frame runtime under `resources/frame/` was only inventoried, not analysed.
- **Unresolved details**: exact permission-engine evaluation for `LocalSessions`/`Cowork` (many policy
  strings are present but the decision code is spread across minified chunks); the precise window-role
  enumeration and window-manager registration protocol of `@loc/electron-window`; and how the macOS app
  decides between `claude.app` bundle vs plain binary at install time (the bundle flag exists but the
  choice logic was not fully traced). These are marked not-determined rather than guessed.

## 10. Check

```
$ wc -l research/claude-desktop/01-architecture.md    # 384 (>= 70 required)
$ grep -c 'index.chunk-\|index.pre.js\|package.json' research/claude-desktop/01-architecture.md  # 100
```
