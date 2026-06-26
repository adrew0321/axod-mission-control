import 'server-only';
import { desc, eq } from 'drizzle-orm';
import { randomBytes, bytesToHex } from '@noble/hashes/utils.js';
import { db } from '@/db/client';
import { sessions, projects } from '@/db/schema';

/**
 * The project's active session for Discord chat: its most-recently-updated session,
 * or a freshly created one if the project has none yet. Mirrors how the Scheduler
 * seeds a session (branch = project default).
 */
export async function getActiveSessionId(projectId: string): Promise<string> {
  const existing = await db
    .select({ id: sessions.id })
    .from(sessions)
    .where(eq(sessions.project_id, projectId))
    .orderBy(desc(sessions.updated_at))
    .limit(1)
    .then((r) => r[0]);
  if (existing) return existing.id;

  const project = await db
    .select({ default_branch: projects.default_branch })
    .from(projects)
    .where(eq(projects.id, projectId))
    .limit(1)
    .then((r) => r[0]);

  const sessionId = `sess_${bytesToHex(randomBytes(4))}`;
  const ts = new Date();
  await db.insert(sessions).values({
    id: sessionId,
    project_id: projectId,
    title: 'Discord',
    branch: project?.default_branch ?? 'dev',
    worktree_path: null,
    status: 'active',
    cleared_at: null,
    created_at: ts,
    updated_at: ts,
  });
  return sessionId;
}
