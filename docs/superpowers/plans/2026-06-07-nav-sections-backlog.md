# Nav Sections Backlog — future views & system epics

> **Not a bite-sized implementation plan.** This is a resume-later roadmap for the
> remaining nav sections + system work, captured 2026-06-07 right after the Task Board
> shipped (v1.5.0). Each item gets its own brainstorm → spec → plan when picked up.
>
> **Progress:** Live views: **Agent Team · Live Feed · Task Board · Proposals ✅ · Skills ✅ ·
> Memory ✅** — all released to `main` as **v1.6.0** (2026-06-10). Done since this doc was
> written: **Proposals** (`specs/2026-06-08-proposals-design.md`), **Skills**
> (`specs/2026-06-09-skills-design.md`), **Memory** (`specs/2026-06-09-memory-design.md`).
> **Next up: the server-side turn runner** (item #4's prereq) — it unblocks **Scheduler** and
> **Dreaming**, which cannot run on a cron without it (see [[turns-require-client-sse]]).
> Proposals/Skills/Memory are the last view-only sections; the rest are runtime work.

## Context / patterns to reuse

- **Nav config:** `src/lib/nav-sections.ts` (flip a section `soon` → `live`); the rail
  (`nav-sidebar.tsx`) already makes live sections clickable.
- **View switch:** `mission-control.tsx` renders `activeSection === "x" ? <XView/> : …`
  (see the Live Feed / Task Board branches). Add a branch + a `*-view.tsx` component.
- **Read-rollup pattern:** `getLiveFeed()` (`src/lib/live-feed.ts`) and `getTaskBoard()`
  (`src/lib/task-board-data.ts`) show how to aggregate DB rows into a view; pure,
  testable composition lives in a separate no-`server-only` module (e.g. `task-board.ts`).
- **Server data → client:** load in `src/app/page.tsx`, pass as an `initial*` prop, mirror
  into state with a sync `useEffect` (see `taskBoard` / `liveFeedEvents`).
- **HARD CONSTRAINT (see memory `turns-require-client-sse`):** an agent turn only runs
  when the browser opens `GET /api/sessions/:id/stream`. There is **no** server-initiated
  turn path today. Anything cron/background that must run agents needs a new server-side
  runner first (calls `runClaudeAgent` directly + persists). This gates Scheduler & Dreaming.

---

## 1. Proposals view (operational) — RECOMMENDED NEXT

**Goal:** A review inbox for everything awaiting the operator — primarily pending tool
**approvals**, surfaced as actionable cards (approve / deny), plus (later) agent-suggested
changes.

**Why next:** lowest new-surface — the data already exists (`approvals` table; Live Feed
already renders pending approvals + has `onApprovalDecision`). Mostly a focused view over
existing rows. No new agent capability, no schema change.

**Sketch:** `getProposals(projectId)` → pending `approvals` (+ maybe `dispatch`-suggested
artifacts) → `proposals-view.tsx` (cards with inline approve/deny via the existing
`/api/approvals/[id]/decision` route). Flip `proposals` to `live`.

**Complexity:** S. **Prereq:** none.

---

## 2. Skills view (system)

**Goal:** Browse the skills/capabilities each agent has (tools allowlist today; later the
agentskills.io-style skill files per the Hermes "Skills" pillar).

**Sketch (v1, read-only):** render each agent's `tools_allowlist` from the `agents` table,
grouped by agent, with friendly tool descriptions. Later: a real skills registry.

**Complexity:** S (read-only) → L (editable registry). **Prereq:** none for read-only.

---

## 3. Memory view (system)

**Goal:** Inspect Sage's session memory / transcript context (the "Memory" pillar). Today
memory = full session transcript (see session-memory work); a view could show what Sage
"remembers" per session and let the operator clear it (the Clear control already exists).

**Sketch:** read messages per session (respecting `cleared_at`); later a cross-session
memory store / knowledge graph (v2.0 roadmap item).

**Complexity:** M. **Prereq:** none for the basic view.

---

## 4. Scheduler view (system) — needs server runner

**Goal:** Schedule recurring or future agent runs (cron-style): "every morning, have Nova
summarize repo activity," etc.

**BLOCKER:** turns require a client SSE connection (see constraint above). A scheduler that
fires when no browser is open needs a **server-side turn runner** + a persistent scheduler
(node cron / a `schedules` table + a tick worker). Build the runner first.

**Sketch:** (a) extract a server `runSessionTurn(sessionId)` that does what the stream route
does but persists without SSE; (b) a `schedules` table + a background ticker that calls it;
(c) `scheduler-view.tsx` to CRUD schedules.

**Complexity:** L. **Prereq:** server-side runner (shared with Dreaming).

---

## 5. Dreaming / Curator (system) — needs server runner

**Goal:** The Hermes "Dreaming" pillar — a background Curator that self-improves on a cron
(reviews recent work, updates skills/notes/system prompts). Same server-runner prerequisite
as Scheduler; this is essentially a special scheduled, self-directed agent run + a place to
review what it changed.

**Complexity:** XL. **Prereq:** server-side runner (#4) + Skills/Memory surfaces (#2/#3).

---

## 6. Hermes / OpenClaw runtime (cross-cutting)

**Goal:** Make the cosmetic `claude-sdk` agent badge real — a `runtime` field on agents so
Mission Control can drive Claude Code / Codex / Hermes / OpenClaw runtimes, not only the
in-process Claude Agent SDK.

**Sketch:** add `runtime` to the `agents` schema; a runner abstraction that dispatches to
the right backend; auto-detect installed runtimes. Additive — existing 6 agents stay
`claude-sdk`. (This is the "evolution not demolition" path discussed during nav design.)

**Complexity:** XL. **Prereq:** stable server runner helps.

---

## 7. Repo view (operational) — Merge Resolver + Commit History

**Goal:** A new "Repo" nav section bundling two focused developer-workflow features that VS-familiar operators expect and MC currently lacks: (a) an in-app 3-way **Merge Resolver** built on Monaco to replace the current "resolve manually" dead-end in Proposals, and (b) a read-only **Commit History** navigator for post-merge audit of what agents actually did.

**Why interesting:** Session-branch UX, base-branch picking, and the Monaco diff viewer already shipped (`src/components/diff-viewer.tsx`, `listBranches()`, session-branch-management spec 2026-06-27). This closes the two remaining gaps in the VS-parity story. Merge conflicts today force the operator to shell out; there is no way to audit multi-commit session history from the UI.

**Sketch:**
- **Merge Resolver:** extend `mergeWorktree()` in `src/lib/worktree.ts` to leave the merge staged (not `--abort`) on conflict; return conflicting files with `<current|incoming|base>` contents. New 3-pane UI parses `<<<<<<< / ======= / >>>>>>>` markers, offers per-hunk accept buttons, POSTs resolved contents, then `git add . && git merge --continue`. Replaces the `proposals-view.tsx` "Merge conflict — resolve manually" toast.
- **Commit History:** new view with branch dropdown, `git log --format=…` list, click-to-diff using the existing Monaco DiffEditor. Also a "session timeline" tab on session detail.

**Deferred sub-features:** stash (session-per-branch model already covers the 90% case); hunk-level staging (future).

**Complexity:** L (Merge Resolver M–L + Commit History M). **Prereq:** none.

---

## 8. C2 — broader theme polish (cross-cutting)

Typography & spacing pass · conversation-thread refinement · roster-card consistency ·
color/accent consistency across the new views (Live Feed / Task Board / future sections).
**Complexity:** M, incremental. **Prereq:** none.

---

## Housekeeping (do before prod / opportunistically)

- Delete the seeded test admin `test@axodcreative.com` from `auth_users` before any real
  use (see memory `test-admin-seeded`).
- `src/lib/plans.ts` is an untracked, currently-unused helper sitting in the working tree —
  decide whether to wire it into a Memory/Plan view or remove it.
- **Local Companion — native-app slice.** The Companion shipped 2026-06-30 (`companion/` package, `src/lib/companion/*`, browser tools) covers browser automation with hard gates. The original "open File Explorer / launch desktop app" idea from an earlier backlog draft is a small extension: add `launch_app` and `open_path` companion actions, gate via allowlist config, reuse the existing hard-gate + operator-approval flow. **Complexity:** S–M. Not an epic; log here so it isn't forgotten.

## Suggested order

Proposals (S, next) → Skills (S) → Memory (M) → **server-side runner** (unlocks) →
Scheduler (L) → Dreaming (XL) → Hermes runtime (XL) → Repo view (L). C2 polish folded in as you go.
