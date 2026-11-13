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
      ctx.todos.replace(list);
      const active = list.filter((t) => t.status === 'in_progress').length;
      const notes = [];
      if (active > 1) notes.push('warning: more than one item is in_progress');
      const summary = `${list.filter((t) => t.status === 'completed').length}/${list.length} complete`;
      return { content: `Checklist updated (${summary})${notes.length ? ` — ${notes.join('; ')}` : ''}\n${ctx.todos.render()}` };
    },
  };
}
