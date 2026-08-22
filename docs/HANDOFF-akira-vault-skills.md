# Handoff — AKIRA in-vault skills (sub-project B)

Updated 2026-08-22. Branch: `feat/akira-vault-skills`, clean tree, pushed to origin.
`dev` is pushed too (`2d7eb51`) — sub-project A is on the remote but still NOT
deployed to the Mini.

## What this is

Sub-project B of the AKIRA agentic-OS program: skills that live inside AKIRA's
Obsidian vault (`data/akira-memory/skills/<name>/SKILL.md`), reached by the SDK
through a `.claude/skills` symlink, plus the one new tool she needs to write them
(`vault_write`, scoped to the document tree, blocked from `memory/`).

- Spec: `docs/superpowers/specs/2026-08-18-akira-vault-skills-design.md`
- Plan: `docs/superpowers/plans/2026-08-18-akira-vault-skills.md` (8 tasks)
- Ledger (rulings R1–R15, briefs, review diffs):
  `.superpowers/sdd/2026-08-18-akira-vault-skills/progress.md`

The plan's checkboxes were never ticked — trust the commit list, not the boxes.
**The ledger overrides the plan** where they disagree (see Task 4 below).

## All 8 tasks are in

| Task | What | Commit |
|---|---|---|
| 1 | `additionalDirectories` + `skills` threaded to the SDK | `6ce7479` |
| 2 | Probe — discovery follows the link; bundled skills suppress. First BLOCKED verdict was a false negative (the harness omitted `Skill`) | — |
| 3 | `src/lib/akira/vault-write.ts` + tests — the path guards | `3b4f321` |
| — | Two review rounds: dangling-symlink escape, case-sensitivity gap, fail-closed `checkVaultPath` | `6487131`, `e0efbed` |
| 5 | Seed skills in `vault-seed/skills/`: `vault-gardening`, `distil-research`, vendored MIT `obsidian-markdown` | `33f7936` |
| 6 | Migration provisions the skills zone, the symlink, and copies seeds (only when absent — operator edits win) | `819feb2` |
| 4 | `vault_write` registered; turn passes `additionalDirectories`/`skills`/`extraEnv` | `45c7a27` |
| 7 | `Skills:` paragraph in her system prompt | `842df88` |
| 4b | **`'Skill'` added to her `tools_allowlist`** in `src/lib/akira/agent.ts` and `scripts/seed.ts` | `e7cff9c` |
| 8 | E2E against a copy of the live vault — passed, see below | — |

### Why 4b exists

The plan's Task 4 is incomplete and following it verbatim ships a silent no-op.
This runner feeds `allowedTools` into the SDK's `tools` (the base capability set),
not just `allowedTools` (the auto-run list) — so without `'Skill'` the skills are
discovered and nothing can invoke them. The Task 2 probe surfaced it; the operator
ruled on 2026-08-18 to add `Skill` now and defer scoped vault-read tools to a
follow-up slice. `agent-runner-sdk.ts`'s doc comment said the opposite and was
corrected in the same commit.

## Task 8 evidence (2026-08-22, on the laptop)

- Live vault pulled read-only from the Mini; it is still flat, confirming A is
  undeployed. Migration moved 17 notes, created all six of A's zones plus `skills`.
- Re-run: `0 notes moved, zones created: none / Skills: link unsupported, seeded:
  none` — idempotent.
- Shape: `skills/` holds `distil-research`, `obsidian-markdown`, `vault-gardening`,
  each with valid `name`/`description` frontmatter. `memory/` holds 21 notes.
- `Skills: link unsupported` — Windows cannot create the symlink without elevation.
  **The symlink is verified on the Mini at deploy, not here.**
- Skills reaching a real agent was proved locally through a hand-made junction
  (the Task 2 approach; needs no elevation). The agent answered:
  `changelog-generator, env-secrets-manager, mcp-server-builder, distil-research,
  obsidian-markdown, vault-gardening` — all three vault skills present, no bundled
  skills. The three extras are the operator's own `~/.claude/skills` on this
  laptop; on the Mini AKIRA runs as `mc`, which has no user skills dir. Known
  deferred minor.
- Scratch harness, junction, and vault copy deleted.

`pnpm exec tsc --noEmit` clean. `pnpm test`: **685 / 677 pass / 0 fail / 8 skipped**
(the 8 skips are the Windows symlink tests). Baseline before this branch was
671/667/0/4.

## What's left

1. **Final whole-branch review** on the most capable model — the ledger asks for it
   and it has not been done.
2. Merge to `dev`, release, deploy. Follow `ship-mc-feature`.

### Rollout, vault-specific

1. **Restart the new build BEFORE migrating** — sub-project A's ordering rule.
2. `cd /srv/mission-control && sudo -n -u mc pnpm vault:migrate`. The `Skills:` line
   must report `link created` (or `exists`), and this is where the symlink is
   actually proven.
3. **Reseed agents** — both her prompt AND her `tools_allowlist` changed. Skipping
   the reseed makes the entire slice inert.
4. `systemctl --failed`.
5. `git status` in the vault — the migration's commit is wrapped in an unconditional
   catch, so a real failure is indistinguishable from a clean tree.
6. In a live turn, ask AKIRA to list her skills; all three must appear.
7. Update `docs/runbook-akira-memory.md` with the skills zone and the symlink.

## Parked, by decision — not defects

- **Both seed skills ship inert.** `vault-gardening` says "Glob the zone" / "Read
  the INDEX.md"; `distil-research` says "Read the raw capture" / "Grep the vault".
  She has none of Read/Glob/Grep — they were removed on purpose because they run as
  `mc` with cwd=/srv/mission-control, which holds `.env` (SESSION_SECRET,
  CLAUDE_CODE_OAUTH_TOKEN, COMPANION_TOKEN, and AKIRA_MEMORY_PIN — the PIN gating
  her own vault) and the live DB. The follow-up slice is scoped vault-read tools.
  Deliberately not reworded now: the follow-up's tool names aren't chosen, and
  guessing them means rewriting twice.
- `ensureSkillsLink`'s `catch {}` is unconditional — on the Mini a genuine failure
  logs the same as success. Watch step 2 of the rollout.

## Constraints that already bit us

- This repo IS the live app dir for the MC project — never `git checkout` or
  branch-switch it; use a worktree. `.worktrees/` is MC's own.
- Never push directly to `main`. Feature branch → `dev`; `main` is release-only.
- Symlinks fail EPERM on Windows. Don't "fix" the migration to use junctions.
- A scratch harness importing `agent-runner-sdk.ts` needs
  `NODE_OPTIONS="--conditions=react-server"` and an async `main()` wrapper.
- Backticks inside `AKIRA_SYSTEM_PROMPT` must be escaped — it's a template literal.
- `room-agent/src/shell-ops.test.ts` has a known load flake; re-run it alone before
  calling it a regression.
