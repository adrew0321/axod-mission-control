// Pure skills logic — no db, no server-only, so the tsx test runner can import it.

export type SkillKind = 'read' | 'edit' | 'run';

export interface AgentSkill {
  name: string;
  label: string;
  description: string;
  kind: SkillKind;
}

export interface AgentSkills {
  id: string;
  name: string;
  role: string;
  model: string;
  color: string;
  skills: AgentSkill[];
}

/** Known tools → friendly metadata. */
export const TOOL_CATALOG: Record<string, { label: string; description: string; kind: SkillKind }> = {
  Read: { label: 'Read', description: 'Read file contents', kind: 'read' },
  Glob: { label: 'Glob', description: 'Find files by name pattern', kind: 'read' },
  Grep: { label: 'Grep', description: 'Search across file contents', kind: 'read' },
  Edit: { label: 'Edit', description: 'Modify existing files', kind: 'edit' },
  Write: { label: 'Write', description: 'Create or overwrite files', kind: 'edit' },
  Bash: { label: 'Bash', description: 'Run shell commands', kind: 'run' },
  WebFetch: { label: 'WebFetch', description: 'Fetch a URL', kind: 'read' },
  WebSearch: { label: 'WebSearch', description: 'Search the web', kind: 'read' },
  TodoWrite: { label: 'TodoWrite', description: 'Maintain a task plan', kind: 'read' },
  dispatch_agent: { label: 'dispatch_agent', description: 'Hand a task to a specialist', kind: 'run' },
};

/** Resolve a tool name to a skill; unknown tools default to the powerful `run` class. */
export function toAgentSkill(name: string): AgentSkill {
  const meta = TOOL_CATALOG[name];
  if (meta) return { name, label: meta.label, description: meta.description, kind: meta.kind };
  return { name, label: name, description: 'Custom tool', kind: 'run' };
}

/** Map a tool list to skills, de-duped, preserving first-seen order. */
export function buildSkills(tools: string[]): AgentSkill[] {
  const seen = new Set<string>();
  const out: AgentSkill[] = [];
  for (const t of tools) {
    if (seen.has(t)) continue;
    seen.add(t);
    out.push(toAgentSkill(t));
  }
  return out;
}
