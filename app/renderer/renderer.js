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
  modelConfig: null,
  mode: 'default',
  busy: false,
  models: [],
  pendingPerm: null,
  assistantEl: null,
  rawText: '',
  thinkingEl: null,
  toolEls: new Map(),
};

const MODE_LABEL = {
  plan: 'plan',
  default: 'default',
  acceptEdits: 'accept edits',
  dontAsk: 'don’t ask',
  bypass: 'bypass',
  auto: 'auto',
};
const MODE_DESC = {
  plan: 'Read-only. Mutating tools are refused.',
  default: 'Reads are allowed; writes and shell ask first.',
  acceptEdits: 'File edits are allowed; shell still asks.',
  dontAsk: 'Never asks. Anything that would prompt is denied.',
  bypass: 'Everything is allowed, nothing asks. Be careful.',
  auto: 'Safe work is allowed; the rest asks.',
};

// ---------------------------------------------------------------- boot

async function boot() {
  const info = await api.version();
  document.body.classList.toggle('mac', info.platform === 'darwin');

  let saved = null;
  try { saved = localStorage.getItem('xm.cwd'); } catch { /* storage blocked */ }
  ui.cwd = saved || info.home;
  setCwd(ui.cwd);

  wireChrome();
  wireComposer();
  wirePermission();
  wireMenu();

  api.onEvent(handleEvent);
  api.onPermissionAsk(showPermission);
  api.onPermissionExpired(() => { if (ui.pendingPerm) closePermission(false); });

  renderRecents();
  await firstRun();
}

// ---------------------------------------------------------------- first run

async function firstRun() {
  const body = $('welcome-body');
  const probe = await api.probeModels(ui.cwd);

  if (!probe.ok) {
    body.innerHTML = `<div class="welcome-error">${esc(probe.error ?? 'could not read configuration')}</div>
      <div class="welcome-actions"><button class="btn primary" id="w-init">Create a config file</button></div>`;
    $('w-init').onclick = async () => {
      const r = await api.scaffoldConfig(ui.cwd);
      body.innerHTML = `<p class="welcome-note">${esc(r.ok ? `Created ${r.path}` : r.error)}</p>`;
    };
    return;
  }

  if (probe.selected && probe.selectedConfig) {
    ui.modelName = probe.selected;
    ui.modelConfig = probe.selectedConfig;
    // Reflect the detected model in the chrome immediately, so "Choose a model"
    // is not shown while a model is already available.
    $('model-name').textContent = probe.selectedConfig.model;
    $('composer-model').textContent = probe.selectedConfig.model;
  }

  const live = (probe.results ?? []).filter((r) => r.ok);
  const dead = (probe.results ?? []).filter((r) => !r.ok);

  if (!probe.selected) {
    body.innerHTML = `
      <div class="welcome-error">No model found. Start one and try again.</div>
      <div class="welcome-list" style="margin-top:14px">
        <div class="model-row"><span class="dot bad"></span>
          <div><div class="m-name">Ollama</div><div class="m-meta">ollama serve</div></div></div>
      </div>
      <p class="welcome-note">Then <b>ollama pull qwen2.5-coder:7b</b>, or set an API key for a cloud model.</p>
      <div class="welcome-actions">
        <button class="btn" id="w-rescan">Check again</button>
        <button class="btn" id="w-init">Create config</button>
        <button class="btn" id="w-folder">Choose folder…</button>
      </div>`;
    $('w-rescan').onclick = () => { body.innerHTML = '<div class="welcome-checking"><span class="spinner"></span> Looking…</div>'; setTimeout(firstRun, 150); };
    $('w-init').onclick = async () => {
      const r = await api.scaffoldConfig(ui.cwd);
      body.innerHTML = `<p class="welcome-note">${esc(r.ok ? `Created ${r.path}` : r.error)}</p>`;
    };
    $('w-folder').onclick = chooseFolder;
    return;
  }

  const isEmbedding = (m) => /embed|nomic|minilm|rerank|bge|e5-/i.test(m);
  const rows = live.map((r) => {
    const chat = (r.models ?? []).filter((m) => !isEmbedding(m));
    const isSel = r.name === probe.selected;
    const title = isSel ? (probe.selectedConfig?.model ?? r.name) : r.name;
    return `<button class="model-row" data-model="${esc(r.name)}">
      <span class="dot ok"></span>
      <div style="min-width:0">
        <div class="m-name">${esc(title)}${isSel ? ' · ready' : ''}</div>
        <div class="m-meta">${esc(r.kind)}${chat.length ? ` · ${esc(chat.slice(0, 2).join(', '))}` : ''}</div>
      </div>
      <span class="m-go">Start →</span>
    </button>`;
  }).join('');

  const deadNote = dead.length
    ? `<p class="welcome-note">Not reachable: ${dead.map((d) => esc(d.name)).join(', ')}</p>`
    : '';

  body.innerHTML = `
    ${probe.detected ? `<p class="welcome-note" style="margin-top:0;margin-bottom:14px">${esc(probe.detected)}</p>` : ''}
    <div class="welcome-list">${rows}</div>
    ${deadNote}
    <div class="welcome-actions"><button class="btn" id="w-folder">Choose a different folder…</button></div>`;

  for (const el of body.querySelectorAll('.model-row')) {
    el.onclick = () => startSession(probe.selected);
  }
  $('w-folder').onclick = chooseFolder;
}

