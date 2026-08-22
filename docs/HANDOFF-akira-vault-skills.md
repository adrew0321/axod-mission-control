# Handoff — AKIRA in-vault skills (sub-project B)

Written 2026-08-22. Branch: `feat/akira-vault-skills` @ `e0efbed`, clean tree,
10 commits ahead of `dev`. `dev` itself is 14 ahead of `origin/dev` (unpushed —
sub-project A, the vault, merged 2026-08-18 and was never pushed or deployed).

## What this is

Sub-project B of the AKIRA agentic-OS program: give AKIRA real skills that live
inside her Obsidian vault (`data/akira-memory/skills/<name>/SKILL.md`), reached
by the SDK through a `.claude/skills` symlink, plus the one new tool she needs to
write them (`vault_write`, scoped to the document tree — never `memory/`).

- Spec: `docs/superpowers/specs/2026-08-18-akira-vault-skills-design.md`
- Plan: `docs/superpowers/plans/2026-08-18-akira-vault-skills.md` (8 tasks)

The plan's checkboxes were never ticked — trust the commit list below, not the
boxes.

## Done (committed)

| Task | What | Commit |
|---|---|---|
| 1 | `additionalDirectories` + `skills` threaded to the SDK in `src/lib/agent-runner-sdk.ts` | `6ce7479` |
| 2 | Probe — skill discovery follows the symlink, bundled skills suppress. Design holds. Scratch harness deleted, no commit | — |
| 3 | `src/lib/akira/vault-write.ts` + tests — the path guards | `3b4f321` |
| 5 | Seed skills under `vault-seed/skills/`: `vault-gardening`, `distil-research`, vendored MIT `obsidian-markdown` | `33f7936` |
| 6 | `scripts/migrate-vault.ts` provisions the skills zone, the symlink, and copies seeds (copy only when absent — operator edits win) | `819feb2` |
| — | Two review-driven hardening rounds on the guards: dangling-symlink escape, case-sensitivity gap, and `checkVaultPath` failing closed instead of throwing | `6487131`, `e0efbed` |

`pnpm test` as of this handoff: **685 tests / 677 pass / 0 fail / 8 skipped**.

## Remaining — start here

**Task 4 — register the tool and wire the turn.** This is the gap: `vault-write.ts`
exists and is tested, but nothing outside its own test imports it, so AKIRA cannot
call it yet. Plan lines 420–507 have the exact code.
- `src/lib/akira/tool-actions.ts` — add `export const AKIRA_VAULT_WRITE = 'mcp__akira__vault_write';` after `AKIRA_FORGET`
- `src/lib/akira/tools.ts` — add the `vaultWriteTool` definition after `forget`, add it to the `base` array
- `src/lib/akira-turn.ts` — add `AKIRA_VAULT_WRITE` to `extraAllowedTools`, and after the `mcpServers:` line add `additionalDirectories: [vaultDir()]`, `skills: 'all'`, `extraEnv: { CLAUDE_CODE_DISABLE_BUNDLED_SKILLS: '1' }`

**Task 7 — tell AKIRA she has skills.** One paragraph in her system prompt (plan
line 852).

**Task 8 — E2E against a copy of the live vault** (plan line 881). Copy the vault
to the scratchpad, run the migration against the copy, assert the shape, prove the
skills reach a real agent. No commit; it gates the release.

## Rollout (after all tasks land) — `ship-mc-feature`

1. Merge to `dev`, release, deploy to the Mini.
2. **Restart the new build BEFORE migrating** — sub-project A's ordering rule.
3. `cd /srv/mission-control && sudo -n -u mc pnpm vault:migrate` — the `Skills:`
   line must report `link created` (or `exists`) plus the seeded skills.
4. **Reseed agents** — AKIRA's prompt changed; a stale seeded prompt is a known
   trap in this repo.
5. `systemctl --failed`.
6. `git status` in the vault — the migration's commit is wrapped in an
   unconditional catch, so a real failure looks exactly like a clean tree.
7. In a live turn, ask AKIRA to list her skills; all three must appear.
8. Update `docs/runbook-akira-memory.md` with the skills zone and the symlink.

## Constraints that bit us already

- This repo IS the live app dir for the MC project — never `git checkout` or
  branch-switch it out from under a running session; use a worktree.
- Never push directly to `main`. Feature branch → `dev`; `main` is release-only.
- Windows: `pnpm test` uses `tsx --test`, extensionless imports only.
- The vault is a separate private git repo, so shipped skills live in
  `vault-seed/` in THIS repo and the migration copies them across.
