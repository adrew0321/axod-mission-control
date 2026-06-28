# v1.9.1 — Commit hardening + proposal summaries + leaner orchestration + session archiving (Implementation Plan)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make agent merges robust (identity + no node_modules), give proposals a real "what changed" summary, stop Sage from re-stating dispatched reports, stop scheduled jobs from leaving proposals, and let the operator archive sessions out of the switcher.

**Architecture:** Five mostly-independent changes. Pure helpers (`summarizeForProposal`, `FRAMING_HEADER`) are unit-tested; `worktree.ts` is real-git-tested; routes/queries/scheduler/UI are `server-only`/client → `tsc` + suite + runtime.

**Tech Stack:** TypeScript, Next.js 16, Drizzle + better-sqlite3 (drizzle-kit migrations), discord.js, React, `node:test` via `tsx`, git CLI.

## Global Constraints

- Tests: `node:test` + `node:assert/strict` via `pnpm test` (`tsx --test src/lib/*.test.ts`); extensionless local imports.
- Pure modules (`proposals.ts`, `conversation.ts`, `worktree.ts`) are unit-tested. `server-only` modules (routes, `proposals-data.ts`, `scheduler.ts`, `active-project.ts`, `discord-session.ts`) and React components are NOT unit-tested — `tsc --noEmit` + suite + runtime.
- Agent reply messages persist with `role: 'agent'`.
- Migrations: `pnpm db:generate` (drizzle-kit) into `./drizzle`, applied with `pnpm db:migrate`. Never hand-write migration SQL. Next migration is `0009`.
- Git commit identity for MC commits: `Mission Control <mc@axodcreative.com>`, passed inline via `-c`.
- No new npm dependencies.
- Work in an isolated git worktree off `dev`.

---

### Task 1: Commit hardening (identity + never commit node_modules)

**Files:**
- Modify: `src/lib/worktree.ts` (`mergeWorktree`, ≈lines 324-329)
- Modify: `src/lib/worktree.test.ts`

- [ ] **Step 1: Write the failing tests**

Append to `src/lib/worktree.test.ts` (it already has `makeRepo`/`freshWorktreeRoot`/`cleanup` helpers and imports `ensureWorktree`, `removeWorktree`, `isWorktreeValid`; add `mergeWorktree` to that import and `writeFile`/`mkdir`/`readFile`/`existsSync` are already imported):

```ts
import { mergeWorktree } from './worktree'; // add to the existing './worktree' import

test('mergeWorktree commits as Mission Control and excludes node_modules', async () => {
  const repo = await makeRepo();
  const root = await freshWorktreeRoot();
  try {
    const wt = await ensureWorktree('sess_merge', repo, 'dev');
    // A real change + a node_modules dir that must NOT be committed.
    await writeFile(path.join(wt.path, 'feature.txt'), 'hello\n');
    await mkdir(path.join(wt.path, 'node_modules', 'junkpkg'), { recursive: true });
    await writeFile(path.join(wt.path, 'node_modules', 'junkpkg', 'index.js'), 'x');
    await exec('git', ['-C', wt.path, 'add', 'node_modules']).catch(() => {}); // even if an agent pre-staged it

    const res = await mergeWorktree('sess_merge', repo, 'dev');
    assert.equal(res.ok, true);

    // The merge commit author is Mission Control (inline identity applied).
    const { stdout: author } = await exec('git', ['-C', repo, 'log', 'dev', '-1', '--format=%an']);
    assert.equal(author.trim(), 'Mission Control');

    // feature.txt landed on dev; node_modules did NOT.
    const { stdout: tree } = await exec('git', ['-C', repo, 'ls-tree', '-r', '--name-only', 'dev']);
    assert.ok(tree.split('\n').includes('feature.txt'), 'feature.txt should be committed');
    assert.ok(!tree.split('\n').some((f) => f.startsWith('node_modules')), 'node_modules must NOT be committed');
  } finally {
    await cleanup(repo, root);
  }
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `pnpm exec tsx --test src/lib/worktree.test.ts`
Expected: FAIL — either the commit fails (no ambient identity in CI) or node_modules appears in the tree.

- [ ] **Step 3: Harden the commit in `mergeWorktree`**

In `src/lib/worktree.ts`, replace the commit block (currently):

```ts
  if (status.trim()) {
    await exec('git', ['-C', wtPath, 'add', '-A']);
    await exec('git', ['-C', wtPath, 'commit', '-m', `mission-control: ${branch}`]);
  }
