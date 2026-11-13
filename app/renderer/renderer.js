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
  attachments: [],
  usage: { inputTokens: 0, outputTokens: 0 },
  lastUserText: '',
  skills: [],
  mcpServers: [],
  view: 'chat',
  artifacts: [],
  pinned: [],
  schedules: [],
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

  loadPinned();
  wireChrome();
  wireComposer();
  wirePermission();
  wireMenu();

  api.onSchedulerEvent?.(() => { if (ui.view === 'scheduled') renderScheduled(); });
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
    const lbl = modelLabel({ name: probe.selected, model: probe.selectedConfig.model });
    $('model-name').textContent = lbl;
    $('composer-model').textContent = lbl;
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
  ui.skills = r.skills ?? [];
  ui.mcpServers = r.mcpServers ?? [];
  ui.capabilities = r.capabilities ?? {};
  ui.configSummary = r.configSummary ?? '';

  const label = modelLabel(r.model);
  $('model-name').textContent = label;
  $('model-btn').classList.add('accent');
  $('mode-name').textContent = MODE_LABEL[r.mode] ?? r.mode;
  $('mode-btn').classList.toggle('warn', r.mode === 'bypass');
  $('composer-model').textContent = label;

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

/** "qwen-uncensored · qwen3.8-27b-abliterated" — alias first, clean model id. */
function modelLabel(model) {
  if (!model) return 'model';
  const id = String(model.model ?? '').replace(/:latest$/, '');
  if (model.name && model.name !== id && !model.name.startsWith('auto-')) {
    return `${model.name} · ${id}`;
  }
  return id;
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
    case 'usage':
      bumpUsage(e.usage);
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
  el.innerHTML = `<div class="bubble"></div>
    <div class="msg-actions">
      <button class="msg-act" data-act="copy" title="Copy">
        <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><rect x="9" y="9" width="12" height="12" rx="2"/><path d="M5 15V5a2 2 0 0 1 2-2h10"/></svg>
      </button>
    </div>`;
  el.querySelector('.bubble').textContent = text;
  el.querySelector('[data-act="copy"]').onclick = (e) => copyButton(e.currentTarget, text);
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
    const text = ui.rawText ?? '';
    ui.assistantEl.classList.remove('streaming-caret');
    ui.assistantEl.innerHTML = renderMarkdown(text);
    const turn = ui.assistantEl.parentElement;
    if (turn && text.trim()) {
      const actions = document.createElement('div');
      actions.className = 'msg-actions';
      actions.innerHTML = `
        <button class="msg-act" data-act="copy" title="Copy">
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><rect x="9" y="9" width="12" height="12" rx="2"/><path d="M5 15V5a2 2 0 0 1 2-2h10"/></svg>
        </button>
        <button class="msg-act" data-act="share" title="Share (copy transcript)">
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M4 12v7a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-7"/><path d="M12 3v13M8 7l4-4 4 4"/></svg>
        </button>
        <button class="msg-act" data-act="retry" title="Regenerate">
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M21 12a9 9 0 1 1-3-6.7"/><path d="M21 3v6h-6"/></svg>
        </button>`;
      actions.querySelector('[data-act="copy"]').onclick = (e) => copyButton(e.currentTarget, text);
      actions.querySelector('[data-act="retry"]').onclick = () => retryLast();
      actions.querySelector('[data-act="share"]').onclick = (e) => shareTranscript(e.currentTarget);
      turn.appendChild(actions);
    }
    // An artifact is any complete HTML document the model produced. Detecting it
    // here means the feature works with every model, without asking the model to
    // learn a tool it does not have.
    harvestArtifacts(text);
    ui.assistantEl = null;
    ui.rawText = '';
  }
  if (ui.thinkingEl) {
    ui.thinkingEl.querySelector('summary span').textContent = 'Thought for a moment';
    ui.thinkingEl = null;
  }
}

/** Copy the whole visible conversation as Markdown — the local "Share". */
async function shareTranscript(btn) {
  const lines = [];
  for (const turn of document.querySelectorAll('#thread .turn')) {
    const isUser = turn.classList.contains('user');
    const body = turn.querySelector('.bubble, .prose');
    if (!body) continue;
    lines.push(isUser ? '**You**' : '**xMonkey**');
    lines.push('');
    lines.push(body.innerText.trim());
    lines.push('');
  }
  const md = `# xMonkey conversation\n\n${lines.join('\n')}`;
  try {
    await navigator.clipboard.writeText(md);
    btn.classList.add('copied');
    setTimeout(() => btn.classList.remove('copied'), 1200);
  } catch { /* clipboard blocked */ }
}

