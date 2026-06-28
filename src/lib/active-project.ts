import 'server-only';
import { randomBytes, bytesToHex } from '@noble/hashes/utils.js';
import { desc, eq } from 'drizzle-orm';
import { db } from '@/db/client';
import { projects, sessions } from '@/db/schema';
import { resolveActiveSession } from '@/lib/sessions';

/**
 * Return the project's active session (projects.active_session_id), self-healing to
 * the newest session for legacy projects, or creating one if the project has none.
 * Persists the resolved id back to active_session_id so web + Discord + scheduler agree.
 */
export async function getOrCreateActiveSession(projectId: string) {
  const project = await db
    .select()
    .from(projects)
    .where(eq(projects.id, projectId))
    .limit(1)
    .then((r) => r[0]);

  const rows = await db
    .select()
    .from(sessions)
    .where(eq(sessions.project_id, projectId))
    .orderBy(desc(sessions.updated_at));

  const decision = resolveActiveSession({
    activeId: project?.active_session_id ?? null,
    existingIds: rows.map((r) => r.id),
    newestId: rows[0]?.id ?? null,
  });

  if (decision.kind === 'use') {
    const chosen = rows.find((r) => r.id === decision.id)!;
    if (project?.active_session_id !== chosen.id) {
      await db.update(projects).set({ active_session_id: chosen.id }).where(eq(projects.id, projectId));
    }
    return chosen;
  }

  const now = new Date();
  const base = project?.default_branch ?? 'dev';
  const row = {
    id: `sess_${bytesToHex(randomBytes(4))}`,
    project_id: projectId,
    title: '(new session)',
    branch: `mc/`, // placeholder; replaced below to include the id
    base_branch: base,
    worktree_path: null,
    status: 'active',
    cleared_at: null,
    created_at: now,
    updated_at: now,
  };
  row.branch = `mc/${row.id}`;
  await db.insert(sessions).values(row);
  await db.update(projects).set({ active_session_id: row.id }).where(eq(projects.id, projectId));
  return row;
}