// ---------------------------------------------------------------- session

async function startSession(modelName) {
  clearThread();
  setBusy(true);
  hideWelcome();

  const r = await api.startSession({
    cwd: ui.cwd,
    modelName: modelName || ui.modelName || undefined,
    modelConfig: ui.modelConfig || undefined,
    mode: ui.mode,
  });

  if (!r.ok) {
    setBusy(false);
    clearThread();
    renderGreeting();
    renderNotice(`Could not start: ${r.error}`, 'error');
    showWelcome();
    return;
  }

  ui.sessionId = r.id;
  ui.modelName = r.model.name;
  ui.models = r.models ?? [];
  ui.mode = r.mode;

  $('model-name').textContent = r.model.model;
  $('model-btn').classList.add('accent');
  $('mode-name').textContent = MODE_LABEL[r.mode] ?? r.mode;
  $('mode-btn').classList.toggle('warn', r.mode === 'bypass');
  $('composer-model').textContent = r.model.model;

  clearThread();
  renderGreeting();

  const notes = [];
  if (r.local) notes.push('running on this machine');
  if (r.skills?.length) notes.push(`${r.skills.length} skill${r.skills.length > 1 ? 's' : ''}`);
  if (r.mcpServers?.length) notes.push(`mcp: ${r.mcpServers.map((s) => s.name).join(', ')}`);
  if (r.mcpErrors?.length) notes.push(`${r.mcpErrors.length} mcp server(s) failed`);
  if (r.resumedMessages) notes.push(`resumed ${r.resumedMessages} messages`);
  setStatus(notes);

  setBusy(false);
  renderRecents();
  $('input').focus();
}

/** The start screen occupies real space, so it must be removed, not just faded. */
function hideWelcome() {
  const w = $('welcome');
  w.classList.add('hidden');
  w.style.display = 'none';
}
function showWelcome() {
  const w = $('welcome');
  w.classList.remove('hidden');
  w.style.display = '';
}

function setStatus(notes) {
  const strip = $('status-strip');
  if (!notes?.length) { strip.classList.add('hidden'); strip.innerHTML = ''; return; }
  strip.classList.remove('hidden');
  strip.innerHTML = `<span class="dot"></span>${esc(notes.join('  ·  '))}`;
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
  return t.scrollHeight - t.scrollTop - t.clientHeight < 140;
}
function scrollDown(force = false) {
  const t = thread();
  if (force || atBottom()) t.scrollTop = t.scrollHeight;
}

