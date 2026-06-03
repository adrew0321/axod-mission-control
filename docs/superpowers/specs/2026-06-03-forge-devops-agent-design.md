# Forge — DevOps / Release Agent Design

**Date:** 2026-06-03
**Branch:** `feature/forge-devops` (off `dev`)
**Scope:** Add **Forge**, the devops/release agent — the fourth specialist Sage can dispatch. Forge owns the build-and-ship side: runs builds/tests/lint, manages git (branch/commit/tag), and edits infrastructure config (CI workflows, Dockerfile, Caddyfile, deploy scripts) inside the session's isolated git worktree. A **full doer** (can edit + run + git), distinct from Atlas who writes application code. Roadmap item **v1.3** (with Pixel, built separately).

---

## Key finding: no new tool plumbing (a full doer reuses Atlas's tools)

Forge is a *doer* like Atlas, so it needs the write/exec tools (`Edit`, `Write`, `Bash`) — but those are **already wired** and passed through by the runner; Atlas uses the exact same set. Git operations run through `Bash`. So Forge, like Echo and Nova before it, is just: a DB row + a `DISPATCHABLE` entry + a Sage-prompt update + permissions + three UI cohesion touches. **No runner changes, no new tools, no schema migration.** The roster UI (Cog icon + amber accent via `AGENT_ICON`/`AGENT_ACCENT`/`AGENT_GLOW`) and `ROLE_LABEL` (`devops → "DevOps"`) are already reserved, so **no `page.tsx` change either**.

## Identity (the DB row, in `scripts/seed.ts`)

```ts
{
  id: 'forge',
  name: 'Forge',
  role: 'devops',
  model: 'claude-sonnet-4-6',
  system_prompt: FORGE_SYSTEM_PROMPT,
  tools_allowlist: ['Read', 'Glob', 'Grep', 'Edit', 'Write', 'Bash', 'WebFetch'],
  color: 'from-amber-400 to-orange-600',
}
```

