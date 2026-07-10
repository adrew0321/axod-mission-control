// Pure predicate: is this repo path a companion-ingested project (under data/ingested)?
export function isIngestedRepo(repoPath: string | null | undefined, ingestedRoot: string): boolean {
  return !!repoPath && repoPath.startsWith(ingestedRoot);
}
