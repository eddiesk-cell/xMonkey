// xMonkey desktop — renderer.
//
// Plain DOM, no framework, no build step. The renderer owns presentation only:
// it sends a prompt, renders the event stream, and answers permission prompts.
// Everything that can touch the filesystem lives in the main process.

window.__xmErrors = [];
window.addEventListener('error', (e) => window.__xmErrors.push(`${e.message} @ ${e.filename}:${e.lineno}:${e.colno}`));
window.addEventListener('unhandledrejection', (e) => window.__xmErrors.push(String(e.reason?.message ?? e.reason)));

const api = window.xmonkey;
const $ = (id) => document.getElementById(id);

const ui = {
  cwd: null,
  sessionId: null,
  modelName: null,
  mode: 'default',
  busy: false,
  models: [],
  pendingPerm: null,
  assistantEl: null,
  thinkingEl: null,
  toolEls: new Map(),
};

const MODE_LABEL = {
  plan: 'plan · read-only',
  default: 'default',
  acceptEdits: 'accept edits',
  dontAsk: 'dont ask',
  bypass: 'bypass',
  auto: 'auto',
};
const MODE_DESC = {
  plan: 'Only reads. Mutating tools are refused.',
  default: 'Reads allowed; writes and shell ask first.',
  acceptEdits: 'File edits allowed; shell still asks.',
  dontAsk: 'Never prompts. Anything that would ask is denied.',
  bypass: 'Everything allowed, nothing asks. Careful.',
  auto: 'Safe work allowed; the rest asks.',
};

// ---------------------------------------------------------------- boot

async function boot() {
  const info = await api.version();
  document.body.classList.toggle('mac', info.platform === 'darwin');
  $('model-btn').textContent = 'model…';
  $('mode-btn').textContent = MODE_LABEL[ui.mode];

  // Restore last folder, else start in the home directory.
  let saved = null;
  try { saved = localStorage.getItem('xm.cwd'); } catch { /* storage blocked */ }
  ui.cwd = saved || info.home;
  setCwd(ui.cwd);

  wireComposer();
  wireMenu();
  wirePermission();

  api.onEvent(handleEvent);
  api.onPermissionAsk(showPermission);
  api.onPermissionExpired(() => { if (ui.pendingPerm) closePermission(false); });

  await firstRun();
}

async function firstRun() {
  const probe = await api.probeModels(ui.cwd);
  const body = $('welcome-body');

  if (!probe.ok) {
    body.innerHTML = `<p class="sub">Could not read configuration: ${esc(probe.error ?? 'unknown error')}</p>
      <div class="welcome-actions"><button class="btn primary" id="w-init">Create a config file</button></div>`;
    $('w-init').onclick = async () => {
      const r = await api.scaffoldConfig(ui.cwd);
      body.innerHTML = `<p class="sub">${r.ok ? `Created ${esc(r.path)}` : esc(r.error)}</p>`;
    };
    return;
  }

  const live = (probe.results ?? []).filter((r) => r.ok);
  const dead = (probe.results ?? []).filter((r) => !r.ok);

  if (!probe.selected && !live.length) {
    body.innerHTML = `
      <p class="sub">No model found yet. Start one, and this window will pick it up.</p>
      <div class="welcome-list">
        <div class="model-row"><span class="dot bad"></span>
          <div><div class="m-name">Ollama</div>
          <div class="m-meta">ollama serve</div></div></div>
      </div>
      <p class="sub" style="margin-top:18px;font-size:12.5px">
        Then <b>ollama pull qwen2.5-coder:7b</b> — or set an API key for a cloud model.
      </p>
      <div class="welcome-actions">
        <button class="btn" id="w-rescan">Check again</button>
        <button class="btn" id="w-init">Create config</button>
      </div>`;
    $('w-rescan').onclick = () => { body.innerHTML = '<div class="checking"><span class="spinner"></span> Looking…</div>'; setTimeout(firstRun, 200); };
    $('w-init').onclick = async () => {
      const r = await api.scaffoldConfig(ui.cwd);
      body.innerHTML = `<p class="sub">${r.ok ? `Created ${esc(r.path)}` : esc(r.error)}</p>`;
    };
    return;
  }

  const isEmbedding = (m) => /embed|nomic|minilm|rerank|bge|e5-/i.test(m);
  const rows = live.map((r) => {
    // An embedding model cannot chat, let alone call tools. Listing it as a
    // choice is how a user ends up with a broken session and no idea why.
    const chat = (r.models ?? []).filter((m) => !isEmbedding(m));
    const models = chat.slice(0, 3).join(', ');
    const isSel = r.name === probe.selected;
    return `<button class="model-row" data-model="${esc(r.name)}">
      <span class="dot ok"></span>
      <div style="min-width:0">
        <div class="m-name">${esc(r.name)}${isSel ? ' <span class="badge">default</span>' : ''}</div>
        <div class="m-meta">${esc(r.kind)} · ${esc(models || 'no chat models listed')}</div>
      </div>
      <span class="m-go">Use →</span>
    </button>`;
  }).join('');

  const deadNote = dead.length
    ? `<p class="sub" style="margin-top:14px;font-size:12px">Not reachable: ${dead.map((d) => esc(d.name)).join(', ')}</p>`
    : '';

  body.innerHTML = `
    ${probe.detected ? `<p class="sub" style="margin-bottom:14px">${esc(probe.detected)}</p>` : ''}
    <div class="welcome-list">${rows}</div>
    ${deadNote}
    <div class="welcome-actions">
      <button class="btn" id="w-folder">Choose a different folder…</button>
    </div>`;

  for (const el of body.querySelectorAll('.model-row')) {
    el.onclick = () => {
      ui.modelName = probe.selected;
      ui.modelConfig = probe.selectedConfig;
      startSession(probe.selected);
    };
  }
  $('w-folder').onclick = chooseFolder;
}

