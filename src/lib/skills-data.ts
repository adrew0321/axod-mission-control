import 'server-only';
import { db } from '@/db/client';
import { agents } from '@/db/schema';
import { buildSkills, type AgentSkills } from './skills';

// Agents with an empty allowlist fall back to a minimal read-only set (defensive —
// every seeded agent currently has an explicit list).
const DEFAULT_TOOLS = ['Read', 'Glob', 'Grep'];

/** Per-agent capability map, read from the agents table. Static (allowlists don't change at runtime). */
export async function getSkills(): Promise<AgentSkills[]> {
  const rows = await db.select().from(agents);
  return rows.map((a) => {
    const tools = a.tools_allowlist && a.tools_allowlist.length > 0 ? [...a.tools_allowlist] : [...DEFAULT_TOOLS];
    // Sage's signature orchestration tool isn't in the allowlist (it's injected at dispatch).
    if (a.id === 'sage') tools.push('dispatch_agent');
    return {
      id: a.id,
      name: a.name,
      role: a.role,
      model: a.model,
      color: a.color ?? 'from-slate-400 to-slate-600',
      skills: buildSkills(tools),
    };
  });
}
