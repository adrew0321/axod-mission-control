# Proposals view Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a **Proposals** nav view — a fleet-wide inbox of sessions whose agent left changes, with Approve→merge (into the base branch) / Discard actions.

**Architecture:** A pure `summarizeDiff` + `Proposal` type live in `proposals.ts` (testable); a server-only `getProposals()` in `proposals-data.ts` runs the existing `diffWorktree` over every session that has a worktree. Two new git helpers in `worktree.ts` (`mergeWorktree`, `discardWorktree`) do the apply/throw-away. Routes expose the inbox + actions; a `proposals-view.tsx` renders as the fourth live nav view.

**Tech Stack:** Next.js 16 route handlers, Drizzle + SQLite, `execFile` git (argv arrays — apostrophe-safe), React client component, node:test via tsx.

**Spec:** `docs/superpowers/specs/2026-06-08-proposals-design.md`

---

## File Structure

- **Create** `src/lib/proposals.ts` — pure: `Proposal` type + `summarizeDiff(diff)`. No db/server-only (testable).
- **Create** `src/lib/proposals.test.ts` — unit tests for `summarizeDiff`.
- **Modify** `src/lib/worktree.ts` — add `mergeWorktree` + `discardWorktree` (+ `MergeResult` type).
- **Create** `src/lib/proposals-data.ts` — `server-only`: `getProposals()`.
- **Create** `src/app/api/proposals/route.ts` — `GET` inbox.
- **Create** `src/app/api/proposals/[sessionId]/merge/route.ts` — `POST` merge.
- **Create** `src/app/api/proposals/[sessionId]/discard/route.ts` — `POST` discard.
- **Modify** `src/lib/nav-sections.ts` — flip `proposals` to `live`.
- **Modify** `src/lib/nav-sections.test.ts` — add `proposals` to the live set.
- **Modify** `src/app/page.tsx` — load + pass `initialProposals`.
- **Modify** `src/components/mission-control.tsx` — prop, state+refresh, `proposals` view branch.
- **Create** `src/components/proposals-view.tsx` — the inbox UI.

---

## Task 1: Pure `summarizeDiff` + `Proposal` type (TDD)

**Files:** Create `src/lib/proposals.ts`, `src/lib/proposals.test.ts`

- [ ] **Step 1: Write the failing tests** — create `src/lib/proposals.test.ts`:

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { summarizeDiff } from './proposals';

test('counts added and removed content lines', () => {
  const diff = [
    'diff --git a/x.ts b/x.ts',
    '--- a/x.ts',
    '+++ b/x.ts',
    '@@ -1,2 +1,3 @@',
    ' unchanged',
    '-old line',
    '+new line one',
    '+new line two',
  ].join('\n');
  assert.deepEqual(summarizeDiff(diff), { additions: 2, deletions: 1 });
});

test('ignores +++/--- file headers', () => {
  const diff = '--- a/f\n+++ b/f\n+only real addition';
  assert.deepEqual(summarizeDiff(diff), { additions: 1, deletions: 0 });
});

