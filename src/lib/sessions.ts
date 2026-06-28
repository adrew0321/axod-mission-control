// Pure session helpers (no DB/fs) — shared by server (page.tsx, routes, resolvers)
// and unit-tested under `tsx --test`. Mirrors the structure of ./projects.

/**
 * Normalize `git branch -a --format='%(refname:short)'` output into an ordered,
 * de-duped branch list: strips `origin/` prefixes, drops HEAD/detached lines, and
 * puts `defaultBranch` first (adding it if missing). Pure.
 */
export function parseGitBranches(raw: string, defaultBranch: string): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const line of raw.split('\n')) {
    let name = line.trim();
    if (!name) continue;
    if (name.includes('->')) continue; // "origin/HEAD -> origin/main"
    if (name.startsWith('(') || name.includes('detached')) continue; // detached HEAD
    name = name.replace(/^remotes\//, '').replace(/^origin\//, '');
    if (!name || name === 'HEAD') continue;
    if (seen.has(name)) continue;
    seen.add(name);
    out.push(name);
  }
  const ordered = out.filter((b) => b !== defaultBranch);
  return [defaultBranch, ...ordered];
}

/**
 * Decide which session is active for a project, given the stored active id, the
 * set of existing session ids, and the newest session id. Pure — the db read/write
 * lives in the server-only resolver that calls this.
 */
export function resolveActiveSession(input: {
  activeId: string | null;
  existingIds: string[];
  newestId: string | null;
}): { kind: 'use'; id: string } | { kind: 'create' } {
  const { activeId, existingIds, newestId } = input;
  if (activeId && existingIds.includes(activeId)) return { kind: 'use', id: activeId };
  if (newestId) return { kind: 'use', id: newestId };
  return { kind: 'create' };
}

/** Session display title with a sane fallback. Pure. */
export function sessionTitleOrDefault(title: string | null | undefined): string {
  const t = (title ?? '').trim();
  return t || 'New session';
}

/** Shape validation for creating a session. baseBranch is optional; when present it
 * must be one of the repo's branches. Pure. */
export function validateNewSessionInput(
  input: { title?: string; baseBranch?: string },
  allowedBranches: string[],
): { ok: true } | { ok: false; error: string } {
  if (input.baseBranch && !allowedBranches.includes(input.baseBranch)) {
    return { ok: false, error: `Unknown base branch: ${input.baseBranch}` };
  }
  return { ok: true };
}
