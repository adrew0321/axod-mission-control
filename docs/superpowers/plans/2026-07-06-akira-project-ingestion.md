# AKIRA Project Ingestion — Slice 1 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Point the AKIRA Local Companion at one local git repo; it lands on the Mini as a registered Mission Control project Sage can work on, with the Mini never touching the operator's DevOps.

**Architecture:** The companion `git bundle`s the repo and streams it (outbound HTTP POST) to a new token-authed Mini route `/api/companion/ingest`. The Mini streams the bundle to a temp file, `git clone`s it into `data/ingested/<slug>/`, removes `origin` (isolation), and registers it as a project. The HUD triggers it via a native folder picker over the existing localhost bridge; AKIRA sees the new project through her existing fleet snapshot.

**Tech Stack:** TypeScript, Next.js 16 route handlers (Web `Request`/`ReadableStream`), Node 22 built-ins (`node:child_process` git, `node:fs`), Drizzle/better-sqlite3, `ws` localhost bridge, Electron (HUD). `node:test` via `tsx --test`.

## Global Constraints

- **No new npm dependencies.** Use built-in `fetch`, `node:child_process`, `node:fs`, the already-present `ws`, and Electron's built-in `dialog`. (Copy exact: keep `package.json` deps unchanged so deploy skips `pnpm install`.)
- **Extensionless relative imports** in all TS (`from './ingest'`, not `'./ingest.ts'`) — the `.ts` extension breaks `tsc`/`next build` in this repo.
- **DevOps isolation (non-negotiable):** the bundle carries git objects only; after clone the Mini runs `git remote remove origin`. Enforced by test: post-ingest `git remote -v` is empty.
- **Commit-based transfer:** `git bundle create <out> --all` packs committed history only; uncommitted working-tree edits do not cross. This is intended.
- **Never break the session proxy:** any new token-authed companion route MUST be added to the `src/proxy.ts` matcher negative-lookahead, or it 307-redirects to `/login`.
- **Slice-1 is create-only:** ingesting a name whose project id already exists returns HTTP 409; no update/merge (that is slice 2).
- **Size ceiling:** `COMPANION_INGEST_MAX_BYTES` (default `1000000000`, ~1 GB); oversize → 413.
- **Ingested repos live under `data/ingested/`** (the app repo already gitignores `data/`).
- **The companion owns Mini communication; the HUD is UI only.**
- Tests run with `pnpm test` (`tsx --test ...`). DB-touching modules import `server-only` and therefore CANNOT be imported in `tsx --test`; keep unit-tested logic in pure/`node:`-only modules.

---

### Task 1: Pure `pickProjectId` helper

Extract the slug + numeric-dedupe logic (currently inline in the projects route) into a pure, tested helper so both the manual "Add Project" route and the new ingest route share it.

**Files:**
- Modify: `src/lib/projects.ts` (add `pickProjectId`)
- Test: `src/lib/projects.test.ts` (extend)

**Interfaces:**
- Produces: `pickProjectId(name: string, existingIds: string[]): string`

- [ ] **Step 1: Write the failing test**

Add to `src/lib/projects.test.ts`:

```ts
import { pickProjectId } from './projects';

test('pickProjectId slugifies the name when unused', () => {
  assert.equal(pickProjectId('Applications.Employer', []), 'applications-employer');
});

test('pickProjectId appends -2, -3 on collision', () => {
  const taken = ['applications-employer'];
  assert.equal(pickProjectId('Applications.Employer', taken), 'applications-employer-2');
  assert.equal(pickProjectId('Applications.Employer', ['applications-employer', 'applications-employer-2']), 'applications-employer-3');
});

test('pickProjectId falls back to "project" for an empty slug', () => {
  assert.equal(pickProjectId('...', []), 'project');
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm exec tsx --test src/lib/projects.test.ts`
Expected: FAIL — `pickProjectId is not a function` (or import error).

- [ ] **Step 3: Write minimal implementation**

Append to `src/lib/projects.ts`:

```ts
/** Pick a unique project id from a name: slugify, then append -2, -3… on collision. */
export function pickProjectId(name: string, existingIds: string[]): string {
  const base = slugifyProjectId(name) || 'project';
  const taken = new Set(existingIds);
  let id = base;
  for (let n = 2; taken.has(id); n++) id = `${base}-${n}`;
  return id;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm exec tsx --test src/lib/projects.test.ts`
Expected: PASS (all tests, including pre-existing ones).

- [ ] **Step 5: Commit**

```bash
git add src/lib/projects.ts src/lib/projects.test.ts
git commit -m "feat(projects): pure pickProjectId helper for shared id dedupe"
```

---

### Task 2: `registerProject()` server helper + refactor the manual projects route

Extract the DB-registration core out of the manual route into a shared server helper. It imports `server-only` (DB), so it is verified by `tsc` + the manual route's existing behavior, not a `tsx --test` unit test (the pure id logic is already tested in Task 1).