function renderGreeting() {
  const t = thread();
  t.classList.add('empty');
  if (t.querySelector('.greeting')) return;
  const el = document.createElement('div');
  el.className = 'greeting';
  el.innerHTML = `
    <h2>What should we build?</h2>
    <p>Describe a task, ask about the code, or point me at a bug.</p>
    <div class="suggestions">
      ${[
        'Explain the architecture of this project',
        'Find and fix the failing test',
        'Add a CLI flag and document it',
        'Review my last commit for bugs',
      ].map((s) => `<button class="suggestion" data-prompt="${esc(s)}">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><path d="M5 12h14M13 6l6 6-6 6"/></svg>
          <span>${esc(s)}</span>
        </button>`).join('')}
    </div>`;
  for (const b of el.querySelectorAll('.suggestion')) {
    b.onclick = () => { $('input').value = b.dataset.prompt; submit(); };
  }
  t.appendChild(el);
}

function removeGreeting() {
  thread().querySelector('.greeting')?.remove();
}

function appendUser(text) {
  thread().classList.remove('empty');
  removeGreeting();
  const el = document.createElement('div');
  el.className = 'turn user';
  el.innerHTML = '<div class="bubble"></div>';
  el.querySelector('.bubble').textContent = text;
  thread().appendChild(el);
  scrollDown(true);
}

function appendThinking(text) {
  if (!ui.thinkingEl) {
    const el = document.createElement('details');
    el.className = 'thinking';
    el.innerHTML = `<summary><svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M9 18l6-6-6-6"/></svg><span>Thinking…</span></summary><div class="t-body"></div>`;
    thread().appendChild(el);
    ui.thinkingEl = el;
    ui.thinkingBody = el.querySelector('.t-body');
  }
  const next = ui.thinkingBody.textContent + text;
  ui.thinkingBody.textContent = next.length > 8000 ? '…' + next.slice(-8000) : next;
  scrollDown();
}

function appendAssistantText(text) {
  if (!ui.assistantEl) {
    removeGreeting();
    const el = document.createElement('div');
    el.className = 'turn assistant';
    el.innerHTML = '<div class="prose streaming-caret"></div>';
    thread().appendChild(el);
    ui.assistantEl = el.querySelector('.prose');
    ui.rawText = '';
  }
  ui.rawText += text;
  ui.assistantEl.classList.add('streaming-caret');
  ui.assistantEl.innerHTML = renderMarkdown(ui.rawText);
  scrollDown();
}

function finalizeAssistant() {
  if (ui.assistantEl) {
    ui.assistantEl.classList.remove('streaming-caret');
    ui.assistantEl.innerHTML = renderMarkdown(ui.rawText ?? '');
    ui.assistantEl = null;
    ui.rawText = '';
  }
  if (ui.thinkingEl) {
    ui.thinkingEl.querySelector('summary span').textContent = 'Thought for a moment';
    ui.thinkingEl = null;
  }
}

function describeTool(name, input) {
  switch (name) {
    case 'read': return input.path ?? '';
    case 'write': return `${input.path ?? ''} · ${(input.content ?? '').length} chars`;
    case 'edit': return input.path ?? '';
    case 'list': return input.path || '.';
    case 'glob': return `${input.pattern ?? ''}${input.path ? ` in ${input.path}` : ''}`;
    case 'grep': return `/${input.pattern ?? ''}/`;
    case 'bash': return input.command ?? '';
    case 'todo': return `${input.todos?.length ?? 0} items`;
    case 'skill': return input.name ?? '';
    case 'task': return input.description ?? '';
    default: return JSON.stringify(input ?? {}).slice(0, 100);
  }
}

