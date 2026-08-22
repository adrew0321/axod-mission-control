// Vault I/O for AKIRA's memory: note files + INDEX.md + best-effort git. Not
// server-only (uses only node fs/child_process), so the fs paths are unit-tested
// against a temp dir. Only server code imports it (routes, akira-turn, tools).
import { readdirSync, readFileSync, writeFileSync, existsSync, mkdirSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { execFile } from 'node:child_process';
import { parseNote, serializeNote, buildIndex, safeSlug, isNoteFile, type Note } from './note';
import { createSerialQueue } from './serial';

export function vaultDir(): string {
  return process.env.AKIRA_MEMORY_DIR || join(process.cwd(), 'data', 'akira-memory');
}
export function vaultReady(dir = vaultDir()): boolean {
  return existsSync(dir);
}
/**
 * The notes zone. Falls back to the vault root when memory/ is absent so the
 * code deploy and the data migration are order-independent — a pre-migration
 * vault keeps reading and writing exactly where it always did.
 */
export function memoryDir(dir = vaultDir()): string {
  const sub = join(dir, 'memory');
  return existsSync(sub) ? sub : dir;
}
function notePath(dir: string, slug: string): string {
  const p = resolve(dir, `${slug}.md`);
  if (!p.startsWith(resolve(dir))) throw new Error('unsafe slug'); // belt + suspenders
  return p;
}
export function listNotes(dir = memoryDir()): Note[] {
  if (!existsSync(dir)) return [];
  const notes: Note[] = [];
  for (const f of readdirSync(dir)) {
    if (!f.endsWith('.md') || f === 'INDEX.md' || f === 'SOUL.md' || f === 'SOUL.proposed.md') continue;
    const md = readFileSync(join(dir, f), 'utf8');
    if (!isNoteFile(md)) continue; // stray file a user dropped in the vault — not a memory
    notes.push(parseNote(f.replace(/\.md$/, ''), md));
  }
  return notes.sort((a, b) => (a.updated < b.updated ? 1 : a.updated > b.updated ? -1 : 0));
}
export function readNote(slug: string, dir = memoryDir()): Note | null {
  const s = safeSlug(slug);
  if (!s) return null;
  const p = notePath(dir, s);
  return existsSync(p) ? parseNote(s, readFileSync(p, 'utf8')) : null;
}
export function writeNote(
  input: { title: string; description: string; type: string; body: string; slug?: string },
  dir = memoryDir(),
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
export function deleteNote(slug: string, dir = memoryDir()): boolean {
  const s = safeSlug(slug);
  if (!s) return false;
  const p = notePath(dir, s);
  if (!existsSync(p)) return false;
  rmSync(p);
  writeIndex(dir);
  return true;
}
// Lessons are injected in full as guidance (see lessonsText) — keep them OUT of
// the recall index so they steer rather than double-appear.
function nonLessonNotes(dir: string): Note[] {
  return listNotes(dir).filter((n) => n.type !== 'lesson');
}

export function writeIndex(dir = memoryDir()): void {
  if (!existsSync(dir)) return;
  writeFileSync(join(dir, 'INDEX.md'), buildIndex(nonLessonNotes(dir)) + '\n');
}
export function indexText(dir = memoryDir()): string {
  return buildIndex(nonLessonNotes(dir));
}

export interface LessonsResult {
  text: string;
  included: number;
  dropped: number;
}

/**
 * Full bodies of the newest lesson notes, as an injectable guidance block.
 * Bounded by BOTH a note count and a char budget (whichever hits first). The
 * counts are returned so truncation surfaces in the UI instead of happening
 * silently — pruning is a judgement call for A'Keem and AKIRA, not the code's.
 */
export function lessonsText(
  dir = memoryDir(),
  opts: { maxNotes?: number; maxChars?: number } = {},
): LessonsResult {
  const maxNotes = opts.maxNotes ?? 20;
  const maxChars = opts.maxChars ?? 8192;
  const lessons = listNotes(dir).filter((n) => n.type === 'lesson'); // newest-first
  const blocks: string[] = [];
  let chars = 0;
  for (const n of lessons.slice(0, maxNotes)) {
    const block = `### ${n.title}\n${n.body.trim()}`;
    if (chars + block.length > maxChars && blocks.length > 0) break;
    blocks.push(block);
    chars += block.length;
  }
  return { text: blocks.join('\n\n'), included: blocks.length, dropped: lessons.length - blocks.length };
}

// --- git: best-effort, ASYNC + serialized. Never blocks the event loop (which
// serves the HUD, scheduler, and Discord poller) on network I/O, and never runs
// two git ops on one repo at once. Fire-and-forget: callers don't await.
const gitQueues = new Map<string, (t: () => Promise<unknown>) => void>();
function gitQueue(dir: string): (t: () => Promise<unknown>) => void {
  let q = gitQueues.get(dir);
  if (!q) {
    q = createSerialQueue();
    gitQueues.set(dir, q);
  }
  return q;
}
function gitAsync(dir: string, args: string[]): Promise<void> {
  return new Promise((res) => {
    // Best-effort: resolve on completion OR error (offline / no remote / conflict).
    execFile('git', ['-C', dir, ...args], { timeout: 15_000 }, () => res());
  });
}
export function gitCommitPush(message: string, dir = vaultDir()): void {
  if (!existsSync(join(dir, '.git'))) return;
  gitQueue(dir)(async () => {
    await gitAsync(dir, ['add', '-A']);
    await gitAsync(dir, ['-c', 'user.name=AKIRA', '-c', 'user.email=akira@axod', 'commit', '-m', message]);
    await gitAsync(dir, ['push']);
  });
}
let lastPull = 0;
export function gitPullDebounced(dir = vaultDir()): void {
  if (!existsSync(join(dir, '.git'))) return;
  const ms = Number(process.env.AKIRA_MEMORY_PULL_MS ?? 60_000);
  if (Date.now() - lastPull < ms) return;
  lastPull = Date.now();
  gitQueue(dir)(() => gitAsync(dir, ['pull', '--ff-only']));
}
