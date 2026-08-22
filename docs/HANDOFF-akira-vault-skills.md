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

## Review pass (2026-08-22)

Final whole-branch review done. The `vault-write.ts` guards hold — containment,
traversal, symlink bridges, and dangling links all fail closed, and the two
earlier review rounds did real work. Six findings, none a broken guard; all fixed
in one commit.

1. **Her prompt instructed her to use Read/Glob/Grep, which she does not have.**
   Pre-existing on `dev` — `808e6f9` removed the tools, `a5e4a0a` wrote the
   prompt, and they never reconciled. It matters now because A has never shipped,
   so this release is the first time it runs live. The paragraph now states the
   absence and tells her to relay when a file's contents are genuinely needed.
2. **`skills: 'all'` picked up MC's own `ship-mc-feature`.** Her cwd is
   `/srv/mission-control`, the runner sets `settingSources: ['project']`, and
   `.claude/skills/ship-mc-feature/SKILL.md` is committed and not gitignored — so
   it deploys and gets discovered. `CLAUDE_CODE_DISABLE_BUNDLED_SKILLS=1` covers
   bundled skills only, not project ones. Replaced with an explicit allowlist
   read from the vault per turn (`src/lib/akira/vault-skills.ts`), which still
   lets her author new skills — they go live on her next turn.
3. **`additionalDirectories: [vaultDir()]` was unguarded** while every other
   vault touchpoint checks `vaultReady()` first. Now conditional. (Checked: the
   Mini has no `AKIRA_MEMORY_DIR`, so the vault resolves under cwd and satisfies
   the SDK's strict-subdirectory rule.)
4. **`ensureSkillsLink` reported `exists` for a plain directory.** A non-symlink
   squatting on `.claude/skills` printed green on the one rollout step whose job
   is proving the link. New `occupied` state plus a warning.
5. **`seeded: none` was ambiguous** between "already seeded" and "seed source not
   found" (it resolves from `process.cwd()`). Now distinct text plus a warning.
6. **The vault `CLAUDE.md` may now be injected twice** — once as the capped
   `## VAULT` block, once by the SDK via `additionalDirectories`. Could not be
   settled from the SDK types; the injection is left in place (safe either way)
   and `vault-map.ts`'s comment no longer claims it never auto-loads. **Check at
   deploy** and drop the block if the map appears twice.

Not changed on purpose: the SDK deprecates `'Skill'` inside `allowedTools`, and
it lands there because `autoRun` concatenates `allowedTools` + `extraAllowedTools`.
It is required in `tools` (the restriction gate) and works today; removing it from
the auto-run list risks a permission round-trip — the hang this runner exists to
avoid. Revisit with a probe, not a guess.

`tsc --noEmit` clean. `pnpm test`: **694 / 686 pass / 0 fail / 8 skipped**.

## SHIPPED — v1.23.0, deployed to the Mini 2026-08-22

Merged to `dev`, released as `v1.23.0` (main `47146ae`), deployed. This release
carried sub-project A as well, which had been sitting on `dev` undeployed since
2026-08-18.

Deploy evidence:

- No new deps and no drizzle migrations, so `pnpm install` and `db:migrate` were
  correctly skipped.
- Restarted BEFORE `vault:migrate`, per A's ordering rule. Health `1.23.0`,
  `db:ok`, front door 200, no failed units, all tickers up, Discord logged in,
  graceful shutdown drained in 2ms.
- `pnpm vault:migrate`: `20 notes moved, zones created: projects, ops, research,
  outputs, personal, skills, memory` and **`Skills: link created`** — the symlink
  is real on the Mini (`.claude/skills -> ../skills`), which no laptop run could
  ever prove. Vault git tree clean, commit `19dc2da`.
- Reseeded: AKIRA's stored prompt went 5786 → 6908 chars and her allowlist went
  `["WebFetch","WebSearch","TodoWrite"]` → `[...,"Skill"]`. Verified the live row
  carries the skills paragraph, the honest tools list, and no Read/Glob/Grep
  claims. DB backed up first to `data/pre-v1.23.0.db`.
- `listVaultSkillNames()` on the Mini returns exactly
  `["distil-research","obsidian-markdown","vault-gardening"]` — MC's own
  `ship-mc-feature` is correctly excluded.

**Still open:** the live-turn check (ask AKIRA to list her skills through the
HUD) is an operator step and has not been done. And finding 6 above — whether
the vault `CLAUDE.md` now appears twice in her context — is answerable now that
this is live.

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
- ~~`ensureSkillsLink`'s `catch {}` is unconditional~~ — stale. The CLI already
  prints a WARNING on `unsupported`; the real silent-success path was a plain
  directory reporting `exists`, fixed in the review pass above.

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
