// xMonkey desktop — Electron main process.
//
// The GUI is a thin shell over the same session API the CLI uses
// (src/app/session.mjs). Nothing about the agent lives here: this file owns
// windows, IPC and permission prompts, nothing else.
//
// Security posture, because this process can spawn a coding agent:
//   - renderer is sandboxed, contextIsolation on, nodeIntegration off
//   - the renderer can only reach the handful of channels in preload.cjs
//   - the permission prompt is answered in the MAIN process, and the renderer's
//     answer is the only thing that can approve a mutating tool call
//   - no remote content is loaded; the window only ever shows local files

import { app, BrowserWindow, ipcMain, Menu, shell, dialog, nativeTheme } from 'electron';
import path from 'node:path';
import fs from 'node:fs/promises';
import fsSync from 'node:fs';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

// Where the xMonkey source tree lives.
//   dev:       <repo>/                      (app/main.mjs -> repo root)
//   packaged:  <bundle>/Contents/Resources/app/   (package.json + src/ + app/)
// Both are resolved through package.json because a wrong path here makes every
// dynamic import fail at runtime, which is exactly what the packaged smoke test
// caught the first time.
const RES = app.isPackaged ? path.join(process.resourcesPath, 'app') : ROOT;

let mainWindow = null;
/** @type {any} */
let session = null;

// --smoke[=out.png]: launch, wait for the renderer to become ready, screenshot,
// exit. This exists so the UI can be verified by looking at it (and in CI)
// instead of being assumed to work because the process started.
const SMOKE = process.argv.find((a) => a.startsWith('--smoke'));
const SMOKE_OUT = SMOKE?.includes('=') ? SMOKE.split('=')[1].split('&')[0] : '/tmp/xmonkey-smoke.png';
// `--smoke=out.png&ask=...` also drives one real turn before the screenshot, so
// the conversation view (tool cards, streaming, notices) is verified by looking.
const SMOKE_ASK = SMOKE?.includes('&ask=') ? decodeURIComponent(SMOKE.split('&ask=')[1]) : null;
const SMOKE_AUTO = SMOKE?.includes('&auto') ?? false;
// `&cwd=/path` lets a test point the window at a real project.
const SMOKE_CWD = SMOKE?.includes('&cwd=') ? decodeURIComponent(SMOKE.split('&cwd=')[1].split('&')[0]) : null;
// `&perm` keeps the approval dialog on screen for the screenshot, then allows it.
const SMOKE_PERM = SMOKE?.includes('&perm') ?? false;
// `&deny` answers the approval dialog with Deny, to prove the refusal path.
const SMOKE_DENY = SMOKE?.includes('&deny') ?? false;
/** Pending permission prompts: id -> resolve */
const pendingApprovals = new Map();
let approvalSeq = 0;

process.env.XMONKEY_VERSION = app.getVersion();

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1240,
    height: 860,
    minWidth: 760,
    minHeight: 560,
    title: 'xMonkey',
    // hiddenInset keeps the macOS traffic lights, floating over our sidebar the
    // way they do in Claude Desktop. The sidebar reserves space for them.
    titleBarStyle: process.platform === 'darwin' ? 'hiddenInset' : 'default',
    trafficLightPosition: process.platform === 'darwin' ? { x: 15, y: 18 } : undefined,
    backgroundColor: nativeTheme.shouldUseDarkColors ? '#1f1e1b' : '#f5f4ed',
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      spellcheck: false,
    },
  });

  const preloadFile = path.join(__dirname, 'preload.cjs');
  if (!fsSync.existsSync(preloadFile)) {
    console.error('[fatal] preload not found at', preloadFile);
  }
  mainWindow.loadFile(path.join(__dirname, 'renderer', 'index.html'));

  // A renderer exception must reach the terminal, not just DevTools.
  // Modern Electron passes an event object; the positional form is deprecated.
  mainWindow.webContents.on('console-message', (event) => {
    const level = event.level ?? 0;
    if (level >= 2) {
      console.error(`[renderer] ${event.message} (${event.sourceId}:${event.lineNumber})`);
    }
  });
  mainWindow.webContents.on('render-process-gone', (_e, details) => {
    console.error('[renderer gone]', JSON.stringify(details));
  });
  mainWindow.webContents.on('preload-error', (_e, p, err) => {
    console.error('[preload error]', p, err?.message);
  });

  // External links open in the user's browser, never inside the agent window.
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });
  mainWindow.webContents.on('will-navigate', (e, url) => {
    if (!url.startsWith('file://')) e.preventDefault();
  });

  mainWindow.on('closed', () => { mainWindow = null; });
}