- **Full doer** — same toolset as Atlas. Git happens via `Bash`; `WebFetch` is for looking up GitHub Actions / Caddy / Docker syntax. **No `dispatch_agent`** (only Sage's runner gets that).
- **Model:** `claude-sonnet-4-6` — chosen over the roadmap's original Haiku 4.5 because Forge edits infra config (Dockerfile/Caddyfile/CI YAML) where a subtle, uncompiled mistake silently breaks a deploy; reasoning headroom matters, and it keeps the two "doers" (Atlas, Forge) consistent. **Haiku 4.5 is the documented alternative** — a one-line swap of this field, since `model` is a per-agent DB column. An in-UI model switcher is deferred (out of scope).
- `color` matches the roster's amber accent for `forge`.

## Forge's system prompt (output contract + distinct persona)

`FORGE_SYSTEM_PROMPT` — an ops/release engineer who owns the pipeline and the release. Voice leans machinery/shipping (Cog, amber), deliberately **not** Atlas's smith/anvil/hammer metaphors. Plain text, no inner backticks (keeps the template literal clean):

```
You are Forge, the devops / release engineer on AXOD's agent team.

Sage dispatches you to handle the build-and-ship side inside this session's
isolated git worktree: run builds/tests/lint, manage git (branch, commit, tag),
and edit infrastructure config (CI workflows, Dockerfile, Caddyfile, deploy
scripts). Unlike Atlas, who writes application code, you own the pipeline and
the release.

How you work:
- Read before you change. Inspect the existing config/scripts and match the
  project's conventions.
- Make precise, minimal config edits. After changes, run the relevant
  build/test/lint to verify, and report exactly what you ran and its result.
- For git/release ops, use clear messages and tags. Push or deploy ONLY when
  Sage's task explicitly grants approval — never push or run a destructive or
  remote command on your own initiative.

Your output is a report, in this shape:

  DID: <what you changed or ran, concretely>
  RESULTS: <commands run + outcomes (build/test/lint pass/fail, etc.)>
  NEXT/RISKS: <what's left, any risk, or what needs operator approval>

Rules:
- Verify before you claim success — paste real command output, do not assume.
- Never push, deploy, or run irreversible/remote operations without explicit
  approval in the task.
- Be honest about failures and gaps. Keep it tight — Sage relays this to the operator.
```

## Letting Sage dispatch Forge (`src/lib/dispatch.ts`)

1. `const DISPATCHABLE = ['atlas', 'echo', 'nova', 'forge'] as const;`
2. Update the `agent_id` enum description and the tool description so Sage understands the four specialists: **Atlas** (implements app code) · **Echo** (reviews work, read-only) · **Nova** (researches, read-only) · **Forge** (devops doer — builds/tests, git/release ops, edits infra config; CAN edit + run).
3. Update `SAGE_SYSTEM_PROMPT` (`scripts/seed.ts`): add Forge to the team capability line and a cue — dispatch Forge to run build/test/lint, do git/release ops (branch/commit/tag), or edit CI/Docker/Caddy/deploy config; and require operator approval before any push or deploy.

## Permissions (`tool_permissions`) — dormant in v1, mirror Atlas

Seed rows mirroring Atlas (read tools `always`; mutating ops `ask`):
```ts
{ agent_id: 'forge', project_id: 'axod-creative', tool_name: 'read_file', policy: 'always' },
{ agent_id: 'forge', project_id: 'axod-creative', tool_name: 'glob', policy: 'always' },
{ agent_id: 'forge', project_id: 'axod-creative', tool_name: 'grep', policy: 'always' },
{ agent_id: 'forge', project_id: 'axod-creative', tool_name: 'edit', policy: 'ask' },
{ agent_id: 'forge', project_id: 'axod-creative', tool_name: 'run_command', policy: 'ask' },
{ agent_id: 'forge', project_id: 'axod-creative', tool_name: 'git', policy: 'ask' },
```
These feed the dormant approval gate (doesn't fire on SDK 0.3.x); `tools_allowlist` is what constrains Forge at runtime. The no-push-without-approval discipline lives in the system prompt.

## UI polish (`src/components/mission-control.tsx`)

The roster already renders Forge (Cog icon + amber accent via `AGENT_ICON`/`AGENT_ACCENT`/`AGENT_GLOW`), and `page.tsx` `ROLE_LABEL` already maps `devops → "DevOps"`. Three small cohesion touches:
- Add Forge to `speakerStyle` (thread bubble): `{ accent: '#f59e0b', tint: 'rgba(245,158,11,0.08)' }` so Forge's messages read amber.
- Add a Forge `IDLE_STATE` line: `"Gears idle — ready to ship"`.
- Add a Forge branch to `friendlyActivity` (machinery/shipping voice):
  - `Bash`: git tag/commit → "Cutting the release…"; deploy/ship → "Shipping it…"; otherwise build/test → "Running the pipeline…" (fallback "Turning the gears: <cmd>").
  - `Edit`/`Write`/`MultiEdit`/`NotebookEdit` → "Wiring up → <file>".
  - `Read` → "Checking the manifest: <file>".
  - `Glob` → "Mapping the pipeline…".
  - `Grep` → "Tracing the config…" (with pattern when present).
  - `WebFetch`/`WebSearch` → "Consulting the ops docs…".
  - `TodoWrite` → "Drafting the runbook…".
  - default → generic fallback.

## Out of scope

Pixel (own cycle) · image-generation plumbing · the actual VPS deploy infrastructure (Week 5) · an in-UI per-agent model switcher (deferred) · changing the dispatch mechanism · runner/schema changes.

## Verification

- `pnpm build` clean; `pnpm test` stays 51/51 (config + prompt; no pure-module logic added).
- Re-seed: `pnpm seed` upserts Sage's prompt and inserts Forge; roster shows Forge (amber, Cog) — `agents` count 4 → 5, `tool_permissions` 15 → 21.
- Live smoke: operator asks Sage a devops task (e.g. "Forge, run the build and tests and report") → Sage dispatches Forge → Forge runs the commands, returns a `DID, RESULTS, NEXT/RISKS` report with real output → Sage relays. Confirm Forge can act (edit/run) but does NOT push or deploy without explicit approval.
