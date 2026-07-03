// Vault I/O for AKIRA's memory: note files + INDEX.md + best-effort git. Not
// server-only (uses only node fs/child_process), so the fs paths are unit-tested
// against a temp dir. Only server code imports it (routes, akira-turn, tools).
import { readdirSync, readFileSync, writeFileSync, existsSync, mkdirSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { execFileSync } from 'node:child_process';
import { parseNote, serializeNote, buildIndex, safeSlug, type Note } from './note';

export function vaultDir(): string {
  return process.env.AKIRA_MEMORY_DIR || join(process.cwd(), 'data', 'akira-memory');
}
export function vaultReady(dir = vaultDir()): boolean {
  return existsSync(dir);
}
function notePath(dir: string, slug: string): string {
  const p = resolve(dir, `${slug}.md`);
  if (!p.startsWith(resolve(dir))) throw new Error('unsafe slug'); // belt + suspenders
  return p;
}
export function listNotes(dir = vaultDir()): Note[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => f.endsWith('.md') && f !== 'INDEX.md')
    .map((f) => parseNote(f.replace(/\.md$/, ''), readFileSync(join(dir, f), 'utf8')))
    .sort((a, b) => (a.updated < b.updated ? 1 : a.updated > b.updated ? -1 : 0));
}
export function readNote(slug: string, dir = vaultDir()): Note | null {
  const s = safeSlug(slug);
  if (!s) return null;
  const p = notePath(dir, s);
  return existsSync(p) ? parseNote(s, readFileSync(p, 'utf8')) : null;
}
export function writeNote(
  input: { title: string; description: string; type: string; body: string; slug?: string },
  dir = vaultDir(),
): Note {
  const slug = safeSlug(input.slug || input.title);
  if (!slug) throw new Error('could not derive a safe slug from the title');
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  const now = new Date().toISOString();
  const existing = readNote(slug, dir);
  const note: Note = {
    slug,
    title: input.title,
    description: input.description,
    type: input.type,
    created: existing?.created || now,
    updated: now,
    body: input.body,
  };
  writeFileSync(notePath(dir, slug), serializeNote(note));
  writeIndex(dir);
  return note;
}
export function deleteNote(slug: string, dir = vaultDir()): boolean {
  const s = safeSlug(slug);
  if (!s) return false;
  const p = notePath(dir, s);
  if (!existsSync(p)) return false;
  rmSync(p);
  writeIndex(dir);
  return true;
}
export function writeIndex(dir = vaultDir()): void {
  if (!existsSync(dir)) return;
  writeFileSync(join(dir, 'INDEX.md'), buildIndex(listNotes(dir)) + '\n');
}
export function indexText(dir = vaultDir()): string {
  return buildIndex(listNotes(dir));
}

// --- git: best-effort, never throws into a turn ---
function git(dir: string, args: string[]): void {
  try {
    execFileSync('git', ['-C', dir, ...args], { stdio: 'ignore', timeout: 15_000 });
  } catch {
    /* offline / no remote / no repo — non-fatal */
  }
}
export function gitCommitPush(message: string, dir = vaultDir()): void {
  if (!existsSync(join(dir, '.git'))) return;
  git(dir, ['add', '-A']);
  git(dir, ['-c', 'user.name=AKIRA', '-c', 'user.email=akira@axod', 'commit', '-m', message]);
  git(dir, ['push']);
}
let lastPull = 0;
export function gitPullDebounced(dir = vaultDir()): void {
  if (!existsSync(join(dir, '.git'))) return;
  const ms = Number(process.env.AKIRA_MEMORY_PULL_MS ?? 60_000);
  if (Date.now() - lastPull < ms) return;
  lastPull = Date.now();
  git(dir, ['pull', '--ff-only']);
}