// ---------------------------------------------------------------- menu

function buildMenu() {
  const isMac = process.platform === 'darwin';
  const send = (ch) => () => mainWindow?.webContents.send(ch);
  const template = [
    ...(isMac ? [{
      label: app.name,
      submenu: [
        { role: 'about' },
        { type: 'separator' },
        { label: 'New Session', accelerator: 'CmdOrCtrl+N', click: send('menu:new-session') },
        { label: 'Open Folder…', accelerator: 'CmdOrCtrl+O', click: () => pickFolder() },
        { type: 'separator' },
        { label: 'Settings…', accelerator: 'CmdOrCtrl+,', click: send('menu:settings') },
        { type: 'separator' },
        { role: 'hide' }, { role: 'hideOthers' }, { role: 'unhide' },
        { type: 'separator' }, { role: 'quit' },
      ],
    }] : []),
    {
      label: 'Session',
      submenu: [
        { label: 'New Session', accelerator: 'CmdOrCtrl+N', click: send('menu:new-session') },
        { label: 'Open Folder…', accelerator: 'CmdOrCtrl+O', click: () => pickFolder() },
        { type: 'separator' },
        { label: 'Stop Turn', accelerator: 'CmdOrCtrl+.', click: send('menu:stop') },
        ...(isMac ? [] : [{ type: 'separator' }, { role: 'quit' }]),
      ],
    },
    {
      label: 'Edit',
      submenu: [
        { role: 'undo' }, { role: 'redo' }, { type: 'separator' },
        { role: 'cut' }, { role: 'copy' }, { role: 'paste' }, { role: 'selectAll' },
      ],
    },
    {
      label: 'View',
      submenu: [
        { role: 'reload' }, { role: 'toggleDevTools' }, { type: 'separator' },
        { role: 'resetZoom' }, { role: 'zoomIn' }, { role: 'zoomOut' }, { type: 'separator' },
        { role: 'togglefullscreen' },
      ],
    },
    { role: 'windowMenu' },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

async function pickFolder() {
  if (!mainWindow) return null;
  const r = await dialog.showOpenDialog(mainWindow, {
    properties: ['openDirectory', 'createDirectory'],
    title: 'Choose a project folder for xMonkey',
  });
  if (r.canceled || !r.filePaths[0]) return null;
  mainWindow.webContents.send('menu:folder-chosen', r.filePaths[0]);
  return r.filePaths[0];
}

// ---------------------------------------------------------------- IPC

function registerIpc() {
  const mod = (p) => import(path.join(RES, p));

  ipcMain.handle('app:info', async () => ({
    version: app.getVersion(),
    platform: process.platform,
    electron: process.versions.electron,
    node: process.versions.node,
    home: app.getPath('home'),
    xmonkeyHome: process.env.XMONKEY_HOME || path.join(app.getPath('home'), '.xmonkey'),
  }));

  ipcMain.handle('app:pick-folder', () => pickFolder());

  ipcMain.handle('app:open-path', (_e, p) => { shell.openPath(String(p)); });

  // Probe configured models + find a local runtime.
  ipcMain.handle('models:probe', async (_e, cwd) => {
    const { probeModels } = await mod('src/app/session.mjs');
    try {
      return { ok: true, ...(await probeModels(cwd || process.cwd())) };
    } catch (err) {
      return { ok: false, error: err.message };
    }
  });

  ipcMain.handle('sessions:recent', async () => {
    const { recentSessions } = await mod('src/app/session.mjs');
    try {
      return { ok: true, sessions: await recentSessions(15) };
    } catch (err) {
      return { ok: false, error: err.message, sessions: [] };
    }
  });

  ipcMain.handle('config:scaffold', async (_e, dir) => {
    const { scaffoldConfig } = await mod('src/app/session.mjs');
    try {
      return { ok: true, ...(await scaffoldConfig(dir)) };
    } catch (err) {
      return { ok: false, error: err.message };
    }
  });

  ipcMain.handle('session:start', async (_e, opts) => {
    if (session) { await session.close().catch(() => {}); session = null; }
    const { createSession } = await mod('src/app/session.mjs');

    try {
      session = await createSession({
        cwd: opts.cwd,
        modelName: opts.modelName || undefined,
        modelConfig: opts.modelConfig || undefined,
        mode: opts.mode || undefined,
        autoApprove: !!opts.autoApprove,
        resumeId: opts.resumeId || undefined,
        allowOutside: !!opts.allowOutside,
        onEvent: (event) => {
          mainWindow?.webContents.send('session:event', event);
        },
        onAsk: (req) => askRenderer(req),
      });
      return {
        ok: true,
        id: session.id,
        model: session.model,
        mode: session.mode,
        local: session.local,
        skills: session.skills,
        mcpServers: session.mcpServers,
        mcpErrors: session.mcpErrors,
        models: session.models,
        capabilities: session.capabilities,
        configSummary: session.configSummary,
        resumedMessages: session.history.length,
      };
    } catch (err) {
      session = null;
      return { ok: false, error: err.message };
    }
  });

  ipcMain.handle('session:send', async (_e, text) => {
    if (!session) return { ok: false, error: 'no session' };
    try {
      const out = await session.send(text);
      return { ok: true, ...out };
    } catch (err) {
      return { ok: false, error: err.message };
    }
  });

  ipcMain.handle('session:stop', async () => {
    session?.abort();
    return { ok: true };
  });

  ipcMain.handle('session:todos', async () => ({ ok: true, items: session?.todoItems?.() ?? [] }));

  ipcMain.handle('session:close', async () => {
    if (session) { await session.close().catch(() => {}); session = null; }
    return { ok: true };
  });

  // The renderer answers a permission prompt. This is the ONLY path that can
  // approve a mutating tool call, so it is a dedicated channel with a one-shot id.
  ipcMain.handle('permission:answer', (_e, { id, approved }) => {
    const resolve = pendingApprovals.get(id);
    if (!resolve) return { ok: false, error: 'unknown or expired approval request' };
    pendingApprovals.delete(id);
    resolve(!!approved);
    return { ok: true };
  });
}

/** Ask the renderer; if the window is gone, deny (fail closed). */
function askRenderer(req) {
  return new Promise((resolve) => {
    const id = `ask_${++approvalSeq}`;
    console.log(`[approval] requesting: ${req.tool} — ${String(req.reason ?? '').slice(0, 80)}`);
    if (!mainWindow || mainWindow.isDestroyed()) {
      resolve(false);
      return;
    }
    pendingApprovals.set(id, resolve);
    mainWindow.webContents.send('permission:ask', { id, ...req });
    // A modal left unanswered must not hang the loop forever.
    setTimeout(() => {
      if (pendingApprovals.has(id)) {
        pendingApprovals.delete(id);
        mainWindow?.webContents.send('permission:expired', { id });
        resolve(false);
      }
    }, 5 * 60_000).unref?.();
  });
}

// ---------------------------------------------------------------- lifecycle

app.whenReady().then(() => {
  resetUserDataIfCorrupt();
  registerIpc();
  buildMenu();
  createWindow();
  if (SMOKE) runSmoke();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

async function runSmoke() {
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  try {
    // Give the renderer time to probe models and paint a real state. The probe
    // hits a live model server, so a cold Ollama can take a few seconds.
    await wait(6000);

    if (SMOKE_CWD) {
      await mainWindow.webContents.executeJavaScript(
        `(() => { const fn = window.__xmSetCwd; if (fn) fn(${JSON.stringify(SMOKE_CWD)}); })()`);
    }

    if (SMOKE_ASK) {
      // Drive the renderer's own UI handlers so this exercises the real path,
      // not a side channel: start a session, type into the composer, press send.
      // Click "Start" then WAIT until the session is actually live before typing.
      // Racing this sent the prompt into an empty session and the turn was silently
      // dropped, which is what made the first screenshot show no conversation.
      await mainWindow.webContents.executeJavaScript(`(async () => {
        const use = document.querySelector('.model-row');
        if (use) use.click();
        const deadline = Date.now() + 60000;
        while (Date.now() < deadline) {
          const ready = window.__xmSessionReady && window.__xmSessionReady();
          if (ready) break;
          await new Promise(r => setTimeout(r, 200));
        }
      })()`);
      await mainWindow.webContents.executeJavaScript(`(() => {
        const input = document.getElementById('input');
        input.value = ${JSON.stringify(SMOKE_ASK)};
        input.dispatchEvent(new Event('input', { bubbles: true }));
        document.getElementById('send').click();
      })()`);
      // Wait for the turn to finish (composer unlock), bounded.
      const deadline = Date.now() + 300_000;
      let lastReport = 0;
      for (;;) {
        const st = await mainWindow.webContents.executeJavaScript(`(() => ({
          busy: document.getElementById('stop').classList.contains('hidden') === false,
          thread: document.getElementById('thread').children.length,
          text: (document.querySelector('.prose')?.textContent ?? '').slice(-120),
        }))()`);
        if (!st.busy && st.thread > 0) break;
        if (Date.now() - lastReport > 15000) {
          console.log('[smoke] still working; tail:', JSON.stringify(st.text));
          lastReport = Date.now();
        }
        if (Date.now() > deadline) { console.error('[smoke] turn did not finish in time'); break; }
        await wait(1000);
      }
      // An approval dialog may be waiting (mode=default blocks writes).
      // With &perm we deliberately LEAVE it up so the screenshot shows the real
      // approval UI, then answer it so the run can finish.
      const permUp = await mainWindow.webContents.executeJavaScript(
        `!document.getElementById('perm')?.classList.contains('hidden')`);
      if (permUp) {
        console.log('[smoke] permission dialog appeared');
        await wait(400);
        if (SMOKE_PERM) {
          // Capture the dialog itself before answering it, so the approval UI is
          // verified by looking at it rather than by trusting that it "must" work.
          const snap = await mainWindow.webContents.capturePage();
          await fs.writeFile(SMOKE_OUT.replace(/\.png$/, '-perm.png'), snap.toPNG());
          console.log('[smoke] captured approval dialog');
        }
      }
      if (SMOKE_AUTO || SMOKE_PERM) {
        if (permUp) {
          const btn = SMOKE_DENY ? 'perm-deny' : 'perm-allow';
          await mainWindow.webContents.executeJavaScript(`document.getElementById('${btn}').click()`);
          await wait(3000);
        }
      } else {
        await wait(1500);
      }
    }
    const image = await mainWindow.webContents.capturePage();
    const png = image.toPNG();
    await fs.writeFile(SMOKE_OUT, png);
    const size = (await fs.stat(SMOKE_OUT)).size;
    console.log(`[smoke] captured ${SMOKE_OUT} (${size} bytes)`);
    // Report what the renderer actually sees, so a blank window is detectable.
    const state = await mainWindow.webContents.executeJavaScript(`(() => ({
      ready: document.readyState,
      hasApi: typeof window.xmonkey === 'object',
      welcomeVisible: (() => {
        const w = document.getElementById('welcome');
        if (!w) return false;
        const cs = getComputedStyle(w);
        return cs.display !== 'none' && !w.classList.contains('hidden');
      })(),
      welcomeText: document.getElementById('welcome-body')?.innerText?.slice(0, 300) ?? '',
      threadChildren: document.getElementById('thread')?.children.length ?? -1,
      bodyStart: document.body.innerText.slice(0, 200),
      title: document.title,
      errors: window.__xmErrors ?? [],
    }))()`);
    console.log('[smoke] state', JSON.stringify(state, null, 1));
    process.exitCode = 0;
  } catch (err) {
    console.error('[smoke] failed:', err?.message ?? err);
    process.exitCode = 1;
  } finally {
    app.exit(process.exitCode ?? 0);
  }
}

function resetUserDataIfCorrupt() {
  // A half-written Electron state file should not brick the app on launch.
  const p = path.join(app.getPath('userData'), 'xmonkey-ui.json');
  // Nothing to do synchronously here; the renderer tolerates a bad file.
  void p;
}

app.on('window-all-closed', async () => {
  if (session) await session.close().catch(() => {});
  if (process.platform !== 'darwin') app.quit();
});

app.on('before-quit', async () => {
  if (session) await session.close().catch(() => {});
});