**Files:**
- Create: `src/lib/register-project.ts`
- Modify: `src/app/api/projects/route.ts:64-82` (use the helper)

**Interfaces:**
- Consumes: `pickProjectId(name, existingIds)` (Task 1); `getOrCreateActiveSession(projectId)` from `@/lib/active-project`.
- Produces: `registerProject(input: { name: string; repoPath: string; defaultBranch?: string; githubUrl?: string | null }): Promise<{ projectId: string }>`

- [ ] **Step 1: Create the helper**

Create `src/lib/register-project.ts`:

```ts
import 'server-only';
import { db } from '@/db/client';
import { projects } from '@/db/schema';
import { pickProjectId } from '@/lib/projects';
import { getOrCreateActiveSession } from '@/lib/active-project';

/**
 * Insert a project row for an on-disk git repo and ensure it has an active
 * session. Shared by the manual "Add Project" route and companion ingestion.
 * Does NOT touch cookies (callers with a request set the active-project cookie).
 */
export async function registerProject(input: {
  name: string;
  repoPath: string;
  defaultBranch?: string;
  githubUrl?: string | null;
}): Promise<{ projectId: string }> {
  const existing = await db.select({ id: projects.id }).from(projects);
  const projectId = pickProjectId(input.name, existing.map((p) => p.id));
  await db.insert(projects).values({
    id: projectId,
    name: input.name.trim(),
    repo_path: input.repoPath,
    github_url: input.githubUrl?.trim() || null,
    default_branch: input.defaultBranch?.trim() || 'dev',
    created_at: new Date(),
  });
  await getOrCreateActiveSession(projectId);
  return { projectId };
}
```

- [ ] **Step 2: Refactor the manual route to use it**

In `src/app/api/projects/route.ts`, replace the id-dedupe + insert + `getOrCreateActiveSession` block (currently lines ~64-80) with a call to the helper. The final section of `POST` becomes:

```ts
  const { projectId: id } = await registerProject({
    name: body.name!,
    repoPath,
    defaultBranch: body.defaultBranch,
    githubUrl: body.githubUrl,
  });

  jar.set(ACTIVE_PROJECT_COOKIE, id, cookieOptions());
  return Response.json({ ok: true, projectId: id });
```

Add the import near the other imports:

```ts
import { registerProject } from '@/lib/register-project';
```

Remove now-unused imports if they are no longer referenced: `projects` (from schema), `getOrCreateActiveSession`, and `slugifyProjectId` — but KEEP `db` only if still used elsewhere in the file (it is not, after this change; remove it too). Keep `validateNewProjectInput`, `slugifyProjectId` import ONLY if still referenced — after refactor `slugifyProjectId` is unused in the route, so drop it. Verify with tsc in Step 3.

- [ ] **Step 3: Verify build + types**

Run: `pnpm exec tsc --noEmit`
Expected: PASS, no unused-import or type errors.

Run: `pnpm test`
Expected: PASS (Task 1 tests still green; nothing else broken).

- [ ] **Step 4: Commit**

```bash
git add src/lib/register-project.ts src/app/api/projects/route.ts
git commit -m "refactor(projects): share registerProject() between manual add and ingest"
```

---

### Task 3: Git mechanics — `streamToFileWithCap` + `cloneBundleIntoProject`

The Mini-side file/git primitives. Pure `node:` modules (no `server-only`, no DB) → fully unit-tested against temp dirs with real git, like `src/lib/akira/memory/store.ts`. This carries the **DevOps-isolation test**.

**Files:**
- Create: `src/lib/companion/ingest-repo.ts`
- Test: `src/lib/companion/ingest-repo.test.ts`

**Interfaces:**
- Produces:
  - `streamToFileWithCap(stream: ReadableStream<Uint8Array>, destPath: string, maxBytes: number): Promise<number>` — writes the stream to `destPath`, returns bytes written; throws `RangeError('bundle exceeds size limit')` (after deleting the partial file) if it would exceed `maxBytes`.
  - `cloneBundleIntoProject(bundlePath: string, destDir: string): Promise<void>` — `git clone` the bundle into `destDir`, then `git remote remove origin`; throws if the clone fails or `destDir/.git` is missing.

- [ ] **Step 1: Write the failing tests**

Create `src/lib/companion/ingest-repo.test.ts`:

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, existsSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { streamToFileWithCap, cloneBundleIntoProject } from './ingest-repo';

function tmp(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

function streamOf(bytes: number[]): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start(c) { c.enqueue(new Uint8Array(bytes)); c.close(); },
  });
}

test('streamToFileWithCap writes bytes and returns the count', async () => {
  const dir = tmp('mc-cap-');
  const dest = join(dir, 'out.bin');
  const n = await streamToFileWithCap(streamOf([1, 2, 3, 4]), dest, 100);
  assert.equal(n, 4);
  assert.deepEqual([...readFileSync(dest)], [1, 2, 3, 4]);
  rmSync(dir, { recursive: true, force: true });
});

