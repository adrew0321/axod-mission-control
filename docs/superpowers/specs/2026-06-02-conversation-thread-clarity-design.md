# Conversation Thread Clarity Design

**Date:** 2026-06-02
**Branch:** `feature/clear-session-log` (stacked with the Clear work; lands on `dev` together)
**Scope:** Make the chat thread easier to scan — messages were full-width, tightly spaced (`space-y-4`), and similarly colored, so they blurred together with no anchor for "who's speaking." Operator chose the **avatars + per-speaker accent, full-width** direction.

---

## Design (operator-approved)

In `mission-control.tsx`, each message in the conversation map becomes an **avatar + content-column row** (`flex gap-2.5`):

1. **Avatar gutter (6×6, left).**
   - `user` → a cyan **"AX"** gradient badge (the operator).
   - `agent` → the speaker's gradient avatar + `AgentIcon` (Sage compass, Atlas hammer, Echo bug), looked up from `team` by `agentId`.
   - `system` → a muted `❖` box. (The previously-inline `❖` in the system bar is removed to avoid a double.)
2. **Per-speaker left-accent.** The user bubble and each agent segment bubble get `border-l-2` with `style={{ borderLeftColor: accent }}`, where `accent` is cyan for the operator and Sage, and the agent's `AGENT_GLOW` hue otherwise (Atlas indigo, Echo violet). Ties each bubble to its author and matches the roster accents.
3. **More breathing room.** Container spacing `space-y-4` → `space-y-5`; the avatar gutter further separates rows.
4. **Everything else intact.** Header (name · attribution · time), the `via Sage` tag, multi-segment agent output, the `working…` spinner, the Orchestrated-Dispatch card, the approval card, and the empty-state all keep working — just re-housed in the content column.

System messages keep their full-width bar in the content column next to the `❖` avatar.

## Out of scope

Chat-style left/right sided alignment · changing message contents/data · the workspace tabs. Pure presentational.

## Verification

- `pnpm build` clean; `pnpm test` 51/51 (no logic touched).
- Live: each message shows its author's avatar + accent edge; Sage/Atlas/Echo and the operator are distinguishable at a glance; rows have clear separation. Dispatch/approval cards and the empty-state still render correctly.