function appendToolUse(e) {
  finalizeAssistant();
  removeGreeting();
  const el = document.createElement('div');
  el.className = 'tool';
  el.innerHTML = `
    <div class="tool-card running open">
      <div class="tool-head">
        <span class="tool-dot"></span>
        <span class="tool-name"></span>
        <span class="tool-args"></span>
        <svg class="tool-chevron" width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M9 18l6-6-6-6"/></svg>
      </div>
      <div class="tool-out hidden"></div>
    </div>`;
  el.querySelector('.tool-name').textContent = e.name;
  el.querySelector('.tool-args').textContent = describeTool(e.name, e.input);
  const card = el.querySelector('.tool-card');
  const out = el.querySelector('.tool-out');
  el.querySelector('.tool-head').onclick = () => {
    out.classList.toggle('hidden');
    card.classList.toggle('open');
  };
  thread().appendChild(el);
  ui.toolEls.set(e.id, el);
  scrollDown();
}

function finishToolUse(e) {
  const el = ui.toolEls.get(e.id);
  if (!el) return;
  const card = el.querySelector('.tool-card');
  card.classList.remove('running');
  card.classList.add(e.isError ? 'err' : 'ok');

  const out = el.querySelector('.tool-out');
  const lines = String(e.content ?? '').split('\n');
  out.textContent = lines.length > 26
    ? `${lines.slice(0, 26).join('\n')}\n… +${lines.length - 26} more`
    : lines.join('\n');
  out.classList.toggle('err', !!e.isError);

  if (e.isError) {
    out.classList.remove('hidden');
  } else {
    out.classList.add('hidden');
    card.classList.remove('open');
  }
  scrollDown();
}

function renderNotice(message, level = 'info') {
  const el = document.createElement('div');
  el.className = `notice ${level}`;
  el.textContent = level === 'error' ? `✕ ${message}` : level === 'warn' ? `! ${message}` : message;
  thread().appendChild(el);
  scrollDown();
}

function renderTodos(items) {
  document.querySelectorAll('.todos').forEach((n) => n.remove());
  if (!items?.length) return;
  const el = document.createElement('div');
  el.className = 'todos';
  for (const t of items) {
    const row = document.createElement('div');
    row.className = `todo ${t.status}`;
    row.innerHTML = `<span class="mark">${t.status === 'completed' ? '✓' : t.status === 'in_progress' ? '◐' : '○'}</span><span class="label"></span>`;
    row.querySelector('.label').textContent = t.content;
    el.appendChild(row);
  }
  thread().appendChild(el);
  scrollDown();
}