// ---------------------------------------------------------------- session

async function startSession(modelName) {
  setBusy(true);
  clearThread();
  showThreadHint('Starting…');

  const r = await api.startSession({
    cwd: ui.cwd,
    modelName: modelName || undefined,
    modelConfig: ui.modelConfig || undefined,
    mode: ui.mode,
  });

  if (!r.ok) {
    clearThread();
    setBusy(false);
    renderNotice(`Could not start: ${r.error}`, 'error');
    return;
  }

  ui.sessionId = r.id;
  ui.modelName = r.model.name;
  ui.models = r.models ?? [];
  ui.mode = r.mode;
  $('session-badge').textContent = r.id.slice(-4);
  $('session-badge').classList.remove('hidden');
  $('model-btn').textContent = r.model.model;
  $('model-btn').classList.add('accent');
  $('mode-btn').textContent = MODE_LABEL[r.mode] ?? r.mode;
  $('mode-btn').classList.toggle('warn-mode', r.mode === 'bypass');
  $('hint-mode').textContent = MODE_LABEL[r.mode] ?? r.mode;
  $('welcome').classList.add('hidden');

  // Surface anything the user should know before they type.
  const notes = [];
  if (r.local) notes.push('running locally');
  if (r.skills?.length) notes.push(`${r.skills.length} skill(s)`);
  if (r.mcpServers?.length) notes.push(`mcp: ${r.mcpServers.map((s) => s.name).join(', ')}`);
  if (r.mcpErrors?.length) notes.push(`${r.mcpErrors.length} mcp server(s) failed`);
  if (r.resumedMessages) notes.push(`resumed ${r.resumedMessages} messages`);
  showThreadHint(notes.join(' · '));

  setBusy(false);
  $('input').focus();
}

function showThreadHint(text) {
  const hint = $('status-strip');
  if (!text) { hint.classList.add('hidden'); hint.textContent = ''; return; }
  hint.classList.remove('hidden');
  hint.textContent = text;
}

// ---------------------------------------------------------------- events

function handleEvent(e) {
  switch (e.type) {
    case 'user':
      ui.assistantEl = null;
      ui.thinkingEl = null;
      ui.toolEls.clear();
      appendUser(e.text);
      break;

    case 'turn_start':
      setBusy(true);
      ui.assistantEl = null;
      break;

    case 'thinking':
      appendThinking(e.text);
      break;

    case 'text':
      appendAssistantText(e.text);
      break;

    case 'tool_use':
      appendToolUse(e);
      break;

    case 'tool_result':
      finishToolUse(e);
      break;

    case 'notice':
      renderNotice(e.message, e.level);
      break;

    case 'usage':
      // Token counts are useful but not worth a permanent line; debug only.
      if (window.__xmDebug) console.log('usage', e.usage);
      break;

    case 'done':
      break;

    case 'turn_done':
      setBusy(false);
      finalizeAssistant();
      break;

    case 'turn_error':
      setBusy(false);
      renderNotice(e.message, 'error');
      break;

    default:
      break;
  }
}

// ---------------------------------------------------------------- rendering

const thread = () => $('thread');

function clearThread() {
  thread().innerHTML = '';
  ui.assistantEl = null;
  ui.thinkingEl = null;
  ui.toolEls.clear();
}

