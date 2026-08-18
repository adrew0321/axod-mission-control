// Scoped writes into AKIRA's vault document tree. Three guards remain, and none
// of them is a trust judgement (see spec D10):
//   - containment: a tool called vault_write writing OUTSIDE the vault is a bug
//   - memory/: mechanism — remember/forget own that zone; a file written here
//     without the note model is invisible to listNotes, and a hand-written
//     memory/INDEX.md is clobbered by the next remember
//   - markdown-only: keeps the vault a document tree
// SOUL.md, the root CLAUDE.md, and skills/ are deliberately writable.
import { existsSync, mkdirSync, writeFileSync, realpathSync } from 'node:fs';
import { dirname, resolve, sep } from 'node:path';
import { vaultDir } from './memory/store';

export type VaultWriteRejection = 'empty-path' | 'not-markdown' | 'outside-vault' | 'memory-zone';

export interface VaultPathCheck {
  ok: boolean;
  reason?: VaultWriteRejection;
  /** The real, symlink-resolved absolute path. Only set when ok. */
  abs?: string;
}

/** The deepest ancestor of `p` that exists, symlink-resolved. */
function realExistingAncestor(p: string): string {
  let cur = p;
  while (!existsSync(cur)) {
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
  while (!existsSync(probe) && dirname(probe) !== probe) probe = dirname(probe);
  const realProbe = realExistingAncestor(probe);
  const real = realProbe + abs.slice(probe.length);

  const inside = real === realRoot || real.startsWith(realRoot + sep);
  if (!inside) return { ok: false, reason: 'outside-vault' };

  const rel = real.slice(realRoot.length + 1);
  if (rel.split(sep)[0] === 'memory') return { ok: false, reason: 'memory-zone' };

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
