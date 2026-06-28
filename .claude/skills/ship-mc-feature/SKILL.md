---
name: ship-mc-feature
description: The end-to-end workflow for shipping any non-trivial change in AXOD Mission Control — brainstorm → spec → plan → build → release → deploy to the Mini. Use when starting a feature, fix, or hardening pass that will end in a release. Encodes this repo's conventions on top of the superpowers skills.
---

# Ship an AXOD Mission Control feature

The proven loop for this repo. The first three phases are the superpowers skills; the
last two (release + deploy) are project-specific and are the reason this skill exists.

**Announce at start:** "I'm using the ship-mc-feature skill to drive this change."

## Phase 1 — Brainstorm → spec
Invoke **superpowers:brainstorming**. Explore the current code first, ask one question
at a time, propose options, get approval, then write the spec to
`docs/superpowers/specs/YYYY-MM-DD-<topic>-design.md` and have the user review it.
Always lock the genuinely-ambiguous decisions here (data model, branch model, scope,
out-of-scope) — they save rework later.

## Phase 2 — Plan
Invoke **superpowers:writing-plans**. Produce `docs/superpowers/plans/YYYY-MM-DD-<feature>.md`
with bite-sized TDD tasks and complete code (no placeholders). Read the exact current
files first so each task carries real code.

## Phase 3 — Build
Pick the executor by size:
- **Terminal handoff (preferred when the current session is long/heavy):** the plan is
  self-contained and committed; tell a fresh `claude` session *"Execute <plan path> using
  the subagent-driven-development skill. Work in an isolated worktree off `dev`."* Lighter
  on the Pro usage window and faster per turn. It stops after merging to `dev`.
- **Subagent-driven here:** superpowers:subagent-driven-development (fresh subagent per
  task + review).
- **Inline here:** superpowers:executing-plans.

Always work in an isolated worktree off `dev` (see [[self-hosted-repo-is-live-dir]] —
never branch-switch the live repo). On Windows the worktree's `node_modules` is junctioned
from the checkout; unlink it before removing the worktree. Finish with
superpowers:finishing-a-development-branch → **merge the feature branch into `dev`** (never
straight to `main`). Verify `pnpm test` + `pnpm exec tsc --noEmit` green before merging.

## Phase 4 — Release (project-specific)
`main` is release-only; releases are `dev`→`main` merges with a version bump + tag.

1. Bump the version in BOTH `package.json` (`"version"`) and
   `src/app/api/health/route.ts` (`version: '…'`). Pick the bump: patch for fixes,
   minor for features.
2. Commit the bump on `dev`.
3. Merge `dev`→`main` via a THROWAWAY worktree (don't switch the live checkout's branch):
   ```bash
   git worktree add .worktrees/_rel main
   git -C .worktrees/_rel merge --no-ff dev -m "release: vX.Y.Z — <summary>"
   git -C .worktrees/_rel tag -a vX.Y.Z -m "vX.Y.Z — <summary>"
   git push origin dev main vX.Y.Z
   git worktree remove --force .worktrees/_rel; git worktree prune
   ```
4. Confirm `origin/dev`, `origin/main`, and the tag all match locally.

End commit messages with the repo's `Co-Authored-By: Claude …` trailer.

## Phase 5 — Deploy to the Mini (production)
**Requires explicit user go-ahead** — production deploys are outward-facing. The Mini is
`mc-bridge` at `akeem@10.0.0.218`; the app lives at `/srv/mission-control` (user `mc`,
systemd unit `mission-control`, public at bridge.axodcreative.com via cloudflared).
Full procedure: `docs/runbook-deploy-homelab.md`. The critical moves:

1. Pull + build as `mc`:
   ```bash
   ssh akeem@10.0.0.218 'sudo -u mc bash -lc "cd /srv/mission-control && git pull --ff-only origin main && pnpm build"'
   ```
   - **SKIP `pnpm install` when the release adds NO new deps.** After the mc-HOME move,
     `pnpm install` aborts wanting to purge `node_modules`; **never let it purge** — it
     would wipe the hand-compiled `better-sqlite3` binding. Only install (deliberately,
     with a native rebuild) when deps actually changed. See [[homelab-deploy-progress]].
2. **Run migrations only if the release added any** (`drizzle/` changed):
   `sudo -u mc bash -lc "cd /srv/mission-control && set -a; . ./.env; set +a; pnpm db:migrate"`.
3. Restart (needs root, so as `akeem` not `mc`): `sudo systemctl restart mission-control`.
4. Verify: `curl -s 127.0.0.1:3000/api/health` shows the new `version` + `db:ok`;
   `curl -s -o /dev/null -w "%{http_code}" -L 127.0.0.1:3000/` is `200`; the journal shows
   the tickers + `[discord] logged in`; no `[discord-notify] tick failed` errors.
   Read logs WITHOUT sudo (the `adm` group) — `sudo journalctl` prompts for a password.

Claude auth on the Mini is a year-long token in `/srv/mission-control/.env`
(`CLAUDE_CODE_OAUTH_TOKEN`); if turns 401, re-mint with `claude setup-token`
([[homelab-deploy-progress]]).

## After shipping
Update affected memory notes and any docs that drifted ([[keep-docs-in-sync]]). If this
change followed an incident, mark the incident note's fixes as shipped with the release tag.

## Watch for skill opportunities
While planning/working, silently watch for a repeated, multi-step, error-prone procedure
that isn't yet a skill. When you spot one, tell the user and offer to capture it
([[create-skills-for-repeated-workflows]]).