```

with:

```ts
  if (status.trim()) {
    await exec('git', ['-C', wtPath, 'reset', '-q', '--', 'node_modules']).catch(() => {}); // drop any pre-staged node_modules
    await exec('git', ['-C', wtPath, 'add', '-A', '--', '.', ':!node_modules']); // stage everything except node_modules
    await exec('git', [
      '-c', 'user.email=mc@axodcreative.com',
      '-c', 'user.name=Mission Control',
      '-C', wtPath, 'commit', '-m', `mission-control: ${branch}`,
    ]);
  }
```

- [ ] **Step 4: Run it to verify it passes**

Run: `pnpm exec tsx --test src/lib/worktree.test.ts`
Expected: PASS (existing worktree tests + the new merge test).

- [ ] **Step 5: Commit**

```bash
git add src/lib/worktree.ts src/lib/worktree.test.ts
git commit -m "fix(worktree): commit with inline Mission Control identity; never commit node_modules"
```

---

### Task 2: Proposal summary from the agent's own words

**Files:**
- Modify: `src/lib/proposals.ts` (`summarizeForProposal`, `ProposalRow.summaryRaw`, `Proposal.summary`, `collectProposals`)
- Modify: `src/lib/proposals.test.ts`
- Modify: `src/lib/proposals-data.ts` (fetch latest agent message)
- Modify: `src/lib/discord-format.ts` (`proposalEmbed` description)
- Modify: `src/lib/discord-format.test.ts`

**Interfaces (produced):** `summarizeForProposal(text, maxChars?, maxLines?): string`; `Proposal.summary: string`; `ProposalRow.summaryRaw: string | null`.

- [ ] **Step 1: Write the failing tests (pure helper)**

Append to `src/lib/proposals.test.ts` (it already imports from `./proposals`; add `summarizeForProposal`):

```ts
import { summarizeForProposal } from './proposals';

