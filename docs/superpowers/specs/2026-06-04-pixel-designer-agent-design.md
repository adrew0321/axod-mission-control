# Pixel — Designer Agent Design

**Date:** 2026-06-04
**Branch:** `feature/pixel-designer` (off `dev`)
**Scope:** Add **Pixel**, the designer agent — the sixth and final specialist Sage can dispatch, completing the v1 roster (Sage · Atlas · Echo · Nova · Forge · Pixel). Pixel builds **code mockups** — real HTML/CSS/Tailwind/SVG pages + components in the session's worktree that render live in the existing Preview tab. A **full doer** (can edit + run + git), distinct from Atlas (app logic) — Pixel owns layout, visual hierarchy, and styling. Roadmap item **v1.3/v1.4** (the designer half of the team).

---

## Key finding: code mockups need no new tool plumbing

The roadmap assumed Pixel needed an `image_generate` tool. It doesn't — a *designer who produces code mockups* reuses the write/exec tools Atlas already has (`Edit`, `Write`, `Bash`), which the runner passes through. Crucially, the **Preview tab already builds the worktree's site (`astro build`) and serves it**, including HTML/CSS/SVG and raster assets (`src/lib/preview.ts` `CONTENT_TYPES`). So a mockup Pixel writes as a real route/component renders live with zero new infrastructure. Like Echo/Nova/Forge before it, Pixel is just: a DB row + a `DISPATCHABLE` entry + a Sage-prompt update + permissions + three UI cohesion touches. **No runner changes, no new tools, no schema migration.** The roster UI (Palette icon + pink accent via `AGENT_ICON`/`AGENT_ACCENT`/`AGENT_GLOW`) and `ROLE_LABEL` (`designer → "Designer"`) are already reserved, so **no `page.tsx` change either**.

Raster image generation (an `image_generate` MCP tool + external provider) is explicitly deferred — a possible future Pixel power, not needed for a useful v1 designer.

## Identity (the DB row, in `scripts/seed.ts`)

```ts
{
  id: 'pixel',
  name: 'Pixel',
  role: 'designer',
  model: 'claude-sonnet-4-6',
  system_prompt: PIXEL_SYSTEM_PROMPT,
  tools_allowlist: ['Read', 'Glob', 'Grep', 'Edit', 'Write', 'Bash', 'WebFetch'],
  color: 'from-pink-400 to-rose-600',
}
```

