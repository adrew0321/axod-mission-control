# AKIRA Long-Term Memory (Obsidian-style git-synced vault) — Design

**Date:** 2026-07-03
**Status:** Approved (design)
**Feature branch:** `feat/akira-long-term-memory`
**Related:** builds on front-door conversation history (v1.11.0); model-agnostic by design so it survives a future DeepSeek/Ollama swap of AKIRA's brain.

## Summary

AKIRA has no memory beyond the last 24 turns of her thread — everything older is
lost when a session ends. This feature gives her a persistent, **Obsidian-native
Markdown vault** she reads into her prompt each turn and writes to in-the-moment
via a scoped tool. The vault is a **private git repo** synced to the operator's
laptop Obsidian app, and browsable through a **PIN-locked Settings section on the
AKIRA front door** that stays collapsed until unlocked. Memory is never on screen
until the operator deliberately unlocks it.

## Goals

- AKIRA remembers durable facts/decisions/preferences/context across sessions.
- The operator can browse/edit her memory in the **Obsidian app** (git-synced) and
  view it in a **PIN-locked Settings section** on the AKIRA front door.
- **Private by construction:** private repo, login-gated app, and a PIN-locked
  section that stays collapsed until deliberately unlocked.
- **Model-agnostic:** plain Markdown + prompt-injection + git — no Claude-specific
  or embeddings dependency.

## Non-Goals (v1)

- Nightly auto-distillation of conversations into notes (a later Dreaming hook).
- Encryption at rest (would break Obsidian browsing — see Security).
- Semantic/vector search (retrieval is index-in-prompt + grep/read).
- Creating/editing notes *from* the UI, and an in-app note-detail/body view (v1 grid
  is list + forget; authoring is AKIRA's `remember` tool, full bodies via Obsidian).
- A dashboard "Memory" view (the front-door locked section is v1; the existing nav
  placeholder is left untouched and can reuse the same API later).

## Locked decisions

| Decision | Choice |
|---|---|
| Sync | **Git** — private `akira-memory` repo, Obsidian Git plugin on the laptop |
| Curation | **In-the-moment** — AKIRA writes via a scoped `remember` tool (no nightly job) |
| Mutations | `remember` **upserts**; `forget` **deletes** — both in v1 |
| At-rest | **Plaintext** in a private repo (keeps Obsidian browsable) |
| UI home | **PIN-locked Settings section on the AKIRA front door** — collapsed until unlocked, drops open to a memory grid |
| Unlock | **Server-verified PIN**; memory data isn't fetched until the PIN checks out; re-locks on collapse/leave/idle |

## Architecture

```
  Laptop  ── Obsidian app + Git plugin ──┐   (browse / hand-edit)
                                          ▼
                              GitHub: private akira-memory repo
                                          ▲
        commit + push (on write) │        │ pull (debounced, before read)
  ┌───────────────────────────────────────────────────────┐
  │  Mini — Mission Control server                          │
  │  data/akira-memory/  (git checkout; gitignored by app) │
  │    · AKIRA reads INDEX into her prompt each turn        │
  │    · `remember`/`forget` tools write notes (vault-only) │
  │    · PIN-locked front-door section: list / forget       │
  └───────────────────────────────────────────────────────┘
```

## Vault format (Obsidian-native)

One note per fact, `<slug>.md`:

```markdown
---
title: Operator prefers the ship-mc-feature loop
description: one-line summary — used for the prompt index + recall
type: fact | preference | project | decision | reference
created: 2026-07-03T14:02:00Z
updated: 2026-07-03T14:02:00Z
---
Body in Markdown. Links related notes with [[other-slug]].
```

`INDEX.md` — one line per note (`- [[slug]] — description`) — is **regenerated
from the notes' frontmatter on every write**, so it never drifts and is pleasant to
browse in Obsidian. It is also the exact text injected into AKIRA's prompt.

## Read path (per turn, in `runAkiraTurn`)

1. **Best-effort `git pull`** of the vault (debounced — at most once per
   `AKIRA_MEMORY_PULL_MS`, default 60s — and time-boxed so a hang never blocks a
   turn). Picks up the operator's Obsidian edits.
2. Build the index from the vault's note frontmatter and inject a **`## MEMORY`**
   section into the prompt (after the fleet snapshot), listing `[[slug]] —
   description` per note.
3. AKIRA reads a specific note on demand with her existing `Read`/`Grep` tools
   (the vault is under `cwd`, so `Read data/akira-memory/<slug>.md` works). This is
   how she stays aware of her memory — no separate fleet-snapshot contributor needed.

## Write path (in-the-moment)

Two new **scoped MCP tools** on AKIRA's server (she does NOT get the generic
`Write`/`Edit` tool — she stays filesystem-read-only everywhere except her vault):

