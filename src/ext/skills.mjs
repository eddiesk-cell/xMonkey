// Skills: reusable instruction packs the model can load on demand.
//
// A skill is a directory containing SKILL.md:
//
//   ---
//   name: commit
//   description: Write a good commit message for staged changes.
//   ---
//
//   Follow these steps...
//
// Discovery order (later wins on a name clash):
//   ~/.xmonkey/skills/<name>/SKILL.md
//   <cwd>/.xmonkey/skills/<name>/SKILL.md
//
// Why skills exist at all instead of one big system prompt: a local model with a
// small context cannot afford every instruction up front. A skill is loaded only
// when the task needs it, which is the whole trick.

import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

export function skillDirs(cwd) {
  return [
    path.join(os.homedir(), '.xmonkey', 'skills'),
    path.join(cwd, '.xmonkey', 'skills'),
  ];
}

/** Parse `---` frontmatter + body. Tolerant of files that omit frontmatter. */
export function parseSkillFile(text, id) {
  const src = String(text ?? '');
  const m = src.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/);
  const meta = {};
  let body = src;
  if (m) {
    body = m[2] ?? '';
    for (const line of m[1].split('\n')) {
      const kv = line.match(/^\s*([A-Za-z0-9_-]+)\s*:\s*(.*)$/);
      if (!kv) continue;
      meta[kv[1]] = kv[2].replace(/^["']|["']$/g, '').trim();
    }
  }
  return {
    id: meta.name || id,
    description: meta.description || firstLine(body) || '(no description)',
    body: body.trim(),
    // Skills commonly ship reference documents next to SKILL.md and refer to
    // them by name. Record them so the body's references are resolvable.
    files: [],
    dir: undefined,
  };
}

function firstLine(body) {
  const line = String(body).split('\n').map((l) => l.trim()).find(Boolean);
  return line ? line.replace(/^#+\s*/, '').slice(0, 160) : '';
}

/** Load every skill found in the standard locations. */
export async function loadSkills(cwd = process.cwd()) {
  const found = new Map();
  for (const root of skillDirs(cwd)) {
    let entries;
    try {
      entries = await fs.readdir(root, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of entries) {
      if (!e.isDirectory()) continue;
      const file = path.join(root, e.name, 'SKILL.md');
      try {
        const text = await fs.readFile(file, 'utf8');
        const skill = parseSkillFile(text, e.name);
        skill.dir = path.join(root, e.name);
        try {
          skill.files = (await fs.readdir(skill.dir, { withFileTypes: true }))
            .filter((f) => f.isFile() && f.name !== 'SKILL.md')
            .map((f) => f.name)
            .sort();
        } catch { /* unreadable dir: body is still usable */ }
        found.set(skill.id, skill);
      } catch { /* no SKILL.md: not a skill */ }
    }
  }
  return [...found.values()].sort((a, b) => a.id.localeCompare(b.id));
}

/**
 * Build the system-prompt fragment that advertises skills. Only the name and
 * description go in — bodies load on demand via the `skill` tool.
 */
export function renderSkillCatalogue(skills) {
  if (!skills.length) return '';
  const lines = skills.map((s) => `- \`${s.id}\` — ${s.description}`);
  return `## Skills

The user has installed skills: focused instruction packs for common jobs.
Load one with the \`skill\` tool before doing the job it describes. Do not guess
the contents; load it.

${lines.join('\n')}`;
}

/** The tool that loads a skill body. */
export function skillTool(getSkills) {
  return {
    name: 'skill',
    description: 'Load the full instructions for an installed skill by id. Use it before a task a skill covers.',
    inputSchema: {
      type: 'object',
      properties: { name: { type: 'string', description: 'Skill id.' } },
      required: ['name'],
      additionalProperties: false,
    },
    isReadOnly: true,
    isConcurrencySafe: true,
    async run(input) {
      const skills = await getSkills();
      const skill = skills.find((s) => s.id === input.name);
      if (!skill) {
        return {
          content: `No skill named "${input.name}". Available: ${skills.map((s) => s.id).join(', ') || '(none)'}`,
          isError: true,
        };
      }
      const extra = skill.files?.length
        ? `\n\n---\nSupporting files in ${skill.dir}:\n` +
          skill.files.map((f) => `- ${f}  (read with the read tool: ${skill.dir}/${f})`).join('\n')
        : '';
      const where = skill.dir ? `\n\nSkill directory: ${skill.dir}` : '';
      return { content: `# Skill: ${skill.id}${where}${extra}\n\n${skill.body}` };
    },
  };
}

/** Slash-command form: `/commit args` expands the skill and forwards the args. */
export function expandSlashCommand(text, skills) {
  const m = String(text ?? '').match(/^\/([A-Za-z0-9_.-]+)\s*([\s\S]*)$/);
  if (!m) return null;
  const skill = skills.find((s) => s.id === m[1]);
  if (!skill) return null;
  const args = m[2].trim();
  return `${args ? `Arguments: ${args}\n\n` : ''}${skill.body}`;
}