test('empty diff is zero/zero', () => {
  assert.deepEqual(summarizeDiff(''), { additions: 0, deletions: 0 });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm test`
Expected: FAIL — cannot find module `./proposals`.

- [ ] **Step 3: Implement** — create `src/lib/proposals.ts`:

```ts
// Pure proposal logic — no db, no server-only, so the tsx test runner can import it.

export interface Proposal {
  sessionId: string;
  sessionTitle: string;
  projectId: string;
  projectName: string;
  branch: string;        // mc/<sessionId>
  baseBranch: string;    // project default branch
  files: Array<{ status: string; path: string }>;
  additions: number;
  deletions: number;
  ts: string;            // session.updated_at, ISO
}

/**
 * Count added/removed CONTENT lines in a unified diff. Lines starting with a
 * single '+'/'-' are changes; the '+++'/'---' file headers are skipped.
 */
export function summarizeDiff(diff: string): { additions: number; deletions: number } {
  let additions = 0;
  let deletions = 0;
  for (const line of diff.split('\n')) {
    if (line.startsWith('+') && !line.startsWith('+++')) additions++;
    else if (line.startsWith('-') && !line.startsWith('---')) deletions++;
  }
  return { additions, deletions };
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `pnpm test`
Expected: PASS (overall count rises by 3 from the 84 baseline).

- [ ] **Step 5: Commit**

```bash
git add src/lib/proposals.ts src/lib/proposals.test.ts
git commit -m "feat(proposals): pure summarizeDiff + Proposal type with tests"
```

---

## Task 2: Git helpers `mergeWorktree` + `discardWorktree`

**Files:** Modify `src/lib/worktree.ts`

These join the existing helpers (`exec = promisify(execFile)`, `sessionBranch`, `sessionWorktreePath`, `removeWorktree` are already defined in this file). Add at the end of the file.

- [ ] **Step 1: Add the merge result type + functions** — append to `src/lib/worktree.ts`:

```ts
export type MergeResult = { ok: true } | { ok: false; conflict: true; message: string };

/**
 * Apply a session's work to the project's base branch. Commits any loose edits on
 * mc/<sessionId>, then merges that branch into baseBranch in the project repo.
 * On a merge conflict: aborts (no partial state) and returns { conflict }.
 * On success: removes the worktree + deletes the branch, returns { ok:true }.
 * A non-merge failure (e.g. dirty base) throws — the caller maps it to a 500.
 */
export async function mergeWorktree(
  sessionId: string,
  repoPath: string,
  baseBranch: string,
): Promise<MergeResult> {
  const wtPath = sessionWorktreePath(sessionId);
  const branch = sessionBranch(sessionId);

  // 1. Commit any uncommitted edits in the worktree so the branch carries them.
  const { stdout: status } = await exec('git', ['-C', wtPath, 'status', '--porcelain']);
  if (status.trim()) {
    await exec('git', ['-C', wtPath, 'add', '-A']);
    await exec('git', ['-C', wtPath, 'commit', '-m', `mission-control: ${branch}`]);
  }

  // 2. Merge the branch into the base in the project repo.
  await exec('git', ['-C', repoPath, 'checkout', baseBranch]);
  try {
    await exec('git', ['-C', repoPath, 'merge', '--no-ff', '-m', `Merge ${branch}`, branch]);
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    await exec('git', ['-C', repoPath, 'merge', '--abort']).catch(() => {});
    return { ok: false, conflict: true, message };
  }

  // 3. Cleanup: remove the worktree (detaches the branch) then delete the branch.
  await removeWorktree(sessionId, repoPath);
  await exec('git', ['-C', repoPath, 'branch', '-D', branch]).catch(() => {});
  return { ok: true };
}

/** Throw away a session's work: remove the worktree and delete the branch. */
export async function discardWorktree(sessionId: string, repoPath: string): Promise<void> {
  await removeWorktree(sessionId, repoPath);
  await exec('git', ['-C', repoPath, 'branch', '-D', sessionBranch(sessionId)]).catch(() => {});
}
```

- [ ] **Step 2: Verify it typechecks**

Run: `pnpm build`
Expected: build completes (functions unused so far — fine).

- [ ] **Step 3: Commit**

```bash
git add src/lib/worktree.ts
git commit -m "feat(proposals): mergeWorktree + discardWorktree git helpers"
```

---

## Task 3: `getProposals` server query

**Files:** Create `src/lib/proposals-data.ts`

- [ ] **Step 1: Implement** — create `src/lib/proposals-data.ts`:

```ts
import 'server-only';
import { eq, isNotNull } from 'drizzle-orm';
import { db } from '@/db/client';
import { sessions, projects } from '@/db/schema';
import { diffWorktree } from './worktree';
import { summarizeDiff, type Proposal } from './proposals';

/** Fleet-wide inbox: every session whose worktree differs from its base branch. */
export async function getProposals(): Promise<Proposal[]> {
  const rows = await db
    .select({
      sessionId: sessions.id,
      sessionTitle: sessions.title,
      worktreePath: sessions.worktree_path,
      updatedAt: sessions.updated_at,
      projectId: projects.id,
      projectName: projects.name,
      defaultBranch: projects.default_branch,
    })
    .from(sessions)
    .innerJoin(projects, eq(sessions.project_id, projects.id))
    .where(isNotNull(sessions.worktree_path));

  const proposals: Proposal[] = [];
  for (const r of rows) {
    if (!r.worktreePath) continue;
    const base = r.defaultBranch ?? 'dev';
    const { diff, files } = await diffWorktree(r.worktreePath, base);
    if (files.length === 0) continue;
    const { additions, deletions } = summarizeDiff(diff);
    proposals.push({
      sessionId: r.sessionId,
      sessionTitle: r.sessionTitle ?? '(untitled session)',
      projectId: r.projectId,
      projectName: r.projectName,
      branch: `mc/${r.sessionId}`,
      baseBranch: base,
      files,
      additions,
      deletions,
      ts: (r.updatedAt ?? new Date()).toISOString(),
    });
  }
  return proposals.sort((a, b) => (a.ts < b.ts ? 1 : a.ts > b.ts ? -1 : 0));
}
```

- [ ] **Step 2: Verify it typechecks**

Run: `pnpm build`
Expected: build completes.

- [ ] **Step 3: Commit**

```bash
git add src/lib/proposals-data.ts
git commit -m "feat(proposals): getProposals server query"
```

---

## Task 4: API routes (inbox + merge + discard)

**Files:** Create `src/app/api/proposals/route.ts`, `src/app/api/proposals/[sessionId]/merge/route.ts`, `src/app/api/proposals/[sessionId]/discard/route.ts`

- [ ] **Step 1: Inbox route** — create `src/app/api/proposals/route.ts`:

```ts
import { cookies } from 'next/headers';
import { SESSION_COOKIE, verifySession } from '@/lib/auth';
import { getProposals } from '@/lib/proposals-data';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET() {
  const jar = await cookies();
  const token = jar.get(SESSION_COOKIE)?.value;
  if (!token || !(await verifySession(token))) {
    return Response.json({ error: 'Unauthorized' }, { status: 401 });
  }
  return Response.json(await getProposals());
}
```

- [ ] **Step 2: Merge route** — create `src/app/api/proposals/[sessionId]/merge/route.ts`:

```ts
import { cookies } from 'next/headers';
import { eq } from 'drizzle-orm';
import { db } from '@/db/client';
import { sessions, projects } from '@/db/schema';
import { SESSION_COOKIE, verifySession } from '@/lib/auth';
import { mergeWorktree } from '@/lib/worktree';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(_req: Request, ctx: { params: Promise<{ sessionId: string }> }) {
  const jar = await cookies();
  const token = jar.get(SESSION_COOKIE)?.value;
  if (!token || !(await verifySession(token))) {
    return Response.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const { sessionId } = await ctx.params;
  const session = await db.select().from(sessions).where(eq(sessions.id, sessionId)).limit(1).then((r) => r[0]);
  if (!session || !session.worktree_path) {
    return Response.json({ error: 'No proposal for this session' }, { status: 404 });
  }
  const project = await db.select().from(projects).where(eq(projects.id, session.project_id)).limit(1).then((r) => r[0]);
  if (!project) return Response.json({ error: 'Project not found' }, { status: 404 });

  try {
    const result = await mergeWorktree(sessionId, project.repo_path, project.default_branch ?? 'dev');
    if (!result.ok) return Response.json(result, { status: 200 }); // { ok:false, conflict, message }
    // The worktree is gone — clear the pointer so it no longer shows as a proposal.
    await db.update(sessions).set({ worktree_path: null }).where(eq(sessions.id, sessionId));
    return Response.json({ ok: true });
  } catch (e) {
    return Response.json(
      { error: `Merge failed: ${e instanceof Error ? e.message : String(e)}` },
      { status: 500 },
    );
  }
}
```

- [ ] **Step 3: Discard route** — create `src/app/api/proposals/[sessionId]/discard/route.ts`:

```ts
import { cookies } from 'next/headers';
import { eq } from 'drizzle-orm';
import { db } from '@/db/client';
import { sessions, projects } from '@/db/schema';
import { SESSION_COOKIE, verifySession } from '@/lib/auth';
import { discardWorktree } from '@/lib/worktree';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(_req: Request, ctx: { params: Promise<{ sessionId: string }> }) {
  const jar = await cookies();
  const token = jar.get(SESSION_COOKIE)?.value;
  if (!token || !(await verifySession(token))) {
    return Response.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const { sessionId } = await ctx.params;
  const session = await db.select().from(sessions).where(eq(sessions.id, sessionId)).limit(1).then((r) => r[0]);
  if (!session || !session.worktree_path) {
    return Response.json({ error: 'No proposal for this session' }, { status: 404 });
  }
  const project = await db.select().from(projects).where(eq(projects.id, session.project_id)).limit(1).then((r) => r[0]);
  if (!project) return Response.json({ error: 'Project not found' }, { status: 404 });

  try {
    await discardWorktree(sessionId, project.repo_path);
    await db.update(sessions).set({ worktree_path: null }).where(eq(sessions.id, sessionId));
    return Response.json({ ok: true });
  } catch (e) {
    return Response.json(
      { error: `Discard failed: ${e instanceof Error ? e.message : String(e)}` },
      { status: 500 },
    );
  }
}
```

- [ ] **Step 4: Verify build**

Run: `pnpm build`
Expected: routes compile; `ƒ /api/proposals` and the two `[sessionId]` routes appear in the route table.

- [ ] **Step 5: Commit**

```bash
git add src/app/api/proposals
git commit -m "feat(proposals): inbox + merge + discard routes"
```

---

## Task 5: Make the nav section live

**Files:** Modify `src/lib/nav-sections.ts`, `src/lib/nav-sections.test.ts`

- [ ] **Step 1: Flip the section** — in `src/lib/nav-sections.ts`, change the `proposals` line's status:

```ts
  { id: "proposals", label: "Proposals", icon: "Inbox", group: "operational", status: "live" },
```

- [ ] **Step 2: Update the live-set assertion** — in `src/lib/nav-sections.test.ts`, change the `deepEqual` in the second test to:

```ts
  assert.deepEqual(live, ['agent-team', 'live-feed', 'task-board', 'proposals']);
```

- [ ] **Step 3: Run tests**

Run: `pnpm test`
Expected: PASS (nav test green with the new live set).

- [ ] **Step 4: Commit**

```bash
git add src/lib/nav-sections.ts src/lib/nav-sections.test.ts
git commit -m "feat(proposals): make the Proposals nav section live"
```

---

## Task 6: Wire into page + mission-control

**Files:** Modify `src/app/page.tsx`, `src/components/mission-control.tsx`

- [ ] **Step 1: Load in the page** — in `src/app/page.tsx`, add the import next to `getTaskBoard`:

```ts
import { getProposals } from "@/lib/proposals-data";
```

After `const initialTaskBoard = await getTaskBoard(project.id);`, add:

```ts
  const initialProposals = await getProposals();
```

In the `<MissionControl ... />` props (after `initialTaskBoard={initialTaskBoard}`), add:

```tsx
      initialProposals={initialProposals}
```

- [ ] **Step 2: Add imports + prop to mission-control** — in `src/components/mission-control.tsx`, near the `TaskBoardView` import add:

```ts
import ProposalsView from "@/components/proposals-view";
import type { Proposal } from "@/lib/proposals";
```

In `MissionControlProps`, after `initialTaskBoard: BoardColumns;` add:

```ts
  initialProposals: Proposal[];
```

In the destructured params, after `initialTaskBoard,` add:

```ts
  initialProposals,
```

- [ ] **Step 3: Add state + refresh** — next to the `taskBoard` state/refresh block, add:

```ts
  const [proposals, setProposals] = useState<Proposal[]>(initialProposals);
  useEffect(() => {
    setProposals(initialProposals);
  }, [initialProposals]);

  const refreshProposals = async () => {
    const res = await fetch(`/api/proposals`);
    if (res.ok) setProposals((await res.json()) as Proposal[]);
  };
```

- [ ] **Step 4: Add the view branch** — in the `activeSection` switch, add a `proposals` branch in front of the `task-board` one so it reads:

```tsx
        {activeSection === "proposals" ? (
          <ProposalsView
            proposals={proposals}
            onSelectSession={handleSelectSession}
            onRefresh={refreshProposals}
          />
        ) : activeSection === "task-board" ? (
          <TaskBoardView
```

(Leave the existing `task-board`, `live-feed`, and Agent Team branches unchanged — only prepend the `proposals` ternary.)

- [ ] **Step 5: Build will fail until Task 7 creates the component — do not commit yet**

Run: `pnpm build`
Expected: FAIL — `Cannot find module '@/components/proposals-view'`. Proceed to Task 7.

---

## Task 7: The Proposals view component

**Files:** Create `src/components/proposals-view.tsx`

- [ ] **Step 1: Implement** — create `src/components/proposals-view.tsx`:

```tsx
"use client";

import { useState } from "react";
import { Loader2, GitMerge, Eye, Trash2, FileDiff } from "lucide-react";
import type { Proposal } from "@/lib/proposals";

interface ProposalsViewProps {
  proposals: Proposal[];
  onSelectSession: (sessionId: string) => Promise<void>;
  onRefresh: () => Promise<void>;
}

export default function ProposalsView({ proposals, onSelectSession, onRefresh }: ProposalsViewProps) {
  const [busyId, setBusyId] = useState<string | null>(null);
  const [confirmId, setConfirmId] = useState<string | null>(null);
  const [errorById, setErrorById] = useState<Record<string, string>>({});

  async function merge(sessionId: string) {
    setBusyId(sessionId);
    setErrorById((e) => ({ ...e, [sessionId]: "" }));
    try {
      const res = await fetch(`/api/proposals/${sessionId}/merge`, { method: "POST" });
      const data = (await res.json().catch(() => ({}))) as { ok?: boolean; conflict?: boolean; message?: string; error?: string };
      if (data.ok) {
        await onRefresh();
      } else {
        setErrorById((e) => ({
          ...e,
          [sessionId]: data.conflict ? "Merge conflict — resolve manually" : data.error ?? "Merge failed",
        }));
      }
    } finally {
      setBusyId(null);
    }
  }

  async function discard(sessionId: string) {
    setBusyId(sessionId);
    try {
      await fetch(`/api/proposals/${sessionId}/discard`, { method: "POST" });
      setConfirmId(null);
      await onRefresh();
    } finally {
      setBusyId(null);
    }
  }

  return (
    <section className="flex-1 flex flex-col min-w-0 bg-[#0a0e14]">
      <div className="h-11 shrink-0 bg-[#11161d] border-b border-[#1e2632] px-4 flex items-center gap-2 select-none">
        <span className="font-semibold text-xs text-[#e6edf3] font-heading">Proposals</span>
        <span className="text-[10px] font-mono text-[#5c6470]">changes awaiting your review</span>
        <span className="ml-auto text-[9px] font-mono text-[#5c6470] bg-[#161c25] border border-[#2a3441] rounded px-1.5">
          {proposals.length}
        </span>
      </div>

      <div className="flex-1 min-h-0 overflow-y-auto p-3 flex flex-col gap-2">
        {proposals.length === 0 && (
          <div className="text-[11px] font-mono text-[#3a424d] text-center py-10">No changes awaiting review.</div>
        )}

        {proposals.map((p) => {
          const busy = busyId === p.sessionId;
          const err = errorById[p.sessionId];
          return (
            <div key={p.sessionId} className="rounded-lg border border-[#1e2632] bg-[#11161d] p-3">
              <div className="flex items-start gap-2">
                <FileDiff className="w-4 h-4 text-[#00e0ff] shrink-0 mt-0.5" />
                <div className="flex-1 min-w-0">
                  <div className="text-xs text-[#e6edf3] font-heading truncate">{p.sessionTitle}</div>
                  <div className="mt-1 flex items-center gap-2 text-[9px] font-mono text-[#5c6470] flex-wrap">
                    <span className="bg-[#0f141b] border border-[#23371f] text-[#7ee787] rounded px-1.5">{p.projectName}</span>
                    <span className="text-[#3fb950]">+{p.additions}</span>
                    <span className="text-[#f85149]">−{p.deletions}</span>
                    <span>· {p.files.length} {p.files.length === 1 ? "file" : "files"}</span>
                    <span className="text-[#3a424d]">→ {p.baseBranch}</span>
                  </div>
                </div>
              </div>

              <div className="mt-2.5 flex items-center gap-2">
                <button
                  onClick={() => void onSelectSession(p.sessionId)}
                  className="flex items-center gap-1 text-[10px] font-mono px-2 py-1 rounded border border-[#2a3441] text-[#8b949e] hover:text-[#e6edf3] hover:border-[#3a424d]"
                >
                  <Eye className="w-3 h-3" /> View diff
                </button>
                <button
                  onClick={() => void merge(p.sessionId)}
                  disabled={busy}
                  className="flex items-center gap-1 text-[10px] font-mono px-2 py-1 rounded bg-[#00e0ff] text-black font-bold disabled:opacity-40"
                >
                  {busy ? <Loader2 className="w-3 h-3 animate-spin" /> : <GitMerge className="w-3 h-3" />} Approve → merge
                </button>
                {confirmId === p.sessionId ? (
                  <span className="flex items-center gap-1 text-[10px] font-mono text-[#f0a020]">
                    Discard {p.files.length} {p.files.length === 1 ? "file" : "files"}?
                    <button onClick={() => void discard(p.sessionId)} disabled={busy} className="px-1.5 py-0.5 rounded bg-[#f85149] text-black font-bold">Yes</button>
                    <button onClick={() => setConfirmId(null)} className="px-1.5 py-0.5 rounded text-[#8b949e]">No</button>
                  </span>
                ) : (
                  <button
                    onClick={() => setConfirmId(p.sessionId)}
                    disabled={busy}
                    className="flex items-center gap-1 text-[10px] font-mono px-2 py-1 rounded border border-[#2a3441] text-[#8b949e] hover:text-[#f85149] hover:border-[#f85149]/40 ml-auto"
                  >
                    <Trash2 className="w-3 h-3" /> Discard
                  </button>
                )}
              </div>

              {err && <div className="mt-2 text-[10px] font-mono text-[#f85149]">{err}</div>}
            </div>
          );
        })}
      </div>
    </section>
  );
}
```

- [ ] **Step 2: Build + test**

Run: `pnpm build && pnpm test`
Expected: build clean; `pnpm test` green (87 — the 84 baseline + 3 `summarizeDiff` tests).

- [ ] **Step 3: Commit (Tasks 6 + 7 together — they compile as a unit)**

```bash
git add src/app/page.tsx src/components/mission-control.tsx src/components/proposals-view.tsx
git commit -m "feat(proposals): Proposals view wired into the nav rail"
```

---

## Task 8: Manual smoke + gate

**Files:** none (verification only)

- [ ] **Step 1: Start the dev server**

Run: `pnpm dev` (background) → open http://localhost:3000.

- [ ] **Step 2: Create a proposal to review**

In the Agent Team view, dispatch a task (or `@forge`/`@atlas`) that edits a file (e.g. "add a comment to README"). Let it finish so the session worktree has a change.

- [ ] **Step 3: Walk the inbox**

1. Click **Proposals** in the nav rail → the session appears as a card with `+N −M · k files → dev`.
2. **View diff** → opens that session (review in the Code Diff tab).
3. **Approve → merge** → card disappears; confirm the project's base branch now has the change (`git -C <repo> log --oneline -1 dev`).
4. Create another change; **Discard** → confirm → **Yes** → card disappears and the branch/worktree are gone.
5. Empty inbox shows "No changes awaiting review."

- [ ] **Step 4: Final gate**

Run: `pnpm build && pnpm test`
Expected: build clean; tests green.

---

## Self-Review notes (for the executor)

- **Spec coverage:** proposal definition + query (Tasks 1/3) · merge/discard git (Task 2) · routes incl. conflict-as-200 + worktree_path clearing (Task 4) · nav live + test (Task 5) · page/mission-control wiring (Task 6) · view with View diff / Approve→merge / confirm-Discard / conflict message / empty state (Task 7) · errors + manual smoke (Tasks 4/8). Pure `summarizeDiff` unit-tested (Task 1); git/routes integration per the repo convention.
- **Out of scope (do NOT build):** push-for-PR, per-file merge, in-app conflict resolution, the dormant approvals gate.
- **Type consistency:** `Proposal`, `summarizeDiff`, `MergeResult`, `mergeWorktree`, `discardWorktree`, `getProposals` are used identically across tasks. Routes clear `sessions.worktree_path` after merge/discard so a card never reappears.
