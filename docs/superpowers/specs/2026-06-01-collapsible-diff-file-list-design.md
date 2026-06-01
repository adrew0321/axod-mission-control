# Collapsible Diff File List — Design

**Date:** 2026-06-01
**Branch:** `feature/week-4-workspace-tabs`
**Scope:** A follow-on polish to the Code Diff tab. Let the operator collapse the changed-files picker so the Monaco diff can use the full pane width — useful on desktop and, with auto-collapse, on the new mobile layout.

---

## Problem

The Code Diff tab (`DiffViewer`) renders a fixed `w-52` (208px) changed-files sidebar to the left of the side-by-side Monaco diff. On a narrow workspace pane — especially the single-pane mobile layout (`< md`) shipped as Week 4 item C — that 208px rail eats space the side-by-side diff badly needs, and there's no way to reclaim it.

## Approach

A self-contained collapse toggle inside `DiffViewer` (`src/components/diff-viewer.tsx`). No changes to `mission-control.tsx` or the diff data flow.

### State

- `filesOpen: boolean` — local `useState`, controls whether the file-list panel renders.
- **Initial value (auto-collapse):** open on wide screens, collapsed below `md` (768px). Resolved once on mount via `matchMedia("(max-width: 767px)")` inside a `useEffect` (default `true` for SSR / first paint, corrected on mount). No resize listener — this only sets the *initial* state; after that it's operator-driven.
- The existing `selected` file index is untouched. A selected file survives collapse/expand, and Monaco's `automaticLayout: true` reflows to the new width automatically.

### Toggle button

- Lives at the **left of the existing `h-9` header bar**, before the file-count text.
- Rendered only when `files.length > 0` (nothing to collapse otherwise — the empty state has no list).
- Lucide `PanelLeftClose` (panel open) / `PanelLeftOpen` (panel collapsed) icon. Carries an `aria-label` ("Hide file list" / "Show file list") and matches the existing Refresh button's styling.

### Layout

- File-list panel (`w-52 …`) renders only when `filesOpen`.
- The diff container stays `flex-1 min-w-0`, so it expands to full width when the panel is gone.
- Desktop default is unchanged (panel open ≥ `md`).

## Decisions

- **Header toggle, not a thin rail** (operator choice). Collapsed = list fully gone; the always-present header button is the single, unambiguous reopen affordance.
- **Auto-collapse below `md`** (operator choice). Initial-mount only via `matchMedia`; no resize listener, to keep behavior predictable and avoid yanking the panel away mid-session on a desktop resize.
- **Local state, not lifted.** Collapse is a pure view concern of `DiffViewer`; nothing else needs to know. Keeping it local keeps the component self-contained and testable.

## Out of scope

No resize-driven re-collapse, no persisting the collapsed state across reloads, no draggable/resizable panel width, no change to the file-picker contents or selection logic.

## Verification

- `pnpm build` clean; `pnpm test` still green (39/39) — this is presentational, adds no logic to the pure modules the `node:test` suite covers.
- Manual: at desktop width the panel starts open and toggles closed/open, diff reflowing each way; at `< md` the Code Diff opens with the list already collapsed and the toggle reopens it.