- **`remember({ title, description, type, body, slug? })`** — upsert. Resolves a
  safe slug (from `slug` or slugified `title`), **path-guards it to inside the
  vault** (rejects `..`/absolute/escape), writes the note (setting `created` on new,
  `updated` always), regenerates `INDEX.md`, then commits + pushes async.
- **`forget({ slug })`** — deletes the note (path-guarded), regenerates `INDEX.md`,
  commits + pushes async.

AKIRA's system prompt gains a short **Memory** guideline: remember durable
facts/decisions/preferences (not transient chatter), keep one fact per note, link
related notes with `[[…]]`, update instead of duplicating, and **never store
secrets/passwords/tokens**.

## AKIRA front door: PIN-locked Settings section

Memory's only UI surface is a **Settings** section in the front door's Mission
Control scroll area (below the overnight brief). It is **collapsed and locked by
default** — nothing sensitive renders until the operator unlocks it.

- **Locked state:** a `Settings` panel showing only "Locked — memory & sensitive
  info" and a **PIN** entry. No memory data is fetched or present in the page.
- **Unlock:** the PIN is sent to the server, **verified server-side** (constant-time
  compare against `AKIRA_MEMORY_PIN` from the Mini's `.env`, with a small attempt
  limiter). Only on success
  does the client fetch the memory list. So notes never sit in the page/network until
  unlocked.
- **Unlocked state:** the panel drops open to a **memory grid** — columns
  **Type / Note / Updated**, one row per note (type chip, title + one-line
  description, timestamp, and a `×` to **forget**), plus **Open in Obsidian** and a
  **Lock** button.
- **Re-locks** automatically on collapse, navigating away/reload, or after a short
  idle — memory is only visible while actively being viewed.
- **Reading full bodies** is via the Obsidian app in v1 (the grid shows the
  description); an in-app note-detail view is a fast-follow.

**API (session-gated route handlers; PIN-gated in the body):**
- `POST /api/memory` `{ pin }` → verify session **and** PIN → return the note list
  (frontmatter only). Wrong PIN → 401 (attempt-limited).
- `DELETE /api/memory/[slug]` `{ pin }` → verify session + PIN → `forget` (delete →
  regenerate index → commit/push).
These are ordinary route handlers, covered by the session proxy (NOT companion
token routes — do not exempt them from the proxy).

The existing dashboard "Memory" nav placeholder ([nav-sections.ts]) is left as-is
for now; the front-door locked section is the v1 home. (A fuller dashboard view can
reuse the same API later.)

## Components (small, focused, testable)

- **`src/lib/akira/memory/note.ts`** — pure: `parseNote(md)` / `serializeNote(note)`
  (frontmatter+body roundtrip), `slugify(title)`, `safeSlug(s)` (path-guard),
  `buildIndex(notes)`. Unit-tested; no I/O.
- **`src/lib/akira/memory/store.ts`** — server: vault paths from
  `AKIRA_MEMORY_DIR` (default `data/akira-memory`), `listNotes`, `readNote`,
  `writeNote` (upsert), `deleteNote`, `writeIndex`, `pullDebounced`, `commitPush`.
  Degrades gracefully if the vault dir is absent / not a git repo (empty index;
  `remember` returns a clear "memory not configured" message rather than throwing).
