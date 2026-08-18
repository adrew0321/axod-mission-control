# AKIRA vault restructure — design

**Date:** 2026-08-18
**Status:** proposed
**Sub-project:** A of four (A vault · B in-vault skills · C reach expansion · D loops)

## Why

AKIRA's vault is a flat directory of one-fact notes. That model was right for
"remember things about A'Keem" and is wrong for what the vault is being asked to
become: the place he and AKIRA both work from, holding projects, ops knowledge,
research, outputs, and a personal/strategy layer.

Measured on the Mini (`/srv/mission-control/data/akira-memory`) on 2026-08-18:

| | count |
|---|---|
| note files | 17 |
| of which `type: lesson` | 15 |
| entries in the recall `INDEX.md` | 2 |

The vault is, in practice, a behaviour-policy file set with two facts attached.
The knowledge half does not exist yet.

Three concrete defects follow from the flat model:

1. **Hierarchy is impossible.** `listNotes` is a single non-recursive
   `readdirSync` (`store.ts`). Subfolders are invisible to every read path.
2. **Lessons silently overflow.** `lessonsText` caps injection at 4096 chars and
   breaks at the first block that would exceed it, without reporting. The 15
   lesson bodies total roughly 6.8k chars, so approximately six of the oldest
   lessons are dropped from every turn and nothing says so.
3. **The map is in the code.** The vault's conventions live in a template
   literal in `src/lib/akira/prompt.ts`. They cannot be edited in Obsidian, and a
   Claude Code opened directly in the vault on the Mini arrives with no map.

## Goals

- One vault, two mechanisms: an AKIRA-owned `memory/` zone keeping the existing
  note model, and a shared document tree both parties write into.
- An `INDEX.md` at every level and a `CLAUDE.md` at the root, injected into
  AKIRA's turn so the map is data rather than code.
- A personal/strategy layer (goals, journals, reviews).
- Migrate the existing 17 notes with no data loss and no broken `[[wikilinks]]`.
- Make lesson truncation visible instead of silent.

## Non-goals

- In-vault skills (sub-project B).
- Reach expansion beyond the room (sub-project C).
- Self-improving loops over run logs (sub-project D).
- Changing the note model itself: frontmatter, `remember`/`forget`, and the
  one-fact-per-note discipline stay exactly as they are.

## Decisions

**D1 — Two mechanisms, not one.** The memory store keeps its model; the document
tree is plain files navigated with the Read/Glob/Grep tools AKIRA already has.
No new tool and no new store. Rejected: making `listNotes` recursive and putting
documents through the note model (destroys one-fact-per-note), and
path-as-identity slugs like `research/agentic-os/chase-levels` (`safeSlug`
strips slashes, and every existing wikilink dies).

**D2 — Flat slugs stay flat.** Obsidian resolves `[[slug]]` by filename
regardless of depth, so unique flat slugs and a deep folder tree coexist without
touching link syntax.

**D3 — The directory keeps its name.** `data/akira-memory` becomes a misnomer
once it holds the whole knowledge base, but renaming it costs a change to
`AKIRA_MEMORY_DIR`, the `adrew0321/akira-memory` remote, her prompt, and the
runbook, for no functional gain. Keep it; note the misnomer in the vault
`CLAUDE.md`.

**D4 — Only `memory/INDEX.md` is code-generated.** A code generator can list
filenames but cannot summarise an arbitrary document, and a one-line summary is
the only thing that makes an index worth reading. So `writeIndex` keeps
generating `memory/INDEX.md` exactly as it does today, and every other
`INDEX.md` — the root map and each domain folder's — is seeded by the migration
and thereafter maintained by AKIRA under a convention stated in the vault
`CLAUDE.md`. No new generator is built.

**D5 — `personal/` is committed, not ignored.** The remote is private. Ignoring
it would mean the one irreplaceable zone is the only one without backup. Stated
here so it is a decision rather than a default.

## Vault shape

