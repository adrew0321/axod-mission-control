# Collapsible Nav Sidebar (Epic C1) — Design

**Date:** 2026-06-06
**Branch:** `feature/nav-sidebar` (off `dev`)
**Scope:** Replace the fixed left roster `<section>` with a **collapsible left navbar** that starts with **Agent Team** and carries a forward-looking section set (OpenClaw operational + Hermes pillars) as disabled "soon" placeholders. The navbar toggles between a minimized **icon rail** and a maximized **labeled sidebar** (persisted). Agent Team becomes **runtime-aware** (every agent shows a `claude-sdk` runtime badge today — the seam for future Hermes/OpenClaw runtimes). This is C1 of the Epic-C polish work; the broader typography/thread/accent polish is **C2** (separate).

---

## Why (context)

The roster lives in a fixed 280px `<section>` (`mission-control.tsx`). The operator wants a navbar that (a) starts with the agent team, (b) minimizes/maximizes between an icon rail and a labeled sidebar, and (c) has room to grow into the OpenClaw operational views + the Hermes "Five Pillars" (Memory, Skills, Soul, Crons, Self-Improvement/Dreaming). Research (`docs/superpowers/specs/...` discussion) showed OpenClaw Mission Control + Hermes Agent OS converge on exactly this multi-section, runtime-aware dashboard. C1 builds the **shell + Agent Team**; the rest are placeholders to wire up in later epics. **No existing agent or data model changes** — this is UI structure + a cosmetic runtime label.

## Section information architecture

A single typed config (`src/lib/nav-sections.ts`) is the source of truth. `status: 'live' | 'soon'`; `group: 'operational' | 'system'`.

| id | label | group | status | future |
|---|---|---|---|---|
| `agent-team` | Agent Team | operational | **live** | the roster (Fleet/Registry) |
| `live-feed` | Live Feed | operational | soon | cross-agent event stream |
| `task-board` | Task Board | operational | soon | Kanban over task phases |
| `proposals` | Proposals | operational | soon | HITL approval inbox (badge = pending) |
| `skills` | Skills | system | soon | Hermes skills library / Skills Hub |
| `memory` | Memory | system | soon | Hermes cross-session memory + docs |
| `dreaming` | Dreaming | system | soon | Hermes Curator / self-improvement |
| `scheduler` | Scheduler | system | soon | Hermes crons / recurring jobs |

Plus two pinned-to-bottom items (not in the scrollable list): **Settings** (`soon`) and **Logout** (`live` — calls the existing `/api/auth/logout` flow). (Cost/Metrics stays in the header; Security can be appended to the config later — both are one-line additions.)

## Component: `NavSidebar` (`src/components/nav-sidebar.tsx`)

Replaces the roster `<section>` in `mission-control.tsx`. Props: `{ team, sage, otherAgents, workingAgents, agentActivity }` (the roster data the current section already computes) — passed through unchanged so the roster rendering moves verbatim.

**Two states**, toggled by a chevron button and persisted to `localStorage` (`mc_nav_collapsed`, read on mount):

- **Expanded (maximized) — labeled sidebar (~210px):**
  - Top: `MC` logo + app name + a collapse chevron (`«`).
  - **Section nav** (from the config), grouped (Operational / System) with small uppercase group labels; each row = icon + label. `live` rows are interactive (Agent Team is selectable/active); `soon` rows are dimmed, non-interactive, with a small "soon" tag + `title="Coming soon"`.
  - The **Agent Team** section is the active/open one: directly under it renders the **roster** (the Sage card + the scrollable other-agent cards) — moved verbatim from today's section, each card gaining a small **runtime badge** (`claude-sdk`).
  - Bottom (pinned): Settings (soon) + Logout (live).
- **Collapsed (minimized) — icon rail (~52px):**
  - Logo, then section **icons** only (active highlighted; `soon` dimmed), tooltips via `title`. Under Agent Team, the agents render as compact **avatar icons** (the existing `AGENT_ICON`/color, tooltip = name). Bottom: settings + logout icons. An expand chevron (`»`).

**Runtime-aware Agent Team:** each agent card/avatar shows `claude-sdk` (a tiny monospace badge in expanded; a dot/omitted in collapsed). Static for now — the seam for a future `runtime` field. No data change.

**Mobile:** keep today's behavior — the navbar occupies the `mobileActiveTab === "team"` pane (`hidden md:flex` rules preserved); on mobile it renders expanded.

## Data flow

`mission-control.tsx` computes `sage`/`otherAgents`/`workingAgents`/`agentActivity` as it does now and passes them to `<NavSidebar>` instead of inlining the roster. Collapse state is local to `NavSidebar` (localStorage). Section clicks: Agent Team is the only live target (no-op beyond staying active); `soon` rows do nothing. Logout calls the existing logout handler (lifted via a prop or replicated `fetch('/api/auth/logout')` → `router.replace('/login')`).

## Pure config + test (`src/lib/nav-sections.ts` + test)

The section list is a typed constant; a node:test asserts intent so flags don't drift:
- `NAV_SECTIONS` includes `agent-team` as the only `status: 'live'` entry; all others `soon`; ids unique; each has `label`, `icon` (a lucide name), `group`.

## Error handling

- Corrupt/missing `mc_nav_collapsed` → default to expanded.
- `soon` sections are inert (disabled), so there are no dead clicks.

## Testing

- **Unit (node:test):** `NAV_SECTIONS` shape (agent-team live + only-live; unique ids; required fields present).
- **Build + manual:** `pnpm build` clean; `pnpm test` green (existing + the config test). Manual: roster still shows the 6 agents with status + a `claude-sdk` badge; collapse → icon rail (agent avatars + section icons, tooltips); expand → labeled sidebar; the toggle **persists** across reload; `soon` rows are dimmed/non-interactive with a "coming soon" tooltip; Logout works; mobile "team" tab shows the navbar.

## Out of scope (later epics)

C2 polish (typography/spacing/thread/accents) · making any `soon` section functional (Skills/Memory/Dreaming/Scheduler/etc.) · a real `runtime` field or Hermes/OpenClaw runtime integration (the badge is cosmetic now) · drag-resizing the navbar (it's a two-state toggle).

## What actually happened (2026-06-06)

Shipped on `feature/nav-sidebar` via inline execution. Build clean, `pnpm test` **74/74** (72 + 2 `NAV_SECTIONS` tests).

- The design **evolved during the smoke** (operator feedback): instead of the roster living *inside* the navbar, the rail became a thin **view-switcher** and the **roster moved out** into `RosterPanel` as the first column of the **Agent Team view** (`rail | roster | session logs | workspace`). "Agent Team" is the one live view; the other sections (Live Feed / Task Board / Proposals / Skills / Memory / Dreaming / Scheduler) are dimmed "soon" placeholders that will each become their own view.
- Shared agent bits (`AGENT_ICON/ACCENT/GLOW`, `AgentIcon`, `idleState`) were extracted to `mission-control-bits.tsx` so the thread and the roster share one source.
- Each agent shows a cosmetic `claude-sdk` runtime badge (the seam for a future `runtime` field → Hermes/OpenClaw runtimes).
- One alignment fix from the smoke: the roster header was `p-3` (uneven with the `h-11` Session Logs / tab headers); set to `h-11` so all top sub-headers' bottom borders line up, and the roster section forced to full height.
- **Next epics (queued):** C2 polish; making the `soon` sections live (Skills/Memory/Dreaming/Scheduler/Live Feed/Task Board/Proposals); the real Hermes runtime integration + Dream/Curator engine.
