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

function within(parent: string, child: string): boolean {
  const p = resolve(parent);
  const c = resolve(child);
  // Compare against parent + separator so /x/workshop-evil is not "inside" /x/workshop.
  return c === p || c.startsWith(p.endsWith(sep) ? p : p + sep);
}

export function validatePath(roots: Roots, requested: string): PathVerdict {
  if (!requested || requested.trim() === '') return { ok: false, reason: 'empty path' };
  if (requested.includes('\0')) return { ok: false, reason: 'null byte in path' };

  // A relative path is relative to the room; an absolute one resolves as itself.
  const abs = resolve(roots.room, requested);

  if (within(roots.room, abs) || within(roots.doorway, abs)) return { ok: true, abs };
  return { ok: false, reason: 'path outside the room and doorway' };
}