```
data/akira-memory/          # vault root — unchanged path (D3)
  CLAUDE.md                 # conventions + navigation pattern (injected)
  INDEX.md                  # top-level map (seeded, then AKIRA-maintained)
  SOUL.md                   # unchanged — soul.ts reads vaultDir() root
  SOUL.proposed.md
  memory/                   # AKIRA-owned. Existing note model, untouched.
    INDEX.md                #   recall index (generated)
    <slug>.md
  projects/                 # per-project knowledge, mirrors the projects table
  ops/                      # runbooks, topology, backup chain, incidents
  research/                 # raw captures distilled into wiki pages
  outputs/                  # specs, plans, reports worth finding again
  personal/                 # goals, journals, reviews (D5)
```

## Code changes

**`memory/store.ts`**

- Add `memoryDir()` = `join(vaultDir(), 'memory')`. All note functions
  (`listNotes`, `readNote`, `writeNote`, `deleteNote`, `writeIndex`,
  `indexText`, `lessonsText`) default to `memoryDir()` instead of `vaultDir()`.
- **`memoryDir()` falls back to `vaultDir()` when `memory/` does not exist.**
  This makes the deploy safe in either order relative to the migration, which
  matters given this repo's history of start-order hazards.
- `vaultDir()` is unchanged and keeps serving SOUL, the root `CLAUDE.md`, and
  the document tree.

**`lessonsText` — make truncation visible**

- Return `{ text, included, dropped }` rather than a bare string.
- Raise `maxChars` to 8192, which fits the current 15 lessons with headroom.
- Callers surface `dropped > 0`; the memory panel shows it. Pruning stays a
  judgement call for A'Keem and AKIRA (`forget` already exists) rather than
  something the code does silently.

**New `memory/vault-map.ts` (pure + unit-tested)**

- Reads the root `CLAUDE.md`, returns it as an injectable `## VAULT` block,
  char-capped like `lessonsText`.
- Returns empty string when absent, so a vault without one still works.

**`prompt.ts`**

- Drop the hardcoded `data/akira-memory/<slug>.md` path from the memory
  paragraph; note paths now resolve under `memory/`.
- Inject the `## VAULT` block each turn.

**Migration script (`scripts/`)**

- Create `memory/` and the five domain folders; move the 17 `*.md` notes into
  `memory/`, leaving `SOUL.md`, `INDEX.md`, and `SOUL.proposed.md` if present at
  the root.
- Seed the root `CLAUDE.md`, the root `INDEX.md`, and a stub `INDEX.md` per
  domain folder.
- Regenerate `memory/INDEX.md`; commit through the existing git path.
- Idempotent: safe to run twice.

## Testing

The note and store modules are already unit-tested against temp dirs, which is
the pattern to extend.

- `vault-map.ts`: pure, unit-tested — present, absent, over-cap.
- `lessonsText`: assert the `dropped` count against a fixture that overflows,
  and that `included` fills to the cap.
- `memoryDir()` fallback: temp vault with and without `memory/`.
- Migration: run against a temp copy of the real 17-note layout; assert every
  note lands in `memory/`, SOUL stays at root, and a second run is a no-op.

## Rollout

1. Merge and release; deploy to the Mini as usual.
2. Run the migration on the Mini against the live vault. It is a git repo, so it
   is revertible.
3. Reseed agents — any change to AKIRA's prompt requires it (known trap).
4. `systemctl --failed` after the deploy.
5. Ops, not code: install Obsidian on the Mini and open
   `/srv/mission-control/data/akira-memory` as a vault.

The `memoryDir()` fallback means steps 1 and 2 can happen in either order
without breaking reads.

## Open questions

- Does `projects/` mirror the `projects` table by id, or is it hand-organised?
  Mirroring gets AKIRA a reliable join between vault knowledge and fleet state;
  hand-organising is friendlier to read. Recommend mirroring by project id with
  a human-readable title in each folder's `INDEX.md`.
- The 15 lessons will keep growing. Raising the cap to 8192 buys room, not a
  policy. Whether lessons eventually need tiering (always-on vs situational) is
  a question for sub-project D, once run logs exist to score them against.
