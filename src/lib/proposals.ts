// Pure proposal logic — no db, no server-only, so the tsx test runner can import it.

export interface Proposal {
  sessionId: string;
  sessionTitle: string;
  projectId: string;
  projectName: string;
  branch: string;        // mc/<sessionId>
  baseBranch: string;    // project default branch
  files: Array<{ status: string; path: string }>;
  additions: number;
  deletions: number;
  ts: string;            // session.updated_at, ISO
}

/**
 * Count added/removed CONTENT lines in a unified diff. Lines starting with a
 * single '+'/'-' are changes; the '+++'/'---' file headers are skipped.
 */
export function summarizeDiff(diff: string): { additions: number; deletions: number } {
  let additions = 0;
  let deletions = 0;
  for (const line of diff.split('\n')) {
    if (line.startsWith('+') && !line.startsWith('+++')) additions++;
    else if (line.startsWith('-') && !line.startsWith('---')) deletions++;
  }
  return { additions, deletions };
}

export interface ProposalRow {
  sessionId: string;
  sessionTitle: string | null;
  worktreePath: string | null;
  updatedAt: Date | null;
  projectId: string;
  projectName: string;
  defaultBranch: string | null;
}

type DiffFn = (
  wtPath: string,
  baseBranch: string,
) => Promise<{ diff: string; files: Array<{ status: string; path: string }> }>;

/**
 * Build proposals from session rows. Each row is isolated in its own try/catch:
 * a worktree whose diff throws (e.g. a broken/hollow dir with no valid base ref)
 * is skipped and logged, never fatal to the rest of the list. Sorted newest-first.
 */
export async function collectProposals(rows: ProposalRow[], diff: DiffFn): Promise<Proposal[]> {
  const proposals: Proposal[] = [];
  for (const r of rows) {
    if (!r.worktreePath) continue;
    try {
      const base = r.defaultBranch ?? 'dev';
      const { diff: text, files } = await diff(r.worktreePath, base);
      if (files.length === 0) continue;
      const { additions, deletions } = summarizeDiff(text);
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
    } catch (err) {
      console.warn(`[proposals] skipping session ${r.sessionId}: ${err instanceof Error ? err.message : err}`);
    }
  }
  return proposals.sort((a, b) => (a.ts < b.ts ? 1 : a.ts > b.ts ? -1 : 0));
}
