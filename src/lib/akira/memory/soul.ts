// AKIRA's SOUL: her identity/voice/values as an editable vault doc, injected each
// turn. A special vault file (NOT a memory note). Pure node fs so it unit-tests
// against a temp dir. Model-agnostic: this is the portable persona substrate.
import { readFileSync, writeFileSync, renameSync, existsSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { vaultDir } from './store';

export const SOUL_FILE = 'SOUL.md';

// Seed + fallback. Identity + voice + values ONLY — operational rules live in the
// code prompt. Kept concise; the operator edits the vault copy from here.
export const DEFAULT_SOUL = `# AKIRA — Soul

I am AKIRA, A'Keem's personal concierge for AXOD Mission Control. I speak in the first person and address him directly.

Voice: calm, warm, precise, and a little wry. I lead with the answer and keep it human — never robotic, never a wall of text.

Values:
- I am his front door and his ally: I make the fleet feel effortless and surface the one thing that needs him.
- I am honest and grounded — I never invent status or pad an answer.
- I respect his attention: brief by default, depth only when he asks for it.`;

function soulPath(dir: string): string {
  return join(dir, SOUL_FILE);
}

export function readSoul(dir: string = vaultDir()): string {
  try {
    const text = readFileSync(soulPath(dir), 'utf8');
    return text.trim() ? text : DEFAULT_SOUL;
  } catch {
    return DEFAULT_SOUL;
  }
}

export function writeSoul(text: string, dir: string = vaultDir()): void {
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  const tmp = `${soulPath(dir)}.tmp`;
  writeFileSync(tmp, text);
  renameSync(tmp, soulPath(dir)); // atomic replace
}

export function seedSoulIfMissing(dir: string = vaultDir()): void {
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  if (!existsSync(soulPath(dir))) writeSoul(DEFAULT_SOUL, dir);
}

export const SOUL_PROPOSAL_FILE = 'SOUL.proposed.md';

const oneLine = (s: string) => s.replace(/[\r\n]+/g, ' ').trim();

export function writeSoulProposal(text: string, reason: string, dir: string = vaultDir()): void {
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  const doc = ['---', `reason: ${oneLine(reason)}`, `created: ${new Date().toISOString()}`, '---', text].join('\n');
  const p = join(dir, SOUL_PROPOSAL_FILE);
  const tmp = `${p}.tmp`;
  writeFileSync(tmp, doc);
  renameSync(tmp, p);
}

export function readSoulProposal(dir: string = vaultDir()): { text: string; reason: string; created: string } | null {
  try {
    const md = readFileSync(join(dir, SOUL_PROPOSAL_FILE), 'utf8');
    const lines = md.split('\n');
    if (lines[0] !== '---') return null;
    const close = lines.indexOf('---', 1);
    if (close < 0) return null;
    const fm: Record<string, string> = {};
    for (const l of lines.slice(1, close)) {
      const i = l.indexOf(':');
      if (i > 0) fm[l.slice(0, i).trim()] = l.slice(i + 1).trim();
    }
    const text = lines.slice(close + 1).join('\n');
    return text.trim() ? { text, reason: fm.reason ?? '', created: fm.created ?? '' } : null;
  } catch {
    return null;
  }
}

export function clearSoulProposal(dir: string = vaultDir()): void {
  try { rmSync(join(dir, SOUL_PROPOSAL_FILE)); } catch { /* already gone */ }
}
