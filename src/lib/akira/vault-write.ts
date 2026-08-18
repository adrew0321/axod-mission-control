// Scoped writes into AKIRA's vault document tree. Three guards remain, and none
// of them is a trust judgement (see spec D10):
//   - containment: a tool called vault_write writing OUTSIDE the vault is a bug
//   - memory/: mechanism — remember/forget own that zone; a file written here
//     without the note model is invisible to listNotes, and a hand-written
//     memory/INDEX.md is clobbered by the next remember
//   - markdown-only: keeps the vault a document tree
// SOUL.md, the root CLAUDE.md, and skills/ are deliberately writable.
import { existsSync, lstatSync, mkdirSync, writeFileSync, realpathSync } from 'node:fs';
import { dirname, resolve, sep } from 'node:path';
import { vaultDir } from './memory/store';

export type VaultWriteRejection = 'empty-path' | 'not-markdown' | 'outside-vault' | 'memory-zone';

export interface VaultPathCheck {
  ok: boolean;
  reason?: VaultWriteRejection;
  /** The real, symlink-resolved absolute path. Only set when ok. */
  abs?: string;
}

/**
 * True if `p` is present in a way realpathSync can resolve: an ordinary
 * existing entry, or a symlink whose own lstat succeeds even though its
 * target is missing (a dangling symlink). existsSync alone is not enough —
 * it stats THROUGH the link, so it reports false for a dangling symlink and
 * the ancestor walk below would skip straight past it, leaving its literal
 * (unresolved) name to be reattached unjudged.
 */
function isPresent(p: string): boolean {
  if (existsSync(p)) return true;
  try {
    return lstatSync(p).isSymbolicLink();
  } catch {
    return false;
  }
}

/** The deepest ancestor of `p` that is present, symlink-resolved. */
function realExistingAncestor(p: string): string {
  let cur = p;
  while (!isPresent(cur)) {
    const parent = dirname(cur);
    if (parent === cur) return cur;
    cur = parent;
  }
  return realpathSync(cur);
}

export function checkVaultPath(relPath: string, root: string): VaultPathCheck {
  const trimmed = relPath.trim();
  if (!trimmed) return { ok: false, reason: 'empty-path' };
  if (!trimmed.toLowerCase().endsWith('.md')) return { ok: false, reason: 'not-markdown' };

  const realRoot = existsSync(root) ? realpathSync(root) : resolve(root);
  const abs = resolve(realRoot, trimmed);

  // Resolve the deepest existing ancestor BEFORE judging containment, so a
  // symlink inside the vault pointing outside it cannot act as a bridge.
  let probe = abs;
  while (!isPresent(probe) && dirname(probe) !== probe) probe = dirname(probe);
  const realProbe = realExistingAncestor(probe);
  const real = realProbe + abs.slice(probe.length);

  const inside = real === realRoot || real.startsWith(realRoot + sep);
  if (!inside) return { ok: false, reason: 'outside-vault' };

  const rel = real.slice(realRoot.length + 1);
  if (rel.split(sep)[0].toLowerCase() === 'memory') return { ok: false, reason: 'memory-zone' };

  return { ok: true, abs: real };
}

export function vaultWrite(
  relPath: string,
  content: string,
  root: string = vaultDir(),
): { path: string; bytes: number } {
  const c = checkVaultPath(relPath, root);
  if (!c.ok || !c.abs) throw new Error(`vault_write rejected (${c.reason}): ${relPath}`);
  mkdirSync(dirname(c.abs), { recursive: true });
  writeFileSync(c.abs, content);
  return { path: relPath.trim(), bytes: Buffer.byteLength(content) };
}
