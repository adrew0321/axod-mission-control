// Pure helpers for the folder picker (no fs/DB). Unit-tested.

/** Validate a new folder name (for create-repo): non-empty, no separators, not . or .. */
export function validateRepoName(name: string): { ok: true } | { ok: false; error: string } {
  const n = (name ?? '').trim();
  if (!n) return { ok: false, error: 'Folder name is required.' };
  if (/[\\/]/.test(n)) return { ok: false, error: 'Folder name cannot contain slashes.' };
  if (n === '.' || n === '..') return { ok: false, error: 'Invalid folder name.' };
  return { ok: true };
}

/** Split an absolute path into cumulative breadcrumb crumbs (Windows or POSIX). */
export function breadcrumbSegments(p: string): { label: string; path: string }[] {
  const norm = p.replace(/[\\/]+$/, ""); // drop trailing separators
  const isWin = /^[A-Za-z]:/.test(norm);
  if (isWin) {
    const parts = norm.split(/[\\/]/).filter(Boolean); // ['C:', 'Source', 'TEI']
    const segs: { label: string; path: string }[] = [{ label: parts[0], path: parts[0] + "\\" }];
    let acc = parts[0];
    for (let i = 1; i < parts.length; i++) {
      acc = acc + "\\" + parts[i];
      segs.push({ label: parts[i], path: acc });
    }
    return segs;
  }
  const segs: { label: string; path: string }[] = [{ label: "/", path: "/" }];
  let acc = "";
  for (const part of norm.split("/").filter(Boolean)) {
    acc += "/" + part;
    segs.push({ label: part, path: acc });
  }
  return segs;
}
