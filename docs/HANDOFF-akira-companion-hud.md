# Handoff: Build the AKIRA Local Companion native HUD

> **You are picking up a fully-specified build.** Everything you need is in two files:
> 1. **The plan** — `docs/superpowers/plans/2026-07-02-akira-companion-hud.md` (your task-by-task
>    source of truth: exact files, complete code, tests, commits)
> 2. **The design spec** — `docs/superpowers/specs/2026-07-02-akira-companion-hud-design.md`
>    (the "why" behind the plan; read it once for context)
>
> This document is the onboarding wrapper: project conventions and the few things the plan
> assumes but doesn't spell out. Read this first, then execute the plan.

---

## What you're building (one paragraph)

The AKIRA Local Companion is a Node process on the **laptop** that gives AKIRA (running on the
Mac Mini) hands on a persistent Playwright browser. Today it runs **headless** and hard-gated
actions (buy / pay / send / delete …) surface in the Mini's web HUD. This build gives the
Companion a **native, always-on-top Electron HUD on the laptop**: a full glass panel (connection,
presence, pending-approval queue, security posture) that collapses to a draggable orb. It adds a
**localhost-only WebSocket bridge** (`127.0.0.1`, token-file auth) between the Companion and the
HUD, and moves the hard-gate approval queue **local** — you Approve/Deny/Stop on the laptop and
the Mini no longer needs to be reachable to resolve a gate. When the HUD isn't running the
Companion falls back to the existing Mini approval path.

## How to execute the plan

Work the plan **straight through, task by task, in order (Task 1 → Task 7).** Each task is broken
into bite-sized TDD steps:

1. Write the failing test → 2. Run it, confirm it fails for the stated reason → 3. Write the
minimal implementation (code is given verbatim — use it) → 4. Run the test, confirm it passes →
5. Commit with the exact message in the step.

Do **not** batch tasks or skip the test-first steps. Commit after every task. Tasks 1–2 are pure
TDD; Tasks 3–6 include **manual verification steps** (booting the bridge, running Electron, driving
a real gate) — those need a human at the machine, so run them and report; don't fake them. If a
step's "Expected" output doesn't match what you see, **stop and investigate** before moving on.

If you have the **superpowers:subagent-driven-development** skill, use it (fresh subagent per task
+ review). If not, just work the tasks straight through as above.

## Project conventions you MUST follow (these aren't all in the plan)

- **This is NOT the Next.js you know.** This repo runs a build of Next.js with breaking changes vs.
  public docs. Before writing/debugging anything framework-level, read the relevant guide in
  `node_modules/next/dist/docs/`. Don't trust training data for Next APIs here. (The HUD itself is
  plain Electron + HTML/JS, not Next — but the root `pnpm build` in Final Verification is Next.)
- **Package manager is `pnpm`**, not npm. Root `.npmrc` has `ignore-scripts=true` **on purpose** —
  don't "fix" it. That's why Electron's binary may not auto-download: the plan has you allowlist
  `electron` in `companion-hud`'s `onlyBuiltDependencies` and, if needed, run
  `node node_modules/electron/install.js` manually (same pattern Playwright uses in `companion/`).
- **Tests** run via `tsx --test` (`node:test` + `node:assert/strict`). Use **extensionless** relative
  imports (`./gate-queue`, not `./gate-queue.ts`). New `companion/src/*.test.ts` files are auto-run
  by both `cd companion && pnpm test` and root `pnpm test`. **Automated tests cover pure logic only**
  (gate-queue, bridge-protocol); sockets/Electron/live browser are manual — consistent with the
  already-untested `browser.ts`/`connection.ts`.
- **`companion/` and `companion-hud/` are laptop-only.** Each is its own self-contained pnpm project
  (own `pnpm-workspace.yaml` with `packages: ['.']`), installed with its own `pnpm install`, and must
  stay out of the root `next build` / `tsc`. Playwright and Electron must never reach the Mini.

## Git rules (important)

- **The branch already exists: `feat/akira-companion-hud`, cut off `dev`.** The design spec and plan
  are already committed on it. Just keep committing there.
- **Work directly in this main checkout on that feature branch — do NOT use a git worktree.** On this
  Windows machine, Playwright, Electron, and `next build` cannot run inside a linked worktree (the
  junctioned `node_modules` breaks Turbopack / native binaries). The main checkout is the only place
  the build works. (This overrides the ship-mc-feature skill's generic "use a worktree" default for
  this feature — same exception the previous Companion handoff made.)
- When all 7 tasks are done and `pnpm test` + `pnpm exec tsc --noEmit` are green, **merge the feature
  branch into `dev`** (`git checkout dev && git merge --no-ff feat/akira-companion-hud`).
- **STOP after merging to `dev`. Do NOT push to `main`, do NOT bump the version, do NOT tag, do NOT
  deploy to the Mini.** `main` is release-only; release (Phase 4) and deploy (Phase 5) are separate,
  human-gated steps in the ship-mc-feature skill. Out of scope for this handoff.
- End commit messages with the repo trailer: `Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>`.

## Definition of done

From the plan's "Final verification" — confirm all before merging to `dev`:

- [ ] `cd companion && pnpm test` — `guard`, `page-snapshot`, `gate-queue`, `bridge-protocol` all pass.
- [ ] Root `pnpm test` — full suite green.
- [ ] `cd companion && pnpm exec tsc --noEmit` — clean.
- [ ] Root `pnpm build` — clean; `companion/` and `companion-hud/` are NOT in the Mini build.
- [ ] Manual E2E (Task 6, Step 3): Companion + HUD run; CONNECTED + ticking timer + presence render;
      a gated click surfaces in the HUD; Approve runs it, Deny reports back, Stop aborts; minimize⇄orb
      works; window stays always-on-top.
- [ ] Feature branch merged into `dev`. Not pushed to `main`, not tagged, not deployed.

## Scope guardrails

- **In scope:** the localhost bridge, local gate-hold queue, and the Electron HUD (panel + orb).
- **Out of scope (do not build):** file transfer laptop↔Mini (its own next slice), packaging /
  installer / autostart / code-signing, and any new AKIRA *capability* (her hands stay
  `navigate / read / type / click`).

## Notes for the human (NOT the build agent)

- No Mini change is needed for this feature: approvals resolve locally, no DB migration, no new Mini
  env var. So Phase 5 (deploy) has nothing to do beyond the eventual normal release of `dev`→`main`.
- Optional `COMPANION_OPERATOR` env sets the name shown in the HUD's presence panel (default
  `Operator`).
- Running it: `cd companion && pnpm start` in one terminal, `cd companion-hud && pnpm start` in
  another (Companion first — it writes the bridge file the HUD reads).
