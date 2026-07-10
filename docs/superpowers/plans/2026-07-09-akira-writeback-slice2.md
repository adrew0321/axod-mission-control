# AKIRA Project Writeback — Slice 2 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Bring Sage's session work on the Mini back to the laptop's original repo as a fast-forward-only review branch `akira/<sessionId>` (not checked out), pulled by the companion — no Mini→laptop or DevOps connectivity.

**Architecture:** The companion (outbound-only) requests a `git bundle` of `base..mc/<sessionId>` from a new token-authed Mini route, then `git fetch`es it into the local repo as `akira/<sessionId>` with non-force (FF-only) semantics. A local ledger (written at ingest time) maps `projectId → local folder`. A discovery route lists ingested projects + their sessions with change badges for the HUD.

**Tech Stack:** TypeScript, Next.js 16 route handlers (`runtime='nodejs'`), `git` via `execFile` (argv array — never a shell string), `node:test` via `tsx --test`, the existing companion WS bridge + Electron HUD.

## Global Constraints

- **DevOps isolation:** transfer is a `git bundle` (objects only, no remotes); the Mini never pushes anywhere; only the operator pushes to DevOps.
- **Companion pulls; the Mini never reaches the laptop.** All Mini calls are companion-initiated (outbound-only), token-authed with `x-companion-token === COMPANION_TOKEN`.
- **Proxy exclusion:** both new routes (`api/companion/writeback`, `api/companion/writeback/list`) MUST be in the `src/proxy.ts` matcher negative-lookahead or they 307→`/login`.
- **Never branch-switch the live repo.** Writeback only reads/commits within the session worktree (`data/worktrees/<sessionId>`) and branch `mc/<sessionId>`; it never checks out or merges the ingested repo's default branch.
- **Review branch = `akira/<sessionId>`** — the sessionId (stable across re-pulls; a session title can change, the id can't). Created, never checked out. Re-pull is **fast-forward-only**: refuse (never clobber) on non-FF.
- Extensionless relative imports; `node:`-only (no `server-only`) in any unit-tested module. Never use a shell string with `execFile`; pass an argv array.
- `git` runs with `{ windowsHide: true }` (matches existing companion/server git calls).

---

### Task 1: Ingest ledger (companion)

**Files:**
- Create: `companion/src/ledger.ts`
- Test: `companion/src/ledger.test.ts`
- Modify: `companion/src/ingest.ts` (write the ledger after a successful ingest)

**Interfaces:**
- Produces: `interface LedgerEntry { localPath: string; name: string; ingestedAt: string }`; `ledgerPath(): string`; `readLedger(file?): Promise<Ledger>`; `upsertLedger(projectId, entry, file?): Promise<void>`; `getLedgerEntry(projectId, file?): Promise<LedgerEntry | undefined>` where `type Ledger = Record<string, LedgerEntry>`.
- Consumes (Task 8): `getLedgerEntry` to resolve a project's local folder.

- [ ] **Step 1: Write the failing test**

```ts
// companion/src/ledger.test.ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readLedger, upsertLedger, getLedgerEntry } from './ledger';

function tmpFile(): string {
  const dir = mkdtempSync(join(tmpdir(), 'akira-ledger-'));
  return join(dir, 'ingest-ledger.json');
}

test('readLedger returns {} when the file is missing', async () => {
  assert.deepEqual(await readLedger(join(tmpdir(), 'does-not-exist-xyz.json')), {});
});

test('upsert then get round-trips an entry', async () => {
  const f = tmpFile();
  await upsertLedger('applications-employer', { localPath: 'C:/TEI/App', name: 'App', ingestedAt: '2026-07-09T00:00:00Z' }, f);
  const e = await getLedgerEntry('applications-employer', f);
  assert.equal(e?.localPath, 'C:/TEI/App');
  assert.equal(e?.name, 'App');
});

test('upsert overwrites the same projectId and preserves others', async () => {
  const f = tmpFile();
  await upsertLedger('a', { localPath: '/one', name: 'A', ingestedAt: 't1' }, f);
  await upsertLedger('b', { localPath: '/two', name: 'B', ingestedAt: 't2' }, f);
  await upsertLedger('a', { localPath: '/one-new', name: 'A', ingestedAt: 't3' }, f);
  assert.equal((await getLedgerEntry('a', f))?.localPath, '/one-new');
  assert.equal((await getLedgerEntry('b', f))?.localPath, '/two');
});

test('readLedger tolerates a corrupt file (returns {})', async () => {
  const f = tmpFile();
  writeFileSync(f, '{ not json');
  assert.deepEqual(await readLedger(f), {});
});

test('getLedgerEntry returns undefined for an unknown projectId', async () => {
  const f = tmpFile();
  await upsertLedger('a', { localPath: '/one', name: 'A', ingestedAt: 't1' }, f);
  assert.equal(await getLedgerEntry('unknown', f), undefined);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd companion && npx tsx --test src/ledger.test.ts`
Expected: FAIL — `Cannot find module './ledger'`.

- [ ] **Step 3: Write minimal implementation**

```ts
// companion/src/ledger.ts
// Local record of where each ingested project came from, so writeback can go
// back to the same folder. JSON map projectId -> { localPath, name, ingestedAt }.
import { readFile, writeFile, rename, mkdir } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, dirname } from 'node:path';

export interface LedgerEntry {
  localPath: string;
  name: string;
  ingestedAt: string;
}
export type Ledger = Record<string, LedgerEntry>;

export function ledgerPath(): string {
  return join(homedir(), '.akira-companion', 'ingest-ledger.json');
}

export async function readLedger(file: string = ledgerPath()): Promise<Ledger> {
  try {
    const raw = await readFile(file, 'utf8');
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' ? (parsed as Ledger) : {};
  } catch {
    return {}; // missing or corrupt — start empty
  }
}

export async function upsertLedger(
  projectId: string,
  entry: LedgerEntry,
  file: string = ledgerPath(),
): Promise<void> {
  const ledger = await readLedger(file);
  ledger[projectId] = entry;
  await mkdir(dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  await writeFile(tmp, JSON.stringify(ledger, null, 2));
  await rename(tmp, file); // atomic replace
}

export async function getLedgerEntry(
  projectId: string,
  file: string = ledgerPath(),
): Promise<LedgerEntry | undefined> {
  return (await readLedger(file))[projectId];
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd companion && npx tsx --test src/ledger.test.ts`
Expected: PASS (5 tests).

- [ ] **Step 5: Wire the ledger write into `ingestRepo`**

In `companion/src/ingest.ts`, add the import and record the mapping after a successful ingest (just before the `return`):

```ts
import { upsertLedger } from './ledger';
```
```ts
    if (!res.ok || !json?.projectId) {
      throw new Error(json?.error ?? `ingest failed (${res.status})`);
    }
    await upsertLedger(json.projectId, {
      localPath: repoPath,
      name: meta.name,
      ingestedAt: new Date().toISOString(),
    });
    return { projectId: json.projectId, name: meta.name };
```

- [ ] **Step 6: Verify the companion still type-checks and tests pass**

Run: `cd companion && npx tsc --noEmit && npx tsx --test src/*.test.ts`
Expected: tsc clean; all companion tests pass.

- [ ] **Step 7: Commit**

```bash
git add companion/src/ledger.ts companion/src/ledger.test.ts companion/src/ingest.ts
git commit -m "feat(companion): ingest ledger (projectId -> local folder) for writeback"
```

---

### Task 2: Extract `commitWorktreeEdits` (Mini)

**Files:**
- Modify: `src/lib/worktree.ts` (extract from `mergeWorktree` step 1)
- Test: `src/lib/worktree.test.ts` (add a focused case)

**Interfaces:**
- Produces: `commitWorktreeEdits(sessionId: string, repoPath: string): Promise<boolean>` — commits any loose worktree edits (excluding `node_modules`) onto `mc/<sessionId>`; returns `true` if it committed, `false` on a clean tree.
- Consumes (Task 4): the writeback route calls it before bundling.

- [ ] **Step 1: Write the failing test**

Add to `src/lib/worktree.test.ts` (it already sets up temp repos + worktrees; mirror its existing helpers):

```ts
test('commitWorktreeEdits commits loose edits and is a no-op on a clean tree', async () => {
  const repo = makeTempRepo(); // existing helper: inits a git repo with a base commit on 'dev'
  const sessionId = `sess_${Math.random().toString(16).slice(2, 8)}`;
  const { path: wt } = await ensureWorktree(sessionId, repo, 'dev');

  // No edits yet -> no commit.
  assert.equal(await commitWorktreeEdits(sessionId, repo), false);

  // Make an edit -> it commits.
  writeFileSync(join(wt, 'new.txt'), 'hello');
  assert.equal(await commitWorktreeEdits(sessionId, repo), true);

  // Clean again -> no-op.
  assert.equal(await commitWorktreeEdits(sessionId, repo), false);

  // The commit is on mc/<sessionId>, ahead of dev.
  const ahead = execFileSync('git', ['-C', repo, 'rev-list', '--count', `dev..mc/${sessionId}`]).toString().trim();
  assert.equal(ahead, '1');

  await removeWorktree(sessionId, repo);
});
```

> If `worktree.test.ts` lacks a `makeTempRepo` helper, add a small one that runs `git init -b dev`, sets `user.email`/`user.name`, writes a file, and makes the first commit — following the pattern in `ingest-repo.test.ts`. Import `writeFileSync` and `execFileSync` if not already imported.

- [ ] **Step 2: Run test to verify it fails**

Run: `npx tsx --test src/lib/worktree.test.ts`
Expected: FAIL — `commitWorktreeEdits is not exported` / not a function.

- [ ] **Step 3: Extract the function and call it from `mergeWorktree`**

In `src/lib/worktree.ts`, add the exported function (lifted from `mergeWorktree` step 1):

```ts
/**
 * Commit any uncommitted edits in a session's worktree onto its branch
 * (mc/<sessionId>), excluding node_modules. Returns true if it committed, false
 * when the tree was already clean. Shared by mergeWorktree and the writeback route.
 */
export async function commitWorktreeEdits(sessionId: string, repoPath: string): Promise<boolean> {
  const wtPath = sessionWorktreePath(sessionId);
  const branch = sessionBranch(sessionId);
  const { stdout: status } = await exec('git', ['-C', wtPath, 'status', '--porcelain']);
  if (!status.trim()) return false;
  await exec('git', ['-C', wtPath, 'reset', '-q', '--', 'node_modules']).catch(() => {});
  await exec('git', ['-C', wtPath, 'add', '-A', '--', '.', ':!node_modules']);
  await exec('git', [
    '-c', 'user.email=mc@axodcreative.com',
    '-c', 'user.name=Mission Control',
    '-C', wtPath, 'commit', '-m', `mission-control: ${branch}`,
  ]);
  return true;
}
```

Then replace `mergeWorktree`'s inline step 1 (the `const { stdout: status } … commit …` block) with:

```ts
  // 1. Commit any uncommitted edits in the worktree so the branch carries them.
  await commitWorktreeEdits(sessionId, repoPath);
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx tsx --test src/lib/worktree.test.ts`
Expected: PASS — the new case AND the existing `mergeWorktree` cases stay green.

- [ ] **Step 5: Commit**

```bash
git add src/lib/worktree.ts src/lib/worktree.test.ts
git commit -m "refactor(worktree): extract commitWorktreeEdits, reuse in mergeWorktree"
```

---

### Task 3: Writeback bundle primitive (Mini)

**Files:**
- Create: `src/lib/companion/writeback-repo.ts`
- Test: `src/lib/companion/writeback-repo.test.ts`

**Interfaces:**
- Produces: `countCommitsAhead(repoPath, base, branch): Promise<number>`; `createSessionBundle(repoPath, base, branch, outPath): Promise<void>` (`git bundle create outPath base..branch`); `countChangedFiles(repoPath, base, branch): Promise<number>`.
- Consumes (Task 4): the route calls these after `commitWorktreeEdits`.

- [ ] **Step 1: Write the failing test**

```ts
// src/lib/companion/writeback-repo.test.ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { countCommitsAhead, createSessionBundle, countChangedFiles } from './writeback-repo';

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', ['-C', cwd, ...args]).toString();
}
function tmp(p: string): string { return mkdtempSync(join(tmpdir(), p)); }

// A repo on 'dev' with one base commit, plus a branch mc/s1 two commits ahead.
function makeRepoWithBranch(): { repo: string } {
  const repo = tmp('wb-src-');
  execFileSync('git', ['init', '-b', 'dev'], { cwd: repo });
  git(repo, 'config', 'user.email', 't@t'); git(repo, 'config', 'user.name', 'T');
  writeFileSync(join(repo, 'base.txt'), 'base'); git(repo, 'add', '-A'); git(repo, 'commit', '-m', 'base');
  git(repo, 'branch', 'mc/s1'); git(repo, 'switch', 'mc/s1');
  writeFileSync(join(repo, 'a.txt'), '1'); git(repo, 'add', '-A'); git(repo, 'commit', '-m', 'c1');
  writeFileSync(join(repo, 'b.txt'), '2'); git(repo, 'add', '-A'); git(repo, 'commit', '-m', 'c2');
  git(repo, 'switch', 'dev');
  return { repo };
}

test('countCommitsAhead counts commits the branch adds over base', async () => {
  const { repo } = makeRepoWithBranch();
  assert.equal(await countCommitsAhead(repo, 'dev', 'mc/s1'), 2);
  rmSync(repo, { recursive: true, force: true });
});

test('countCommitsAhead is 0 when the branch has nothing over base', async () => {
  const { repo } = makeRepoWithBranch();
  git(repo, 'branch', 'mc/empty', 'dev');
  assert.equal(await countCommitsAhead(repo, 'dev', 'mc/empty'), 0);
  rmSync(repo, { recursive: true, force: true });
});

test('countChangedFiles counts files changed base..branch', async () => {
  const { repo } = makeRepoWithBranch();
  assert.equal(await countChangedFiles(repo, 'dev', 'mc/s1'), 2); // a.txt, b.txt
  rmSync(repo, { recursive: true, force: true });
});

test('createSessionBundle makes a base..branch bundle that fetches into a clone of base', async () => {
  const { repo } = makeRepoWithBranch();
  const bundle = join(tmp('wb-out-'), 'session.bundle');
  await createSessionBundle(repo, 'dev', 'mc/s1', bundle);
  assert.equal(existsSync(bundle), true);

  // Simulate the laptop: a repo that has only the base commit.
  const laptop = tmp('wb-laptop-');
  execFileSync('git', ['clone', '--branch', 'dev', '--single-branch', repo, laptop]);
  execFileSync('git', ['-C', laptop, 'remote', 'remove', 'origin']);
  // Verify prerequisites are present, then fetch as a NEW review branch.
  execFileSync('git', ['-C', laptop, 'bundle', 'verify', bundle]);
  execFileSync('git', ['-C', laptop, 'fetch', bundle, 'refs/heads/mc/s1:refs/heads/akira/s1']);
  const count = execFileSync('git', ['-C', laptop, 'rev-list', '--count', 'dev..akira/s1']).toString().trim();
  assert.equal(count, '2');
  rmSync(repo, { recursive: true, force: true });
  rmSync(laptop, { recursive: true, force: true });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx tsx --test src/lib/companion/writeback-repo.test.ts`
Expected: FAIL — `Cannot find module './writeback-repo'`.

- [ ] **Step 3: Write minimal implementation**

```ts
// src/lib/companion/writeback-repo.ts
// Mini-side writeback primitives: count/bundle a session branch's commits over
// its base. Pure node (no DB/server-only) so it is unit-tested against temp
// repos with real git. A git bundle carries objects only — no remotes — which is
// exactly the DevOps-isolation guarantee, in reverse of ingest.
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

export async function countCommitsAhead(repoPath: string, base: string, branch: string): Promise<number> {
  const { stdout } = await execFileAsync('git', ['-C', repoPath, 'rev-list', '--count', `${base}..${branch}`], { windowsHide: true });
  return Number(stdout.trim()) || 0;
}

export async function countChangedFiles(repoPath: string, base: string, branch: string): Promise<number> {
  const { stdout } = await execFileAsync('git', ['-C', repoPath, 'diff', '--name-only', `${base}..${branch}`], { windowsHide: true });
  return stdout.split('\n').map((l) => l.trim()).filter(Boolean).length;
}

export async function createSessionBundle(repoPath: string, base: string, branch: string, outPath: string): Promise<void> {
  // base..branch: the bundle contains `branch`'s commits and records `base` as a
  // prerequisite the laptop must already have. Names the ref refs/heads/<branch>.
  await execFileAsync('git', ['-C', repoPath, 'bundle', 'create', outPath, `${base}..${branch}`], { windowsHide: true });
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx tsx --test src/lib/companion/writeback-repo.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add src/lib/companion/writeback-repo.ts src/lib/companion/writeback-repo.test.ts
git commit -m "feat(companion): Mini-side writeback bundle primitives"
```

---

### Task 4: Writeback route (Mini)

**Files:**
- Create: `src/app/api/companion/writeback/route.ts`

**Interfaces:**
- Consumes: `commitWorktreeEdits` (Task 2), `countCommitsAhead`/`countChangedFiles`/`createSessionBundle` (Task 3), `ensureWorktree` (`@/lib/worktree`), `db`/`sessions`/`projects` (`@/db`).
- Produces: `POST /api/companion/writeback?sessionId=…` → streams a bundle body with headers `x-wb-branch`, `x-wb-commits`, `x-wb-files`; JSON error otherwise.

> This is a thin route over Task 2/3 primitives; verified by manual E2E (routes aren't unit-tested in this repo, matching slice 1).

- [ ] **Step 1: Create the route**

```ts
// src/app/api/companion/writeback/route.ts
import { mkdir, rm, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { randomBytes, bytesToHex } from '@noble/hashes/utils.js';
import { eq } from 'drizzle-orm';
import { db } from '@/db/client';
import { sessions, projects } from '@/db/schema';
import { ensureWorktree, commitWorktreeEdits } from '@/lib/worktree';
import { countCommitsAhead, countChangedFiles, createSessionBundle } from '@/lib/companion/writeback-repo';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(req: Request) {
  const token = req.headers.get('x-companion-token');
  if (!process.env.COMPANION_TOKEN || token !== process.env.COMPANION_TOKEN) {
    return new Response('Unauthorized', { status: 401 });
  }

  const sessionId = new URL(req.url).searchParams.get('sessionId')?.trim();
  if (!sessionId) return Response.json({ error: 'sessionId is required' }, { status: 400 });

  const session = await db.select().from(sessions).where(eq(sessions.id, sessionId)).limit(1).then((r) => r[0]);
  if (!session?.project_id) return Response.json({ error: 'session not found' }, { status: 400 });

  const project = await db.select().from(projects).where(eq(projects.id, session.project_id)).limit(1).then((r) => r[0]);
  const ingestedRoot = join(process.cwd(), 'data', 'ingested');
  if (!project?.repo_path || !project.repo_path.startsWith(ingestedRoot)) {
    return Response.json({ error: 'not a companion-ingested project' }, { status: 400 });
  }

  const base = session.base_branch ?? project.default_branch ?? 'dev';
  const branch = `mc/${sessionId}`;
  const tmpDir = join(ingestedRoot, '.tmp');
  const bundlePath = join(tmpDir, `${bytesToHex(randomBytes(6))}.bundle`);

  try {
    await ensureWorktree(sessionId, project.repo_path, base);
    await commitWorktreeEdits(sessionId, project.repo_path);

    const commits = await countCommitsAhead(project.repo_path, base, branch);
    if (commits === 0) return Response.json({ error: 'nothing to write back' }, { status: 409 });
    const files = await countChangedFiles(project.repo_path, base, branch);

    await mkdir(tmpDir, { recursive: true });
    await createSessionBundle(project.repo_path, base, branch, bundlePath);
    const bytes = await readFile(bundlePath); // bundles are small (delta only)

    return new Response(bytes as unknown as BodyInit, {
      headers: {
        'Content-Type': 'application/octet-stream',
        'x-wb-branch': branch,
        'x-wb-commits': String(commits),
        'x-wb-files': String(files),
      },
    });
  } catch (e) {
    return Response.json({ error: `writeback failed: ${e instanceof Error ? e.message : String(e)}` }, { status: 500 });
  } finally {
    await rm(bundlePath, { force: true }).catch(() => {});
  }
}
```

- [ ] **Step 2: Type-check**

Run: `npx tsc --noEmit`
Expected: EXIT 0.

- [ ] **Step 3: Commit**

```bash
git add "src/app/api/companion/writeback/route.ts"
git commit -m "feat(api): POST /api/companion/writeback streams a session's commit bundle"
```

---

### Task 5: Discovery route + filter helper (Mini)

**Files:**
- Create: `src/lib/companion/writeback-list.ts` (pure filter/shape)
- Test: `src/lib/companion/writeback-list.test.ts`
- Create: `src/app/api/companion/writeback/list/route.ts`

**Interfaces:**
- Produces: `isIngestedRepo(repoPath: string | null | undefined, ingestedRoot: string): boolean`.
- Produces (route): `GET /api/companion/writeback/list` → `{ projects: [{ projectId, projectName, sessions: [{ sessionId, sessionName, changed, fileCount }] }] }`.

- [ ] **Step 1: Write the failing test**

```ts
// src/lib/companion/writeback-list.test.ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { isIngestedRepo } from './writeback-list';

const root = join('/srv/app', 'data', 'ingested');

test('isIngestedRepo is true for a path under the ingested root', () => {
  assert.equal(isIngestedRepo(join(root, 'applications-employer'), root), true);
});
test('isIngestedRepo is false for a path outside the ingested root', () => {
  assert.equal(isIngestedRepo('/srv/app/some-other-repo', root), false);
});
test('isIngestedRepo is false for null/empty', () => {
  assert.equal(isIngestedRepo(null, root), false);
  assert.equal(isIngestedRepo('', root), false);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx tsx --test src/lib/companion/writeback-list.test.ts`
Expected: FAIL — `Cannot find module './writeback-list'`.

- [ ] **Step 3: Write the helper**

```ts
// src/lib/companion/writeback-list.ts
// Pure predicate: is this repo path a companion-ingested project (under data/ingested)?
export function isIngestedRepo(repoPath: string | null | undefined, ingestedRoot: string): boolean {
  return !!repoPath && repoPath.startsWith(ingestedRoot);
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx tsx --test src/lib/companion/writeback-list.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Create the discovery route**

```ts
// src/app/api/companion/writeback/list/route.ts
import { join } from 'node:path';
import { and, eq, isNull } from 'drizzle-orm';
import { db } from '@/db/client';
import { sessions, projects } from '@/db/schema';
import { diffWorktree } from '@/lib/worktree';
import { isIngestedRepo } from '@/lib/companion/writeback-list';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(req: Request) {
  const token = req.headers.get('x-companion-token');
  if (!process.env.COMPANION_TOKEN || token !== process.env.COMPANION_TOKEN) {
    return new Response('Unauthorized', { status: 401 });
  }

  const ingestedRoot = join(process.cwd(), 'data', 'ingested');
  const allProjects = await db.select().from(projects);
  const ingested = allProjects.filter((p) => isIngestedRepo(p.repo_path, ingestedRoot));

  const out = [];
  for (const p of ingested) {
    const rows = await db
      .select()
      .from(sessions)
      .where(and(eq(sessions.project_id, p.id), isNull(sessions.archived_at)));
    const sess = [];
    for (const s of rows) {
      const base = s.base_branch ?? p.default_branch ?? 'dev';
      const { files } = s.worktree_path
        ? await diffWorktree(s.worktree_path, base)
        : { files: [] as { status: string; path: string }[] };
      sess.push({
        sessionId: s.id,
        sessionName: s.title ?? s.id,
        changed: files.length > 0,
        fileCount: files.length,
      });
    }
    out.push({ projectId: p.id, projectName: p.name, sessions: sess });
  }

  return Response.json({ projects: out });
}
```

- [ ] **Step 6: Type-check**

Run: `npx tsc --noEmit`
Expected: EXIT 0.

- [ ] **Step 7: Commit**

```bash
git add src/lib/companion/writeback-list.ts src/lib/companion/writeback-list.test.ts "src/app/api/companion/writeback/list/route.ts"
git commit -m "feat(api): GET /api/companion/writeback/list (ingested projects + session changes)"
```

---

### Task 6: Proxy exclusion for the two writeback routes (Mini)

**Files:**
- Modify: `src/proxy.ts` (matcher negative-lookahead + comment)

> Verified by the deploy-time 401-not-307 check (how slice 1's ingest exclusion was confirmed live), not a unit test.

- [ ] **Step 1: Update the matcher**

In `src/proxy.ts`, change the companion group from `(?:stream|result|ingest)$` to also cover `writeback` and `writeback/list`:

```ts
    '/((?!login$|api/auth/|api/companion/(?:stream|result|ingest|writeback(?:/list)?)$|api/health$|_next/|favicon\\.ico|sitemap\\.xml|robots\\.txt|.*\\..*).*)',
```

And extend the comment above it to mention `writeback` / `writeback/list` alongside `stream, result, ingest`.

- [ ] **Step 2: Type-check + build (the matcher must compile)**

Run: `npx tsc --noEmit`
Expected: EXIT 0.

- [ ] **Step 3: Commit**

```bash
git add src/proxy.ts
git commit -m "fix(proxy): exclude writeback routes from the session gate (token-authed)"
```

---

### Task 7: Bridge protocol additions (companion)

**Files:**
- Modify: `companion/src/bridge-protocol.ts`
- Modify: `companion/src/bridge-protocol.test.ts`

**Interfaces:**
- Produces: `WritebackSession`, `WritebackProject`, `WritebackState`; `StateSnapshot.writeback`; `ClientMsg` gains `{ type:'writeback:list' }` and `{ type:'writeback'; projectId; sessionId }`; `buildState` carries `writeback`.

- [ ] **Step 1: Write the failing tests**

Add to `companion/src/bridge-protocol.test.ts`:

```ts
test("parseClientMsg accepts writeback:list", () => {
  assert.deepEqual(parseClientMsg(JSON.stringify({ type: 'writeback:list' })), { type: 'writeback:list' });
});
test("parseClientMsg accepts a well-formed writeback", () => {
  assert.deepEqual(
    parseClientMsg(JSON.stringify({ type: 'writeback', projectId: 'app', sessionId: 'sess_1' })),
    { type: 'writeback', projectId: 'app', sessionId: 'sess_1' },
  );
});
test("parseClientMsg rejects a writeback missing ids", () => {
  assert.equal(parseClientMsg(JSON.stringify({ type: 'writeback', projectId: 'app' })), null);
  assert.equal(parseClientMsg(JSON.stringify({ type: 'writeback', sessionId: 's' })), null);
});
test("buildState carries the writeback block", () => {
  const s = buildState({
    presence: { connected: false, operator: 'A', host: 'h', uptimeSec: 0, task: 'idle' },
    queue: [], security: { tokenAuthed: true, transport: 'outbound-only', profile: 'p', sensitiveCount: 0 },
    ingest: { phase: 'idle' },
    writeback: { phase: 'idle' },
  });
  assert.equal(s.writeback.phase, 'idle');
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd companion && npx tsx --test src/bridge-protocol.test.ts`
Expected: FAIL — writeback types/handling missing (compile error or null mismatches). Existing `buildState` calls in this test file will also need the new `writeback` field; add `writeback: { phase: 'idle' }` to any existing `buildState({...})` fixtures in this file so they compile.

- [ ] **Step 3: Implement**

In `companion/src/bridge-protocol.ts`:

```ts
export interface WritebackSession {
  sessionId: string;
  sessionName: string;
  changed: boolean;
  fileCount: number;
}
export interface WritebackProject {
  projectId: string;
  projectName: string;
  sessions: WritebackSession[];
}
export interface WritebackState {
  phase: 'idle' | 'listing' | 'verifying' | 'downloading' | 'applying' | 'done' | 'error';
  projects?: WritebackProject[];
  branch?: string;
  commits?: number;
  files?: number;
  error?: string;
}
```

Add `writeback: WritebackState;` to `StateSnapshot`. Add to the `ClientMsg` union:

```ts
  | { type: 'writeback:list' }
  | { type: 'writeback'; projectId: string; sessionId: string };
```

In `buildState`, include `writeback: s.writeback`. In `parseClientMsg`'s switch, add:

```ts
    case 'writeback:list':
      return { type: 'writeback:list' };
    case 'writeback':
      return typeof m.projectId === 'string' && m.projectId && typeof m.sessionId === 'string' && m.sessionId
        ? { type: 'writeback', projectId: m.projectId, sessionId: m.sessionId }
        : null;
```

- [ ] **Step 4: Run to verify it passes**

Run: `cd companion && npx tsx --test src/bridge-protocol.test.ts`
Expected: PASS (existing + 4 new).

- [ ] **Step 5: Commit**

```bash
git add companion/src/bridge-protocol.ts companion/src/bridge-protocol.test.ts
git commit -m "feat(companion): writeback bridge protocol (state + client messages)"
```

---

### Task 8: Companion writeback apply + list (companion)

**Files:**
- Create: `companion/src/writeback.ts`
- Test: `companion/src/writeback.test.ts`

**Interfaces:**
- Consumes: `getLedgerEntry` (Task 1) — resolved by the caller (Task 9), so `downloadAndApply` takes an explicit `localPath`.
- Produces: `applyBundleAsReviewBranch(localPath, sessionId, bundlePath): Promise<{ branch: string }>` (pure git — apply only, no counting); `downloadAndApply(cfg, args, hooks): Promise<{ branch; commits; files }>` where `cfg = { miniUrl; token }`, `args = { sessionId; localPath }`, `hooks = { onPhase: (p: 'downloading'|'verifying'|'applying') => void }` (commits/files come from the Mini's `x-wb-*` headers); and `fetchWritebackList(cfg): Promise<WritebackProject[]>`.

- [ ] **Step 1: Write the failing test (git apply logic against temp repos)**

```ts
// companion/src/writeback.test.ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { applyBundleAsReviewBranch } from './writeback';

function git(cwd: string, ...a: string[]): string { return execFileSync('git', ['-C', cwd, ...a]).toString(); }
function tmp(p: string): string { return mkdtempSync(join(tmpdir(), p)); }

// Build: a "mini" repo on dev with mc/s1 ahead; a "laptop" repo cloned at dev.
// Return the path to a base..mc/s1 bundle plus the laptop path.
function scenario(extraMiniCommit = false) {
  const mini = tmp('wb-mini-');
  execFileSync('git', ['init', '-b', 'dev'], { cwd: mini });
  git(mini, 'config', 'user.email', 't@t'); git(mini, 'config', 'user.name', 'T');
  writeFileSync(join(mini, 'base.txt'), 'base'); git(mini, 'add', '-A'); git(mini, 'commit', '-m', 'base');
  const laptop = tmp('wb-laptop-');
  execFileSync('git', ['clone', '--branch', 'dev', '--single-branch', mini, laptop]);
  execFileSync('git', ['-C', laptop, 'remote', 'remove', 'origin']);
  git(mini, 'switch', '-c', 'mc/s1');
  writeFileSync(join(mini, 'a.txt'), '1'); git(mini, 'add', '-A'); git(mini, 'commit', '-m', 'c1');
  if (extraMiniCommit) { writeFileSync(join(mini, 'b.txt'), '2'); git(mini, 'add', '-A'); git(mini, 'commit', '-m', 'c2'); }
  const bundle = join(tmp('wb-b-'), 's1.bundle');
  execFileSync('git', ['-C', mini, 'bundle', 'create', bundle, 'dev..mc/s1']);
  return { mini, laptop, bundle };
}

test('first apply creates akira/s1 at the session tip', async () => {
  const { laptop, bundle } = scenario();
  const r = await applyBundleAsReviewBranch(laptop, 's1', bundle);
  assert.equal(r.branch, 'akira/s1');
  assert.equal(git(laptop, 'rev-list', '--count', 'dev..akira/s1').trim(), '1');
});

test('second apply fast-forwards the same branch', async () => {
  const first = scenario();
  await applyBundleAsReviewBranch(first.laptop, 's1', first.bundle);
  // Re-bundle after another mini commit onto the same mc/s1, then re-apply.
  writeFileSync(join(first.mini, 'c.txt'), '3'); git(first.mini, 'switch', 'mc/s1');
  git(first.mini, 'add', '-A'); git(first.mini, 'commit', '-m', 'c2');
  const bundle2 = join(tmp('wb-b2-'), 's1.bundle');
  execFileSync('git', ['-C', first.mini, 'bundle', 'create', bundle2, 'dev..mc/s1']);
  const r = await applyBundleAsReviewBranch(first.laptop, 's1', bundle2);
  assert.equal(r.branch, 'akira/s1');
  assert.equal(git(first.laptop, 'rev-list', '--count', 'dev..akira/s1').trim(), '2');
});

test('a non-fast-forward re-apply is refused and leaves the branch unchanged', async () => {
  const s = scenario(); // mini: dev(base) + mc/s1(+c1); laptop@dev; bundle = dev..mc/s1
  await applyBundleAsReviewBranch(s.laptop, 's1', s.bundle); // akira/s1 = base + c1
  // Operator adds their own commit on top of the review branch.
  git(s.laptop, 'switch', 'akira/s1');
  writeFileSync(join(s.laptop, 'mine.txt'), 'x'); git(s.laptop, 'add', '-A'); git(s.laptop, 'commit', '-m', 'mine');
  const afterMine = git(s.laptop, 'rev-parse', 'akira/s1').trim();
  git(s.laptop, 'switch', 'dev');
  // On the mini, REWRITE mc/s1 over the SAME base (amend c1) -> divergent history.
  // Same base means the bundle prerequisite is present on the laptop (verify passes),
  // so the failure is specifically the non-fast-forward fetch, not a missing prereq.
  git(s.mini, 'switch', 'mc/s1');
  writeFileSync(join(s.mini, 'a.txt'), '1-rewritten'); git(s.mini, 'add', '-A');
  git(s.mini, 'commit', '--amend', '-m', 'c1-rewritten');
  const bundle2 = join(tmp('wb-div-'), 's1.bundle');
  execFileSync('git', ['-C', s.mini, 'bundle', 'create', bundle2, 'dev..mc/s1']);
  await assert.rejects(() => applyBundleAsReviewBranch(s.laptop, 's1', bundle2), /diverged|fast-forward|rejected/i);
  assert.equal(git(s.laptop, 'rev-parse', 'akira/s1').trim(), afterMine); // unchanged
});

test('a bundle whose prerequisite is missing raises a re-ingest error', async () => {
  const { bundle } = scenario();
  const stranger = tmp('wb-stranger-'); // fresh repo without the base commit
  execFileSync('git', ['init', '-b', 'dev'], { cwd: stranger });
  git(stranger, 'config', 'user.email', 't@t'); git(stranger, 'config', 'user.name', 'T');
  writeFileSync(join(stranger, 'x.txt'), 'x'); git(stranger, 'add', '-A'); git(stranger, 'commit', '-m', 'x');
  await assert.rejects(() => applyBundleAsReviewBranch(stranger, 's1', bundle), /re-ingest|prerequisite|base commit/i);
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd companion && npx tsx --test src/writeback.test.ts`
Expected: FAIL — `applyBundleAsReviewBranch` not exported.

- [ ] **Step 3: Implement**

```ts
// companion/src/writeback.ts
// Companion-side writeback: pull a session's commit bundle from the Mini and lay
// it into the local repo as a fast-forward-only review branch akira/<sessionId>.
// The Mini can never reach us; every call here is companion-initiated (outbound).
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { rm, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { WritebackProject } from './bridge-protocol';

const execFileAsync = promisify(execFile);

/**
 * Verify + fast-forward-only fetch a base..mc/<sessionId> bundle into
 * akira/<sessionId>. Never checks out; never forces. Throws a readable error on a
 * missing prerequisite (re-ingest) or a non-fast-forward (diverged branch).
 */
export async function applyBundleAsReviewBranch(
  localPath: string,
  sessionId: string,
  bundlePath: string,
): Promise<{ branch: string }> {
  const branch = `akira/${sessionId}`;

  try {
    await execFileAsync('git', ['-C', localPath, 'bundle', 'verify', bundlePath], { windowsHide: true });
  } catch {
    throw new Error('your local repo no longer has the base commit this work forked from — re-ingest to continue');
  }

  const refspec = `refs/heads/mc/${sessionId}:refs/heads/${branch}`; // no leading '+' => FF-only
  try {
    await execFileAsync('git', ['-C', localPath, 'fetch', bundlePath, refspec], { windowsHide: true });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (/non-fast-forward|rejected|fast[- ]forward/i.test(msg)) {
      throw new Error(`'${branch}' has diverged from Sage's work — rename or delete it, then pull again`);
    }
    throw new Error(`could not apply writeback: ${msg}`);
  }

  return { branch }; // commits/files come from the Mini's authoritative headers (downloadAndApply)
}

export async function downloadAndApply(
  cfg: { miniUrl: string; token: string },
  args: { sessionId: string; localPath: string },
  hooks: { onPhase: (p: 'downloading' | 'verifying' | 'applying') => void },
): Promise<{ branch: string; commits: number; files: number }> {
  hooks.onPhase('downloading');
  const qs = new URLSearchParams({ sessionId: args.sessionId });
  const res = await fetch(`${cfg.miniUrl}/api/companion/writeback?${qs.toString()}`, {
    method: 'POST',
    headers: { 'x-companion-token': cfg.token },
  });
  if (!res.ok) {
    const j = (await res.json().catch(() => null)) as { error?: string } | null;
    throw new Error(j?.error ?? `writeback failed (${res.status})`);
  }
  const commits = Number(res.headers.get('x-wb-commits')) || 0;
  const files = Number(res.headers.get('x-wb-files')) || 0;
  const buf = new Uint8Array(await res.arrayBuffer());

  const work = await mkdtemp(join(tmpdir(), 'akira-wb-'));
  const bundlePath = join(work, 'session.bundle');
  try {
    await writeFile(bundlePath, buf);
    hooks.onPhase('verifying');
    const r = await applyBundleAsReviewBranch(args.localPath, args.sessionId, bundlePath);
    hooks.onPhase('applying');
    return { branch: r.branch, commits, files }; // Mini's counts are authoritative
  } finally {
    await rm(work, { recursive: true, force: true }).catch(() => {});
  }
}

export async function fetchWritebackList(cfg: { miniUrl: string; token: string }): Promise<WritebackProject[]> {
  const res = await fetch(`${cfg.miniUrl}/api/companion/writeback/list`, {
    headers: { 'x-companion-token': cfg.token },
  });
  if (!res.ok) throw new Error(`writeback list failed (${res.status})`);
  const j = (await res.json()) as { projects?: WritebackProject[] };
  return j.projects ?? [];
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `cd companion && npx tsx --test src/writeback.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 5: Type-check the companion**

Run: `cd companion && npx tsc --noEmit`
Expected: EXIT 0.

- [ ] **Step 6: Commit**

```bash
git add companion/src/writeback.ts companion/src/writeback.test.ts
git commit -m "feat(companion): writeback apply (FF-only review branch) + list fetch"
```

---

### Task 9: Wire writeback into the companion runtime (companion)

**Files:**
- Modify: `companion/src/bridge.ts` (dispatch the two new messages)
- Modify: `companion/src/index.ts` (state + handlers)

> Integration wiring; verified by manual E2E.

- [ ] **Step 1: Extend the bridge handlers**

In `companion/src/bridge.ts`, add to `BridgeHandlers`:

```ts
  onWritebackList: () => void;
  onWriteback: (projectId: string, sessionId: string) => void;
```

And in the message dispatch (after the `ingest` case):

```ts
      else if (msg.type === 'writeback:list') h.onWritebackList();
      else if (msg.type === 'writeback') h.onWriteback(msg.projectId, msg.sessionId);
```

- [ ] **Step 2: Wire state + handlers in `index.ts`**

Add imports:

```ts
import { getLedgerEntry } from './ledger';
import { downloadAndApply, fetchWritebackList } from './writeback';
import type { IngestState, WritebackState } from './bridge-protocol';
```

Add state next to `ingestState`:

```ts
let writebackState: WritebackState = { phase: 'idle' };
```

Include it in `getState()`'s returned object: `writeback: writebackState,`.

Add the two handlers to the `startBridge({...})` call:

```ts
  onWritebackList: () => { void runWritebackList(); },
  onWriteback: (projectId, sessionId) => { void runWriteback(projectId, sessionId); },
```

Add the functions:

```ts
async function runWritebackList(): Promise<void> {
  writebackState = { ...writebackState, phase: 'listing' };
  bridge.push();
  try {
    const projects = await fetchWritebackList(cfg);
    writebackState = { phase: 'idle', projects };
  } catch (e) {
    writebackState = { phase: 'error', error: e instanceof Error ? e.message : String(e) };
  }
  bridge.push();
}

async function runWriteback(projectId: string, sessionId: string): Promise<void> {
  const busy = writebackState.phase === 'downloading' || writebackState.phase === 'verifying' || writebackState.phase === 'applying';
  if (busy) return; // one at a time
  const entry = await getLedgerEntry(projectId);
  if (!entry) {
    writebackState = { ...writebackState, phase: 'error', error: 'unknown project on this laptop — re-ingest it first' };
    bridge.push();
    return;
  }
  writebackState = { ...writebackState, phase: 'downloading', error: undefined };
  bridge.push();
  try {
    const { branch, commits, files } = await downloadAndApply(
      cfg,
      { sessionId, localPath: entry.localPath },
      { onPhase: (phase) => { writebackState = { ...writebackState, phase }; bridge.push(); } },
    );
    writebackState = { ...writebackState, phase: 'done', branch, commits, files };
  } catch (e) {
    writebackState = { ...writebackState, phase: 'error', error: e instanceof Error ? e.message : String(e) };
  }
  bridge.push();
}
```

- [ ] **Step 3: Type-check the companion**

Run: `cd companion && npx tsc --noEmit`
Expected: EXIT 0.

- [ ] **Step 4: Commit**

```bash
git add companion/src/bridge.ts companion/src/index.ts
git commit -m "feat(companion): wire writeback list + apply into the runtime"
```

---

### Task 10: HUD "Bring work to my laptop" panel (HUD)

**Files:**
- Modify: `companion-hud/renderer/index.html` (new section + styles reuse)
- Modify: `companion-hud/renderer/hud.js` (render projects/sessions + send messages)

> HUD JS isn't unit-tested; verified by manual E2E.

- [ ] **Step 1: Add the panel markup**

In `companion-hud/renderer/index.html`, after the "Projects" section (`</div>` closing the ingest `.sec`, before the `.scroll` closes), add:

```html
      <div class="sec">
        <div class="sec-h"><div class="t">Bring work to my laptop</div><div class="n" id="wbRefresh" style="cursor:pointer">↻</div></div>
        <div id="wbList"></div>
        <div class="ingest-status" id="wbStatus"></div>
      </div>
```

- [ ] **Step 2: Render + wire in `hud.js`**

Add a renderer and wire the refresh + per-session buttons. In `render()`, after `renderIngest(state.ingest);` add `renderWriteback(state.writeback);`. Add:

```js
function renderWriteback(wb) {
  const list = $('wbList');
  const status = $('wbStatus');
  if (!list) return;
  const projects = (wb && wb.projects) || [];
  list.innerHTML = '';
  if (projects.length === 0) {
    list.innerHTML = '<div class="empty">No ingested projects yet.</div>';
  }
  for (const p of projects) {
    const head = document.createElement('div');
    head.className = 'kv';
    head.innerHTML = `<span class="k">${escapeHtml(p.projectName)}</span><span class="v"></span>`;
    list.appendChild(head);
    for (const s of p.sessions) {
      const row = document.createElement('div');
      row.className = 'appr-item';
      const badge = s.changed ? `changed · ${s.fileCount} file${s.fileCount === 1 ? '' : 's'}` : 'no changes';
      row.innerHTML =
        `<div class="tgt"><b>${escapeHtml(s.sessionName)}</b></div>` +
        `<div class="ts">${escapeHtml(badge)}</div>` +
        `<div class="btns"><button class="ok" ${s.changed ? '' : 'disabled style="opacity:.4;cursor:default"'}>Bring to laptop</button></div>`;
      const btn = row.querySelector('button');
      if (s.changed) btn.onclick = () => send({ type: 'writeback', projectId: p.projectId, sessionId: s.sessionId });
      list.appendChild(row);
    }
  }
  if (!status) return;
  status.classList.remove('err', 'ok');
  const phase = wb && wb.phase;
  if (!wb || phase === 'idle') { status.textContent = ''; }
  else if (phase === 'listing') { status.textContent = 'Loading sessions…'; }
  else if (phase === 'downloading') { status.textContent = 'Downloading changes…'; }
  else if (phase === 'verifying') { status.textContent = 'Verifying…'; }
  else if (phase === 'applying') { status.textContent = 'Applying to your repo…'; }
  else if (phase === 'done') { status.classList.add('ok'); status.textContent = `Updated ${wb.branch} (+${wb.commits} commit${wb.commits === 1 ? '' : 's'})`; }
  else if (phase === 'error') { status.classList.add('err'); status.textContent = `Failed: ${wb.error || 'unknown error'}`; }
}
```

And wire the refresh control (near the other `$(...).onclick` handlers):

```js
const wbRefresh = $('wbRefresh');
if (wbRefresh) wbRefresh.onclick = () => send({ type: 'writeback:list' });
```

- [ ] **Step 3: Manual smoke (structure only)**

The HUD only renders live under Electron with a running companion; there's no unit test. Confirm the file parses (no syntax error) by loading it in the companion-hud dev run during E2E (Task 11). No commit-gating test here.

- [ ] **Step 4: Commit**

```bash
git add companion-hud/renderer/index.html companion-hud/renderer/hud.js
git commit -m "feat(hud): 'Bring work to my laptop' panel (list sessions + pull)"
```

---

### Task 11: Full verification + branch finish

**Files:** none (verification + merge).

- [ ] **Step 1: Root gate**

Run: `npx tsc --noEmit && pnpm test`
Expected: tsc clean; all tests pass (new: `writeback-repo`, `writeback-list`, plus `worktree` case).

- [ ] **Step 2: Companion gate**

Run: `cd companion && npx tsc --noEmit && npx tsx --test src/*.test.ts`
Expected: tsc clean; all companion tests pass (new: `ledger`, `writeback`, `bridge-protocol` additions).

- [ ] **Step 3: Build gate (main checkout only — not a junctioned worktree)**

Run: `pnpm build`
Expected: EXIT 0.

- [ ] **Step 4: Manual E2E (documented, run by the operator on the Mini + laptop)**

1. Ingest a small temp repo via the HUD (writes the ledger).
2. In the dashboard, dispatch Sage to make a one-line change in that project's session.
3. In the HUD, open "Bring work to my laptop", hit ↻, confirm the session shows "changed · N files".
4. Click **Bring to laptop**; confirm the HUD shows `Updated akira/<sessionId> (+N commits)` and the local repo has a new `akira/<sessionId>` branch at Sage's commit, with the working tree/current branch untouched.
5. Have Sage make another change; pull again → confirm the branch **fast-forwards**.
6. Commit a local edit on `akira/<sessionId>`, force a diverging pull → confirm it's **refused** with the "diverged" message and the branch is unchanged.

- [ ] **Step 5: Finish the branch**

Use superpowers:finishing-a-development-branch → merge the feature branch into `dev` (never straight to `main`). On Windows, unlink the worktree's junctioned `node_modules` before removing the worktree.

---

## Self-Review

**Spec coverage:** ledger (Task 1) ✓; discovery route (Task 5) ✓; writeback bundle route (Tasks 3–4) ✓; laptop apply / FF-only / missing-prereq (Task 8) ✓; HUD panel (Task 10) ✓; bridge protocol (Task 7) ✓; `commitWorktreeEdits` extraction (Task 2) ✓; proxy exclusion (Task 6) ✓; auto-commit loose edits (Task 4 calls Task 2) ✓; DevOps isolation (bundle-only, no push — Tasks 3/4/8) ✓.

**Type consistency:** `WritebackProject`/`WritebackSession`/`WritebackState` defined in Task 7 and consumed in Tasks 8/9/10; `applyBundleAsReviewBranch(localPath, sessionId, bundlePath)` and `downloadAndApply(cfg, {sessionId, localPath}, hooks)` and `fetchWritebackList(cfg)` names match across Tasks 8/9; route headers `x-wb-branch|commits|files` set in Task 4 and read in Task 8; branch `akira/<sessionId>` consistent Tasks 4/8/10.

**Placeholder scan:** none — every code step carries complete code.