function atBottom() {
  const t = thread();
  return t.scrollHeight - t.scrollTop - t.clientHeight < 120;
}
function scrollDown(force = false) {
  const t = thread();
  if (force || atBottom()) t.scrollTop = t.scrollHeight;
}

function appendUser(text) {
  const el = document.createElement('div');
  el.className = 'msg user';
  el.innerHTML = `<div class="msg-head"><span class="who">You</span></div>
    <div class="msg-body"></div>`;
  el.querySelector('.msg-body').textContent = text;
  thread().appendChild(el);
  scrollDown(true);
}

function appendThinking(text) {
  if (!ui.thinkingEl) {
    const el = document.createElement('details');
    el.className = 'thinking';
    el.innerHTML = `<summary>thinking…</summary><div class="thinking-body"></div>`;
    thread().appendChild(el);
    ui.thinkingEl = el;
    ui.thinkingBody = el.querySelector('.thinking-body');
  }
  // Keep the thinking buffer bounded: a long reasoning model should not grow the
  // DOM without limit. The last ~8k chars are the useful part.
  const next = (ui.thinkingBody.textContent + text);
  ui.thinkingBody.textContent = next.length > 8000 ? '…' + next.slice(-8000) : next;
  scrollDown();
}

function appendAssistantText(text) {
  if (!ui.assistantEl) {
    const el = document.createElement('div');
    el.className = 'msg assistant';
    el.innerHTML = `<div class="msg-head"><span class="who">xMonkey</span></div>
      <div class="msg-body cursor"></div>`;
    thread().appendChild(el);
    ui.assistantEl = el.querySelector('.msg-body');
    ui.rawText = '';
  }
  ui.rawText += text;
  ui.assistantEl.classList.add('cursor');
  ui.assistantEl.innerHTML = renderMarkdown(ui.rawText);
  scrollDown();
}

function finalizeAssistant() {
  if (ui.assistantEl) {
    ui.assistantEl.classList.remove('cursor');
    ui.assistantEl.innerHTML = renderMarkdown(ui.rawText ?? '');
    ui.assistantEl = null;
  }
  if (ui.thinkingEl) {
    ui.thinkingEl.querySelector('summary').textContent = 'thinking';
    ui.thinkingEl = null;
  }
}

const TOOL_ICON = {
  read: '📄', write: '💾', edit: '✏️', list: '📁', glob: '🔍', grep: '🔎',
  bash: '⌘', todo: '☑︎', skill: '🧩', task: '🤖',
};

function describeTool(name, input) {
  switch (name) {
    case 'read': return input.path ?? '';
    case 'write': return `${input.path ?? ''} (${(input.content ?? '').length} chars)`;
    case 'edit': return input.path ?? '';
    case 'list': return input.path ?? '.';
    case 'glob': return `${input.pattern ?? ''}${input.path ? ` in ${input.path}` : ''}`;
    case 'grep': return `/${input.pattern ?? ''}/${input.include ? ` in ${input.include}` : ''}`;
    case 'bash': return input.command ?? '';
    case 'todo': return `${input.todos?.length ?? 0} items`;
    default: return JSON.stringify(input ?? {}).slice(0, 120);
  }
}

function appendToolUse(e) {
  // A tool call ends the current assistant paragraph.
  finalizeAssistant();

  const el = document.createElement('div');
  el.className = 'tool';
  const icon = TOOL_ICON[e.name] ?? (e.name.startsWith('mcp__') ? '🔌' : '⚙');
  el.innerHTML = `
    <div class="tool-card">
      <div class="tool-head">
        <span class="tool-icon">${icon}</span>
        <span class="tool-name"></span>
        <span class="tool-args"></span>
        <span class="tool-status run">running…</span>
      </div>
      <div class="tool-out hidden"></div>
    </div>`;
  el.querySelector('.tool-name').textContent = e.name;
  el.querySelector('.tool-args').textContent = describeTool(e.name, e.input);
  const out = el.querySelector('.tool-out');
  el.querySelector('.tool-head').onclick = () => out.classList.toggle('hidden');

  thread().appendChild(el);
  ui.toolEls.set(e.id, el);
  scrollDown();
}

