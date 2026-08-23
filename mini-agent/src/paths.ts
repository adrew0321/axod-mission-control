// Path gate for the room agent. Every fs_* command goes through validatePath
// before it touches disk. Pure — no fs access, unit-tested with fake roots.
import { resolve, sep } from 'node:path';

export interface Roots {
  /** The container-local workspace, e.g. /home/akira/workshop */
  room: string;
  /** The bind-mounted shared folder, e.g. /mnt/doorway */
  doorway: string;
}

export type PathVerdict = { ok: true; abs: string } | { ok: false; reason: string };

/**
 * True iff `child` resolves to a path inside `parent`. Compares against
 * parent + separator so /x/workshop-evil is not "inside" /x/workshop.
 *
 * `inclusive` (default true) controls whether `child === parent` itself
 * counts as "inside" — this gate needs it to (a path gate that refused the
 * room's own root would be useless), but doorway.ts's `zoneForPath` does
 * NOT: a bare zone directory with no file under it is not a drop, so it
 * calls this with `{ inclusive: false }`. Shared here rather than
 * duplicated so the two call sites can't silently drift on the boundary
 * case again.
 */
export function within(parent: string, child: string, opts: { inclusive?: boolean } = {}): boolean {
  const inclusive = opts.inclusive ?? true;
  const p = resolve(parent);
  const c = resolve(child);
  if (inclusive && c === p) return true;
  return c.startsWith(p.endsWith(sep) ? p : p + sep);
}

export function validatePath(roots: Roots, requested: string): PathVerdict {
  if (!requested || requested.trim() === '') return { ok: false, reason: 'empty path' };
  if (requested.includes('\0')) return { ok: false, reason: 'null byte in path' };

  // A relative path is relative to the room; an absolute one resolves as itself.
  const abs = resolve(roots.room, requested);

  if (within(roots.room, abs) || within(roots.doorway, abs)) return { ok: true, abs };
  return { ok: false, reason: 'path outside the room and doorway' };
}
