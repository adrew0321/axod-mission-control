import 'server-only';
import { desc, eq } from 'drizzle-orm';
import { randomBytes, bytesToHex } from '@noble/hashes/utils.js';
import { db } from '@/db/client';
import { sessions, projects } from '@/db/schema';
import { resolveActiveSession } from '@/lib/sessions';

/**
 * The project's active session for Discord chat: resolves through
 * projects.active_session_id (shared with web + scheduler), self-healing to the
 * newest session, or creating one if the project has none yet.
 */
export async function getActiveSessionId(projectId: string): Promise<string> {
  const project = await db
    .select()
    .from(projects)
    .where(eq(projects.id, projectId))
    .limit(1)
    .then((r) => r[0]);

  const rows = await db
    .select({ id: sessions.id })
    .from(sessions)
    .where(eq(sessions.project_id, projectId))
    .orderBy(desc(sessions.updated_at));

  const decision = resolveActiveSession({
    activeId: project?.active_session_id ?? null,
    existingIds: rows.map((r) => r.id),
    newestId: rows[0]?.id ?? null,
  });

  if (decision.kind === 'use') {
    if (project?.active_session_id !== decision.id) {
      await db.update(projects).set({ active_session_id: decision.id }).where(eq(projects.id, projectId));
    }
    return decision.id;
  }

  const sessionId = `sess_${bytesToHex(randomBytes(4))}`;
  const ts = new Date();
  const base = project?.default_branch ?? 'dev';
  await db.insert(sessions).values({
    id: sessionId,
    project_id: projectId,
    title: 'Discord',
    branch: `mc/${sessionId}`,
    base_branch: base,
    worktree_path: null,
    status: 'active',
    cleared_at: null,
    created_at: ts,
    updated_at: ts,
  });
  await db.update(projects).set({ active_session_id: sessionId }).where(eq(projects.id, projectId));
  return sessionId;
}
