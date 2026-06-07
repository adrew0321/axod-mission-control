import path from 'node:path';

/**
 * Resolve `rel` (a path relative to `root`) to an absolute path, or return null
 * if it escapes `root`. Mirrors the traversal guard in preview.ts. No fs access.
 */
export function resolveWithinRoot(root: string, rel: string): string | null {
  const clean = (rel ?? '').replace(/^[\\/]+/, '');
  const resolved = path.resolve(root, clean);
  if (resolved !== root && !resolved.startsWith(root + path.sep)) return null;
  return resolved;
}
