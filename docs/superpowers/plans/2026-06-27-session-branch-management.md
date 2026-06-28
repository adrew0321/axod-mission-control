# Session & Branch Management (web) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let the operator create, list, and switch sessions in the web UI, choose each session's base branch, and see the active Project ▸ Session ▸ branch — with the active session stored explicitly and shared by web + Discord + scheduler.

**Architecture:** Add `projects.active_session_id` (explicit current session) and `sessions.base_branch` (per-session fork base). Centralize "which session is active" in a pure `resolveActiveSession` used by both resolvers. Thread `session.base_branch ?? project.default_branch` through the worktree/proposal/merge paths. Add list/create/branches/activate APIs and a `SessionSwitcher` + create dialog + breadcrumb in the UI.

**Tech Stack:** TypeScript, Next.js 16, Drizzle + better-sqlite3 (drizzle-kit migrations), React client components, `node:test` via `tsx`, git CLI.

## Global Constraints

- Tests use `node:test` + `node:assert/strict` via `pnpm test` (`tsx --test src/lib/*.test.ts`); local imports WITHOUT file extensions.
- Pure modules (`src/lib/sessions.ts`, `src/lib/projects.ts`) are unit-tested. `server-only` modules (db, routes, `active-project.ts`, `discord-session.ts`, `run-turn.ts`) are NOT unit-tested — verified by `tsc --noEmit` + full suite + runtime.
- Branch model is **fork-only**: a session works on `mc/<id>`; `base_branch` is what it forks from / diffs against / merges into. Effective base everywhere = `session.base_branch ?? project.default_branch ?? 'dev'`.
- Active session is **explicit + server-side**: `projects.active_session_id`. Both `getOrCreateActiveSession` (web) and `getActiveSessionId` (Discord/scheduler) resolve through it.
- Worktree creation stays **lazy** (first turn), unchanged.
- Migrations are generated with `pnpm db:generate` (drizzle-kit) into `./drizzle`, applied with `pnpm db:migrate`. Never hand-write migration SQL.
- Auth: every route guards with `verifySession` on `SESSION_COOKIE` (mirror existing routes), returning `401` when absent/invalid.
- No new npm dependencies.
- Implementation runs in an isolated git worktree off `dev`.

---

### Task 1: Schema + migration (active_session_id, base_branch)

**Files:**
- Modify: `src/db/schema.ts`
- Create (generated): `drizzle/0008_*.sql` (+ `drizzle/meta` updates)

**Interfaces (produced):** `projects.active_session_id` (text, nullable), `sessions.base_branch` (text, nullable).

- [ ] **Step 1: Add the columns to the schema**

In `src/db/schema.ts`, add to the `projects` table (after `default_branch`):

```ts
  active_session_id: text('active_session_id'),
```

and to the `sessions` table (after `branch`):

```ts
  base_branch: text('base_branch'),
```

- [ ] **Step 2: Generate the migration**

Run: `pnpm db:generate`
Expected: a new `drizzle/0008_*.sql` containing `ALTER TABLE projects ADD ...active_session_id...` and `ALTER TABLE sessions ADD ...base_branch...`. Open it and confirm both ALTERs are present.

- [ ] **Step 3: Apply it locally**

Run: `pnpm db:migrate`
Expected: `migrations applied successfully`.

- [ ] **Step 4: Typecheck + commit**

```bash
pnpm exec tsc --noEmit
git add src/db/schema.ts drizzle/
git commit -m "feat(db): add projects.active_session_id + sessions.base_branch (migration 0008)"
```
Expected: tsc clean.

---

### Task 2: Pure session helpers

**Files:**
- Create: `src/lib/sessions.ts`
- Create: `src/lib/sessions.test.ts`

**Interfaces (produced):**
- `parseGitBranches(raw: string, defaultBranch: string): string[]`
- `resolveActiveSession(input: { activeId: string | null; existingIds: string[]; newestId: string | null }): { kind: 'use'; id: string } | { kind: 'create' }`
- `sessionTitleOrDefault(title: string | null | undefined): string`
- `validateNewSessionInput(input: { title?: string; baseBranch?: string }, allowedBranches: string[]): { ok: true } | { ok: false; error: string }`

- [ ] **Step 1: Write the failing tests**

Create `src/lib/sessions.test.ts`:

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  parseGitBranches,
  resolveActiveSession,
  sessionTitleOrDefault,
  validateNewSessionInput,
} from './sessions';

test('parseGitBranches: dedups local+remote, default first, drops HEAD/detached', () => {
  const raw = ['dev', 'main', 'feature/x', 'origin/dev', 'origin/main', 'origin/feature/x', 'origin/HEAD -> origin/main', '(HEAD detached at abc123)'].join('\n');
  const out = parseGitBranches(raw, 'dev');
  assert.deepEqual(out, ['dev', 'main', 'feature/x']);
});

