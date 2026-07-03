# Handoff: Build the AKIRA Local Companion

> **You are picking up a fully-specified build.** Everything you need is in two files:
> 1. **The plan** — `docs/superpowers/plans/2026-06-29-akira-local-companion.md` (your task-by-task source of truth: exact files, complete code, tests, commits)
> 2. **The design spec** — `docs/superpowers/specs/2026-06-29-akira-local-companion-design.md` (the "why" behind the plan; read it once for context)
>
> This document is the onboarding wrapper: project conventions and the few things the plan assumes but doesn't spell out. Read this first, then execute the plan.

---

## What you're building (one paragraph)

AKIRA is an AI concierge running on a Mac Mini ("the Mini", production). The **Local Companion** is a new process that runs on this **laptop** and gives AKIRA hands on the machine: it drives a persistent Playwright browser (navigate / read / type / click) on her behalf. The Companion dials **outbound** to the Mini over SSE to receive commands and POSTs results back — no inbound ports on the laptop. Irreversible actions (buy / pay / send / delete / transfer, payment fields, sensitive domains) are **hard-gated at the Companion** and require explicit human approval surfaced in AKIRA's HUD. The user logs into sites once via a persistent browser profile; AKIRA never stores or types passwords.

## How to execute the plan

The plan was written for a Claude "subagent-driven development" workflow. You don't have that skill — **ignore the `REQUIRED SUB-SKILL` line at the top of the plan.** Instead, just work it straight through, task by task, in order (Task 1 → Task 12). Each task is already broken into bite-sized TDD steps:

1. Write the failing test.
2. Run it, confirm it fails for the stated reason.
3. Write the minimal implementation (the code is given verbatim — use it).
4. Run the test, confirm it passes.
5. Commit with the exact message in the step.

Do **not** batch tasks or skip the test-first steps. Commit after every task. If a step's "Expected" output doesn't match what you see, stop and investigate before moving on — don't paper over it.

## Project conventions you MUST follow (these aren't in the plan)

- **This is NOT the Next.js you know.** This repo runs a build of Next.js with breaking changes vs. public docs. Before writing or debugging anything framework-level (route handlers, SSE, runtime config), read the relevant guide in `node_modules/next/dist/docs/`. Heed deprecation notices. Don't trust your training data for Next APIs here.
- **Package manager is `pnpm`**, not npm. `.npmrc` has `ignore-scripts=true` on purpose — don't "fix" it.
- **Tests** run via `tsx --test` (see the `test` script in `package.json`). Use **extensionless** relative imports in TS (`./guard`, not `./guard.ts`) — the `.ts` extension breaks the build. Tests cover **pure logic only**; Playwright / live-SSE are manual/integration and are not in the automated suite.
- **The `companion/` package is laptop-only.** Playwright is installed there and nowhere else. `companion/` is excluded from the root `tsconfig.json` so `next build` / `tsc` never sees Playwright. Keep it that way (Task 2, Step 1 sets this up).

## Git rules (important)

- **Branch off `dev`**, not `main`. Create a feature branch like `feat/akira-local-companion`.
- **Work directly in this checkout on that feature branch — do NOT use a git worktree.** On this Windows machine, Playwright and `next build` cannot run inside a linked worktree (the junctioned `node_modules` breaks Turbopack). The main checkout is the only place the build works.
- When all 12 tasks are done and `pnpm test` + `pnpm build` are green, **merge the feature branch into `dev`** (`git checkout dev && git merge --no-ff feat/akira-local-companion`).
- **STOP after merging to `dev`. Do NOT push to `main`, do NOT tag a release, do NOT deploy to the Mini.** `main` is release-only and deploys are done by a separate, human-gated process. Releasing/deploying is explicitly out of scope for this handoff.

## Definition of done

From the plan's "Final verification" section — confirm all of these before merging to `dev`:

- [ ] `pnpm test` — the new `guard`, `page-snapshot`, and `registry` suites pass alongside the existing tests.
- [ ] `pnpm build` — clean; routes `/api/companion/stream`, `/api/companion/result`, `/api/companion/approve` are present; `companion/` is excluded from the build.
- [ ] On the laptop: `cd companion && pnpm install && pnpm exec playwright install chromium && pnpm exec tsc --noEmit` all succeed.
- [ ] (Optional, manual E2E — needs the Mini reachable) Start the Companion → HUD shows "laptop ●" → ask AKIRA to open a site → browser opens and she reads/navigates → a buy/send/delete attempt raises the smooth hard-gate approval card and only runs on Approve.
- [ ] Feature branch merged into `dev`. Not pushed to `main`, not deployed.

## Deploy note (for the human, NOT you)

When this is eventually released, the Mini needs `COMPANION_TOKEN` set in its `.env` (new env var only — **no database migration** in this feature). Playwright is never installed on the Mini. That release/deploy is a separate human-run step — leave it to them.