async function copyButton(btn, text) {
  try {
    await navigator.clipboard.writeText(text);
    btn.classList.add('copied');
    setTimeout(() => btn.classList.remove('copied'), 1200);
  } catch { /* clipboard blocked */ }
}

/** Re-send the last user prompt: the model tries again from the same point. */
function retryLast() {
  if (!ui.lastUserText || ui.busy) return;
  $('input').value = ui.lastUserText;
  $('input').dispatchEvent(new Event('input', { bubbles: true }));
  submit();
}

function bumpUsage(u) {
  if (!u) return;
  ui.usage.inputTokens += u.inputTokens ?? 0;
  ui.usage.outputTokens += u.outputTokens ?? 0;
  const total = ui.usage.inputTokens + ui.usage.outputTokens;
  $('usage-label').textContent = total > 1000 ? (total / 1000).toFixed(1) + 'k' : String(total);
  $('usage-btn').title = `${ui.usage.inputTokens} input · ${ui.usage.outputTokens} output tokens this session`;
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
    item.onclick = () => switchView(item.dataset.view || 'chat');
  }
  document.querySelector('.sb-nav-item[data-view="chat"]')?.classList.add('active');

  // ---- search
  $('sb-search-btn').onclick = () => {
    const wrap = $('sb-search-wrap');
    wrap.classList.toggle('hidden');
    if (!wrap.classList.contains('hidden')) $('sb-search').focus();
    else { $('sb-search').value = ''; renderRecents(); }
  };
  $('sb-search').addEventListener('input', () => renderRecents());
  $('sb-search').addEventListener('keydown', (e) => {
    if (e.key === 'Escape') { $('sb-search').value = ''; $('sb-search-wrap').classList.add('hidden'); renderRecents(); }
  });

  // ---- settings
  $('settings-btn').onclick = openSettings;
  $('customize-btn').onclick = openSettings;
  $('settings-close').onclick = () => $('settings').classList.add('hidden');
  $('usage-btn').onclick = openSettings;

  // Remembered sidebar state.
  try {
    if (localStorage.getItem('xm.sb') === '0') document.body.classList.add('sb-collapsed');
  } catch { /* ignore */ }
}

function toggleSidebar() {
  document.body.classList.toggle('sb-collapsed');
  try { localStorage.setItem('xm.sb', document.body.classList.contains('sb-collapsed') ? '0' : '1'); } catch { /* ignore */ }
}

// ---------------------------------------------------------------- views

function switchView(view) {
  ui.view = view;
  for (const el of document.querySelectorAll('.view')) el.classList.add('hidden');
  for (const el of document.querySelectorAll('.sb-nav-item')) {
    el.classList.toggle('active', el.dataset.view === view);
  }
  $('welcome').classList.add('hidden');

  if (view === 'chat') {
    $('view-chat').classList.remove('hidden');
    // Returning to Chat must restore whatever state the thread should be in:
    // with no API key rule, that means the greeting, not a blank panel.
    const t = $('thread');
    if (t.children.length === 0) renderGreeting();
    t.scrollTop = t.scrollHeight;
    $('input').focus();
    return;
  }
  if (view === 'projects') { $('view-projects').classList.remove('hidden'); renderProjects(); }
  if (view === 'skills') { $('view-skills').classList.remove('hidden'); renderSkillsView(); }
  if (view === 'scheduled') { $('view-scheduled').classList.remove('hidden'); renderScheduled(); }
  if (view === 'artifacts') { $('view-artifacts').classList.remove('hidden'); renderArtifacts(); }
  if (view === 'connectors') { $('view-connectors').classList.remove('hidden'); renderConnectors(); }
}