test('parseGitBranches: default is first even if listed later, and is added if missing', () => {
  assert.deepEqual(parseGitBranches('main\nfeature/y', 'dev'), ['dev', 'main', 'feature/y']);
  assert.deepEqual(parseGitBranches('main\ndev', 'dev'), ['dev', 'main']);
});

test('resolveActiveSession: valid active id is used', () => {
  assert.deepEqual(
    resolveActiveSession({ activeId: 's1', existingIds: ['s1', 's2'], newestId: 's2' }),
    { kind: 'use', id: 's1' },
  );
});

test('resolveActiveSession: stale active id falls back to newest', () => {
  assert.deepEqual(
    resolveActiveSession({ activeId: 'gone', existingIds: ['s1', 's2'], newestId: 's2' }),
    { kind: 'use', id: 's2' },
  );
});

test('resolveActiveSession: no sessions => create', () => {
  assert.deepEqual(
    resolveActiveSession({ activeId: null, existingIds: [], newestId: null }),
    { kind: 'create' },
  );
});

test('sessionTitleOrDefault: trims, falls back', () => {
  assert.equal(sessionTitleOrDefault('  Hi  '), 'Hi');
  assert.equal(sessionTitleOrDefault(''), 'New session');
  assert.equal(sessionTitleOrDefault(null), 'New session');
});

