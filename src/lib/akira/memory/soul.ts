// AKIRA's SOUL: her identity/voice/values as an editable vault doc, injected each
// turn. A special vault file (NOT a memory note). Pure node fs so it unit-tests
// against a temp dir. Model-agnostic: this is the portable persona substrate.
import { readFileSync, writeFileSync, renameSync, existsSync, mkdirSync } from 'node:fs';
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