test('streamToFileWithCap throws and cleans up when over the cap', async () => {
  const dir = tmp('mc-cap-');
  const dest = join(dir, 'out.bin');
  await assert.rejects(() => streamToFileWithCap(streamOf([1, 2, 3, 4, 5]), dest, 3), RangeError);
  assert.equal(existsSync(dest), false);
  rmSync(dir, { recursive: true, force: true });
});

test('cloneBundleIntoProject clones the bundle and removes origin (DevOps isolation)', async () => {
  const work = tmp('mc-src-');
  // Build a source repo with a fake DevOps origin, then bundle it.
  execFileSync('git', ['init', '-b', 'main'], { cwd: work });
  execFileSync('git', ['config', 'user.email', 't@t'], { cwd: work });
  execFileSync('git', ['config', 'user.name', 'T'], { cwd: work });
  execFileSync('git', ['remote', 'add', 'origin', 'https://devops.example/secret.git'], { cwd: work });
  writeFileSync(join(work, 'hello.txt'), 'hi');
  execFileSync('git', ['add', '-A'], { cwd: work });
  execFileSync('git', ['commit', '-m', 'init'], { cwd: work });
  const bundle = join(work, 'repo.bundle');
  execFileSync('git', ['bundle', 'create', bundle, '--all'], { cwd: work });

  const destParent = tmp('mc-dest-');
  const dest = join(destParent, 'applications-employer');
  await cloneBundleIntoProject(bundle, dest);

  assert.equal(existsSync(join(dest, '.git')), true);
  assert.equal(existsSync(join(dest, 'hello.txt')), true);
  const remotes = execFileSync('git', ['-C', dest, 'remote', '-v']).toString().trim();
  assert.equal(remotes, ''); // origin removed — the Mini has NO path back to DevOps

  rmSync(work, { recursive: true, force: true });
  rmSync(destParent, { recursive: true, force: true });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm exec tsx --test src/lib/companion/ingest-repo.test.ts`
Expected: FAIL — module/functions not found.

- [ ] **Step 3: Implement**

Create `src/lib/companion/ingest-repo.ts`:

```ts
// Mini-side ingestion primitives: stream a bundle to disk (capped) and clone it
// into a project dir with NO remote. Pure node — no DB, no server-only — so it is
// unit-tested against temp dirs with real git.
import { createWriteStream } from 'node:fs';
import { rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

export async function streamToFileWithCap(
  stream: ReadableStream<Uint8Array>,
  destPath: string,
  maxBytes: number,
): Promise<number> {
  const out = createWriteStream(destPath);
  const reader = stream.getReader();
  let total = 0;
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) {
        throw new RangeError('bundle exceeds size limit');
      }
      await new Promise<void>((res, rej) => out.write(value, (e) => (e ? rej(e) : res())));
    }
    await new Promise<void>((res, rej) => out.end((e?: Error) => (e ? rej(e) : res())));
    return total;
  } catch (e) {
    out.destroy();
    await rm(destPath, { force: true });
    throw e;
  }
}

