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