- **Full doer** — same toolset as Atlas/Forge. `Bash` for building/previewing and installing design deps (icons/fonts); `WebFetch` for design references. **No `dispatch_agent`** (only Sage's runner gets that).
- **Model:** `claude-sonnet-4-6` (matches the roadmap; visual/layout reasoning wants the headroom, and it keeps the doers — Atlas, Forge, Pixel — consistent). **Haiku 4.5 is the documented fallback** — a one-line swap, since `model` is a per-agent DB column.
- `color` matches the roster's pink accent for `pixel` (`#ec4899`).

## Pixel's system prompt (output contract + distinct persona)

`PIXEL_SYSTEM_PROMPT` — a designer who owns the visual layer and produces editable code mockups, deliberately distinct from Atlas's app-logic focus. Voice leans artist/studio (Palette, pink). Plain text, no inner backticks (keeps the template literal clean):

```
You are Pixel, the designer on AXOD's agent team.

Sage dispatches you to design — mock up pages and sections, build UI components,
and refine layout, visual hierarchy, spacing, and styling — inside this session's
isolated git worktree. You build with code (HTML/CSS/Tailwind/SVG), not throwaway
raster art, so your work is real and editable. Unlike Atlas, who writes
application logic, you own how things look and feel.

How you work:
- Read before you design. Match the project's existing design system, components,
  and conventions (its Tailwind config, tokens, fonts) — fit in, do not reinvent.
- Build mockups as real routes/components so they render live in the Preview tab.
  After changes, run the build to confirm they compile and preview.
- Prefer semantic, accessible markup and the project's existing utility classes.
  Keep visuals tasteful and consistent; call out anything that is a placeholder.

Your output is a report, in this shape:

DESIGNED: <what you built or changed, concretely>
PREVIEW: <which page/route to open in the Preview tab to see it>
NOTES: <design choices; what is mock vs production-ready; any follow-ups>

Rules:
- Verify it builds before you claim it is ready — run the build, report the result.
- Push or deploy ONLY when Sage's task explicitly grants approval.
- Be honest about gaps and placeholders. Keep it tight — Sage relays this to the operator.
```

## Letting Sage dispatch Pixel (`src/lib/dispatch.ts`)

1. `const DISPATCHABLE = ['atlas', 'echo', 'nova', 'forge', 'pixel'] as const;`
2. Update the `agent_id` enum description and the tool description so Sage understands the five specialists, adding: **Pixel** (designer — builds UI mockups/components in code that render in the Preview tab; can edit + run).
3. Update `SAGE_SYSTEM_PROMPT` (`scripts/seed.ts`): add Pixel to the team capability line and a cue — dispatch Pixel for design/UI/layout/mockups/visual-styling work; relay Pixel's DESIGNED/PREVIEW/NOTES report and point the operator at the Preview tab.

## Permissions (`tool_permissions`) — dormant in v1, mirror Atlas

Seed rows mirroring Atlas (read tools `always`; mutating ops `ask`):
```ts
{ agent_id: 'pixel', project_id: 'axod-creative', tool_name: 'read_file', policy: 'always' },
{ agent_id: 'pixel', project_id: 'axod-creative', tool_name: 'glob', policy: 'always' },
{ agent_id: 'pixel', project_id: 'axod-creative', tool_name: 'grep', policy: 'always' },
{ agent_id: 'pixel', project_id: 'axod-creative', tool_name: 'edit', policy: 'ask' },
{ agent_id: 'pixel', project_id: 'axod-creative', tool_name: 'run_command', policy: 'ask' },
{ agent_id: 'pixel', project_id: 'axod-creative', tool_name: 'git', policy: 'ask' },
```
These feed the dormant approval gate (doesn't fire on SDK 0.3.x); `tools_allowlist` is what constrains Pixel at runtime. The no-push-without-approval discipline lives in the system prompt.

## UI polish (`src/components/mission-control.tsx`)

The roster already renders Pixel (Palette icon + pink accent via `AGENT_ICON`/`AGENT_ACCENT`/`AGENT_GLOW`), and `page.tsx` `ROLE_LABEL` already maps `designer → "Designer"`. Three small cohesion touches:
- Add Pixel to `speakerStyle` (thread bubble): `{ accent: '#ec4899', tint: 'rgba(236,72,153,0.08)' }` so Pixel's messages (and its dispatch card) read pink.
- Add a Pixel `IDLE_STATE` line: `"Brushes down — ready to design"`.
- Add a Pixel branch to `friendlyActivity` (artist/studio voice):
  - `Edit`/`Write`/`MultiEdit`/`NotebookEdit` → "Sketching → <file>".
  - `Read` → "Studying the canvas: <file>".
  - `Bash`: build/preview commands → "Rendering the mockup…"; otherwise → "Mixing tools: <cmd>".
  - `Glob` → "Surveying the canvas…".
  - `Grep` → "Matching swatches…" (with pattern when present).
  - `WebFetch`/`WebSearch` → "Gathering inspiration…".
  - `TodoWrite` → "Sketching the layout…".
  - default → generic fallback.

## Out of scope

`image_generate` / raster image generation (deferred — possible future Pixel power) · the actual VPS deploy infrastructure (Week 5) · an in-UI per-agent model switcher · changing the dispatch mechanism · runner/schema changes.

## Verification

- `pnpm build` clean; `pnpm test` stays 54/54 (config + prompt; no pure-module logic added).
- Re-seed: `pnpm seed` upserts Sage's prompt and inserts Pixel; roster shows Pixel (pink, Palette) — `agents` count 5 → 6, `tool_permissions` 21 → 27.
- Live smoke: operator asks Sage a design task (e.g. "Pixel, mock up a pricing section for the landing page") → Sage dispatches Pixel → Pixel builds the mockup as a real route/component, runs the build, returns a `DESIGNED / PREVIEW / NOTES` report → operator opens the named route in the Preview tab and sees it. Confirm Pixel can act (edit/run) but does NOT push or deploy without explicit approval.

## What actually happened (2026-06-04)

Shipped on `feature/pixel-designer` via subagent-driven execution. Pixel completes the six-agent v1 roster (Sage · Atlas · Echo · Nova · Forge · Pixel).

- The "no new plumbing" finding held: a code-mockup designer reuses Atlas's existing `Edit`/`Write`/`Bash`, and the Preview tab already builds + serves the worktree site, so no `image_generate` tool was needed. The change was the `DISPATCHABLE` entry + dispatch descriptions, the seed row + Sage-prompt updates + `tool_permissions`, a `dispatchFlavor` `pixel` case ("Pixel sets up the easel"), and three UI cohesion touches. `ROLE_LABEL` already had `designer → "Designer"`, so no `page.tsx` change.
- Model: `claude-sonnet-4-6` (Haiku 4.5 documented fallback).
- Verification clean: `pnpm build` compiled; `pnpm test` 54/54 (51 + 3 helper tests); `pnpm seed` → `agents: 6`, `tool_permissions: 27`; the `pixel` row matched this spec exactly; roster shows Pixel (pink, Palette, "Designer").
- **Two pre-existing UI bugs surfaced during the smoke and were fixed (not caused by Pixel)** — committed on this branch:
  1. **Conversation "snap back up"** on load / after a turn. Root cause: an unguarded `scrollIntoView({behavior:"smooth"})` plus the `persisted` handler dropping the streamed bubbles and then `router.refresh()` re-adding their DB copies with new React keys (remount + scroll collapse). Fixed by pinning to the bottom instantly via the container's `scrollTop`, with a near-bottom guard + first-load jump.
  2. **Roster not scrollable** (6th agent, Pixel, cut off). Fixed by adding `min-h-0` to the roster `ScrollArea` (the same flexbox fix as the terminal scroll, commit `5608212`).
- Live design smoke (operator-run): the dispatch flow was observed working (Sage scans the target repo and dispatches Pixel); a full mockup-render confirmation can be run anytime on `dev`.