export async function cloneBundleIntoProject(bundlePath: string, destDir: string): Promise<void> {
  // A clone from a bundle sets origin = the bundle path; we remove it so the Mini
  // keeps no reference to where the repo came from (e.g. DevOps).
  await execFileAsync('git', ['clone', bundlePath, destDir], { windowsHide: true });
  if (!existsSync(join(destDir, '.git'))) {
    throw new Error('clone produced no .git');
  }
  await execFileAsync('git', ['-C', destDir, 'remote', 'remove', 'origin'], { windowsHide: true });
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm exec tsx --test src/lib/companion/ingest-repo.test.ts`
Expected: PASS (all three).

- [ ] **Step 5: Commit**

```bash
git add src/lib/companion/ingest-repo.ts src/lib/companion/ingest-repo.test.ts
git commit -m "feat(ingest): capped bundle streaming + isolated clone (Mini side)"
```

---

### Task 4: Mini ingest route + proxy exclusion

Wire the token-authed endpoint that ties Task 3 (git mechanics) and Task 2 (registration) together, and exclude it from the session proxy. Route wiring imports `server-only` (via `registerProject`) → verified by `tsc` + a live `curl` (the established way this repo verified the prior companion-route fix), not a `tsx --test`.

**Files:**
- Create: `src/app/api/companion/ingest/route.ts`
- Modify: `src/proxy.ts:31` (matcher)

**Interfaces:**
- Consumes: `streamToFileWithCap`, `cloneBundleIntoProject` (Task 3); `registerProject` (Task 2); `slugifyProjectId` from `@/lib/projects`.
- Wire contract: `POST /api/companion/ingest?name=<repoName>&branch=<headBranch>`, header `x-companion-token: <COMPANION_TOKEN>`, body = raw `.bundle` bytes. Response `{ ok: true, projectId }` (200) or an error status (401/409/413/400/507).

- [ ] **Step 1: Add the proxy exclusion**

In `src/proxy.ts`, change the matcher on line 31 from:

```ts
    '/((?!login$|api/auth/|api/companion/(?:stream|result)$|api/health$|_next/|favicon\\.ico|sitemap\\.xml|robots\\.txt|.*\\..*).*)',
```

to (add `|ingest`):

```ts
    '/((?!login$|api/auth/|api/companion/(?:stream|result|ingest)$|api/health$|_next/|favicon\\.ico|sitemap\\.xml|robots\\.txt|.*\\..*).*)',
```

Also add `ingest` to the comment block above (the list of excluded companion routes) so the reason stays documented.

- [ ] **Step 2: Create the route**

Create `src/app/api/companion/ingest/route.ts`:

```ts
import { mkdir, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { randomBytes, bytesToHex } from '@noble/hashes/utils.js';
import { db } from '@/db/client';
import { projects } from '@/db/schema';
import { slugifyProjectId } from '@/lib/projects';
import { registerProject } from '@/lib/register-project';
import { streamToFileWithCap, cloneBundleIntoProject } from '@/lib/companion/ingest-repo';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const MAX_BYTES = Number(process.env.COMPANION_INGEST_MAX_BYTES ?? 1_000_000_000);

export async function POST(req: Request) {
  const token = req.headers.get('x-companion-token');
  if (!process.env.COMPANION_TOKEN || token !== process.env.COMPANION_TOKEN) {
    return new Response('Unauthorized', { status: 401 });
  }

  const url = new URL(req.url);
  const name = (url.searchParams.get('name') ?? '').trim();
  const branch = (url.searchParams.get('branch') ?? '').trim() || 'main';
  if (!name) return Response.json({ error: 'name is required' }, { status: 400 });
  if (!req.body) return Response.json({ error: 'no bundle body' }, { status: 400 });

  const slug = slugifyProjectId(name) || 'project';

  // Slice 1 is create-only: refuse if this project already exists.
  const existing = await db.select({ id: projects.id }).from(projects);
  if (existing.some((p) => p.id === slug)) {
    return Response.json({ error: `Project "${slug}" already exists.` }, { status: 409 });
  }

  const root = join(process.cwd(), 'data', 'ingested');
  const destDir = join(root, slug);
  if (existsSync(destDir)) {
    return Response.json({ error: `Folder for "${slug}" already exists.` }, { status: 409 });
  }
  const tmpDir = join(root, '.tmp');
  await mkdir(tmpDir, { recursive: true });
  const bundlePath = join(tmpDir, `${bytesToHex(randomBytes(6))}.bundle`);

  try {
    await streamToFileWithCap(req.body as ReadableStream<Uint8Array>, bundlePath, MAX_BYTES);
    await cloneBundleIntoProject(bundlePath, destDir);
    const { projectId } = await registerProject({ name, repoPath: destDir, defaultBranch: branch });
    return Response.json({ ok: true, projectId });
  } catch (e) {
    await rm(destDir, { recursive: true, force: true }).catch(() => {});
    if (e instanceof RangeError) {
      return Response.json({ error: 'bundle too large' }, { status: 413 });
    }
    return Response.json(
      { error: `ingest failed: ${e instanceof Error ? e.message : String(e)}` },
      { status: 400 },
    );
  } finally {
    await rm(bundlePath, { force: true }).catch(() => {});
  }
}
```

- [ ] **Step 3: Verify build + types**

Run: `pnpm exec tsc --noEmit`
Expected: PASS.

- [ ] **Step 4: Live-verify the proxy exclusion (the isolation-critical check)**

Start the dev server (`pnpm dev`) in another terminal, then:

Run: `curl -s -o /dev/null -w "%{http_code}\n" -X POST http://localhost:3000/api/companion/ingest`
Expected: `401` (token missing) — NOT `307` (which would mean the proxy is redirecting it to `/login`, the prior bug).

- [ ] **Step 5: Commit**

```bash
git add src/app/api/companion/ingest/route.ts src/proxy.ts
git commit -m "feat(ingest): token-authed Mini ingest route + proxy exclusion"
```

---

### Task 5: Bridge protocol — `IngestState` + `ingest` client message

Extend the pure HUD bridge protocol so the HUD can request an ingest and see its status. Pure module → TDD.

**Files:**
- Modify: `companion/src/bridge-protocol.ts`
- Test: `companion/src/bridge-protocol.test.ts` (extend)

**Interfaces:**
- Produces:
  - `IngestState { phase: 'idle' | 'bundling' | 'uploading' | 'done' | 'error'; projectName?: string; projectId?: string; error?: string }`
  - `StateSnapshot` gains `ingest: IngestState`.
  - `ClientMsg` gains `{ type: 'ingest'; path: string }`; `parseClientMsg` accepts it.

- [ ] **Step 1: Write the failing tests**

In `companion/src/bridge-protocol.test.ts`, add `ingest` to the fixture snapshot and add cases:

Update the `snap` fixture to include the new required field:

```ts
const snap: StateSnapshot = {
  presence: { connected: true, operator: 'A\'Keem', host: 'LAPTOP', uptimeSec: 42, task: 'idle' },
  queue: [],
  security: { tokenAuthed: true, transport: 'outbound-only', profile: 'persistent · local', sensitiveCount: 2 },
  ingest: { phase: 'idle' },
};
```

Add tests:

```ts
test('buildState carries the ingest state', () => {
  const m = buildState({ ...snap, ingest: { phase: 'done', projectName: 'Applications.Employer', projectId: 'applications-employer' } });
  assert.equal(m.ingest.phase, 'done');
  assert.equal(m.ingest.projectId, 'applications-employer');
});

test('parseClientMsg accepts an ingest message with a path', () => {
  assert.deepEqual(parseClientMsg('{"type":"ingest","path":"C:/TEI/App"}'), { type: 'ingest', path: 'C:/TEI/App' });
});

test('parseClientMsg rejects an ingest message with no path', () => {
  assert.equal(parseClientMsg('{"type":"ingest"}'), null);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm exec tsx --test companion/src/bridge-protocol.test.ts`
Expected: FAIL — `ingest` missing from `StateSnapshot` type / `parseClientMsg` returns null for the valid ingest message.

- [ ] **Step 3: Implement**

In `companion/src/bridge-protocol.ts`:

Add the interface (after `Security`):

```ts
export interface IngestState {
  phase: 'idle' | 'bundling' | 'uploading' | 'done' | 'error';
  projectName?: string;
  projectId?: string;
  error?: string;
}
```

Add `ingest` to `StateSnapshot`:

```ts
export interface StateSnapshot {
  presence: Presence;
  queue: PendingGate[];
  security: Security;
  ingest: IngestState;
}
```

Extend `ClientMsg`:

```ts
export type ClientMsg =
  | { type: 'hello'; token: string }
  | { type: 'approve'; id: string }
  | { type: 'deny'; id: string }
  | { type: 'stop' }
  | { type: 'ingest'; path: string };
```

Update `buildState` to carry `ingest`:

```ts
export function buildState(s: StateSnapshot): StateMsg {
  return { type: 'state', presence: s.presence, queue: s.queue, security: s.security, ingest: s.ingest };
}
```

Add the parse case (before `default:`):

```ts
    case 'ingest':
      return typeof m.path === 'string' && m.path ? { type: 'ingest', path: m.path } : null;
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm exec tsx --test companion/src/bridge-protocol.test.ts`
Expected: PASS (all, including pre-existing).

- [ ] **Step 5: Commit**

```bash
git add companion/src/bridge-protocol.ts companion/src/bridge-protocol.test.ts
git commit -m "feat(companion): ingest state + ingest client message in bridge protocol"
```

---

### Task 6: Companion ingest module — bundle + upload

The companion-side worker: validate the repo, derive metadata, `git bundle`, and stream it to the Mini. `deriveIngestMeta` is pure (tested); `createBundle` uses real git (tested against a temp repo); `ingestRepo` is thin orchestration.

**Files:**
- Create: `companion/src/ingest.ts`
- Test: `companion/src/ingest.test.ts`

**Interfaces:**
- Consumes: nothing from other new tasks (POSTs to the wire contract from Task 4).
- Produces:
  - `deriveIngestMeta(repoPath: string, headBranch: string): { name: string; branch: string }`
  - `isGitRepo(repoPath: string): boolean`
  - `createBundle(repoPath: string, outPath: string): Promise<void>`
  - `ingestRepo(cfg: { miniUrl: string; token: string }, repoPath: string, hooks: { onPhase: (p: 'bundling' | 'uploading') => void }): Promise<{ projectId: string; name: string }>`

- [ ] **Step 1: Write the failing tests**

Create `companion/src/ingest.test.ts`:

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, existsSync, writeFileSync, rmSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { deriveIngestMeta, isGitRepo, createBundle } from './ingest';

function tmp(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

test('deriveIngestMeta uses the folder basename and the head branch', () => {
  assert.deepEqual(deriveIngestMeta('C:/TEI/Applications.Employer', 'develop'), {
    name: 'Applications.Employer',
    branch: 'develop',
  });
});

test('deriveIngestMeta defaults an empty branch to main', () => {
  assert.deepEqual(deriveIngestMeta('/home/a/TEI/App', ''), { name: 'App', branch: 'main' });
});

test('isGitRepo is false for a plain dir, true for a git repo', () => {
  const plain = tmp('mc-plain-');
  assert.equal(isGitRepo(plain), false);
  execFileSync('git', ['init'], { cwd: plain });
  assert.equal(isGitRepo(plain), true);
  rmSync(plain, { recursive: true, force: true });
});

test('createBundle writes a valid git bundle of the repo', async () => {
  const repo = tmp('mc-repo-');
  execFileSync('git', ['init', '-b', 'main'], { cwd: repo });
  execFileSync('git', ['config', 'user.email', 't@t'], { cwd: repo });
  execFileSync('git', ['config', 'user.name', 'T'], { cwd: repo });
  writeFileSync(join(repo, 'a.txt'), 'x');
  execFileSync('git', ['add', '-A'], { cwd: repo });
  execFileSync('git', ['commit', '-m', 'c1'], { cwd: repo });

  const out = join(repo, 'out.bundle');
  await createBundle(repo, out);
  assert.equal(existsSync(out), true);
  // git verifies its own bundle format:
  execFileSync('git', ['bundle', 'verify', out], { cwd: repo });
  rmSync(repo, { recursive: true, force: true });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm exec tsx --test companion/src/ingest.test.ts`
Expected: FAIL — module/functions not found.

- [ ] **Step 3: Implement**

Create `companion/src/ingest.ts`:

```ts
import { existsSync } from 'node:fs';
import { rm, mkdtemp } from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import { Readable } from 'node:stream';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

export function deriveIngestMeta(repoPath: string, headBranch: string): { name: string; branch: string } {
  // basename() is POSIX-separator only; normalise Windows backslashes first.
  const name = basename(repoPath.replace(/\\/g, '/')) || 'project';
  return { name, branch: headBranch.trim() || 'main' };
}

export function isGitRepo(repoPath: string): boolean {
  return existsSync(join(repoPath, '.git'));
}

export async function createBundle(repoPath: string, outPath: string): Promise<void> {
  await execFileAsync('git', ['bundle', 'create', outPath, '--all'], { cwd: repoPath, windowsHide: true });
}

async function currentBranch(repoPath: string): Promise<string> {
  try {
    const { stdout } = await execFileAsync('git', ['-C', repoPath, 'rev-parse', '--abbrev-ref', 'HEAD'], {
      windowsHide: true,
    });
    return stdout.trim();
  } catch {
    return '';
  }
}

export async function ingestRepo(
  cfg: { miniUrl: string; token: string },
  repoPath: string,
  hooks: { onPhase: (p: 'bundling' | 'uploading') => void },
): Promise<{ projectId: string; name: string }> {
  if (!isGitRepo(repoPath)) throw new Error('not a git repo (no .git found)');

  const meta = deriveIngestMeta(repoPath, await currentBranch(repoPath));
  const work = await mkdtemp(join(tmpdir(), 'akira-ingest-'));
  const bundlePath = join(work, 'repo.bundle');

  try {
    hooks.onPhase('bundling');
    await createBundle(repoPath, bundlePath);

    hooks.onPhase('uploading');
    const qs = new URLSearchParams({ name: meta.name, branch: meta.branch });
    const body = Readable.toWeb(createReadStream(bundlePath)) as unknown as ReadableStream<Uint8Array>;
    const res = await fetch(`${cfg.miniUrl}/api/companion/ingest?${qs.toString()}`, {
      method: 'POST',
      headers: { 'x-companion-token': cfg.token, 'Content-Type': 'application/octet-stream' },
      body,
      // Node fetch requires this when streaming a request body.
      // @ts-expect-error duplex is valid at runtime (undici) but missing from the DOM types.
      duplex: 'half',
    });
    const json = (await res.json().catch(() => null)) as { projectId?: string; error?: string } | null;
    if (!res.ok || !json?.projectId) {
      throw new Error(json?.error ?? `ingest failed (${res.status})`);
    }
    return { projectId: json.projectId, name: meta.name };
  } finally {
    await rm(work, { recursive: true, force: true }).catch(() => {});
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm exec tsx --test companion/src/ingest.test.ts`
Expected: PASS (all four).

- [ ] **Step 5: Commit**

```bash
git add companion/src/ingest.ts companion/src/ingest.test.ts
git commit -m "feat(companion): ingest module — bundle a repo and stream it to the Mini"
```

---

### Task 7: Wire the companion — bridge `onIngest` + main process

Connect the HUD's `ingest` message through the bridge to `ingestRepo`, tracking `IngestState` and pushing it to the HUD. Glue → verified by `tsc` + `pnpm test` (protocol/ingest tests stay green) + a manual run.

**Files:**
- Modify: `companion/src/bridge.ts` (handler type + dispatch)
- Modify: `companion/src/index.ts` (state, handler, getState)

**Interfaces:**
- Consumes: `ingestRepo` (Task 6); `IngestState` (Task 5); `parseClientMsg`'s `ingest` case (Task 5).
- Produces: `BridgeHandlers` gains `onIngest: (path: string) => void`.

- [ ] **Step 1: Add the handler to the bridge**

In `companion/src/bridge.ts`, extend `BridgeHandlers`:

```ts
export interface BridgeHandlers {
  getState: () => StateSnapshot;
  onApprove: (id: string) => void;
  onDeny: (id: string) => void;
  onStop: () => void;
  onIngest: (path: string) => void;
}
```

And dispatch it in the message handler (after the `stop` branch, still inside the `authed` block):

```ts
      if (msg.type === 'approve') h.onApprove(msg.id);
      else if (msg.type === 'deny') h.onDeny(msg.id);
      else if (msg.type === 'stop') h.onStop();
      else if (msg.type === 'ingest') h.onIngest(msg.path);
```

- [ ] **Step 2: Wire it in the main process**

In `companion/src/index.ts`:

Add the import:

```ts
import { ingestRepo } from './ingest';
import type { IngestState } from './bridge-protocol';
```

Add module state near `let currentTask = 'idle';`:

```ts
let ingestState: IngestState = { phase: 'idle' };
```

Add `ingest: ingestState` to the object returned by `getState`:

```ts
  getState: () => ({
    presence: { /* unchanged */ },
    queue: queue.list(),
    security: { /* unchanged */ },
    ingest: ingestState,
  }),
```

Add `onIngest` to the `startBridge` handlers:

```ts
  onIngest: (path) => { void runIngest(path); },
```

Add the runner function (near `stopAll`):

```ts
async function runIngest(path: string): Promise<void> {
  ingestState = { phase: 'bundling' };
  bridge.push();
  console.log('[companion] ingest start:', path);
  try {
    const { projectId, name } = await ingestRepo(cfg, path, {
      onPhase: (phase) => { ingestState = { phase }; bridge.push(); },
    });
    ingestState = { phase: 'done', projectName: name, projectId };
    console.log('[companion] ingest done:', projectId);
  } catch (e) {
    ingestState = { phase: 'error', error: e instanceof Error ? e.message : String(e) };
    console.error('[companion] ingest error:', ingestState.error);
  }
  bridge.push();
}
```

- [ ] **Step 3: Verify build + tests**

Run: `pnpm exec tsc --noEmit`
Expected: PASS (note: `tsc` covers both `src/` and `companion/src/` per the repo config).

Run: `pnpm test`
Expected: PASS (all companion + lib tests).

- [ ] **Step 4: Commit**

```bash
git add companion/src/bridge.ts companion/src/index.ts
git commit -m "feat(companion): wire HUD ingest message to bundle+upload with live status"
```

---

### Task 8: HUD — folder picker + ingest UI

Give the operator the gesture: a "Send a project to AKIRA" button that opens a native folder picker and shows ingest status. Electron/renderer glue → verified by launching the HUD.

**Files:**
- Modify: `companion-hud/main.js` (IPC `hud:pick-folder` via `dialog`)
- Modify: `companion-hud/preload.js` (expose `pickFolder`)
- Modify: `companion-hud/renderer/index.html` (button + status row)
- Modify: `companion-hud/renderer/hud.js` (wire click + render status)

**Interfaces:**
- Consumes: the `ingest` client message + `state.ingest` (Tasks 5-7).

- [ ] **Step 1: Add the folder-picker IPC in main**

In `companion-hud/main.js`, add `dialog` to the top require:

```js
const { app, BrowserWindow, ipcMain, dialog } = require('electron');
```

Register the handler at module scope (next to the existing `ipcMain.on('hud:resize', …)`):

```js
ipcMain.handle('hud:pick-folder', async () => {
  const r = await dialog.showOpenDialog({ properties: ['openDirectory'] });
  return r.canceled || r.filePaths.length === 0 ? null : r.filePaths[0];
});
```

- [ ] **Step 2: Expose it in preload**

In `companion-hud/preload.js`, add to the exposed `hud` object:

```js
contextBridge.exposeInMainWorld('hud', {
  resize: (width, height) => ipcRenderer.send('hud:resize', { width, height }),
  onBridge: (cb) => ipcRenderer.on('hud:bridge', (_e, bridge) => cb(bridge)),
  pickFolder: () => ipcRenderer.invoke('hud:pick-folder'),
});
```

- [ ] **Step 3: Add the UI section**

In `companion-hud/renderer/index.html`, add a new section immediately before the `<div class="foot">` block:

```html
      <div class="sec">
        <div class="sec-h"><div class="t">Projects</div></div>
        <div class="ingest-btn" id="ingestBtn">＋ Send a project to AKIRA</div>
        <div class="ingest-status" id="ingestStatus"></div>
      </div>
```

Add styles inside the `<style>` block (near `.foot`):

```css
      .ingest-btn { text-align: center; padding: 9px 0; border-radius: 9px; font-size: 12px; font-weight: 700;
        letter-spacing: .4px; border: 1px solid rgba(127,220,255,.5); color: #7fdcff; background: rgba(127,220,255,.06);
        cursor: pointer; -webkit-app-region: no-drag; }
      .ingest-status { font-size: 11px; color: #8fb2c9; margin-top: 8px; min-height: 14px; font-family: ui-monospace, monospace; }
      .ingest-status.err { color: #ff8fdc; }
      .ingest-status.ok { color: #37d39b; }
```

- [ ] **Step 4: Wire the renderer**

In `companion-hud/renderer/hud.js`:

Add the click handler (near the other button wiring, e.g. after the `stopBtn` line):

```js
$('ingestBtn').onclick = async () => {
  if (!window.hud || !window.hud.pickFolder) return;
  const path = await window.hud.pickFolder();
  if (path) send({ type: 'ingest', path });
};
```

Add ingest rendering inside `render()`, within the `if (state) { … }` block (after `renderApprovals(queue);`):

```js
    renderIngest(state.ingest);
```

Add the helper function (near `renderApprovals`):

```js
function renderIngest(ing) {
  const el = $('ingestStatus');
  if (!el) return;
  el.classList.remove('err', 'ok');
  if (!ing || ing.phase === 'idle') { el.textContent = ''; return; }
  if (ing.phase === 'bundling') { el.textContent = 'Bundling repo…'; return; }
  if (ing.phase === 'uploading') { el.textContent = 'Uploading to AKIRA…'; return; }
  if (ing.phase === 'done') { el.classList.add('ok'); el.textContent = `Sent “${ing.projectName}” → ${ing.projectId}`; return; }
  if (ing.phase === 'error') { el.classList.add('err'); el.textContent = `Failed: ${ing.error || 'unknown error'}`; return; }
}
```

- [ ] **Step 5: Manual verification**

With the companion running (`pnpm --dir companion start` or the documented start command) and the Mini reachable:
1. Launch the HUD (`pnpm --dir companion-hud start`).
2. Click "＋ Send a project to AKIRA", pick a small local git repo.
3. Expect the status to move Bundling → Uploading → `Sent "<name>" → <slug>`.
4. On the Mini (or dev server), confirm `data/ingested/<slug>/.git` exists and `git -C data/ingested/<slug> remote -v` is empty.
5. In the web front door, confirm the project appears and AKIRA references it.

- [ ] **Step 6: Commit**

```bash
git add companion-hud/main.js companion-hud/preload.js companion-hud/renderer/index.html companion-hud/renderer/hud.js
git commit -m "feat(hud): send-a-project folder picker + ingest status"
```

---

### Task 9: AKIRA awareness + docs sync

One prompt line so AKIRA frames ingested projects naturally, plus keep the spec/memory in sync.

**Files:**
- Modify: `src/lib/akira/prompt.ts` (one sentence in the Memory/Style area of `AKIRA_SYSTEM_PROMPT`)
- Modify: `docs/superpowers/specs/2026-07-06-akira-project-ingestion-design.md` (mark slice 1 as built once merged)

**Interfaces:** none (prose only).

- [ ] **Step 1: Add the prompt line**

In `src/lib/akira/prompt.ts`, within `AKIRA_SYSTEM_PROMPT`, add one sentence after the tools list (before `Style:`):

```
Projects can arrive by companion ingestion (the operator sends a local repo from his laptop); when a new project appears you can hand it to its team with relay, just like any other project.
```

- [ ] **Step 2: Verify build**

Run: `pnpm exec tsc --noEmit && pnpm test`
Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add src/lib/akira/prompt.ts
git commit -m "feat(akira): note companion-ingested projects in the system prompt"
```

- [ ] **Step 4: Full green + finish the branch**

Run: `pnpm exec tsc --noEmit && pnpm test`
Expected: PASS across the whole suite.

Then follow superpowers:finishing-a-development-branch to merge the feature branch into `dev` (never straight to `main`). Release + Mini deploy happen later via the ship-mc-feature skill (note: this adds NO new npm deps and NO DB migration, so the Mini deploy skips `pnpm install` and `db:migrate`).

---

## Self-Review

**1. Spec coverage:**
- Companion bundle + outbound stream → Task 6. ✅
- HUD native folder picker + status → Task 8. ✅
- Mini `POST /api/companion/ingest` (stream-to-temp, size cap, clone, origin removal, register) → Tasks 3 + 4. ✅
- Proxy matcher exclusion → Task 4. ✅
- `registerProject()` refactor shared with manual route → Tasks 1 + 2. ✅
- DevOps isolation (origin removed) + test → Task 3 (isolation test) + Task 4 (curl 401). ✅
- Create-only 409 on collision → Task 4. ✅
- Size ceiling ~1 GB + 413 → Tasks 3 + 4. ✅
- `data/ingested/` root → Task 4. ✅
- AKIRA awareness via snapshot + one prompt line → Task 9. ✅
- Commit-based transfer (`--all`) → Task 6. ✅

**2. Placeholder scan:** No TBD/TODO; every code step carries complete code and exact commands. ✅

**3. Type consistency:** `IngestState` (Task 5) is consumed unchanged in Tasks 6-8; `registerProject` signature (Task 2) matches its call in Task 4; the wire contract `?name=&branch=` + `x-companion-token` + `{ projectId }` is identical in Task 4 (server) and Task 6 (client); `pickProjectId(name, existingIds)` (Task 1) is used in Task 2. ✅
