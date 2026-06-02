# Roster Card Depth + Motion Design

**Date:** 2026-06-01
**Branch:** `feature/roster-polish` (stacked on `feature/at-mention-routing`, off `dev`)
**Scope:** Give the agent-team roster cards (left pane) more visual depth and on-brand motion — they currently read flat. "Noticeably richer" but still restrained, extending the existing motion vocabulary (pulse/ping dots, glow shadows, gradient sheen). Roster only for now; the same language can extend to other surfaces later.

---

## Current state

Roster cards (`mission-control.tsx`, the Sage orchestrator card ~640–696 and the `otherAgents.map` specialist cards ~705–760) use a flat accent tint (`AGENT_ACCENT[id].bg` at `/30`), a transparent idle border, `shadow-inner` when active, a gradient avatar, and a pulsing status dot. The design system: HSL theme tokens (bg `#0a0e14`, card `#11161d`, cyan `#00e0ff`), per-agent gradient avatars, and a motion language of `animate-pulse`/`animate-ping` + glow `shadow-[0_0_Npx_<color>]` + `transition-all` hovers. No custom keyframes today.

## Design

Per-agent accent stays the identity; depth and motion are layered on.

1. **Layered surface (all cards).** Replace the flat tint with a top-lit panel: `bg-gradient-to-b` from the agent tint to a darker base, a 1px inset top highlight (via `ring-1 ring-inset ring-white/[0.04]` or a thin gradient line), a soft outer shadow (`shadow-md shadow-black/30`), and `rounded-lg`.
2. **Hover (all cards).** `transition-all duration-200`, gentle lift `hover:-translate-y-0.5`, brightening border, growing shadow.
3. **Avatar.** Add `shadow-lg`; when the agent is active, a colored glow `shadow-[0_0_14px_-3px_var(--glow)]` + a subtle ring.
4. **Active agent (the "richer" motion).**
   - A slow **breathing glow** around the card in the agent's accent (`animate-[breathe_3s_ease-in-out_infinite]`, box-shadow using `var(--glow)`).
   - An **animated gradient sheen** sweeping diagonally across the card surface (`animate-[sheen_4s_linear_infinite]`, an overlay with a translucent highlight band sliding via `background-position`). Subtle — the AXOD marching-ants DNA.
   - Status dot keeps its existing pulse.
5. **Per-agent glow colors.** A small `AGENT_GLOW: Record<string,string>` of hex accents (e.g. `sage:#00e0ff`, `atlas:#6366f1`, `echo:#8b5cf6`, plus future `nova`/`forge`/`pixel`). Each card sets `style={{ ['--glow']: AGENT_GLOW[id] ?? '#00e0ff' }}`, so glow + sheen tint match the agent. Falls back to cyan.
6. **Two keyframes** added once to `src/app/globals.css`:
   - `@keyframes breathe` — box-shadow pulse between a tight and a wider glow using `var(--glow)`.
   - `@keyframes sheen` — `background-position` slide for the sweeping highlight.

## Reduced motion

Wrap the continuous animations (breathe, sheen) so they're disabled under `@media (prefers-reduced-motion: reduce)` (add the media query in `globals.css`). The active state still reads via the static glow/border.

## Out of scope

Other surfaces (chat bubbles, header, tabs, workspace) — deferred; this pass is the roster only. No new dependencies. No layout/structure changes (same card contents, same data).

## Verification

- `pnpm build` clean; `pnpm test` unchanged (51/51 — pure presentational, no logic).
- Live eyeball: idle cards have subtle depth + hover lift; the active agent shows the breathing glow + gentle sheen in its accent color; reduced-motion users get the static treatment. Iterate intensity live if needed.