/** Minimal markdown: fenced code, inline code, bold, headings. */
function renderMarkdown(src) {
  const text = String(src ?? '');
  const blocks = [];
  let rest = text.replace(/```([a-zA-Z0-9_+-]*)\n([\s\S]*?)(?:```|$)/g, (_m, _lang, code) => {
    const i = blocks.push(code) - 1;
    return `\u0000C${i}\u0000`;
  });
  rest = esc(rest);
  rest = rest
    .replace(/^### (.+)$/gm, '<b>$1</b>')
    .replace(/^## (.+)$/gm, '<b>$1</b>')
    .replace(/^# (.+)$/gm, '<b>$1</b>')
    .replace(/\*\*([^*]+)\*\*/g, '<b>$1</b>')
    .replace(/`([^`]+)`/g, '<code>$1</code>');
  rest = rest.replace(/\u0000C(\d+)\u0000/g, (_m, n) => `<pre><code>${esc(blocks[Number(n)])}</code></pre>`);
  return rest;
}

function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

// ---------------------------------------------------------------- chrome

function wireChrome() {
  $('sb-new').onclick = () => startSession(ui.modelName);
  $('sb-compose').onclick = () => { showWelcome(); firstRun(); };
  $('new-btn').onclick = () => startSession(ui.modelName);
  $('folder-btn').onclick = chooseFolder;
  $('attach-btn').onclick = chooseFolder;
  $('model-btn').onclick = openModelPicker;
  $('mode-btn').onclick = openModePicker;
  $('sb-collapse').onclick = toggleSidebar;
  $('sb-toggle-sm').onclick = toggleSidebar;

  for (const item of document.querySelectorAll('.sb-nav-item')) {
    item.onclick = () => {
      for (const other of document.querySelectorAll('.sb-nav-item')) other.classList.remove('active');
      item.classList.add('active');
    };
  }
  document.querySelector('.sb-nav-item[data-nav="chat"]')?.classList.add('active');

  // Remembered sidebar state.
  try {
    if (localStorage.getItem('xm.sb') === '0') document.body.classList.add('sb-collapsed');
  } catch { /* ignore */ }
}

function toggleSidebar() {
  document.body.classList.toggle('sb-collapsed');
  try { localStorage.setItem('xm.sb', document.body.classList.contains('sb-collapsed') ? '0' : '1'); } catch { /* ignore */ }
}

async function renderRecents() {
  const box = $('sb-recents');
  const r = await api.recentSessions();
  if (!r.ok || !r.sessions?.length) {
    box.innerHTML = '<div class="sb-empty">No conversations yet</div>';
    return;
  }
  box.innerHTML = '';
  for (const s of r.sessions.slice(0, 12)) {
    const el = document.createElement('button');
    el.className = 'sb-recent';
    const when = new Date(s.mtime ?? Date.now());
    el.innerHTML = '<span class="title"></span><span class="when"></span>';
    el.querySelector('.title').textContent = String(s.id).slice(-8);
    el.querySelector('.when').textContent =
      `${when.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })} · ${when.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })}`;
    el.title = `${s.id}\n${s.cwd ?? ''}\n${s.modelName ?? ''}`;
    el.onclick = () => resumeSession(s.id);
    box.appendChild(el);
  }
}

async function resumeSession(id) {
  setBusy(true);
  hideWelcome();
  const start = await api.startSession({ cwd: ui.cwd, resumeId: id, mode: ui.mode });
  if (!start.ok) {
    setBusy(false);
    renderNotice(`Could not resume: ${start.error}`, 'error');
    return;
  }
  ui.sessionId = start.id;
  ui.models = start.models ?? [];
  ui.modelName = start.model.name;
  $('model-name').textContent = start.model.model;
  $('composer-model').textContent = start.model.model;
  clearThread();
  renderGreeting();
  renderNotice(`Resumed ${start.id.slice(-4)} — ${start.resumedMessages} messages restored.`);
  setBusy(false);
}

async function chooseFolder() {
  const p = await api.pickFolder();
  if (p) { setCwd(p); await startSession(ui.modelName); }
}

function setCwd(p) {
  ui.cwd = p;
  try { localStorage.setItem('xm.cwd', p); } catch { /* ignore */ }
  $('cwd-label').textContent = p.replace(/^\/Users\/[^/]+/, '~');
  $('folder-btn').title = p;
}

// ---------------------------------------------------------------- composer

function wireComposer() {
  const input = $('input');
  const autosize = () => {
    input.style.height = 'auto';
    input.style.height = Math.min(220, input.scrollHeight) + 'px';
    $('send').disabled = !input.value.trim() || ui.busy;
  };
  input.addEventListener('input', autosize);
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); submit(); }
  });
  $('send').onclick = submit;
  $('stop').onclick = async () => { await api.stop(); };
  setBusy(false);
}

async function submit() {
  const input = $('input');
  const text = input.value.trim();
  if (!text || ui.busy) return;
  if (!ui.sessionId) {
    await startSession(ui.modelName);
    if (!ui.sessionId) return;
  }
  input.value = '';
  input.style.height = 'auto';
  setBusy(true);
  const r = await api.send(text);
  if (!r.ok) { renderNotice(r.error, 'error'); setBusy(false); }
  if (r.ok) {
    const items = await api.todos();
    renderTodos(items.items);
  }
  renderRecents();
}

function setBusy(busy) {
  ui.busy = busy;
  $('send').classList.toggle('hidden', busy);
  $('stop').classList.toggle('hidden', !busy);
  $('send').disabled = busy || !$('input').value.trim();
  if (!busy) $('input').focus();
}

// ---------------------------------------------------------------- permissions

function wirePermission() {
  $('perm-allow').onclick = () => closePermission(true);
  $('perm-deny').onclick = () => closePermission(false);
  document.addEventListener('keydown', (e) => {
    if ($('perm').classList.contains('hidden')) return;
    if (e.key === 'Enter') { e.preventDefault(); closePermission(true); }
    if (e.key === 'Escape') { e.preventDefault(); closePermission(false); }
  });
}

const RISKY = /\b(rm\s+-rf|git\s+push\s+--force|sudo|mkfs|dd\s+if=|chmod\s+777|drop\s+table)\b/i;

function showPermission(req) {
  ui.pendingPerm = req;
  $('perm-tool').textContent = req.tool;
  const detail = req.input?.command
    ? req.input.command
    : req.input?.path
      ? `${req.input.path}${req.input.content ? `\n\n${String(req.input.content).slice(0, 400)}` : ''}`
      : JSON.stringify(req.input ?? {}, null, 2).slice(0, 900);
  $('perm-detail').textContent = detail;

  const danger = RISKY.test(detail);
  $('perm-title').textContent = danger ? 'This action looks destructive' : 'Allow this action?';
  $('perm-sub').textContent = danger
    ? 'It can delete or overwrite data and cannot be undone.'
    : `xMonkey wants to run ${req.tool}.`;
  $('perm-allow').textContent = danger ? 'Allow anyway' : 'Allow';
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
  api.onMenu('new-session', () => startSession(ui.modelName));
  api.onMenu('folder-chosen', (p) => { setCwd(p); startSession(ui.modelName); });
  api.onMenu('stop', () => api.stop());
  api.onMenu('settings', () => openModePicker());
}

function openPicker(title, html, wire) {
  $('picker-title').textContent = title;
  $('picker-body').innerHTML = html;
  $('picker').classList.remove('hidden');
  $('picker-close').onclick = () => $('picker').classList.add('hidden');
  wire?.();
}

function openModelPicker() {
  const local = new Set(['ollama', 'lmstudio', 'llama.cpp', 'vllm']);
  const groups = { Local: [], Remote: [] };
  for (const m of ui.models) (local.has(m.kind) ? groups.Local : groups.Remote).push(m);

  const check = `<svg class="check" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M20 6 9 17l-5-5"/></svg>`;
  const row = (m) => `<button class="pick-item ${m.name === ui.modelName ? 'active' : ''}" data-name="${esc(m.name)}">
      ${check}
      <div style="min-width:0">
        <div class="pick-name">${esc(m.name)}</div>
        <div class="pick-desc">${esc(m.kind)} · ${esc(m.model)}</div>
      </div>
    </button>`;

  const html = Object.entries(groups)
    .filter(([, list]) => list.length)
    .map(([g, list]) => `<div class="pick-group">${g}</div>${list.map(row).join('')}`)
    .join('') || '<p class="welcome-note">No models configured. Create xmonkey.config.json in the project folder.</p>';

  openPicker('Choose a model', html, () => {
    for (const el of $('picker-body').querySelectorAll('.pick-item')) {
      el.onclick = async () => {
        $('picker').classList.add('hidden');
        ui.modelConfig = null;
        await startSession(el.dataset.name);
      };
    }
  });
}

function openModePicker() {
  const html = Object.keys(MODE_LABEL).map((m) => `
    <button class="pick-item ${m === ui.mode ? 'active' : ''}" data-mode="${m}">
      <svg class="check" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M20 6 9 17l-5-5"/></svg>
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
        // The mode applies on the next session, which is when it is reported back;
        // fixing it per session means the UI cannot show a mode that is not
        // the one actually being enforced.
        await startSession(ui.modelName);
      };
    }
  });
}

// Hooks used only by the app's own smoke test. They expose no new capability:
// pointing the window at a folder and asking whether a session is live.
window.__xmSetCwd = (p) => setCwd(p);
window.__xmSessionReady = () => !!ui.sessionId && !ui.busy;

// ---------------------------------------------------------------- go

boot().catch((err) => {
  document.body.innerHTML = `<pre style="padding:24px;color:#b4432f">xMonkey failed to start:\n${esc(err.stack || err.message)}</pre>`;
});