test('validateNewSessionInput: base branch must be allowed when provided', () => {
  assert.deepEqual(validateNewSessionInput({ baseBranch: 'dev' }, ['dev', 'main']), { ok: true });
  assert.deepEqual(validateNewSessionInput({}, ['dev']), { ok: true }); // omitted is fine (defaults later)
  assert.equal(validateNewSessionInput({ baseBranch: 'nope' }, ['dev', 'main']).ok, false);
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm exec tsx --test src/lib/sessions.test.ts`
Expected: FAIL — module `./sessions` not found.

- [ ] **Step 3: Implement the helpers**

Create `src/lib/sessions.ts`:

```ts
// Pure session helpers (no DB/fs) — shared by server (page.tsx, routes, resolvers)
// and unit-tested under `tsx --test`. Mirrors the structure of ./projects.

/**
 * Normalize `git branch -a --format='%(refname:short)'` output into an ordered,
 * de-duped branch list: strips `origin/` prefixes, drops HEAD/detached lines, and
 * puts `defaultBranch` first (adding it if missing). Pure.
 */
export function parseGitBranches(raw: string, defaultBranch: string): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const line of raw.split('\n')) {
    let name = line.trim();
    if (!name) continue;
    if (name.includes('->')) continue; // "origin/HEAD -> origin/main"
    if (name.startsWith('(') || name.includes('detached')) continue; // detached HEAD
    name = name.replace(/^remotes\//, '').replace(/^origin\//, '');
    if (!name || name === 'HEAD') continue;
    if (seen.has(name)) continue;
    seen.add(name);
    out.push(name);
  }
  const ordered = out.filter((b) => b !== defaultBranch);
  return [defaultBranch, ...ordered];
}

/**
 * Decide which session is active for a project, given the stored active id, the
 * set of existing session ids, and the newest session id. Pure — the db read/write
 * lives in the server-only resolver that calls this.
 */
export function resolveActiveSession(input: {
  activeId: string | null;
  existingIds: string[];
  newestId: string | null;
}): { kind: 'use'; id: string } | { kind: 'create' } {
  const { activeId, existingIds, newestId } = input;
  if (activeId && existingIds.includes(activeId)) return { kind: 'use', id: activeId };
  if (newestId) return { kind: 'use', id: newestId };
  return { kind: 'create' };
}

/** Session display title with a sane fallback. Pure. */
export function sessionTitleOrDefault(title: string | null | undefined): string {
  const t = (title ?? '').trim();
  return t || 'New session';
}

/** Shape validation for creating a session. baseBranch is optional; when present it
 * must be one of the repo's branches. Pure. */
export function validateNewSessionInput(
  input: { title?: string; baseBranch?: string },
  allowedBranches: string[],
): { ok: true } | { ok: false; error: string } {
  if (input.baseBranch && !allowedBranches.includes(input.baseBranch)) {
    return { ok: false, error: `Unknown base branch: ${input.baseBranch}` };
  }
  return { ok: true };
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `pnpm exec tsx --test src/lib/sessions.test.ts`
Expected: PASS (7 tests).

- [ ] **Step 5: Commit**

```bash
git add src/lib/sessions.ts src/lib/sessions.test.ts
git commit -m "feat(sessions): pure helpers — branch parse, active-session resolution, create-input validation"
```

---

### Task 3: Unify active-session resolution on `active_session_id`

**Files:**
- Modify: `src/lib/active-project.ts` (web resolver)
- Modify: `src/lib/discord-session.ts` (Discord/scheduler resolver)

**Interfaces (consumed):** `resolveActiveSession` (Task 2). **Produced:** both resolvers honor + persist `projects.active_session_id` and set `base_branch` on created sessions.

- [ ] **Step 1: Rewrite `getOrCreateActiveSession`**

Replace the body of `getOrCreateActiveSession` in `src/lib/active-project.ts`:

```ts
import 'server-only';
import { randomBytes, bytesToHex } from '@noble/hashes/utils.js';
import { desc, eq } from 'drizzle-orm';
import { db } from '@/db/client';
import { projects, sessions } from '@/db/schema';
import { resolveActiveSession } from '@/lib/sessions';

/**
 * Return the project's active session (projects.active_session_id), self-healing to
 * the newest session for legacy projects, or creating one if the project has none.
 * Persists the resolved id back to active_session_id so web + Discord + scheduler agree.
 */
export async function getOrCreateActiveSession(projectId: string) {
  const project = await db
    .select()
    .from(projects)
    .where(eq(projects.id, projectId))
    .limit(1)
    .then((r) => r[0]);

  const rows = await db
    .select()
    .from(sessions)
    .where(eq(sessions.project_id, projectId))
    .orderBy(desc(sessions.updated_at));

  const decision = resolveActiveSession({
    activeId: project?.active_session_id ?? null,
    existingIds: rows.map((r) => r.id),
    newestId: rows[0]?.id ?? null,
  });

  if (decision.kind === 'use') {
    const chosen = rows.find((r) => r.id === decision.id)!;
    if (project?.active_session_id !== chosen.id) {
      await db.update(projects).set({ active_session_id: chosen.id }).where(eq(projects.id, projectId));
    }
    return chosen;
  }

  const now = new Date();
  const base = project?.default_branch ?? 'dev';
  const row = {
    id: `sess_${bytesToHex(randomBytes(4))}`,
    project_id: projectId,
    title: '(new session)',
    branch: `mc/`, // placeholder; replaced below to include the id
    base_branch: base,
    worktree_path: null,
    status: 'active',
    cleared_at: null,
    created_at: now,
    updated_at: now,
  };
  row.branch = `mc/${row.id}`;
  await db.insert(sessions).values(row);
  await db.update(projects).set({ active_session_id: row.id }).where(eq(projects.id, projectId));
  return row;
}
```

- [ ] **Step 2: Rewrite `getActiveSessionId` to match**

Replace the body of `getActiveSessionId` in `src/lib/discord-session.ts` (keep the file's existing imports; add `resolveActiveSession`):

```ts
import { resolveActiveSession } from '@/lib/sessions';

export async function getActiveSessionId(projectId: string): Promise<string> {
  const project = await db
    .select()
    .from(projects)
    .where(eq(projects.id, projectId))
    .limit(1)
    .then((r) => r[0]);

  const rows = await db
    .select({ id: sessions.id })
    .from(sessions)
    .where(eq(sessions.project_id, projectId))
    .orderBy(desc(sessions.updated_at));

  const decision = resolveActiveSession({
    activeId: project?.active_session_id ?? null,
    existingIds: rows.map((r) => r.id),
    newestId: rows[0]?.id ?? null,
  });

  if (decision.kind === 'use') {
    if (project?.active_session_id !== decision.id) {
      await db.update(projects).set({ active_session_id: decision.id }).where(eq(projects.id, projectId));
    }
    return decision.id;
  }

  const sessionId = `sess_${bytesToHex(randomBytes(4))}`;
  const ts = new Date();
  const base = project?.default_branch ?? 'dev';
  await db.insert(sessions).values({
    id: sessionId,
    project_id: projectId,
    title: 'Discord',
    branch: `mc/${sessionId}`,
    base_branch: base,
    worktree_path: null,
    status: 'active',
    cleared_at: null,
    created_at: ts,
    updated_at: ts,
  });
  await db.update(projects).set({ active_session_id: sessionId }).where(eq(projects.id, projectId));
  return sessionId;
}
```

- [ ] **Step 3: Typecheck + suite**

Run: `pnpm exec tsc --noEmit && pnpm test`
Expected: tsc clean; suite green (no test imports these server-only modules; this guards types).

- [ ] **Step 4: Commit**

```bash
git add src/lib/active-project.ts src/lib/discord-session.ts
git commit -m "feat(sessions): resolve active session via projects.active_session_id (web + discord)"
```

---

### Task 4: Thread `base_branch` through worktree/proposal/merge paths

**Files:**
- Modify: `src/lib/run-turn.ts`
- Modify: `src/lib/proposals.ts` (`ProposalRow` + `collectProposals` base precedence)
- Modify: `src/lib/proposals.test.ts` (base precedence test)
- Modify: `src/lib/proposals-data.ts` (select `base_branch`)
- Modify: `src/app/api/proposals/[sessionId]/merge/route.ts`
- Modify: `src/app/api/proposals/[sessionId]/discard/route.ts`
- Modify: `src/lib/discord-bot.ts` (`handleButton` base)

**Interfaces:** effective base everywhere = `session.base_branch ?? project.default_branch ?? 'dev'`.

- [ ] **Step 1: Add a base-precedence test for `collectProposals`**

Append to `src/lib/proposals.test.ts`:

```ts
test('collectProposals: session base_branch wins over project default', async () => {
  const rows = [row({ sessionId: 'b', worktreePath: '/wt/b', baseBranch: 'main', defaultBranch: 'dev' })];
  let seenBase = '';
  const diff = async (_wt: string, base: string) => {
    seenBase = base;
    return { diff: '+a\n', files: [{ status: 'M', path: 'f' }] };
  };
  const [p] = await collectProposals(rows, diff);
  assert.equal(seenBase, 'main'); // diff invoked with the session base
  assert.equal(p.baseBranch, 'main');
});
```

Update the `row(...)` helper in this file to include `baseBranch: null` in its defaults:

```ts
function row(over: Partial<ProposalRow> = {}): ProposalRow {
  return {
    sessionId: 's', sessionTitle: 'S', worktreePath: '/wt/s', baseBranch: null,
    updatedAt: new Date('2026-06-01T00:00:00Z'), projectId: 'p', projectName: 'P',
    defaultBranch: 'dev', ...over,
  };
}
```

- [ ] **Step 2: Run it to verify it fails**

Run: `pnpm exec tsx --test src/lib/proposals.test.ts`
Expected: FAIL — `baseBranch` not on `ProposalRow` / not used.

- [ ] **Step 3: Add `baseBranch` to `ProposalRow` and use it as the base**

In `src/lib/proposals.ts`, add `baseBranch` to the interface:

```ts
export interface ProposalRow {
  sessionId: string;
  sessionTitle: string | null;
  worktreePath: string | null;
  baseBranch: string | null;
  updatedAt: Date | null;
  projectId: string;
  projectName: string;
  defaultBranch: string | null;
}
```

and in `collectProposals`, change the base line from `const base = r.defaultBranch ?? 'dev';` to:

```ts
      const base = r.baseBranch ?? r.defaultBranch ?? 'dev';
```

- [ ] **Step 4: Run it to verify it passes**

Run: `pnpm exec tsx --test src/lib/proposals.test.ts`
Expected: PASS.

- [ ] **Step 5: Select `base_branch` in `proposals-data.ts`**

In `src/lib/proposals-data.ts`, add `baseBranch: sessions.base_branch,` to the `.select({...})` object (after `worktreePath`). No other change — `collectProposals(rows, diffWorktree)` now receives it.

- [ ] **Step 6: Use the session base in run-turn**

In `src/lib/run-turn.ts`, change the `ensureWorktree` call from `project.default_branch ?? 'dev'` to use the session's base. The session row is already loaded as `session`; use:

```ts
      const wt = await ensureWorktree(sessionId, project.repo_path, session.base_branch ?? project.default_branch ?? 'dev');
```

- [ ] **Step 7: Use the session base in merge + discard routes**

In `src/app/api/proposals/[sessionId]/merge/route.ts`, change line 27 to:

```ts
    const result = await mergeWorktree(sessionId, project.repo_path, session.base_branch ?? project.default_branch ?? 'dev');
```

In `src/app/api/proposals/[sessionId]/discard/route.ts`, if it computes a base for any message/branch display, use the same `session.base_branch ?? project.default_branch ?? 'dev'`; `discardWorktree(sessionId, repo_path)` itself takes no base, so the only change there is if a base string is referenced — match the merge route's expression where one is.

- [ ] **Step 8: Use the session base in the Discord button handler**

In `src/lib/discord-bot.ts` `handleButton`, change `const base = project.default_branch ?? 'dev';` (≈line 155) to:

```ts
      const base = session.base_branch ?? project.default_branch ?? 'dev';
```

- [ ] **Step 9: Typecheck, full suite, commit**

```bash
pnpm exec tsc --noEmit
pnpm test
git add src/lib/run-turn.ts src/lib/proposals.ts src/lib/proposals.test.ts src/lib/proposals-data.ts src/app/api/proposals src/lib/discord-bot.ts
git commit -m "feat(sessions): use per-session base_branch for worktree fork, diff, and merge"
```
Expected: tsc clean; suite green.

---

### Task 5: Branches API

**Files:**
- Modify: `src/lib/worktree.ts` (add effectful `listBranches`)
- Create: `src/app/api/projects/[id]/branches/route.ts`

**Interfaces (consumed):** `parseGitBranches` (Task 2). **Produced:** `listBranches(repoPath, defaultBranch): Promise<string[]>`; `GET /api/projects/[id]/branches`.

- [ ] **Step 1: Add `listBranches` to worktree.ts**

Append to `src/lib/worktree.ts` (it already imports `exec`/`existsSync`/`path`; add the `parseGitBranches` import at the top: `import { parseGitBranches } from './sessions';`):

```ts
/**
 * List the repo's branches (local + remote-tracking, de-duped, default first) for
 * the session base-branch picker. Best-effort: returns just [defaultBranch] when the
 * repo is missing/not a git repo, so the UI always has at least the default.
 */
export async function listBranches(repoPath: string, defaultBranch: string): Promise<string[]> {
  try {
    if (!repoPath || !existsSync(repoPath)) return [defaultBranch];
    const { stdout } = await exec('git', ['-C', repoPath, 'branch', '-a', '--format=%(refname:short)']);
    return parseGitBranches(stdout, defaultBranch);
  } catch {
    return [defaultBranch];
  }
}
```

- [ ] **Step 2: Create the route**

Create `src/app/api/projects/[id]/branches/route.ts`:

```ts
import { cookies } from 'next/headers';
import { eq } from 'drizzle-orm';
import { db } from '@/db/client';
import { projects } from '@/db/schema';
import { SESSION_COOKIE, verifySession } from '@/lib/auth';
import { listBranches } from '@/lib/worktree';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  const jar = await cookies();
  const token = jar.get(SESSION_COOKIE)?.value;
  if (!token || !(await verifySession(token))) {
    return Response.json({ error: 'Unauthorized' }, { status: 401 });
  }
  const { id } = await ctx.params;
  const project = await db.select().from(projects).where(eq(projects.id, id)).limit(1).then((r) => r[0]);
  if (!project) return Response.json({ error: 'Project not found' }, { status: 404 });
  const def = project.default_branch ?? 'dev';
  const branches = await listBranches(project.repo_path, def);
  return Response.json({ branches, default: def });
}
```

- [ ] **Step 3: Typecheck + commit**

```bash
pnpm exec tsc --noEmit
git add src/lib/worktree.ts "src/app/api/projects/[id]/branches/route.ts"
git commit -m "feat(api): GET /api/projects/[id]/branches for the base-branch picker"
```
Expected: tsc clean. (Manual check after deploy: the endpoint returns the repo's branches.)

---

### Task 6: Sessions API (list, create, activate)

**Files:**
- Create: `src/app/api/sessions/route.ts` (GET list + POST create)
- Modify: `src/app/api/sessions/[id]/active/route.ts` (set `active_session_id`)

**Interfaces (consumed):** `sessionTitleOrDefault`, `validateNewSessionInput` (Task 2); `listBranches` (Task 5).

- [ ] **Step 1: Create list + create route**

Create `src/app/api/sessions/route.ts`:

```ts
import { cookies } from 'next/headers';
import { eq, desc } from 'drizzle-orm';
import { randomBytes, bytesToHex } from '@noble/hashes/utils.js';
import { db } from '@/db/client';
import { sessions, projects } from '@/db/schema';
import { SESSION_COOKIE, verifySession } from '@/lib/auth';
import { sessionTitleOrDefault, validateNewSessionInput } from '@/lib/sessions';
import { listBranches } from '@/lib/worktree';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(req: Request) {
  const jar = await cookies();
  const token = jar.get(SESSION_COOKIE)?.value;
  if (!token || !(await verifySession(token))) return Response.json({ error: 'Unauthorized' }, { status: 401 });

  const projectId = new URL(req.url).searchParams.get('projectId');
  if (!projectId) return Response.json({ error: 'projectId required' }, { status: 400 });

  const project = await db.select().from(projects).where(eq(projects.id, projectId)).limit(1).then((r) => r[0]);
  if (!project) return Response.json({ error: 'Project not found' }, { status: 404 });

  const rows = await db
    .select()
    .from(sessions)
    .where(eq(sessions.project_id, projectId))
    .orderBy(desc(sessions.updated_at));

  return Response.json({
    sessions: rows.map((s) => ({
      id: s.id,
      title: sessionTitleOrDefault(s.title),
      baseBranch: s.base_branch ?? project.default_branch ?? 'dev',
      hasChanges: s.worktree_path != null,
      isActive: project.active_session_id === s.id,
      updatedAt: (s.updated_at ?? new Date()).toISOString(),
    })),
  });
}

export async function POST(req: Request) {
  const jar = await cookies();
  const token = jar.get(SESSION_COOKIE)?.value;
  if (!token || !(await verifySession(token))) return Response.json({ error: 'Unauthorized' }, { status: 401 });

  const body = (await req.json().catch(() => ({}))) as { projectId?: string; title?: string; baseBranch?: string };
  if (!body.projectId) return Response.json({ error: 'projectId required' }, { status: 400 });

  const project = await db.select().from(projects).where(eq(projects.id, body.projectId)).limit(1).then((r) => r[0]);
  if (!project) return Response.json({ error: 'Project not found' }, { status: 404 });

  const def = project.default_branch ?? 'dev';
  const allowed = await listBranches(project.repo_path, def);
  const v = validateNewSessionInput({ title: body.title, baseBranch: body.baseBranch }, allowed);
  if (!v.ok) return Response.json({ error: v.error }, { status: 400 });

  const id = `sess_${bytesToHex(randomBytes(4))}`;
  const now = new Date();
  await db.insert(sessions).values({
    id,
    project_id: project.id,
    title: sessionTitleOrDefault(body.title),
    branch: `mc/${id}`,
    base_branch: body.baseBranch ?? def,
    worktree_path: null,
    status: 'active',
    cleared_at: null,
    created_at: now,
    updated_at: now,
  });
  await db.update(projects).set({ active_session_id: id }).where(eq(projects.id, project.id));
  return Response.json({ id });
}
```

- [ ] **Step 2: Repurpose the activate route to set `active_session_id`**

Rewrite `src/app/api/sessions/[id]/active/route.ts` so the `POST` body becomes (keep the auth guard + imports; add `projects` import):

```ts
  const { id: sessionId } = await ctx.params;
  const session = await db.select().from(sessions).where(eq(sessions.id, sessionId)).limit(1).then((r) => r[0]);
  if (!session) return Response.json({ error: 'Session not found' }, { status: 404 });

  await db.update(projects).set({ active_session_id: sessionId }).where(eq(projects.id, session.project_id));
  jar.set(ACTIVE_PROJECT_COOKIE, session.project_id, cookieOptions());

  return Response.json({ ok: true, sessionId, projectId: session.project_id });
```

(Drop the `updated_at` bump — the active session is now explicit. Add `projects` to the `@/db/schema` import.)

- [ ] **Step 3: Typecheck + suite + commit**

```bash
pnpm exec tsc --noEmit
pnpm test
git add src/app/api/sessions/route.ts "src/app/api/sessions/[id]/active/route.ts"
git commit -m "feat(api): list/create sessions + set active session explicitly"
```
Expected: tsc clean; suite green.

---

### Task 7: UI — SessionSwitcher, create dialog, breadcrumb

**Files:**
- Create: `src/components/session-switcher.tsx`
- Create: `src/components/new-session-dialog.tsx`
- Modify: `src/app/page.tsx` (load sessions + pass props)
- Modify: `src/components/mission-control.tsx` (render SessionSwitcher + breadcrumb)

**Interfaces (consumed):** `GET/POST /api/sessions`, `POST /api/sessions/[id]/active`, `GET /api/projects/[id]/branches`.

- [ ] **Step 1: Create `new-session-dialog.tsx`**

Create `src/components/new-session-dialog.tsx`:

```tsx
"use client";

import { useState, useEffect } from "react";
import { useRouter } from "next/navigation";
import { X } from "lucide-react";

export default function NewSessionDialog({
  open,
  projectId,
  onClose,
}: {
  open: boolean;
  projectId: string;
  onClose: () => void;
}) {
  const router = useRouter();
  const [title, setTitle] = useState("");
  const [branches, setBranches] = useState<string[]>([]);
  const [base, setBase] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  useEffect(() => {
    if (!open) return;
    setTitle(""); setError(null);
    fetch(`/api/projects/${encodeURIComponent(projectId)}/branches`)
      .then((r) => r.json())
      .then((d) => { setBranches(d.branches ?? []); setBase(d.default ?? (d.branches?.[0] ?? "dev")); })
      .catch(() => { setBranches([]); setBase("dev"); });
  }, [open, projectId]);

  if (!open) return null;

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setPending(true);
    try {
      const res = await fetch("/api/sessions", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ projectId, title, baseBranch: base }),
      });
      if (!res.ok) {
        const b = await res.json().catch(() => ({}));
        setError(b.error ?? `Failed (${res.status})`);
        setPending(false);
        return;
      }
      const { id } = await res.json();
      await fetch(`/api/sessions/${encodeURIComponent(id)}/active`, { method: "POST" });
      onClose();
      router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Network error");
      setPending(false);
    }
  }

  const inputCls =
    "w-full bg-[#060810] border border-[#2a3441] focus:border-[#00e0ff] rounded-md px-3 py-2 text-xs text-[#e6edf3] placeholder-[#5c6470] focus:outline-none transition-colors mb-3";
  const labelCls = "block text-[10px] font-mono text-[#5c6470] tracking-wider uppercase mb-1";

  return (
    <div className="fixed inset-0 z-[100] flex items-center justify-center bg-black/60" onMouseDown={onClose}>
      <form onMouseDown={(e) => e.stopPropagation()} onSubmit={submit}
        className="w-[420px] bg-[#11161d] border border-[#1e2632] rounded-lg p-6 shadow-lg shadow-black/40">
        <div className="flex items-center justify-between mb-4">
          <h2 className="text-sm font-semibold text-[#e6edf3] font-heading">New session</h2>
          <button type="button" onClick={onClose} className="text-[#5c6470] hover:text-[#e6edf3]"><X className="w-4 h-4" /></button>
        </div>

        <label className={labelCls}>Title (optional)</label>
        <input className={inputCls} value={title} onChange={(e) => setTitle(e.target.value)} placeholder="New session" />

        <label className={labelCls}>Base branch</label>
        <select className={inputCls} value={base} onChange={(e) => setBase(e.target.value)}>
          {branches.map((b) => <option key={b} value={b}>{b}</option>)}
        </select>

        {error && (
          <div className="mb-3 px-3 py-2 rounded text-[11px] font-mono bg-red-500/10 border border-red-500/40 text-red-400">{error}</div>
        )}

        <button type="submit" disabled={pending}
          className="w-full bg-[#00e0ff] hover:bg-[#00c0dd] disabled:opacity-50 text-black font-bold py-2 rounded-md text-xs transition-colors">
          {pending ? "Creating…" : "Create session"}
        </button>
      </form>
    </div>
  );
}
```

- [ ] **Step 2: Create `session-switcher.tsx`**

Create `src/components/session-switcher.tsx`:

```tsx
"use client";

import { useState, useRef, useEffect } from "react";
import { useRouter } from "next/navigation";
import { ChevronDown, Check, Plus } from "lucide-react";

export type SessionOption = { id: string; title: string; baseBranch: string; hasChanges: boolean; isActive: boolean };

export default function SessionSwitcher({
  sessions,
  activeSessionId,
  onNewSession,
}: {
  sessions: SessionOption[];
  activeSessionId: string;
  onNewSession: () => void;
}) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const ref = useRef<HTMLDivElement>(null);
  const active = sessions.find((s) => s.id === activeSessionId);

  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => { if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false); };
    document.addEventListener("mousedown", onDoc);
    return () => document.removeEventListener("mousedown", onDoc);
  }, [open]);

  async function switchTo(id: string) {
    if (id === activeSessionId) { setOpen(false); return; }
    setBusy(id);
    try {
      await fetch(`/api/sessions/${encodeURIComponent(id)}/active`, { method: "POST" });
      setOpen(false);
      router.refresh();
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="relative hidden sm:block" ref={ref}>
      <button onClick={() => setOpen((o) => !o)}
        className="flex items-center gap-2 px-2.5 py-1 bg-[#161c25] border border-[#1e2632] rounded-md cursor-pointer hover:bg-[#1c2330] transition-colors">
        <span className="text-[9px] font-mono text-[#5c6470] uppercase tracking-wider">SESSION</span>
        <span className="text-xs font-semibold text-[#e6edf3] max-w-[160px] truncate">{active?.title ?? "—"}</span>
        {active && <span className="text-[9px] font-mono text-[#5c6470]">{active.baseBranch}</span>}
        <ChevronDown className="w-3.5 h-3.5 text-[#5c6470]" />
      </button>

      {open && (
        <div className="absolute left-0 top-full mt-1 z-50 min-w-[260px] bg-[#11161d] border border-[#2a3441] rounded-md shadow-lg shadow-black/40 py-1">
          {sessions.map((s) => (
            <button key={s.id} onClick={() => switchTo(s.id)} disabled={busy !== null}
              className="w-full flex items-center gap-2 px-3 py-1.5 text-xs text-[#e6edf3] text-left hover:bg-[#1c2330] transition-colors disabled:opacity-50">
              <span className="w-3.5 shrink-0">{s.id === activeSessionId && <Check className="w-3.5 h-3.5 text-[#00e0ff]" />}</span>
              <span className="flex-1 min-w-0 truncate">{s.title}</span>
              {s.hasChanges && <span title="has changes" className="w-1.5 h-1.5 rounded-full bg-[#f59e0b] shrink-0" />}
              <span className="text-[9px] font-mono text-[#5c6470] shrink-0">{s.baseBranch}</span>
            </button>
          ))}
          <div className="my-1 h-px bg-[#1e2632]" />
          <button onClick={() => { setOpen(false); onNewSession(); }}
            className="w-full flex items-center gap-2 px-3 py-1.5 text-xs text-[#00e0ff] hover:bg-[#1c2330] transition-colors text-left">
            <Plus className="w-3.5 h-3.5" /> New session
          </button>
        </div>
      )}
    </div>
  );
}
```

- [ ] **Step 3: Load sessions in `page.tsx` and pass them down**

In `src/app/page.tsx`, after `const currentSessionRow = await getOrCreateActiveSession(project.id);`, add a query for the project's sessions:

```ts
  const sessionRows = await db
    .select()
    .from(sessions)
    .where(eq(sessions.project_id, project.id))
    .orderBy(desc(sessions.updated_at));
```

(`eq`, `desc` are already imported in page.tsx; `sessions` is already imported.) Then extend the `<MissionControl ... />` props (near `activeProjectId={project.id}`) with:

```tsx
      sessions={sessionRows.map((s) => ({
        id: s.id,
        title: (s.title ?? "").trim() || "New session",
        baseBranch: s.base_branch ?? project.default_branch ?? "dev",
        hasChanges: s.worktree_path != null,
        isActive: s.id === currentSessionRow.id,
      }))}
      activeSessionId={currentSessionRow.id}
```

- [ ] **Step 4: Render the switcher + breadcrumb in `mission-control.tsx`**

In `src/components/mission-control.tsx`:

1. Add imports near the other component imports (line ~33):

```tsx
import SessionSwitcher, { type SessionOption } from "@/components/session-switcher";
import NewSessionDialog from "@/components/new-session-dialog";
```

2. Add to the props type (near `activeProjectId: string;`, line ~63):

```tsx
  sessions: SessionOption[];
  activeSessionId: string;
```

3. Destructure them in the component signature (near `activeProjectId,`, line ~259): add `sessions, activeSessionId,`.

4. Add dialog state near the other `useState` hooks (e.g. beside `addProjectOpen`):

```tsx
  const [newSessionOpen, setNewSessionOpen] = useState(false);
```

5. Beside `<ProjectSwitcher ... />` (line ~861) add the session switcher and a breadcrumb separator:

```tsx
          <SessionSwitcher
            sessions={sessions}
            activeSessionId={activeSessionId}
            onNewSession={() => setNewSessionOpen(true)}
          />
```

6. Beside `<AddProjectDialog ... />` (line ~1591) add:

```tsx
      <NewSessionDialog open={newSessionOpen} projectId={activeProjectId} onClose={() => setNewSessionOpen(false)} />
```

The breadcrumb (Project ▸ Session ▸ branch) is satisfied by `ProjectSwitcher` + `SessionSwitcher` sitting next to each other (each shows its label and the switcher shows the base branch). No extra element required.

- [ ] **Step 5: Typecheck + build + commit**

```bash
pnpm exec tsc --noEmit
pnpm build
git add src/components/session-switcher.tsx src/components/new-session-dialog.tsx src/app/page.tsx src/components/mission-control.tsx
git commit -m "feat(ui): session switcher + new-session dialog + active session/branch in the header"
```
Expected: tsc clean; build succeeds. (Runtime check after deploy below.)

---

## Self-Review

**Spec coverage:**
- Sessions create/list/switch → Tasks 6 (API) + 7 (UI). ✓
- Branch choice at create (fork from picked base) → Task 6 POST + Task 5 branches + Task 7 dialog; base stored in `sessions.base_branch` (Task 1). ✓
- Active-context visibility (Project ▸ Session ▸ branch) → Task 7 switcher beside ProjectSwitcher. ✓
- Project switching verify → covered by leaving `ProjectSwitcher` intact; runtime check below. ✓ (no code change needed unless broken)
- Explicit server-side active session (web + Discord + scheduler) → Task 1 column + Task 3 both resolvers + Task 6 activate route. ✓
- Per-session base threaded through worktree/proposal/merge/discord → Task 4. ✓
- Lazy worktree creation unchanged → no eager-create added. ✓
- Testing: pure helpers unit-tested (Task 2, Task 4 base test); effectful via tsc+suite+runtime. ✓

**Runtime verification (after deploy):** create a session on `main` → switch to it (header shows it + `main`) → send it a turn → the proposal diffs/merges against `main`; Discord chat for the project continues the same session; the existing project switcher still switches projects.

**Placeholder scan:** No TBD/TODO; every code step has complete code or an exact, unambiguous edit against a named file/line. The only line-number references (`mission-control.tsx` ~33/63/259/861/1591) are anchors in a 1500-line existing file, each paired with the exact code to insert.

**Type consistency:** `SessionOption` (switcher) matches the `sessions={...}` mapping in page.tsx (id/title/baseBranch/hasChanges/isActive) — note the switcher only reads id/title/baseBranch/hasChanges/isActive. `ProposalRow.baseBranch` added in Task 4 matches the `proposals-data.ts` select and the test `row()` helper. `resolveActiveSession`'s return (`{kind:'use',id}|{kind:'create'}`) is consumed identically in both resolvers (Task 3). Effective-base expression `session.base_branch ?? project.default_branch ?? 'dev'` is identical across run-turn, merge, discord (Task 4).
