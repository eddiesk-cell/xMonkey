# Evidence ledger

Every claim in `research/` rests on a shipped artifact that was opened through REA
(Reverse-Engineering Agent). This file records the exact provenance so a claim can be
re-checked rather than trusted, and so "we observed this" is distinguishable from "we
inferred this".

## Targets

| target | version | path | size |
|---|---|---|---|
| Claude Desktop | 4.23118.0 | `/Applications/Claude.app` | — |
| Claude Desktop main bundle | — | `Resources/app.asar` | 81,159,563 B |
| Claude Desktop renderer | — | `Resources/ion-dist.asar` | 203,070,604 B |
| Claude Code harness | 2.1.231 | `/opt/homebrew/lib/node_modules/@anthropic-ai/claude-code/bin/claude.exe` | 294,720,528 B |

## REA operations

| operation | evidence id | what it establishes |
|---|---|---|
| `open_binary` | — | bound the Mach-O arm64 executable, `sha256:ba790279cab6ef77b713864d4bf5f764fcea87d3a3eb7591a41f741e45212b5c` |
| `inspect_artifact` | `ev_d775e25dd5416678f4e729150985224114927068869cf15cc49dae29b33739d9` | the binary is a **Bun standalone** (`bun-standalone`, layout `bun-1.3.9`), payload at offset 65,847,304, 15 stored modules, entry `/$bunfs/root/cli`; 17 graph nodes, 0 integrity contradictions |
| `extract_artifact` | `ev_f185985c612cca94f237d8c95a0c2248d375cb14dd5c97546f36fa60abc59320` | materialised all 15 modules; `$bunfs/root/cli` is 25,410,680 B of JavaScript (`sha256:c82d56af…`), plus `cli.bytecode` 191,315,808 B and native `.node` modules |

Parent evidence for the inventory view: `ev_15778503d1e9535ddb0553d7c038c049901463326d766288f8b5851f8b25abfc`.

## Method (why the line cites work)

`$bunfs/root/cli` is a **minified CJS bundle: 62,954 lines, but individual lines are
hundreds of kilobytes.** A `cli.js:3741` citation therefore identifies *a line*, not a
function, and the named token may appear far to the right of column 0.

Two verification disciplines were used, and both are stated rather than assumed:

1. **Line containment** — for a cite claiming identifier `X` on line `N`,
   `sed -n "${N}p" cli.js | grep -qF "X"` must succeed. Used for the loop entry points
   (`jhe`, `iyp`, `queryWithObserverTap`, `WOr`), the hook event list, and the compaction
   constants (`DISABLE_COMPACT`, `Rzo=0.2`).
2. **Phrase matching** — for behavioural claims, the exact quoted phrase, not just the
   identifier, was located on the cited line (88 claim→line pairs in R3).

Research R5 (Claude Desktop) uses a third form, `path:line@charOffset`, because its main
bundle is minified to a handful of physical lines: the offset is the byte position of the
quoted literal, obtained with `grep -Fob`. 114 offset cites were re-read and re-computed
from the extracted bytes with 0 mismatches.

## Extraction reproductions

`app.asar` and `ion-dist.asar` were unpacked with a ~40-line ASAR reader
(`.rea/extract.mjs`) rather than an npm tool, because the npm cache was not writable in
the sandbox:

```
{"src":"app.asar","out":"extracted-app","dataOffset":269448,"count":991,"bytes":89805996}
{"src":"ion-dist.asar","out":"extracted-ion","dataOffset":1337728,"count":5039,"bytes":201732876}
```

`app.asar` needed `integrity_policy=record-and-continue`: the declared hash of the unpacked
native binding `node_modules/@ant/claude-native/claude-native-binding.node` does not match
its companion file, which is normal for packaging tools that sign or strip native binaries
after writing the archive.

## Observations vs inferences vs unknowns

Kept separate throughout, as REA requires.

**Observed (static bytes):**
- Claude Code's harness is one Bun-bundled JavaScript file with a bytecode sidecar.
- Claude Desktop's main process is readable minified JS, **not** lost bytecode
  (`index.pre.js` 1,038,343 B); the three `compile-cache/*.arm64.jsc` files are V8 code
  caches *of* those same readable chunks.
- The desktop imports the Claude Agent SDK (`index.chunk-CqnLpjST.js` exports
  `query`, `createSdkMcpServer`, `tool`) and spawns the CLI with
  `--output-format stream-json --input-format stream-json`.
- The desktop's pinned CLI version is 2.1.317; the harness extracted and analysed here is
  2.1.231. Same product line, **different build**.
- The app ships six `.skill` archives and a `manifest.json` with per-skill `tier`.

**Inferred (bounded static hypotheses, not execution):**
- The 70-tool base inventory is the static `getAllBaseTools` array; the effective
  per-session pool varies with settings, deny rules, skills and MCP servers.
- Hook count (31 events) is the union of the declared event list; not every event was
  traced to a dispatch site.
- Permission ordering is read from `T4S`, not observed at runtime.

**Unknown / not established:**
- No original TypeScript or source maps exist in either extraction.
- `smol-bin.arm64.img` (the Cowork Linux VM image) was not parsed; Cowork execution is
  unobserved.
- Behaviour was **not** observed at runtime: no agent run, no network capture, no
  instrumentation. Everything about the harness is static analysis.
- The desktop was never launched on this machine (no `~/Library/Application Support/Claude`),
  so no desktop state or transcripts existed to compare against.

## What was deliberately not done

We did not copy Claude's code. `research/` records behaviour and names; `src/` is written
from scratch. Serialised protocol and file formats are documented because interoperability
requires them — a SKILL.md or a settings.json has to be understood to be honoured.
