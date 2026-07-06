// Pure project helpers (no DB/fs) — shared by the server (page.tsx, routes) and
// unit-tested under `tsx --test`. The cookie name lives here as the single source.

export const ACTIVE_PROJECT_COOKIE = 'mc_active_project';

/**
 * Pick the active project: the cookie's project if it still exists, else the
 * most-recent session's project, else the first project. Returns undefined only
 * when there are no projects at all.
 */
export function resolveActiveProject<T extends { id: string }>(
  projects: T[],
  cookieId: string | undefined,
  recentSessionProjectId: string | undefined,
): T | undefined {
  if (projects.length === 0) return undefined;
  return (
    (cookieId && projects.find((p) => p.id === cookieId)) ||
    (recentSessionProjectId && projects.find((p) => p.id === recentSessionProjectId)) ||
    projects[0]
  );
}

/** Turn a project name into a stable id: lowercase, non-alphanumerics → '-', trimmed/collapsed. */
export function slugifyProjectId(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

export type NewProjectInput = {
  name?: string;
  repoPath?: string;
  defaultBranch?: string;
  githubUrl?: string;
};

/** Shape-only validation (the filesystem repo check happens in the route). */
export function validateNewProjectInput(
  input: NewProjectInput,
): { ok: true } | { ok: false; error: string } {
  if (!input.name || !input.name.trim()) return { ok: false, error: 'Project name is required.' };
  if (!input.repoPath || !input.repoPath.trim()) return { ok: false, error: 'Repo path is required.' };
  return { ok: true };
}

/** Pick a unique project id from a name: slugify, then append -2, -3… on collision. */
export function pickProjectId(name: string, existingIds: string[]): string {
  const base = slugifyProjectId(name) || 'project';
  const taken = new Set(existingIds);
  let id = base;
  for (let n = 2; taken.has(id); n++) id = `${base}-${n}`;
  return id;
}
