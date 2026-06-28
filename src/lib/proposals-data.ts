import 'server-only';
import { eq, isNotNull } from 'drizzle-orm';
import { db } from '@/db/client';
import { sessions, projects } from '@/db/schema';
import { diffWorktree } from './worktree';
import { collectProposals, type Proposal } from './proposals';

/** Fleet-wide inbox: every session whose worktree differs from its base branch. */
export async function getProposals(): Promise<Proposal[]> {
  const rows = await db
    .select({
      sessionId: sessions.id,
      sessionTitle: sessions.title,
      worktreePath: sessions.worktree_path,
      updatedAt: sessions.updated_at,
      projectId: projects.id,
      projectName: projects.name,
      defaultBranch: projects.default_branch,
    })
    .from(sessions)
    .innerJoin(projects, eq(sessions.project_id, projects.id))
    .where(isNotNull(sessions.worktree_path));

  return collectProposals(rows, diffWorktree);
}