async function renderProjects() {
  const body = $('projects-body');
  const r = await api.recentSessions();
  const cwds = new Map();
  for (const s of r.sessions ?? []) {
    if (!s.cwd) continue;
    cwds.set(s.cwd, (cwds.get(s.cwd) ?? 0) + 1);
  }
  const rows = [...cwds.entries()].map(([cwd, n]) => `
    <div class="panel-row">
      <div class="grow">
        <div class="pname">${esc(cwd.replace(/^\/Users\/[^/]+/, '~'))}</div>
        <div class="pmeta">${n} conversation${n > 1 ? 's' : ''}</div>
      </div>
      <button class="btn" data-cwd="${esc(cwd)}">Open</button>
    </div>`).join('') || '<p class="panel-empty">No projects yet. Start a chat to create one.</p>';

  body.innerHTML = `
    <div class="panel-row">
      <div class="grow">
        <div class="pname">${esc(ui.cwd.replace(/^\/Users\/[^/]+/, '~'))}</div>
        <div class="pmeta">current folder</div>
      </div>
      <button class="btn primary" id="p-choose">Change…</button>
    </div>
    ${rows}`;
  $('p-choose').onclick = chooseFolder;
  for (const b of body.querySelectorAll('[data-cwd]')) {
    b.onclick = async () => { setCwd(b.dataset.cwd); switchView('chat'); await startSession(ui.modelName); };
  }
}

function renderSkillsView() {
  const body = $('skills-body');
  const rows = (ui.skills ?? []).map((sk) => `
    <div class="panel-row">
      <div class="grow">
        <div class="pname">/${esc(sk.id)}</div>
        <div class="pmeta">${esc(sk.description)}</div>
      </div>
      <span class="panel-badge">skill</span>
    </div>`).join('');
  body.innerHTML = rows || `<p class="panel-empty">No skills installed.<br>
    Add <code>.xmonkey/skills/&lt;name&gt;/SKILL.md</code> in this project (or
    <code>~/.xmonkey/skills/</code>), then start a new chat.</p>`;
}

function renderConnectors() {
  const body = $('connectors-body');
  const servers = ui.mcpServers ?? [];
  const rows = servers.map((s) => `
    <div class="panel-row">
      <div class="grow">
        <div class="pname">${esc(s.name)}</div>
        <div class="pmeta">${s.tools} tool${s.tools === 1 ? '' : 's'}</div>
      </div>
      <span class="panel-badge">connected</span>
    </div>`).join('');
  body.innerHTML = rows || `<p class="panel-empty">No MCP servers configured.<br>
    Add them to <code>xmonkey.config.json</code>:</p>
    <pre class="panel-pre">{
  "mcpServers": {
    "filesystem": {
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-filesystem", "."]
    }
  }
}</pre>`;
}

// ---------------------------------------------------------------- scheduled

async function renderScheduled() {
  const body = $('scheduled-body');
  const r = await api.listSchedules();
  ui.schedules = r.schedules ?? [];
  if (!ui.schedules.length) {
    body.innerHTML = '<p class="panel-empty">No schedules yet.</p>';
  } else {
    body.innerHTML = '';
    for (const s of ui.schedules) {
      const el = document.createElement('div');
      el.className = 'panel-row';
      const when = s.every ? `every ${s.every}`
        : s.daily ? `daily at ${s.daily}`
        : s.weekday ? `weekly on ${['Mon','Tue','Wed','Thu','Fri','Sat','Sun'][s.weekday - 1]} at ${s.time}`
        : '—';
      const next = s.next ? new Date(s.next).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }) : '—';
      const last = s.runs?.length ? s.runs.at(-1) : null;
      el.innerHTML = `
        <div class="grow">
          <div class="pname"></div>
          <div class="pmeta">${esc(when)} · ${esc(s.cwd.replace(/^\/Users\/[^/]+/, '~'))}</div>
          <div class="sched-next">next: ${esc(next)}${last ? ` · last: <span class="${last.ok ? 'ok' : 'bad'}">${last.ok ? 'ok' : 'failed'}</span>` : ''}</div>
        </div>
        <button class="btn" data-toggle>${s.enabled ? 'Pause' : 'Resume'}</button>
        <button class="btn ghost" data-del>Delete</button>`;
      el.querySelector('.pname').textContent = s.prompt.slice(0, 90) || '(no prompt)';
      el.querySelector('[data-toggle]').onclick = async () => {
        await api.toggleSchedule(s.id, !s.enabled);
        renderScheduled();
      };
      el.querySelector('[data-del]').onclick = async () => {
        await api.removeSchedule(s.id);
        renderScheduled();
      };
      body.appendChild(el);
    }
  }
  wireScheduleForm();
}

