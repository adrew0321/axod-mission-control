import 'server-only';
import { eq, isNotNull } from 'drizzle-orm';
import { db } from '@/db/client';
import { sessions, projects } from '@/db/schema';
import { diffWorktree } from './worktree';
import { summarizeDiff, type Proposal } from './proposals';

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

  const proposals: Proposal[] = [];
  for (const r of rows) {
    if (!r.worktreePath) continue;
    const base = r.defaultBranch ?? 'dev';
    const { diff, files } = await diffWorktree(r.worktreePath, base);
    if (files.length === 0) continue;
    const { additions, deletions } = summarizeDiff(diff);
    proposals.push({
      sessionId: r.sessionId,
      sessionTitle: r.sessionTitle ?? '(untitled session)',
      projectId: r.projectId,
      projectName: r.projectName,
      branch: `mc/${r.sessionId}`,
      baseBranch: base,
      files,
      additions,
      deletions,
      ts: (r.updatedAt ?? new Date()).toISOString(),
    });
  }
  return proposals.sort((a, b) => (a.ts < b.ts ? 1 : a.ts > b.ts ? -1 : 0));
}
