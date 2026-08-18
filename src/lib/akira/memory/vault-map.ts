// The vault's own map: conventions and navigation pattern, authored as
// CLAUDE.md at the vault root so it is editable in Obsidian and present for any
// Claude Code opened directly in the vault. Injected into AKIRA's turn because
// she runs with cwd at Mission Control, where a vault CLAUDE.md never auto-loads.
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { vaultDir } from './store';

export const VAULT_MAP_FILE = 'CLAUDE.md';
const DEFAULT_MAX_CHARS = 6144;

export function readVaultMap(dir: string = vaultDir(), maxChars = DEFAULT_MAX_CHARS): string {
  const p = join(dir, VAULT_MAP_FILE);
  if (!existsSync(p)) return '';
  try {
    return readFileSync(p, 'utf8').trim().slice(0, maxChars);
  } catch {
    return ''; // unreadable map must never break a turn
  }
}

/** Pure: wrap the map as an injectable block. Empty in, empty out. */
export function vaultBlock(map: string): string {
  const m = map.trim();
  return m ? `## VAULT\n${m}` : '';
}
