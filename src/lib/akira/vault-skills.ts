// Which of AKIRA's skills the SDK should enable.
//
// `skills: 'all'` is wrong for her: discovery covers every working-directory
// root, and her cwd is Mission Control itself, which ships
// `.claude/skills/ship-mc-feature` — a developer release workflow she has no
// tools to execute. Naming the vault's own skills keeps MC's workflows out of
// her context. The list is read from disk per turn, so a skill she authors with
// vault_write is enabled on her next turn.
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { vaultDir } from './memory/store';

/**
 * The `name:` from a SKILL.md frontmatter block. Empty when there is no
 * frontmatter or no name — callers fall back to the directory name, which is
 * what the SDK matches against anyway.
 */
export function skillName(md: string): string {
  const fm = /^---\r?\n([\s\S]*?)\r?\n---/.exec(md);
  if (!fm) return '';
  const n = /^name:[ \t]*(.+?)[ \t]*$/m.exec(fm[1]);
  return n ? n[1].replace(/^['"]|['"]$/g, '').trim() : '';
}

/** Skill names under <vault>/skills. Empty when the zone is absent. */
export function listVaultSkillNames(dir: string = vaultDir()): string[] {
  const root = join(dir, 'skills');
  if (!existsSync(root)) return [];
  let entries;
  try {
    entries = readdirSync(root, { withFileTypes: true });
  } catch {
    return []; // an unreadable skills zone must never break a turn
  }
  const names: string[] = [];
  for (const e of entries) {
    // isDirectory() is false for a symlinked skill folder, so accept links too.
    if (!e.isDirectory() && !e.isSymbolicLink()) continue;
    const skillMd = join(root, e.name, 'SKILL.md');
    if (!existsSync(skillMd)) continue;
    let declared = '';
    try {
      declared = skillName(readFileSync(skillMd, 'utf8'));
    } catch {
      // unreadable SKILL.md: fall back to the directory name
    }
    names.push(declared || e.name);
  }
  return names;
}
