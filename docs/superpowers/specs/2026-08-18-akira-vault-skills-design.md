# AKIRA in-vault skills — design

**Date:** 2026-08-18
**Status:** proposed
**Sub-project:** B of four (A vault · **B in-vault skills** · C reach expansion · D loops)
**Depends on:** A — `docs/superpowers/specs/2026-08-18-akira-vault-restructure-design.md` (merged to `dev`)

## Why

Sub-project A gave the vault a shape. It did not give AKIRA anything new to do
with it. B gives her a repertoire: named, versioned workflows she can invoke,
authored as Markdown in the vault where the operator can read and correct them.

The framing comes from Chase AI's "Agentic OS" — codify the workflows you repeat
instead of re-explaining them every time. The two chosen for this slice are not
generic: one closes a hazard A knowingly shipped, and the other replaces a
third-party plugin that was evaluated and rejected.

## Findings that shaped this

Measured before designing, not assumed:

| Finding | Evidence |
|---|---|
| The SDK already supports skills natively | `@anthropic-ai/claude-agent-sdk@0.3.228` exposes `skills?: string[] \| 'all'`, `additionalDirectories`, and `reloadSkills()` |
| `settingSources: ['project']` is already set | `src/lib/agent-runner-sdk.ts:156` |
| **Skill discovery follows a symlinked `.claude/skills`** | Probe on the Mini 2026-08-18: `.claude/skills -> ../real-skills`, then `claude -p "list your skills"` returned `hello-spike` first, ahead of the bundled skills. This is the finding the whole design rests on. |
| Bundled skills can be suppressed without touching `.claude/skills/` | `CLAUDE_CODE_DISABLE_BUNDLED_SKILLS=1` (documented in `sdk.d.ts`) |
| AKIRA's cwd makes the vault reachable | She runs `workingDir: process.cwd()` (`src/lib/akira-turn.ts:137`), so `data/akira-memory` is a strict subdirectory |
| The Mini runs Node v22.23.2 | `node -v` over SSH; MC pins `22` in `.nvmrc` |

So B is mostly wiring, not building — with one exception, D4 below.

## Goals

- Skills live in the vault, visible and editable in Obsidian's file explorer.
- Adding a skill is adding a file. No code change, no deploy, no restart.
- AKIRA can write into the vault's document tree, which she cannot do today.
- Ship two working skills plus one vendored reference skill.

## Non-goals

- Sage and the specialists getting vault skills. They run inside a project
  worktree where the vault is not a subdirectory of cwd; that is a different
  problem and its own slice.
- The nightly `reflect.ts` pass getting a skill menu. It is a narrow
  distillation call and should stay narrow.
- `defuddle`, `obsidian-cli`, `obsidian-bases`, `json-canvas` (D6, D7).
- The `obsidian-llm-wiki` plugin — evaluated and rejected (D8).

## Decisions

**D1 — A symlink, not a generator.** The vault holds `skills/<name>/SKILL.md`
where Obsidian shows it, and `data/akira-memory/.claude/skills` is a symlink to
`../skills`. Rejected: generating `.claude/skills/` copies from Obsidian-visible
sources, which adds a module, a trigger, tests, and a drift window, to buy
nothing the symlink does not already give. Rejected: storing skills directly in
`.claude/skills/`, which works but is invisible in Obsidian — the requirement
that started this slice.

**D2 — `skills: 'all'`, with bundled skills suppressed.** An explicit allowlist
would mean a code change per skill, destroying the "add a file, get a
capability" property that is the point. `'all'` also pulls in roughly thirteen
bundled Claude Code skills (`code-review`, `security-review`, …) which are
developer tools and pure context cost for her, so
`CLAUDE_CODE_DISABLE_BUNDLED_SKILLS=1` is set for her process. It removes
exactly those and leaves `.claude/skills/` untouched. She will still see MC's
own `ship-mc-feature`; that is harmless, since her prompt already directs her to
relay project work rather than perform it.

**D3 — AKIRA's turn path only.** `src/lib/akira-turn.ts`, not `reflect.ts`, not
`dispatch.ts`.

**D4 — A new scoped `vault_write` tool.** This is the one place B builds rather
than wires, and it ends a promise A made. A's D1 said "no new tool"; both skills
in this slice must write into the document tree, and today AKIRA cannot. Her
only writes are `remember`/`forget` (note-model files into `memory/` only),
`room_write` (her container), and the `~/AKIRA` doorway. See "The `vault_write`
contract" below.