function wireScheduleForm() {
  const add = $('sched-add');
  if (add.dataset.wired) return;
  add.dataset.wired = '1';
  const kind = $('sched-kind');
  const value = $('sched-value');
  const hint = $('sched-hint');
  const syncHint = () => {
    const k = kind.value;
    if (k === 'every') { value.value = '1h'; hint.textContent = 'Interval: 15m, 1h, 2h (minimum 5m).'; }
    if (k === 'daily') { value.value = '09:00'; hint.textContent = 'Local time, 24h: 09:00.'; }
    if (k === 'weekly') { value.value = '1 09:00'; hint.textContent = 'ISO weekday then time: 1 09:00 = Monday 9am (1=Mon … 7=Sun).'; }
  };
  kind.onchange = syncHint;
  syncHint();
  add.onclick = async () => {
    const prompt = $('sched-prompt').value.trim();
    if (!prompt) { hint.textContent = 'Write the prompt first.'; return; }
    const k = kind.value;
    const v = value.value.trim();
    const spec = { cwd: ui.cwd, prompt };
    try {
      if (k === 'every') spec.every = v;
      else if (k === 'daily') spec.daily = v;
      else {
        const [wd, time] = v.split(/\s+/);
        spec.weekday = Number(wd);
        spec.time = time || '09:00';
      }
      const r = await api.createSchedule(spec);
      if (!r.ok) { hint.textContent = r.error; return; }
      $('sched-prompt').value = '';
      renderScheduled();
    } catch (err) {
      hint.textContent = err.message;
    }
  };
}

// ---------------------------------------------------------------- artifacts

let artifactSeq = 0;

/**
 * Find complete HTML documents in an assistant message and register them.
 * A "complete document" is a fenced ```html block that contains <html or <!DOCTYPE,
 * or any such block long enough to be a real page rather than an inline snippet.
 */
function harvestArtifacts(text) {
  const src = String(text ?? '');
  const re = /```html\n([\s\S]*?)```/gi;
  let m;
  let found = 0;
  while ((m = re.exec(src)) !== null) {
    const html = m[1].trim();
    if (html.length < 200) continue;
    if (!/<(html|body|div|section|main|!doctype)/i.test(html)) continue;
    const id = `art_${Date.now()}_${++artifactSeq}`;
    const titleMatch = html.match(/<title>([^<]{1,80})<\/title>/i);
    const h1 = html.match(/<h1[^>]*>([^<]{1,80})<\/h1>/i);
    const title = (titleMatch?.[1] || h1?.[1] || `Artifact ${ui.artifacts.length + 1}`).trim();
    ui.artifacts.unshift({ id, title, html, at: Date.now(), message: ui.lastUserText });
    found++;
  }
  if (found) {
    renderNotice(`${found} artifact${found > 1 ? 's' : ''} produced — see Artifacts in the sidebar.`);
  }
}

function renderArtifacts() {
  const body = $('artifacts-body');
  if (!ui.artifacts.length) {
    body.innerHTML = `<p class="panel-empty">No artifacts yet.<br>
      Ask xMonkey for a self-contained HTML page and it will appear here.</p>`;
    return;
  }
  body.innerHTML = '';
  for (const a of ui.artifacts) {
    const card = document.createElement('button');
    card.className = 'artifact-card';
    card.innerHTML = `
      <div class="artifact-thumb"><iframe sandbox="allow-scripts" title=""></iframe></div>
      <div class="artifact-meta">
        <div class="grow">
          <div class="artifact-name"></div>
          <div class="artifact-kind">html · ${new Date(a.at).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })}</div>
        </div>
        <span class="panel-badge">open</span>
      </div>`;
    card.querySelector('.artifact-name').textContent = a.title;
    card.querySelector('iframe').srcdoc = a.html;
    card.onclick = () => openArtifact(a);
    body.appendChild(card);
  }
}

