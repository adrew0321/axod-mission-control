# Day 5 (item C) — Mobile-Responsive Layout Design

**Date:** 2026-06-01
**Branch:** `feature/week-4-workspace-tabs`
**Scope:** Week 4 Day 5 item **C**, deferred from the cleanup+polish slice (`2026-05-31-day5-cleanup-polish-design.md`) to its own session. Make the fixed three-pane desktop layout usable on a phone without touching the desktop experience.

---

## Problem

`MissionControl` is a fixed three-column layout: **Team roster** (`w-[280px]`), **Orchestrator chat** (`flex-1 min-w-[400px]`), **Workspace tabs** (`flex-1 min-w-[400px]`). Two `min-w-[400px]` panes plus a 280px rail need ~1080px before the chat input and workspace tabs are even reachable — unusable below tablet width. The header also packs project/branch chips and cost/token chips that have nowhere to go on a narrow screen, and the footer status strip competes for vertical space that a phone can't spare.

## Approach

One breakpoint, `md` (768px). Desktop (`≥ md`) is untouched — every change is gated behind a `md:` modifier or a `hidden md:flex` / `md:hidden` pair, so the three-pane layout renders byte-for-byte as before. Below `md`, the app becomes a single-pane, tab-switched view driven by a bottom tab bar.

### State

One piece of state: `mobileActiveTab: "team" | "chat" | "workspace"`, defaulting to `"chat"` (the operator's primary surface). Independent of the existing `activeTab` (preview/plan/code/terminal) inside the workspace pane — switching mobile panes doesn't disturb which workspace sub-tab is open.

### Panes

Each `<section>` gets a visibility class keyed off `mobileActiveTab`:
`mobileActiveTab === "<name>" ? "flex" : "hidden md:flex"`. So on mobile exactly one pane shows (full width); at `md` and up all three always show. The two workspace panes drop `min-w-[400px]` → `min-w-0 md:min-w-[400px]` so they can shrink to a phone's width; the team rail goes `w-full md:w-[280px]`.

### Bottom tab bar (mobile-only, `md:hidden`)

A 56px-tall bar pinned below `<main>`, three equal buttons — **Team** (`Users`), **Chat** (`MessageSquare`), **Workspace** (`Briefcase`) — active tab in cyan, others muted. Each carries a live status dot derived from existing state (no new state):
- Team: green pulse when `workingAgents.length > 0`.
- Chat: amber bounce when any message has a `pending` approval (operator action needed).
- Workspace: cyan count of `diffFiles.length` when non-zero.

The footer status strip becomes `hidden md:flex` — the tab bar replaces it on mobile.

### Header

Below `sm`, hide the project chip, branch chip, and divider; below `md`, hide the cost/token chips. Logo and the logout button always remain. Inside the chat pane, the "Target Directory" readout hides below `sm`. Workspace tab buttons tighten (`px-2 sm:px-3`, `text-[10px] sm:text-xs`) so all four fit a phone width.

### Navigation: tab bar only

Navigation between panes is the bottom tab bar exclusively. **No swipe gestures** — an earlier WIP added left/right touch-swipe on `<main>`, but the handler sat above the Code (Monaco) and Terminal panes, where a horizontal drag to scroll content would fire an accidental pane switch. Operator chose to drop it; the tab bar is unambiguous and conflict-free. (See decision below.)

## Decisions

- **Swipe gestures dropped.** Considered as a bonus on top of the tab bar, but the touch handler on `<main>` conflicts with horizontal scrolling inside Monaco / the terminal / the preset-button row. Operator chose tab-bar-only for v1 over accepting the conflict or scoping swipe to non-workspace panes. ~25 lines of touch state/handlers removed.
- **Default pane `chat`.** The orchestrator conversation is where the operator drives work; team and workspace are reference surfaces.
- **One breakpoint (`md`).** No tablet-specific intermediate layout — desktop three-pane down to `md`, single-pane below. `sm` is used only to progressively hide header chrome, not to change the pane model.

## Out of scope

No landscape-specific layout, no resizable/collapsible desktop panes, no persisting `mobileActiveTab` across reloads, no virtualized lists. Desktop layout unchanged.

## Verification

- `pnpm build` clean, `pnpm test` green (39/39) — mobile work is pure JSX/Tailwind, touches no tested logic module.
- Desktop unchanged: all changes gated behind `md:` / `sm:` modifiers.
- Manual: at `< md`, exactly one pane visible, bottom bar switches panes, badges reflect live state; at `≥ md`, three-pane layout and footer identical to before.
