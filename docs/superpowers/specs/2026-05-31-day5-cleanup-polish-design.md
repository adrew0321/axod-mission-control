# Day 5 (partial) — Cleanup + Polish Design

**Date:** 2026-05-31
**Branch:** `feature/week-4-workspace-tabs`
**Scope:** The safe closeout slice of Week 4 Day 5. Three items — **A** mock-data cleanup, **B** tab badges, **E** docs update — then pause for operator confirmation on **F** (merge `dev` → `main`, first push). Deliberately **deferred** to their own sessions: **C** mobile-responsive workspace tabs, **D** `docs/plans/week-5-deploy.md`.

**Why partial:** Day 5 as written in `docs/plans/week-4-workspace-tabs.md` is a basket of six loosely-related closeout tasks, not one feature. C is genuine design work (the fixed 3-pane desktop layout → responsive) and D is its own week-5 planning effort; both warrant dedicated sessions. A/B/E are mechanical-to-small and safe to land together as the week-4 release groundwork.

---

## Context (ground truth, 2026-05-31)

`src/app/page.tsx` already pulls **team, session, messages, approvals, and token/cost totals live from the database**. The only remaining mock wiring is `artifacts={mockArtifacts}` (page.tsx:159). After Day 4, `MissionControl` no longer consumes that `artifacts` prop at all — it's a dangling thread: passed, ignored, and still declared on the props interface.

`mockTeam`, `mockSession`, `mockMessages`, and `mockArtifacts` in `src/lib/mock-data.ts` are dead value exports (imported nowhere after this cleanup). Only the **interfaces** (`Agent`, `Message`, `Session`, `Artifact`) are still imported and shared across `page.tsx` and `mission-control.tsx`.

---

## A. Mock-data cleanup

Goal: nothing mock ships, no dead plumbing lingers.

1. **`src/app/page.tsx`** — drop the `artifacts={mockArtifacts}` prop (line ~159); remove `mockArtifacts` from the import (line ~5). Keep the type imports (`Agent`, `Message`, `Session`).
2. **`src/components/mission-control.tsx`** — remove `artifacts: Artifact[]` from the `MissionControlProps` interface (line ~40); drop the now-unused `Artifact` from the type import on line ~28 (verify nothing else in the file uses it first).
3. **`src/lib/mock-data.ts`** — delete the dead value exports `mockTeam`, `mockSession`, `mockMessages`, `mockArtifacts` (all three `art_*` rows go with `mockArtifacts`). **Keep** the interfaces `Agent`, `Message`, `Session`, `Artifact` — the file becomes a types-only module.

Net effect: the `'plan'`/`'terminal'`/`'code'` artifact *type* union survives (harmless, reusable); every mock *row* and the dead-prop plumbing is gone.

## B. Tab badges

Mirror the existing Code Diff badge (`bg-cyan-500/10 border border-cyan-500/25 …` span at mission-control.tsx ~1003-1007) on two more tab buttons. No new state — both derive from existing state.

- **Plan** tab: when `plan && plan.todos.length > 0`, render `{done}/{total}`, where `done = plan.todos.filter((t) => t.status === "completed").length` and `total = plan.todos.length` (same computation `PlanView` uses).
- **Terminal** tab: when `terminalLines.length > 0`, render `{terminalLines.length}`.

Badges appear only when there's something to count, matching the Code Diff conditional.

## E. Docs update

- **`docs/plans/week-4-workspace-tabs.md`** — under Day 5, add a "what actually happened (partial)" note: mock-data cleanup done, badges done, and **C (mobile-responsive) + D (week-5-deploy plan) explicitly deferred** to their own sessions. Keep the record honest about partial completion.
- **v1 spec:** locate it; if a single v1 spec file exists, add a one-line status note. If there is no single v1 spec file, note that in the final report rather than invent one.

---

## Verification & commits

- `pnpm build` + `pnpm test` green after A, and again after B.
- Three commits, matching Day 4's per-task style: cleanup / badges / docs.
- Then **pause** for operator go-ahead on F (merge `dev` → `main`, first push). Do not merge or push without explicit confirmation (see `git-branch-workflow`, `workflow-day-by-day`).

## Scope guard

Not touching the desktop 3-pane layout (C, deferred). Not writing the deploy plan (D, deferred). No new dependencies. No DB or route changes.