function finishToolUse(e) {
  const el = ui.toolEls.get(e.id);
  if (!el) return;
  const status = el.querySelector('.tool-status');
  status.textContent = e.isError ? 'failed' : 'done';
  status.className = `tool-status ${e.isError ? 'err' : 'ok'}`;

  const out = el.querySelector('.tool-out');
  const text = String(e.content ?? '');
  // Keep the visible output focused. The model sees the full result; the user
  // sees the part that answers "what happened?".
  const lines = text.split('\n');
  const shown = lines.slice(0, 24).join('\n');
  out.textContent = lines.length > 24 ? `${shown}\n… +${lines.length - 24} more line(s)` : shown;
  out.classList.toggle('err', !!e.isError);
  // A failure is worth seeing without a click.
  if (e.isError) out.classList.remove('hidden');

  scrollDown();
}

function renderNotice(message, level = 'info') {
  const el = document.createElement('div');
  el.className = `notice ${level}`;
  const icon = level === 'error' ? '✕' : level === 'warn' ? '!' : '·';
  el.textContent = `${icon} ${message}`;
  thread().appendChild(el);
  scrollDown();
}

function renderTodos(items) {
  document.querySelectorAll('.todos').forEach((n) => n.remove());
  if (!items?.length) return;
  const el = document.createElement('div');
  el.className = 'todos';
  el.innerHTML = items.map((t) => {
    const mark = t.status === 'completed' ? '✔' : t.status === 'in_progress' ? '▶' : '○';
    return `<div class="todo ${t.status}"><span>${mark}</span><span></span></div>`;
  }).join('');
  el.querySelectorAll('.todo').forEach((row, i) => {
    row.lastElementChild.textContent = items[i].content;
  });
  thread().appendChild(el);
  scrollDown();
}

