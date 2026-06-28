import 'server-only';
import { eq, and, desc, isNotNull, isNull, sql } from 'drizzle-orm';
import { db } from '@/db/client';
import { sessions, projects, messages } from '@/db/schema';
import { diffWorktree } from './worktree';
import { collectProposals, type Proposal } from './proposals';

/** Fleet-wide inbox: every session whose worktree differs from its base branch. */
export async function getProposals(): Promise<Proposal[]> {
  const rows = await db
    .select({
      sessionId: sessions.id,
      sessionTitle: sessions.title,
      worktreePath: sessions.worktree_path,
      baseBranch: sessions.base_branch,
      updatedAt: sessions.updated_at,
      projectId: projects.id,
      projectName: projects.name,
      defaultBranch: projects.default_branch,
    })
    .from(sessions)
    .innerJoin(projects, eq(sessions.project_id, projects.id))
    .where(and(isNotNull(sessions.worktree_path), isNull(sessions.archived_at)));

  const rowsWithSummary = await Promise.all(
    rows.map(async (r) => {
      const last = await db
        .select({ content: messages.content })
        .from(messages)
        .where(and(eq(messages.session_id, r.sessionId), eq(messages.role, 'agent')))
        .orderBy(desc(messages.created_at), desc(sql`rowid`))
        .limit(1)
        .then((x) => x[0]);
      return { ...r, summaryRaw: last?.content ?? null };
    }),
  );

  return collectProposals(rowsWithSummary, diffWorktree);
}
