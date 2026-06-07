import 'server-only';
import { randomBytes, bytesToHex } from '@noble/hashes/utils.js';
import { desc, eq } from 'drizzle-orm';
import { db } from '@/db/client';
import { projects, sessions } from '@/db/schema';

/**
 * Return the project's most-recently-updated session, creating one if the project
 * has none yet (so a freshly added / freshly switched-to project always has a
 * workspace session). The session's branch defaults to the project's default_branch.
 */
export async function getOrCreateActiveSession(projectId: string) {
  const existing = await db
    .select()
    .from(sessions)
    .where(eq(sessions.project_id, projectId))
    .orderBy(desc(sessions.updated_at))
    .limit(1)
    .then((r) => r[0]);
  if (existing) return existing;

  const project = await db
    .select()
    .from(projects)
    .where(eq(projects.id, projectId))
    .limit(1)
    .then((r) => r[0]);

  const now = new Date();
  const row = {
    id: `sess_${bytesToHex(randomBytes(4))}`,
    project_id: projectId,
    title: '(new session)',
    branch: project?.default_branch ?? 'dev',
    worktree_path: null,
    status: 'active',
    cleared_at: null,
    created_at: now,
    updated_at: now,
  };
  await db.insert(sessions).values(row);
  return row;
}