**D5 — AKIRA may write into `skills/`.** She can already author `type: lesson`
notes unprompted, and those become standing directives injected into every turn,
so a skill is not a categorically new kind of self-modification — it is a more
structured version of something she already does. Blocking it would also make
`vault-gardening` unable to garden the skills zone. Recorded as a decision
rather than a default because a skill she writes changes how she later behaves.

**D6 — Third-party skills are vendored, not installed.** `kepano/obsidian-skills`
(MIT, from Obsidian's CEO) offers three install paths, all of which place skills
in the *agent's* configuration (`~/.claude`, the plugin marketplace, `npx
skills`). Ours must live in the vault so they travel with its git repo and are
readable in Obsidian. So the folder is copied in with its MIT license and
attribution intact. The cost is that it does not track upstream; that is
acceptable for a reference document and is stated here so nobody assumes
otherwise.

**D7 — Only `obsidian-markdown` is vendored in this slice.**

- `obsidian-markdown` — **included.** Pure reference knowledge, no dependencies,
  ~2k words plus `references/{PROPERTIES,EMBEDS,CALLOUTS}.md` that load on
  demand. D4 lets AKIRA write into an Obsidian vault for the first time; this is
  what makes what she writes idiomatic — real callouts, properties, embeds, and
  correct wikilink syntax — rather than plain Markdown that happens to sit in a
  vault.
- `defuddle` — **deferred.** Conceptually a good fit for `distil-research`
  (strip a web page to clean Markdown before distilling), but it shells out to
  `defuddle parse <url> --md` after `npm install -g defuddle`, and **AKIRA has no
  Bash on the host.** Her only shell is `room_bash`, inside her LXD container.
  Adopting it means installing it in her room and vendoring an adapted copy that
  invokes `room_bash` — a fork we would then own.
- `obsidian-cli` — **skipped.** Aimed at plugin and theme development, needs the
  Obsidian CLI binary, and also assumes Bash.
- `obsidian-bases`, `json-canvas` — **left out.** The operator does not
  currently use Bases or Canvas. Either can be added later by copying a folder
  into the vault, with no deploy.

**D8 — `obsidian-llm-wiki` was evaluated and rejected.** It implements the same
Karpathy wiki structure and would have done `distil-research`'s job better, but
its Anthropic provider requires a paid Platform API key with no subscription
OAuth, which the operator declined. Recorded so the evaluation is not repeated.
Secondary blockers, had the answer been yes: no folder-exclusion setting (so
`personal/` and `memory/` would have been in scope, mitigable by opening
`research/` as its own vault), a Node 24 requirement against the Mini's v22, and
a CLI mid-migration to a separate repository.

**D9 — Provisioned by extending `migrate-vault.ts`.** `skills` joins `ZONES` and
the symlink is created when absent, rather than adding a second script. The
migration is already idempotent and already runs on deploy.

## Vault shape (delta from A)

```
data/akira-memory/
  skills/                          # NEW zone — Obsidian-visible, symlink target
    INDEX.md                       #   maintained by AKIRA, like every zone index
    vault-gardening/SKILL.md
    distil-research/SKILL.md
    obsidian-markdown/             #   vendored, MIT (D6/D7)
      SKILL.md
      LICENSE
      references/{PROPERTIES,EMBEDS,CALLOUTS}.md
  .claude/
    skills -> ../skills            # NEW symlink (D1)
```

## The `vault_write` contract

```ts
vault_write({ path: string, content: string }): { path: string; bytes: number }
```

`path` is relative to the vault root. The write is rejected unless every guard
below passes. Guards are evaluated against the **real** path — `realpathSync` on
the parent, then `resolve` — so the `.claude/skills` symlink cannot be used to
reach a rejected zone by an alternate name.

| Guard | Rejects |
|---|---|
| Containment | Any path resolving outside `vaultDir()` — `..`, absolute paths, symlink escapes |
| `memory/` | Owned by `remember`/`forget`; its `INDEX.md` is code-generated and hand-writing it would be silently overwritten |
| `SOUL.md`, `SOUL.proposed.md` | PIN-protected identity, with its own approval flow |
| Root `CLAUDE.md` | Injected into every turn as the `## VAULT` block (A's `vault-map.ts`). Letting her rewrite it freely would give her *more* power over her own standing instructions than she has over SOUL, which requires PIN approval. She may propose changes in chat; the operator edits it in Obsidian. |
| Non-Markdown | Anything not ending `.md`, so the tool cannot drop executables or configs into the vault |

Allowed: every document zone (`projects/`, `ops/`, `research/`, `outputs/`,
`personal/`), every zone `INDEX.md` including the root one — which A's D4 already
designates AKIRA-maintained and which is *not* injected into her prompt — and
`skills/` (D5).

Writes are committed through the existing `gitCommitPush`, the same
fire-and-forget serialized path `remember`/`forget` already use. `vault_write`
does not update any `INDEX.md` itself — indexes are AKIRA-maintained per A's D4,
and the skills instruct her to add the line in the same turn.

## The skills

**`vault-gardening`** — walk a zone, list files with no line in their folder's
`INDEX.md`, and write the missing lines with a real one-line summary of each.
This closes the drift hazard the final review on A named explicitly: every index
outside `memory/` is maintained by instruction alone, with no generator, no
test, and no drift check, so the tree's navigability decays silently and the
instruction to "read the INDEX.md at each level" becomes actively misleading as
indexes go stale.

**`distil-research`** — read a raw capture in `research/`, write a distilled
page with `[[wikilinks]]` to related notes, and add its line to
`research/INDEX.md`. The job D8's rejected plugin would have done.

Both are Markdown. Neither shells out. Both rely on `vault_write` and on
`obsidian-markdown` for syntax.

## Code changes

**`src/lib/akira/vault-write.ts` (new, pure + I/O split)** — path guards as pure
functions so they unit-test without a filesystem, plus the write. The guard
table above is the test surface.

**`src/lib/akira/tools.ts`** — register `vault_write` alongside
`remember`/`forget`.

**`src/lib/akira-turn.ts`** — pass `additionalDirectories: [vaultDir()]`,
`skills: 'all'`, and `CLAUDE_CODE_DISABLE_BUNDLED_SKILLS=1` in the child env.

**`src/lib/agent-runner-sdk.ts`** — thread `additionalDirectories`, `skills`, and
`env` through `RunAgentOptions`; today it exposes neither. Defaults stay
unset so no other agent's behaviour changes.

**`scripts/migrate-vault.ts`** — add `skills` to `ZONES`; add
`ensureSkillsLink(dir)` returning `'created' | 'exists' | 'unsupported'`.
Non-fatal on failure: the dev laptop is Windows, where `symlinkSync` needs
Developer Mode or administrator rights, and that is where tests run. The Mini is
the only place it must actually succeed, and the CLI reports which of the three
outcomes occurred.

**`src/lib/akira/prompt.ts`** — one paragraph telling her she has skills, that
they live in `skills/`, and that she may write new ones.

## Testing

- **`vault_write` guards carry the real coverage** — one case per row of the
  guard table, plus a symlink-escape attempt through `.claude/skills`, plus the
  allowed zones. This is the security surface of the slice.
- **`ensureSkillsLink`** — already-exists and unsupported paths; creation itself
  is only assertable on a POSIX filesystem.
- **Skill discovery end to end** — against a copy of the live vault, as Task 7
  did in A: run the migration, then confirm from a real agent invocation that
  `vault-gardening`, `distil-research`, and `obsidian-markdown` are listed and
  that the bundled skills are not.
- The skills themselves are Markdown and are verified by running them against a
  vault copy, not by unit tests.

## Rollout

1. Merge and release; deploy to the Mini.
2. `pnpm vault:migrate` — creates `skills/` and the symlink. Idempotent.
3. **Reseed agents** — AKIRA's prompt changes (known trap in this repo).
4. `systemctl --failed`.
5. Confirm in a live turn that she lists the three skills.

Restart-then-migrate ordering from A still applies.

## Open questions

- The `skills` option and `CLAUDE_CODE_DISABLE_BUNDLED_SKILLS` are documented in
  `sdk.d.ts` but unverified in this codebase's call path. The implementation
  plan's first task should prove both against a real invocation before the rest
  is built on them.
- Whether `additionalDirectories` at launch is subject to the same
  strict-subdirectory rule the mid-session add-directory control request
  documents. It does not matter for AKIRA, whose vault *is* a subdirectory of
  her cwd, but it decides whether Sage could ever get vault skills.
- Skill count versus context. Only frontmatter descriptions are always resident;
  bodies load on demand. A already added roughly 2.5k tokens per turn, so the
  standing cost of the skills zone should be measured once it exists.
