# Handoff: Build AKIRA's Long-Term Memory

> **You are picking up a fully-specified build.** Everything you need is in two files:
> 1. **The plan** — `docs/superpowers/plans/2026-07-03-akira-long-term-memory.md`
>    (your task-by-task source of truth: exact files, complete code, tests, commits)
> 2. **The design spec** — `docs/superpowers/specs/2026-07-03-akira-long-term-memory-design.md`
>    (the "why"; read it once for context)
>
> This document is the onboarding wrapper: conventions + the few things the plan
> assumes but doesn't spell out. Read this first, then execute the plan.

## What you're building (one paragraph)

AKIRA (an AI concierge on a Mac Mini) currently forgets everything past the last 24
turns. This gives her a persistent **Obsidian-style Markdown memory vault** — a git
repo checked out at `data/akira-memory/` on the Mini. She reads a `## MEMORY` index
into her prompt each turn and writes durable notes in-the-moment via two **scoped**
tools (`remember` upsert / `forget` delete) that can only write inside the vault (she
never gets a generic `Write` tool). The operator browses it in the Obsidian app
(git-synced) and in a **PIN-locked "Settings" section on the AKIRA front door** that
stays collapsed until unlocked. Plaintext, private-repo, model-agnostic.

## How to execute the plan

You have the **subagent-driven-development** skill — use it: one fresh subagent per
task, review between tasks. Work the tasks **in order, Task 1 → Task 8.** Each task is
already broken into bite-sized TDD steps (write failing test → run it, confirm the
stated failure → paste the given implementation → run, confirm pass → commit). Tasks
1–3 are pure/fs TDD; 4–8 are wiring + UI with concrete manual-verify steps. **Commit
after every task** with the exact message given. Don't batch tasks or skip the
test-first steps. If a step's "Expected" output doesn't match, **stop and investigate**
before moving on.

## Project conventions you MUST follow (not all in the plan)

- **This is NOT the Next.js you know.** This repo runs a build of Next.js (v16.x) with
  breaking changes vs. public docs — its middleware is `src/proxy.ts`, dynamic-route
  params are a `Promise` you `await`, etc. **Before writing/debugging any route or
  framework code, read the relevant guide in `node_modules/next/dist/docs/`** and
  match the existing routes (e.g. `src/app/api/sessions/[id]/*`). Don't trust training
  data for Next APIs here.
- **Package manager `pnpm`**; `.npmrc` has `ignore-scripts=true` **on purpose** — leave
  it. **This feature adds NO npm dependency** (frontmatter parsed by hand; git via
  `node:child_process`). If you find yourself wanting a yaml/gray-matter dep, don't.
- **Tests** run via `tsx --test` (`node:test` + `node:assert/strict`), **extensionless**
  relative imports (`./note`, not `./note.ts`). Task 1 Step 5 updates the root `test`
  glob to include `src/lib/akira/memory/*.test.ts` — do it, or the new tests won't run
  under `pnpm test`.
- **No DB migration** in this feature. `data/akira-memory/` is gitignored (Task 8) — it's
  a separate repo, never committed into the app repo.

## Git rules (important)

- **The branch already exists and you're on it: `feat/akira-long-term-memory`**, cut
  from current `dev` (v1.11.4), with the spec + plan already committed. Just keep
  committing here — no branch setup, start at Task 1.
- **Work in THIS main checkout — do NOT use git worktrees** (not for the parent, not
  for subagents). On this Windows machine Turbopack/`next build` break on a linked
  worktree's junctioned `node_modules`; the main checkout is the only place the build
  works. This overrides the generic "use a worktree" default. (Subagents edit files in
  this shared checkout — that's fine.)
- When all 8 tasks are done and `pnpm test` + `pnpm exec tsc --noEmit` + `pnpm build`
  are green, **merge into `dev`** (`git checkout dev && git merge --no-ff
  feat/akira-long-term-memory`).
- **STOP after merging to `dev`.** Do NOT bump the version, tag, push to `main`, or
  deploy. Release (Phase 4) + deploy + the one-time vault setup are a separate,
  human-gated step done by the operator. Out of scope for you.
- End commit messages with: `Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>`.

## Definition of done (from the plan's Final Verification)

- [ ] `pnpm test` — new `note`, `pin`, `store` suites pass alongside the rest.
- [ ] `pnpm exec tsc --noEmit` — clean.
- [ ] `pnpm build` — clean; `/api/memory` and `/api/memory/[slug]` present.
- [ ] Manual (local, no vault needed): the front-door **Settings** panel locks; with
      `AKIRA_MEMORY_PIN` set it unlocks, re-locks, 429s on brute force, renders the
      (empty) grid. (Without the env set, every PIN correctly fails.)
- [ ] Feature branch merged into `dev`. **Not** released, tagged, or deployed.

## Scope guardrails

- **In scope:** `note.ts`, `pin.ts`, `store.ts`, `remember`/`forget` tools, prompt
  injection + pre-turn pull, `/api/memory` routes, the locked Settings panel, and the
  setup runbook (Task 8 is docs only — do NOT create the real GitHub repo or deploy key).
- **Out of scope (do not build):** nightly auto-distillation, encryption at rest,
  vector search, a dashboard memory view, editing/creating notes from the UI, and the
  actual Mini vault provisioning (that's deploy-time, human-run).

## Notes for the human (NOT you, the build agent)

- The build works **without** a vault — tools say "not configured", the panel shows no
  notes. Real value comes after the operator runs `docs/runbook-akira-memory.md` on the
  Mini at deploy time (private repo + deploy key + clone at `data/akira-memory/` +
  `AKIRA_MEMORY_PIN` in `.env`). No npm deps, no migration for this release.
