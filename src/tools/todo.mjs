// Session checklist tool. The model uses it to plan multi-step work and to keep
// the user oriented; the state is session-scoped and rendered by the CLI.

export function todoTools() {
  return [todoWriteTool()];
}

export function createTodoStore() {
  /** @type {{id: string, content: string, status: 'pending'|'in_progress'|'completed'}[]} */
  const items = [];
  return {
    items,
    replace(list) {
      items.length = 0;
      list.forEach((t, i) => {
        items.push({
          id: String(t.id ?? i + 1),
          content: String(t.content ?? '').trim(),
          status: t.status === 'completed' ? 'completed' : t.status === 'in_progress' ? 'in_progress' : 'pending',
        });
      });
      return items;
    },
    render() {
      if (!items.length) return '  (empty)';
      return items
        .map((t) => `  ${t.status === 'completed' ? '✔' : t.status === 'in_progress' ? '▶' : '○'} ${t.content}`)
        .join('\n');
    },
    done() {
      return items.length > 0 && items.every((t) => t.status === 'completed');
    },
  };
}

function todoWriteTool() {
  return {
    name: 'todo',
    description:
      'Replace the session task checklist. Use it when a job has more than two real steps so both you and ' +
      'the user can see progress. Mark exactly one item in_progress at a time. Keep items short and concrete.',
    inputSchema: {
      type: 'object',
      properties: {
        todos: {
          type: 'array',
          description: 'The full list, replacing any previous list.',
          items: {
            type: 'object',
            properties: {
              content: { type: 'string' },
              status: { type: 'string', enum: ['pending', 'in_progress', 'completed'] },
            },
            required: ['content', 'status'],
          },
        },
      },
      required: ['todos'],
      additionalProperties: false,
    },
    // Planning is exactly what plan mode is FOR: a checklist changes session
    // state only, never the user's files, so it stays available in every mode.
    isReadOnly: true,
    isConcurrencySafe: false,
    async run(input, ctx) {
      if (!ctx.todos) return { content: 'todo store unavailable in this context', isError: true };
      const list = Array.isArray(input.todos) ? input.todos : [];
      const before = ctx.todos.items.map((t) => ({ content: t.content, status: t.status }));
      ctx.todos.replace(list);
      // TaskCreated / TaskCompleted mirror checklist transitions, so a hook can
      // react to progress the same way it would in Claude Code.
      if (ctx.hooks) {
        const { fireHook } = await import('../ext/hooks.mjs');
        for (const t of list) {
          const prev = before.find((b) => b.content === String(t.content ?? '').trim());
          if (!prev) fireHook(ctx.hooks, 'TaskCreated', { content: t.content, status: t.status }, { cwd: ctx.workspace });
          else if (prev.status !== 'completed' && t.status === 'completed') {
            fireHook(ctx.hooks, 'TaskCompleted', { content: t.content }, { cwd: ctx.workspace });
          }
        }
      }
      const active = list.filter((t) => t.status === 'in_progress').length;
      const notes = [];
      if (active > 1) notes.push('warning: more than one item is in_progress');
      const summary = `${list.filter((t) => t.status === 'completed').length}/${list.length} complete`;
      return { content: `Checklist updated (${summary})${notes.length ? ` — ${notes.join('; ')}` : ''}\n${ctx.todos.render()}` };
    },
  };
}

/**
 * Structured task list (Claude Code's TaskCreate/TaskGet/TaskUpdate/TaskList).
 * Separate from the lightweight `todo` checklist: tasks have ids, owners and
 * status transitions, and survive across turns in the session state.
 */
export function taskTools() {
  const store = {
    items: new Map(),
    seq: 0,
  };
  return { tools: [taskCreate(store), taskGet(store), taskUpdate(store), taskList(store)], store };
}

function taskCreate(store) {
  return {
    name: 'task_create',
    description: 'Create a trackable task with an id. Use for multi-step work that spans turns.',
    inputSchema: {
      type: 'object',
      properties: {
        subject: { type: 'string', description: 'Short task title.' },
        description: { type: 'string', description: 'What done looks like.' },
        activeForm: { type: 'string', description: 'Present-continuous label, e.g. "Running tests".' },
      },
      required: ['subject'],
      additionalProperties: false,
    },
    isReadOnly: false,
    isConcurrencySafe: false,
    async run(input) {
      const id = ++store.seq;
      const task = {
        id,
        subject: String(input.subject),
        description: String(input.description ?? ''),
        activeForm: input.activeForm ?? null,
        status: 'pending',
        createdAt: new Date().toISOString(),
      };
      store.items.set(id, task);
      return { content: `created task #${id}: ${task.subject}` };
    },
  };
}

function taskGet(store) {
  return {
    name: 'task_get',
    description: 'Read one task by id.',
    inputSchema: {
      type: 'object',
      properties: { id: { type: 'number' } },
      required: ['id'],
      additionalProperties: false,
    },
    isReadOnly: true,
    isConcurrencySafe: true,
    async run(input) {
      const t = store.items.get(Number(input.id));
      if (!t) return { content: `no task #${input.id}`, isError: true };
      return { content: JSON.stringify(t, null, 2) };
    },
  };
}

function taskUpdate(store) {
  return {
    name: 'task_update',
    description: 'Update a task: status (pending|in_progress|completed), subject, or description.',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'number' },
        status: { type: 'string', enum: ['pending', 'in_progress', 'completed'] },
        subject: { type: 'string' },
        description: { type: 'string' },
      },
      required: ['id'],
      additionalProperties: false,
    },
    isReadOnly: false,
    isConcurrencySafe: false,
    async run(input) {
      const t = store.items.get(Number(input.id));
      if (!t) return { content: `no task #${input.id}`, isError: true };
      if (input.status) t.status = input.status;
      if (input.subject) t.subject = String(input.subject);
      if (input.description) t.description = String(input.description);
      t.updatedAt = new Date().toISOString();
      return { content: `task #${t.id} → ${t.status}` };
    },
  };
}

function taskList(store) {
  return {
    name: 'task_list',
    description: 'List all tasks with their status.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    isReadOnly: true,
    isConcurrencySafe: true,
    async run() {
      if (!store.items.size) return { content: 'no tasks' };
      return {
        content: [...store.items.values()]
          .map((t) => `#${t.id} [${t.status}] ${t.subject}`)
          .join('\n'),
      };
    },
  };
}
