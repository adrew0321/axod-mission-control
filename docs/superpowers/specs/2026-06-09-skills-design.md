# Skills view — design

**Date:** 2026-06-09
**Status:** approved (design)
**Nav section:** `skills` (currently `soon` → flip to `live`)

## Summary

A read-only **capability map**: the System-group nav view that shows, per agent, exactly
which tools it may use — with friendly descriptions and a read / edit / run tag. It doubles
as the security surface, since the **tool allowlist is the v1 safety model** (capability
allowlist + worktree isolation + diff review). No schema, no writes, no live refresh — the
allowlist doesn't change at runtime, so it's a static server-loaded view.

## Decisions (locked during brainstorm)

1. **Read-only** v1 (no editing of allowlists).
2. Grouped **by agent** (matches the roster mental model).
3. Each tool carries a **kind** tag: `read` | `edit` | `run` — so "who can edit files / run
   commands" is visible at a glance.
4. **Sage** gets a synthetic `dispatch_agent` skill (its orchestration lever; not in the
   allowlist — injected at dispatch time).

## 1. Pure module — `src/lib/skills.ts` (no db, no server-only; testable)

```ts
export type SkillKind = 'read' | 'edit' | 'run';

export interface AgentSkill {
  name: string;        // tool name, e.g. "Bash"
  label: string;       // display label
  description: string; // friendly one-liner
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

// Catalog of known tools → friendly metadata.
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

// Unknown tools fall back to a safe "run"-classified entry (treat as powerful by default).
export function toAgentSkill(name: string): AgentSkill { ... }

export function buildSkills(tools: string[]): AgentSkill[]; // map + de-dupe, preserve order
```

- Unknown tool → `{ name, label: name, description: 'Custom tool', kind: 'run' }` (default to the
  most-powerful class so an unrecognized capability is never under-stated).
- `buildSkills` de-dupes (an agent shouldn't list the same tool twice) and preserves input order.

## 2. Server query — `src/lib/skills-data.ts` (server-only)

`getSkills(): Promise<AgentSkills[]>` —
- read all `agents`;
- per agent, `tools = agent.tools_allowlist ?? []`; if empty, use a default read-only set
  `['Read','Glob','Grep']` (defensive — every seeded agent currently has an explicit list);
- for `sage`, append `'dispatch_agent'`;
- `skills = buildSkills(tools)`; carry `id/name/role/model/color`.
- Order: keep the DB order (Sage first, as seeded).

## 3. UI — `src/components/skills-view.tsx`

- Rendered when `activeSection === 'skills'` — a new branch alongside the Proposals /
  Task Board / Live Feed / Agent Team switch in `mission-control.tsx`. Flip `skills` →
  `status: 'live'` in `src/lib/nav-sections.ts` and update the nav test (live set gains
  `'skills'`).
- Loaded in `page.tsx` as `await getSkills()` → passed as the `initialSkills` prop straight
  to the view (no state/effect — static).
- Layout: a scrollable column of **agent cards**. Each card header: `AgentIcon` (from
  `mission-control-bits`) + name · role · model, plus a `claude-sdk` runtime badge (matching
  the roster). Body: each skill as a row — `label`, `description` (muted), and a small colored
  **kind tag**: `read` (dim/cyan), `edit` (amber), `run` (red). Themed to the app (mono +
  Georgia, `h-11` header).
- Header bar: "Skills" + a subtitle like "what each agent is allowed to do".

## 4. Error handling

- No writes/routes, so little to fail. An agent with no resolvable tools renders an empty
  skills list (shows the card with a muted "no tools" line). Unknown tools render via the
  fallback (never crash).

## 5. Testing

- Pure unit tests (`src/lib/skills.test.ts`): `toAgentSkill` for a known tool (correct
  label/description/kind), an unknown tool (fallback `run`), and `buildSkills` (maps a list,
  de-dupes, preserves order). DB/UI are integration (the view just renders props).

## Out of scope (later)

Editing allowlists from the UI · a real skills registry / agentskills.io skill files (the
Hermes "Skills" pillar) · per-project capability overrides (the unused `tool_permissions`
table) · live refresh.