/** Minimal markdown: fenced code, inline code, bold, headings, lists. */
function renderMarkdown(src) {
  const text = String(src ?? '');
  const blocks = [];
  // Pull fenced code out first so its contents are never treated as markdown.
  let rest = text.replace(/```([a-zA-Z0-9_+-]*)\n([\s\S]*?)(?:```|$)/g, (_m, lang, code) => {
    const i = blocks.push({ lang, code }) - 1;
    return `\u0000CODE${i}\u0000`;
  });
  const esc2 = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  rest = esc2(rest);
  rest = rest
    .replace(/^### (.+)$/gm, '<b>$1</b>')
    .replace(/^## (.+)$/gm, '<b>$1</b>')
    .replace(/^# (.+)$/gm, '<b>$1</b>')
    .replace(/\*\*([^*]+)\*\*/g, '<b>$1</b>')
    .replace(/`([^`]+)`/g, '<code>$1</code>');
  rest = rest.replace(/\u0000CODE(\d+)\u0000/g, (_m, n) => {
    const b = blocks[Number(n)];
    return `<pre><code>${esc2(b.code)}</code></pre>`;
  });
  return rest;
}

function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

// ---------------------------------------------------------------- composer

function wireComposer() {
  const input = $('input');
  const autosize = () => {
    input.style.height = 'auto';
    input.style.height = Math.min(200, input.scrollHeight) + 'px';
  };
  input.addEventListener('input', autosize);
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      submit();
    }
  });
  $('send').onclick = submit;
  $('stop').onclick = async () => { await api.stop(); };
  setBusy(false);
}

async function submit() {
  const input = $('input');
  const text = input.value.trim();
  if (!text || ui.busy) return;
  if (!ui.sessionId) { await startSession(ui.modelName); if (!ui.sessionId) return; }

  input.value = '';
  input.style.height = 'auto';
  setBusy(true);
  const r = await api.send(text);
  if (!r.ok) {
    renderNotice(r.error, 'error');
    setBusy(false);
  }
  if (r.ok) {
    const items = await api.todos();
    renderTodos(items.items);
  }
}

function setBusy(busy) {
  ui.busy = busy;
  $('send').disabled = busy;
  $('send').classList.toggle('hidden', busy);
  $('stop').classList.toggle('hidden', !busy);
  if (!busy) $('input').focus();
}

// ---------------------------------------------------------------- permissions

function wirePermission() {
  $('perm-allow').onclick = () => closePermission(true);
  $('perm-deny').onclick = () => closePermission(false);
  document.addEventListener('keydown', (e) => {
    if (!ui.pendingPerm) return;
    if (e.key === 'Enter') { e.preventDefault(); closePermission(true); }
    if (e.key === 'Escape') { e.preventDefault(); closePermission(false); }
  });
}

const RISKY = /\b(rm\s+-rf|git\s+push\s+--force|sudo|mkfs|dd\s+if=|chmod\s+777|drop\s+table)\b/i;

function showPermission(req) {
  ui.pendingPerm = req;
  $('perm-tool').textContent = req.reason ?? req.tool;
  const detail = req.input?.command
    ? req.input.command
    : req.input?.path
      ? `${req.input.path}${req.input.content ? `\n${String(req.input.content).slice(0, 300)}` : ''}`
      : JSON.stringify(req.input ?? {}, null, 2).slice(0, 800);
  $('perm-detail').textContent = detail;

  const danger = RISKY.test(detail) || (req.tool === 'bash' && /rm |mv |git reset/.test(detail));
  $('perm-title').textContent = danger ? 'This looks destructive — approve?' : 'Approve this action?';
  $('perm-allow').textContent = danger ? 'Allow anyway' : 'Allow once';
  $('perm').classList.remove('hidden');
  $('perm-allow').focus();
}

async function closePermission(approved) {
  const req = ui.pendingPerm;
  if (!req) return;
  ui.pendingPerm = null;
  $('perm').classList.add('hidden');
  await api.answerPermission(req.id, approved);
}

// ---------------------------------------------------------------- pickers

function wireMenu() {
  $('folder-btn').onclick = chooseFolder;
  $('new-btn').onclick = () => startSession(ui.modelName);
  $('model-btn').onclick = openModelPicker;
  $('mode-btn').onclick = openModePicker;
  api.onMenu('new-session', () => startSession(ui.modelName));
  api.onMenu('folder-chosen', (p) => { setCwd(p); startSession(ui.modelName); });
  api.onMenu('stop', () => api.stop());
  api.onMenu('settings', () => openModePicker());
}

async function chooseFolder() {
  const p = await api.pickFolder();
  if (p) { setCwd(p); await startSession(ui.modelName); }
}

// Exposed only so the app's own smoke test can point the window at a project
// without a native folder dialog. It is a no-op for normal use.
window.__xmSetCwd = (p) => { setCwd(p); };

function setCwd(p) {
  ui.cwd = p;
  try { localStorage.setItem('xm.cwd', p); } catch { /* ignore */ }
  const short = p.replace(/^\/Users\/[^/]+/, '~');
  $('cwd-label').textContent = short;
  $('folder-btn').title = p;
}

function openPicker(title, html, wire) {
  $('picker-title').textContent = title;
  $('picker-body').innerHTML = html;
  $('picker').classList.remove('hidden');
  $('picker-close').onclick = () => $('picker').classList.add('hidden');
  if (wire) wire();
}

function openModelPicker() {
  const groups = { local: [], cloud: [] };
  for (const m of ui.models) {
    (['ollama', 'lmstudio', 'llama.cpp', 'vllm'].includes(m.kind) ? groups.local : groups.cloud).push(m);
  }
  const row = (m) => `<button class="pick-item ${m.name === ui.modelName ? 'active' : ''}" data-name="${esc(m.name)}">
      <div style="min-width:0">
        <div class="pick-name">${esc(m.name)}</div>
        <div class="pick-meta">${esc(m.kind)} · ${esc(m.model)}</div>
      </div>
    </button>`;
  const html = [
    groups.local.length ? `<div class="pick-group">Local</div>${groups.local.map(row).join('')}` : '',
    groups.cloud.length ? `<div class="pick-group">Remote</div>${groups.cloud.map(row).join('')}` : '',
    !ui.models.length ? '<p class="sub">No models configured. Create xmonkey.config.json in the project folder.</p>' : '',
  ].join('');
  openPicker('Choose a model', html, () => {
    for (const el of $('picker-body').querySelectorAll('.pick-item')) {
      el.onclick = async () => {
        $('picker').classList.add('hidden');
        await startSession(el.dataset.name);
      };
    }
  });
}

function openModePicker() {
  const html = Object.keys(MODE_LABEL).map((m) => `
    <button class="pick-item ${m === ui.mode ? 'active' : ''}" data-mode="${m}">
      <div style="min-width:0">
        <div class="pick-name">${MODE_LABEL[m]}</div>
        <div class="pick-desc">${MODE_DESC[m]}</div>
      </div>
    </button>`).join('');
  openPicker('Permission mode', html, () => {
    for (const el of $('picker-body').querySelectorAll('.pick-item')) {
      el.onclick = async () => {
        ui.mode = el.dataset.mode;
        $('picker').classList.add('hidden');
        // A mode change takes effect on the next session, which is also when it
        // is reported back; keeping a live session's mode mutable would let the
        // mode shown in the UI drift from the mode actually enforced.
        await startSession(ui.modelName);
      };
    }
  });
}

// ---------------------------------------------------------------- go

boot().catch((err) => {
  document.body.innerHTML = `<pre style="padding:24px;color:#f87171">xMonkey failed to start:\n${esc(err.stack || err.message)}</pre>`;
});