- **`remember`/`forget`** wired into `src/lib/akira/tools.ts` (pure arg-validation
  in `tool-actions` where practical); added to `extraAllowedTools` in `akira-turn.ts`.
- **`prompt.ts` / `akira-turn.ts`** — `## MEMORY` injection + the pre-turn pull.
- **`src/lib/akira/memory/pin.ts`** — pure: `verifyPin(input, secret)` (constant-time)
  + a tiny attempt limiter. Unit-tested.
- **Front-door Settings section** in `hud.tsx` (locked panel → PIN → memory grid,
  re-lock on collapse/idle) + the `POST /api/memory` and `DELETE /api/memory/[slug]`
  route handlers.

## Error handling

- Vault missing / not a git repo → memory features no-op gracefully (empty index;
  `remember`/`forget` return a friendly "memory not configured"). Prod (Mini) has it
  cloned; local dev may not — both are fine.
- `git push` fails (offline/credential) → the note is already written locally; log
  and move on; the next write's push carries it. Never blocks a turn.
- `git pull` fails → use the local vault state.
- Writes are naturally serialized (AKIRA runs one turn at a time).
- Index growth: v1 injects the full index (one-liners). If the vault grows very
  large this is a future ranking/trim concern — out of scope now.

## Security posture

- **Private GitHub repo** for the vault; the Mini authenticates with a **deploy key
  scoped to that one repo** (write). No public surface.
- **Login-gated** — the app (front door, dashboard, `/api/memory/*`) all sit behind
  the session proxy; only the authenticated operator reaches memory.
- **PIN-locked & collapsed by default** — memory sits in a Settings section on the
  front door but stays locked; the data is not fetched or rendered until the
  server-verified PIN succeeds, and it re-locks on collapse/leave/idle. So it never
  appears in casual view / screenshots / screen-shares. The PIN is a second factor
  on top of the session login.
- **Plaintext** (chosen over encryption to keep Obsidian browsing) — the private
  repo + login gate is the boundary; protects against everything short of a
  GitHub-account or Mini-disk compromise.
- **No secrets in memory** — enforced by prompt guideline; memory is for
  facts/decisions/preferences, not credentials.

## Testing

- **Automated (`node:test` via tsx):** `note.ts` — frontmatter roundtrip, `slugify`,
  `safeSlug` path-guard (reject `..`, absolute, empty), `buildIndex` ordering/format.
- **Manual/integration:** git clone/pull/push on the Mini; `remember`/`forget`
  end-to-end (AKIRA writes → note appears → Obsidian pulls it); prompt injection
  (she recalls across a fresh session); the front-door locked section
  (wrong PIN rejected, right PIN → grid, forget works, re-lock on collapse/idle).

## One-time setup (ops, human-run — documented in the plan)

1. Create a **private `akira-memory` GitHub repo** (seed with `INDEX.md`).
2. On the Mini: generate a **deploy key**, add it to the repo (write access), clone
   to `data/akira-memory`, set the checkout's git identity to `AKIRA`.
3. App repo `.gitignore`: add `data/akira-memory/`.
4. Set **`AKIRA_MEMORY_PIN`** in the Mini's `.env` (the unlock PIN for the Settings
   section). Optional `AKIRA_MEMORY_DIR` / `AKIRA_MEMORY_PULL_MS`.
5. Laptop: clone the repo, open in Obsidian, enable the **Git plugin** (auto-pull).

## Conventions

- Branch `feat/akira-long-term-memory` off `dev`; merge to `dev` when green; release
  as a **minor** version via the ship-mc-feature loop. No DB migration.
- Extensionless TS imports; tests via `tsx --test`; no new runtime dependency
  (git via `child_process`, frontmatter parsed by hand — no yaml dep needed for the
  simple flat frontmatter, or a tiny parser in `note.ts`).
