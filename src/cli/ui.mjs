// Terminal rendering helpers. Deliberately dependency-free and colour-safe:
// colour is used when the terminal supports it and stripped when output is piped,
// because agents get run by other programs and escape codes poison their logs.

const supportsColor = (() => {
  if (process.env.NO_COLOR) return false;
  if (process.env.FORCE_COLOR === '1') return true;
  return process.stdout.isTTY === true && process.env.TERM !== 'dumb';
})();

const wrap = (open, close) => (s) => (supportsColor ? `\x1b[${open}m${s}\x1b[${close}m` : String(s));

export const c = {
  dim: wrap(2, 22),
  bold: wrap(1, 22),
  red: wrap(31, 39),
  green: wrap(32, 39),
  yellow: wrap(33, 39),
  blue: wrap(34, 39),
  magenta: wrap(35, 39),
  cyan: wrap(36, 39),
  grey: wrap(90, 39),
};

export const symbols = {
  user: c.cyan('❯'),
  assistant: c.magenta('◆'),
  tool: c.blue('⚙'),
  ok: c.green('✔'),
  fail: c.red('✘'),
  warn: c.yellow('!'),
  info: c.grey('·'),
  bullet: '•',
};

/** Pretty-print a value in one line, clipped. */
export function brief(v, max = 120) {
  let s;
  if (typeof v === 'string') s = v;
  else {
    try { s = JSON.stringify(v); } catch { s = String(v); }
  }
  s = String(s ?? '').replace(/\s+/g, ' ').trim();
  return s.length > max ? s.slice(0, max) + '…' : s;
}

/** One-line summary of a tool call, the way a human would say it. */
export function describeToolCall(name, input) {
  switch (name) {
    case 'read': return `read ${input.path}${input.offset ? ` from line ${input.offset}` : ''}`;
    case 'write': return `write ${input.path} (${(input.content ?? '').length} chars)`;
    case 'edit': return `edit ${input.path}`;
    case 'list': return `list ${input.path ?? '.'}`;
    case 'glob': return `glob ${input.pattern}${input.path ? ` in ${input.path}` : ''}`;
    case 'grep': return `grep /${input.pattern}/${input.include ? ` in ${input.include}` : ''}`;
    case 'bash': return `$ ${brief(input.command, 100)}`;
    case 'todo': return `update checklist (${input.todos?.length ?? 0} items)`;
    default: return `${name} ${brief(input, 80)}`;
  }
}

export function renderToolResult(name, content, isError, maxLines = 12) {
  const text = String(content ?? '');
  const lines = text.split('\n');
  const shown = lines.slice(0, maxLines);
  const more = lines.length > maxLines ? `\n  ${c.grey(`… +${lines.length - maxLines} more line(s)`)}` : '';
  const body = shown.map((l) => `  ${c.grey('│')} ${l}`).join('\n');
  return `${isError ? symbols.fail : symbols.ok} ${c.grey(name)}${body ? '\n' + body + more : ''}`;
}

/** A tiny spinner that is a no-op when not a TTY. */
export function spinner(label = 'thinking') {
  if (!process.stdout.isTTY) {
    return { start() {}, update() {}, stop() {} };
  }
  const frames = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];
  let i = 0;
  let t = null;
  let current = label;
  const draw = () => {
    process.stdout.write(`\r${c.grey(frames[i++ % frames.length])} ${c.grey(current)}\x1b[K`);
  };
  return {
    start() { if (!t) t = setInterval(draw, 80); draw(); },
    update(next) { current = next; },
    stop() {
      if (t) clearInterval(t);
      t = null;
      process.stdout.write('\r\x1b[K');
    },
  };
}

export function banner(modelLabel, cwd, mode) {
  if (!process.stdout.isTTY) return;
  const width = Math.min(78, process.stdout.columns || 78);
  const line = c.grey('─'.repeat(width));
  process.stdout.write(
    `\n${line}\n` +
    `  ${c.bold(c.magenta('xMonkey'))} ${c.grey('· model-agnostic coding harness')}\n` +
    `  ${c.grey('model:')} ${modelLabel}   ${c.grey('mode:')} ${mode}\n` +
    `  ${c.grey('cwd:')}   ${cwd}\n` +
    `${line}\n\n`
  );
}
