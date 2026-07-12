// Pure predicate: is this repo path a companion-ingested project (under data/ingested)?
import { relative, isAbsolute } from 'node:path';

export function isIngestedRepo(repoPath: string | null | undefined, ingestedRoot: string): boolean {
  if (!repoPath) return false;
  // Path-BOUNDARY check, not a prefix check: a raw startsWith would wrongly accept a
  // sibling like `<root>-evil`. relative() escaping the root yields a leading `..`
  // (or an absolute path across drives on Windows).
  const rel = relative(ingestedRoot, repoPath);
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
}