test('summarizeForProposal: trims lines, caps lines and chars', () => {
  assert.equal(summarizeForProposal(null), '');
  assert.equal(summarizeForProposal('  '), '');
  assert.equal(summarizeForProposal('  one  \n\n  two  '), 'one\ntwo');
  assert.equal(summarizeForProposal('a\nb\nc\nd\ne', 999, 3), 'a\nb\nc');
  const long = 'x'.repeat(400);
  const out = summarizeForProposal(long, 280, 4);
  assert.ok(out.length <= 280 && out.endsWith('…'));
});
```

Also update the existing `row(...)` helper in this file to include `summaryRaw: null` in its defaults (so it satisfies `ProposalRow`):

```ts
function row(over: Partial<ProposalRow> = {}): ProposalRow {
  return {
    sessionId: 's', sessionTitle: 'S', worktreePath: '/wt/s', baseBranch: null, summaryRaw: null,
    updatedAt: new Date('2026-06-01T00:00:00Z'), projectId: 'p', projectName: 'P',
    defaultBranch: 'dev', ...over,
  };
}
```

Add a `collectProposals` summary test:

```ts
test('collectProposals sets summary from summaryRaw', async () => {
  const rows = [row({ sessionId: 'z', worktreePath: '/wt/z', summaryRaw: 'Did the thing.\nAnd another.' })];
  const diff = async () => ({ diff: '+a\n', files: [{ status: 'M', path: 'f' }] });
  const [p] = await collectProposals(rows, diff);
  assert.equal(p.summary, 'Did the thing.\nAnd another.');
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm exec tsx --test src/lib/proposals.test.ts`
Expected: FAIL — `summarizeForProposal` not exported; `summaryRaw`/`summary` unknown.

- [ ] **Step 3: Implement in `proposals.ts`**

Add `summary: string;` to the `Proposal` interface; add `summaryRaw: string | null;` to the `ProposalRow` interface. Add the helper:

```ts
/** Condense an agent message into a short proposal summary: trim blank lines,
 * keep the first `maxLines`, cap at `maxChars` with an ellipsis. Pure. */
export function summarizeForProposal(
  text: string | null | undefined,
  maxChars = 280,
  maxLines = 4,
): string {
  if (!text) return '';
  const lines = text.split('\n').map((l) => l.trim()).filter(Boolean);
  if (lines.length === 0) return '';
  let out = lines.slice(0, maxLines).join('\n');
  if (out.length > maxChars) out = out.slice(0, maxChars - 1).trimEnd() + '…';
  return out;
}
```

In `collectProposals`, add `summary: summarizeForProposal(r.summaryRaw),` to the pushed proposal object (alongside the existing fields).

- [ ] **Step 4: Run to verify it passes**

Run: `pnpm exec tsx --test src/lib/proposals.test.ts`
Expected: PASS.

- [ ] **Step 5: Fetch the latest agent message in `proposals-data.ts`**

Replace `src/lib/proposals-data.ts` body. Update imports to add `and, desc` and `messages`:

```ts
import 'server-only';
import { eq, and, desc, isNotNull } from 'drizzle-orm';
import { db } from '@/db/client';
import { sessions, projects, messages } from '@/db/schema';
import { diffWorktree } from './worktree';
import { collectProposals, type Proposal } from './proposals';

/** Fleet-wide inbox: every session whose worktree differs from its base branch. */
export async function getProposals(): Promise<Proposal[]> {
  const rows = await db
    .select({
      sessionId: sessions.id,
      sessionTitle: sessions.title,
      worktreePath: sessions.worktree_path,
      baseBranch: sessions.base_branch,
      updatedAt: sessions.updated_at,
      projectId: projects.id,
      projectName: projects.name,
      defaultBranch: projects.default_branch,
    })
    .from(sessions)
    .innerJoin(projects, eq(sessions.project_id, projects.id))
    .where(isNotNull(sessions.worktree_path));

  const rowsWithSummary = await Promise.all(
    rows.map(async (r) => {
      const last = await db
        .select({ content: messages.content })
        .from(messages)
        .where(and(eq(messages.session_id, r.sessionId), eq(messages.role, 'agent')))
        .orderBy(desc(messages.created_at))
        .limit(1)
        .then((x) => x[0]);
      return { ...r, summaryRaw: last?.content ?? null };
    }),
  );

  return collectProposals(rowsWithSummary, diffWorktree);
}
```

- [ ] **Step 6: Add the summary to `proposalEmbed` + test**

In `src/lib/discord-format.ts`, change `proposalEmbed` to include the description (omit when empty):

```ts
export function proposalEmbed(p: Proposal): APIEmbed {
  return {
    title: `Proposal ready: ${p.sessionTitle}`,
    ...(p.summary ? { description: p.summary } : {}),
    color: BLUE,
    fields: [
      { name: 'Project', value: p.projectName, inline: true },
      { name: 'Changes', value: `+${p.additions} / -${p.deletions}`, inline: true },
      { name: 'Files', value: String(p.files.length), inline: true },
    ],
  };
}
```

Append to `src/lib/discord-format.test.ts` (it already imports `proposalEmbed`; this builds a minimal `Proposal`):

```ts
test('proposalEmbed includes the summary as description when present', () => {
  const base = {
    sessionId: 's', sessionTitle: 'T', projectId: 'p', projectName: 'P',
    branch: 'mc/s', baseBranch: 'dev', files: [{ status: 'M', path: 'f' }],
    additions: 1, deletions: 0, ts: '2026-06-28T00:00:00.000Z',
  };
  assert.equal(proposalEmbed({ ...base, summary: 'Did X.' }).description, 'Did X.');
  assert.equal(proposalEmbed({ ...base, summary: '' }).description, undefined);
});
```

- [ ] **Step 7: Typecheck, suite, commit**

```bash
pnpm exec tsc --noEmit
pnpm test
git add src/lib/proposals.ts src/lib/proposals.test.ts src/lib/proposals-data.ts src/lib/discord-format.ts src/lib/discord-format.test.ts
git commit -m "feat(proposals): show a short 'what changed' summary from the agent's last message"
```
Expected: tsc clean; suite green.

---

### Task 3: Leaner orchestration after dispatch

**Files:**
- Modify: `src/lib/conversation.ts` (`FRAMING_HEADER`)
- Modify: `src/lib/conversation.test.ts`

- [ ] **Step 1: Write the failing test**

Append to `src/lib/conversation.test.ts` (it already imports `buildOrchestratorPrompt`; reuse its message-building style):

```ts
test('orchestrator prompt carries the post-dispatch brevity rule', () => {
  const out = buildOrchestratorPrompt([{ role: 'user', content: 'hi' }], {});
  assert.match(out, /do not restate|don't restate|one-line TL;DR/i);
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm exec tsx --test src/lib/conversation.test.ts`
Expected: FAIL — the brevity text isn't in the header yet.

- [ ] **Step 3: Extend `FRAMING_HEADER`**

In `src/lib/conversation.ts`, change `FRAMING_HEADER` to:

```ts
const FRAMING_HEADER =
  'This is the ongoing conversation for the current session. Reply to the latest Operator message below, using the full context of the conversation. ' +
  'When you dispatch an agent and receive its report, do NOT restate or re-summarize the report — the Operator can already read it. ' +
  'Reply with at most a one-line TL;DR of the outcome, or simply note the report is ready. Never duplicate information the Operator can already see.';
```

- [ ] **Step 4: Run to verify it passes**

Run: `pnpm exec tsx --test src/lib/conversation.test.ts`
Expected: PASS (the existing `/ongoing conversation for the current session/i` assertions still hold; the new one passes).

- [ ] **Step 5: Commit**

```bash
git add src/lib/conversation.ts src/lib/conversation.test.ts
git commit -m "feat(orchestrator): after a dispatch, Sage gives a TL;DR instead of restating the report"
```

---

### Task 4: Scheduled jobs clean up their worktree

**Files:**
- Modify: `src/lib/scheduler.ts`

- [ ] **Step 1: Add the cleanup after a scheduled turn**

In `src/lib/scheduler.ts`, add `discardWorktree` to the worktree import (it already imports `projects` and uses `runSessionTurn`):

```ts
import { discardWorktree } from '@/lib/worktree';
```

Immediately after the `schedules` update that records `last_run_at`/`last_status` (the `.set({ last_run_at: new Date(), last_session_id: sessionId, last_status, ... })` block) and before the `catch`, add:

```ts
      // Scheduled runs are automation, not reviewable work — never leave a lingering proposal.
      const ran = await db
        .select({ wt: sessions.worktree_path, projectId: sessions.project_id })
        .from(sessions).where(eq(sessions.id, sessionId)).limit(1).then((r) => r[0]);
      if (ran?.wt) {
        const proj = await db
          .select({ repo: projects.repo_path })
          .from(projects).where(eq(projects.id, ran.projectId)).limit(1).then((r) => r[0]);
        if (proj) await discardWorktree(sessionId, proj.repo).catch(() => {});
        await db.update(sessions).set({ worktree_path: null }).where(eq(sessions.id, sessionId));
      }
```

- [ ] **Step 2: Typecheck + suite**

Run: `pnpm exec tsc --noEmit && pnpm test`
Expected: tsc clean; suite green (scheduler is server-only; this guards types + no regressions).

- [ ] **Step 3: Commit**

```bash
git add src/lib/scheduler.ts
git commit -m "fix(scheduler): discard a scheduled run's worktree so reporting jobs don't pile up as proposals"
```

---

### Task 5: Archive sessions — schema, route, and exclusions (backend)

**Files:**
- Modify: `src/db/schema.ts` (+ generated `drizzle/0009_*.sql`)
- Create: `src/app/api/sessions/[id]/archive/route.ts`
- Modify: `src/app/api/sessions/route.ts` (GET excludes archived)
- Modify: `src/lib/proposals-data.ts` (exclude archived)
- Modify: `src/lib/active-project.ts` (exclude archived)
- Modify: `src/lib/discord-session.ts` (exclude archived)
- Modify: `src/app/page.tsx` (sessionRows excludes archived)

**Interfaces (produced):** `sessions.archived_at` (timestamp, nullable); `POST /api/sessions/[id]/archive`.

- [ ] **Step 1: Add the column + migration**

In `src/db/schema.ts`, add to the `sessions` table (after `running_since`):

```ts
  archived_at: integer('archived_at', { mode: 'timestamp' }),
```

Run: `pnpm db:generate` (creates `drizzle/0009_*.sql` with `ALTER TABLE sessions ADD ...archived_at...`), then `pnpm db:migrate`.
Expected: `migrations applied successfully`.

- [ ] **Step 2: Create the archive route**

Create `src/app/api/sessions/[id]/archive/route.ts`:

```ts
import { cookies } from 'next/headers';
import { eq } from 'drizzle-orm';
import { db } from '@/db/client';
import { sessions, projects } from '@/db/schema';
import { SESSION_COOKIE, verifySession } from '@/lib/auth';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  const jar = await cookies();
  const token = jar.get(SESSION_COOKIE)?.value;
  if (!token || !(await verifySession(token))) return Response.json({ error: 'Unauthorized' }, { status: 401 });

  const { id } = await ctx.params;
  const session = await db.select().from(sessions).where(eq(sessions.id, id)).limit(1).then((r) => r[0]);
  if (!session) return Response.json({ error: 'Session not found' }, { status: 404 });
  if (session.worktree_path) {
    return Response.json({ error: 'Resolve its proposal (merge or discard) first' }, { status: 409 });
  }

  await db.update(sessions).set({ archived_at: new Date() }).where(eq(sessions.id, id));

  const project = await db.select().from(projects).where(eq(projects.id, session.project_id)).limit(1).then((r) => r[0]);
  if (project?.active_session_id === id) {
    await db.update(projects).set({ active_session_id: null }).where(eq(projects.id, project.id));
  }
  return Response.json({ ok: true });
}
```

- [ ] **Step 3: Exclude archived sessions from the list route**

In `src/app/api/sessions/route.ts` GET, change the import `import { eq, desc } from 'drizzle-orm';` to add `and, isNull`, and change the rows query `.where(eq(sessions.project_id, projectId))` to:

```ts
    .where(and(eq(sessions.project_id, projectId), isNull(sessions.archived_at)))
```

- [ ] **Step 4: Exclude archived from proposals**

In `src/lib/proposals-data.ts`, the import already has `and` and `isNotNull` (from Task 2); add `isNull`. Change `.where(isNotNull(sessions.worktree_path))` to:

```ts
    .where(and(isNotNull(sessions.worktree_path), isNull(sessions.archived_at)))
```

- [ ] **Step 5: Exclude archived from active-session resolution**

In `src/lib/active-project.ts`, add `and, isNull` to the drizzle import (currently `desc, eq`), and change the `rows` query `.where(eq(sessions.project_id, projectId))` to:

```ts
    .where(and(eq(sessions.project_id, projectId), isNull(sessions.archived_at)))
```

Do the same in `src/lib/discord-session.ts` (its `rows` query that selects `{ id: sessions.id }` filtered by `project_id`): add `and, isNull` to its drizzle import and add `isNull(sessions.archived_at)` via `and(...)`.

- [ ] **Step 6: Exclude archived from `page.tsx` sessionRows**

In `src/app/page.tsx`, the `sessionRows` query filters `eq(sessions.project_id, project.id)`. Add `and, isNull` to the drizzle import if not present, and change it to:

```ts
    .where(and(eq(sessions.project_id, project.id), isNull(sessions.archived_at)))
```

- [ ] **Step 7: Typecheck, suite, commit**

```bash
pnpm exec tsc --noEmit
pnpm test
git add src/db/schema.ts drizzle/ "src/app/api/sessions/[id]/archive/route.ts" src/app/api/sessions/route.ts src/lib/proposals-data.ts src/lib/active-project.ts src/lib/discord-session.ts src/app/page.tsx
git commit -m "feat(sessions): archive sessions (migration 0009) + exclude archived from list/active/proposals"
```
Expected: tsc clean; suite green.

---

### Task 6: Archive sessions — switcher UI

**Files:**
- Modify: `src/components/session-switcher.tsx`

- [ ] **Step 1: Add a trash/confirm archive action per session**

In `src/components/session-switcher.tsx`, add `Trash2` to the lucide import, a `confirmingId` state, an `archive` function, and render the trash button on hover. Replace the imports line and the component body's session-list map.

Change the import:

```tsx
import { ChevronDown, Check, Plus, Trash2 } from "lucide-react";
```

Add state next to the others:

```tsx
  const [confirmingId, setConfirmingId] = useState<string | null>(null);
```

Add the archive handler next to `switchTo`:

```tsx
  async function archive(id: string) {
    setBusy(id);
    try {
      const res = await fetch(`/api/sessions/${encodeURIComponent(id)}/archive`, { method: "POST" });
      if (!res.ok) {
        const b = await res.json().catch(() => ({}));
        alert(b.error ?? `Failed (${res.status})`);
        return;
      }
      setConfirmingId(null);
      setOpen(false);
      router.refresh();
    } finally {
      setBusy(null);
    }
  }
```

Replace the session-list `{sessions.map((s) => ( ... ))}` block with one that includes the trash control + an inline confirm (mirrors `project-switcher.tsx`), and only offers archive when there is more than one session:

```tsx
          {sessions.map((s) =>
            confirmingId === s.id ? (
              <div key={s.id} className="flex items-center gap-2 px-3 py-1.5 text-xs text-[#e6edf3]">
                <span className="flex-1 min-w-0 truncate">
                  Archive <span className="font-semibold">{s.title}</span>?
                  <span className="block text-[9.5px] text-[#5c6470] font-mono">history kept; hidden from the list</span>
                </span>
                <button onClick={() => archive(s.id)} disabled={busy !== null}
                  className="text-[10px] font-mono text-amber-400 hover:text-amber-300 px-1.5 py-0.5 rounded border border-amber-500/40 disabled:opacity-50">archive</button>
                <button onClick={() => setConfirmingId(null)}
                  className="text-[10px] font-mono text-[#8b949e] hover:text-[#e6edf3] px-1.5 py-0.5">cancel</button>
              </div>
            ) : (
              <div key={s.id} className="group flex items-center hover:bg-[#1c2330] transition-colors">
                <button onClick={() => switchTo(s.id)} disabled={busy !== null}
                  className="flex-1 min-w-0 flex items-center gap-2 px-3 py-1.5 text-xs text-[#e6edf3] text-left disabled:opacity-50">
                  <span className="w-3.5 shrink-0">{s.id === activeSessionId && <Check className="w-3.5 h-3.5 text-[#00e0ff]" />}</span>
                  <span className="flex-1 min-w-0 truncate">{s.title}</span>
                  {s.hasChanges && <span title="has changes" className="w-1.5 h-1.5 rounded-full bg-[#f59e0b] shrink-0" />}
                  <span className="text-[9px] font-mono text-[#5c6470] shrink-0">{s.baseBranch}</span>
                </button>
                {sessions.length > 1 && (
                  <button onClick={() => setConfirmingId(s.id)} title="Archive session"
                    className="shrink-0 px-2 text-[#5c6470] opacity-0 group-hover:opacity-100 hover:text-amber-400 transition-all">
                    <Trash2 className="w-3.5 h-3.5" />
                  </button>
                )}
              </div>
            ),
          )}
```

- [ ] **Step 2: Typecheck + build**

```bash
pnpm exec tsc --noEmit
pnpm build
```
Expected: tsc clean; build succeeds.

- [ ] **Step 3: Commit**

```bash
git add src/components/session-switcher.tsx
git commit -m "feat(ui): archive a session from the switcher (hover trash + confirm)"
```

---

## Self-Review

**Spec coverage:**
- Item 1 commit hardening (inline identity + node_modules exclusion) → Task 1 + real-git test. ✓
- Item 2 proposal summary from agent's words → Task 2 (`summarizeForProposal`, `summaryRaw`/`summary`, proposals-data fetch, embed description). ✓
- Item 3 leaner orchestration → Task 3 (`FRAMING_HEADER` + test). ✓
- Item 4 scheduled-job cleanup → Task 4 (scheduler discards worktree). ✓
- Item 5 archive sessions → Task 5 (migration `0009` + route + exclusions in list/proposals/active/page) + Task 6 (UI). ✓

**Placeholder scan:** No TBD/TODO; every code step has complete code or an exact named edit; commands have expected output.

**Type consistency:** `Proposal.summary` (string) + `ProposalRow.summaryRaw` (string|null) defined in Task 2 and consumed by `proposalEmbed` (Task 2) and the test `row()` helper; `summarizeForProposal` signature matches its test + call site; `archived_at` (Task 5) is filtered with `isNull(sessions.archived_at)` consistently across the list route, proposals-data, active-project, discord-session, and page.tsx; the archive route returns `409` for a session with `worktree_path` and clears `active_session_id` when archiving the active session; `discardWorktree(sessionId, repoPath)` (Task 4) matches its existing signature.