function downloadArtifact(a) {
  const blob = new Blob([a.html], { type: 'text/html' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = `${a.title.replace(/[^a-z0-9-_ ]/gi, '').trim() || 'artifact'}.html`;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function openArtifact(a) {
  $('artifact-title').textContent = a.title;
  $('artifact-sub').textContent = a.message ? `from: ${a.message.slice(0, 100)}` : 'self-contained html';
  $('artifact-frame').srcdoc = a.html;
  $('artifact').classList.remove('hidden');
  $('artifact-download').onclick = () => downloadArtifact(a);
  $('artifact-close').onclick = () => {
    $('artifact').classList.add('hidden');
    $('artifact-frame').srcdoc = '';
  };
}

// ---------------------------------------------------------------- pinned

function loadPinned() {
  try { ui.pinned = JSON.parse(localStorage.getItem('xm.pinned') ?? '[]'); } catch { ui.pinned = []; }
}
function savePinned() {
  try { localStorage.setItem('xm.pinned', JSON.stringify(ui.pinned)); } catch { /* ignore */ }
}
function isPinned(id) { return ui.pinned.includes(id); }
function togglePin(id) {
  ui.pinned = isPinned(id) ? ui.pinned.filter((x) => x !== id) : [...ui.pinned, id];
  savePinned();
  renderRecents();
}

function renderPinned(rows) {
  const box = $('sb-pinned');
  const section = $('sb-pinned-section');
  if (!rows?.length) { box.innerHTML = ''; section.style.display = 'none'; return; }
  section.style.display = '';
  box.innerHTML = '';
  for (const s of rows) {
    const el = document.createElement('button');
    el.className = 'sb-pin';
    el.innerHTML = '<svg class="pin" width="10" height="10" viewBox="0 0 24 24" fill="currentColor"><path d="M12 2l2.9 6.3 6.9.8-5.1 4.7 1.4 6.8L12 17.3 5.9 20.6l1.4-6.8L2.2 9.1l6.9-.8z"/></svg><span class="t"></span>';
    el.querySelector('.t').textContent = String(s.id).slice(-8);
    el.title = s.cwd ?? '';
    el.onclick = () => resumeSession(s.id);
    el.oncontextmenu = (e) => { e.preventDefault(); openRowMenu(e, s); };
    box.appendChild(el);
  }
}

/** Claude-style context menu for a conversation row. */
function openRowMenu(evt, s) {
  document.querySelectorAll('.row-menu').forEach((n) => n.remove());
  const menu = document.createElement('div');
  menu.className = 'row-menu';
  menu.style.left = `${evt.clientX}px`;
  menu.style.top = `${evt.clientY}px`;
  const items = [
    [isPinned(s.id) ? 'Unpin' : 'Pin', () => togglePin(s.id)],
    ['Rename', () => renameSession(s)],
    ['Copy id', () => navigator.clipboard.writeText(s.id).catch(() => {})],
    ['Delete', () => deleteSession(s), 'danger'],
  ];
  for (const [label, fn, cls] of items) {
    const b = document.createElement('button');
    b.textContent = label;
    if (cls) b.className = cls;
    b.onclick = () => { menu.remove(); fn(); };
    menu.appendChild(b);
  }
  document.body.appendChild(menu);
  const close = (e) => {
    if (!menu.contains(e.target)) { menu.remove(); document.removeEventListener('click', close); }
  };
  setTimeout(() => document.addEventListener('click', close), 0);
}

function renameSession(s) {
  const next = prompt('Rename this conversation', s.title ?? String(s.id).slice(-8));
  if (!next) return;
  try {
    const names = JSON.parse(localStorage.getItem('xm.titles') ?? '{}');
    names[s.id] = next;
    localStorage.setItem('xm.titles', JSON.stringify(names));
  } catch { /* ignore */ }
  renderRecents();
}

function sessionTitle(s) {
  try {
    const names = JSON.parse(localStorage.getItem('xm.titles') ?? '{}');
    if (names[s.id]) return names[s.id];
  } catch { /* ignore */ }
  return String(s.id).slice(-8);
}

async function deleteSession(s) {
  const ok = confirm(`Delete conversation ${String(s.id).slice(-8)}? The transcript file is removed.`);
  if (!ok) return;
  await api.deleteSession(s.id);
  renderRecents();
}

// ---------------------------------------------------------------- search

async function renderRecents() {
  const box = $('sb-recents');
  const r = await api.recentSessions();
  if (!r.ok || !r.sessions?.length) {
    box.innerHTML = '<div class="sb-empty">No conversations yet</div>';
    return;
  }
  renderPinned((r.sessions ?? []).filter((x) => isPinned(x.id)));
  const q = ($('sb-search')?.value ?? '').trim().toLowerCase();
  const rows = (r.sessions ?? []).filter((s) => {
    if (!q) return true;
    return String(s.id).toLowerCase().includes(q)
      || String(s.cwd ?? '').toLowerCase().includes(q)
      || String(s.modelName ?? '').toLowerCase().includes(q);
  });
  if (!rows.length) {
    box.innerHTML = `<div class="sb-empty">${q ? 'No matches' : 'No conversations yet'}</div>`;
    return;
  }
  box.innerHTML = '';
  for (const s of rows.slice(0, 12)) {
    const el = document.createElement('button');
    el.className = 'sb-recent';
    const when = new Date(s.mtime ?? Date.now());
    el.innerHTML = '<span class="title"></span><span class="when"></span>';
    el.querySelector('.title').textContent = sessionTitle(s);
    el.querySelector('.when').textContent =
      `${when.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })} · ${when.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })}`;
    el.title = `${s.id}\n${s.cwd ?? ''}\n${s.modelName ?? ''}`;
    el.onclick = () => resumeSession(s.id);
    el.oncontextmenu = (e) => { e.preventDefault(); openRowMenu(e, s); };
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

// ---------------------------------------------------------------- attachments

function addAttachment(file) {
  if (ui.attachments.some((f) => f.path === file.path)) return;
  ui.attachments.push(file);
  renderAttachments();
}

function removeAttachment(path) {
  ui.attachments = ui.attachments.filter((f) => f.path !== path);
  renderAttachments();
}

function renderAttachments() {
  const box = $('attachments');
  if (!ui.attachments.length) { box.classList.add('hidden'); box.innerHTML = ''; return; }
  box.classList.remove('hidden');
  box.innerHTML = '';
  for (const f of ui.attachments) {
    const chip = document.createElement('span');
    chip.className = 'chip';
    chip.innerHTML = '<span class="chip-name"></span><button title="Remove">✕</button>';
    chip.querySelector('.chip-name').textContent = f.name;
    chip.querySelector('button').onclick = () => removeAttachment(f.path);
    box.appendChild(chip);
  }
}

/** Attachments are sent as an explicit file manifest, not inlined content. */
function buildPayload(text) {
  if (!ui.attachments.length) return text;
  const list = ui.attachments.map((f) => `- ${f.path}`).join('\n');
  return `${text}\n\nAttached files (read them if you need their contents):\n${list}`;
}

async function attachFiles() {
  const files = await api.pickFiles();
  for (const f of files) addAttachment(f);
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
  $('attach-btn').onclick = attachFiles;
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
  ui.lastUserText = text;
  input.value = '';
  input.style.height = 'auto';
  setBusy(true);
  const payload = buildPayload(text);
  const r = await api.send(payload);
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
    if (e.key === 'Escape' && !$('artifact').classList.contains('hidden')) {
      $('artifact').classList.add('hidden');
      $('artifact-frame').srcdoc = '';
      return;
    }
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

function openSettings() {
  const body = $('settings-body');
  const cfg = ui.configSummary ?? '';
  const caps = ui.capabilities ?? {};
  const capList = Object.entries(caps)
    .filter(([, v]) => v === true)
    .map(([k]) => k);
  const total = ui.usage.inputTokens + ui.usage.outputTokens;

  body.innerHTML = `
    <div class="set-group">
      <h3>Model</h3>
      <div class="set-row"><span class="k">Active</span><span class="v">${esc(ui.modelName ?? '—')}</span></div>
      <div class="set-row"><span class="k">Capabilities</span><span class="v wrap">${esc(capList.join(', ') || '—')}</span></div>
      <div class="set-row"><span class="k">Context window</span><span class="v">${caps.contextWindow ? caps.contextWindow.toLocaleString() + ' tokens' : '—'}</span></div>
    </div>
    <div class="set-group">
      <h3>Session</h3>
      <div class="set-row"><span class="k">Working folder</span><span class="v wrap">${esc(ui.cwd)}</span></div>
      <div class="set-row"><span class="k">Permission mode</span><span class="v">${esc(ui.mode)}</span></div>
      <div class="set-row"><span class="k">Session id</span><span class="v">${esc(ui.sessionId ?? '—')}</span></div>
      <div class="set-row"><span class="k">Tokens this session</span><span class="v">${total.toLocaleString()} (${ui.usage.inputTokens.toLocaleString()} in / ${ui.usage.outputTokens.toLocaleString()} out)</span></div>
    </div>
    <div class="set-group">
      <h3>Extensions</h3>
      <div class="set-row"><span class="k">Skills</span><span class="v">${(ui.skills ?? []).length || 'none'}</span></div>
      <div class="set-row"><span class="k">MCP servers</span><span class="v">${(ui.mcpServers ?? []).length || 'none'}</span></div>
    </div>
    <div class="set-group">
      <h3>Configuration</h3>
      <pre class="panel-pre" style="font-size:.6875rem;line-height:1.5;margin:0">${esc(cfg)}</pre>
    </div>`;
  $('settings').classList.remove('hidden');
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
