// Symlink-aware wrapper over the pure path gate. `validatePath` is path MATH: it
// cannot see a symlink inside the room or doorway that points outside them. Slice
// 1 had no action that could create one; `shell` does, so every path is re-checked
// after links are resolved.
//
// This is defence in depth INSIDE the room. The load-bearing boundary is the LXD
// mount namespace — prod and /home/akeem are simply not in the container.
import { realpath } from 'node:fs/promises';
import { dirname, join, basename } from 'node:path';
import { validatePath, type Roots, type PathVerdict } from './paths';

/**
 * realpath the deepest ancestor that actually exists, then re-append the tail
 * that does not. A leaf may legitimately be missing (fs_write creates it), but
 * every directory above it must resolve to somewhere real.
 */
async function realpathDeepest(abs: string): Promise<string> {
  const tail: string[] = [];
  let cur = abs;
  for (;;) {
    try {
      const real = await realpath(cur);
      return tail.length ? join(real, ...tail) : real;
    } catch {
      const parent = dirname(cur);
      if (parent === cur) return abs; // hit the filesystem root; nothing resolved
      tail.unshift(basename(cur));
      cur = parent;
    }
  }
}

/** validatePath, then again against the link-resolved path. */
export async function validatePathReal(roots: Roots, requested: string): Promise<PathVerdict> {
  const first = validatePath(roots, requested);
  if (!first.ok) return first; // obvious escapes never touch the disk
  const real = await realpathDeepest(first.abs);
  // The roots themselves must be resolved too, not just the candidate — comparing
  // a link-resolved candidate against a NOT-yet-resolved root produces false
  // refusals whenever the root's own path isn't already canonical (e.g. a parent
  // directory symlink, or on Windows a short 8.3 alias vs. the long form). Both
  // sides of the containment check must be in the same, real, form.
  const realRoots: Roots = {
    room: await realpathDeepest(roots.room),
    doorway: await realpathDeepest(roots.doorway),
  };
  const second = validatePath(realRoots, real);
  if (!second.ok) return { ok: false, reason: 'path resolves outside the room and doorway (symlink)' };
  return second;
}
