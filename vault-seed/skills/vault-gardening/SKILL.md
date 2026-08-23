---
name: vault-gardening
description: Sweep a vault zone for documents missing from their folder's INDEX.md and write the missing lines. Use when the operator asks to tidy, garden, or reindex the vault, or when you notice a folder's index is stale.
---

# Vault gardening

Every `INDEX.md` outside `memory/` is maintained by you, by hand. Nothing
generates them and nothing checks them, so they go stale silently — and a stale
index is worse than no index, because the vault's own conventions tell you to
trust it and descend only where it points.

This skill fixes one zone at a time.

Your vault lives on the host at `/srv/mission-control/data/akira-memory`. Read it
with `read` and search it with `bash` (`list` shows one directory at a time and
does not recurse), both on `target: "host"`; write it with `vault_write`, which
takes vault-relative paths.

## Steps

1. Ask which zone, unless the operator already said. Valid zones: `projects`,
   `ops`, `research`, `outputs`, `personal`, `skills`.
2. Find the zone's documents:
   `bash` on `target: "host"` with
   `find /srv/mission-control/data/akira-memory/<zone> -name '*.md' -not -name 'INDEX.md'`
3. `read` **every** `INDEX.md` the zone contains, on `target: "host"` — the
   zone's own at `/srv/mission-control/data/akira-memory/<zone>/INDEX.md`, and
   one per subfolder if the zone has them. `projects/` does: each
   `projects/<project-id>/` carries its own index, and comparing those files
   against the zone-level index instead would garden the wrong file. Find them
   the same way as step 2:
   `find /srv/mission-control/data/akira-memory/<zone> -name 'INDEX.md'`
   Each document belongs to the index in **its own** folder.
4. For each folder that has documents, compute which of its files have no line
   in that folder's `INDEX.md`.
5. For each missing file, `read` it and write **one line** that says what it is
   and why someone would open it. A filename restated as a sentence is not a
   summary — if you cannot say something useful, say what question the document
   answers.
6. Write the updated `INDEX.md` with `vault_write`. Preserve existing lines
   verbatim; you are adding, not rewriting.
7. Report what you added, as a count plus the notable ones. Do not paste the
   whole index back.

## Rules

- Never touch `memory/INDEX.md`. It is generated, and `vault_write` will refuse.
- Never invent a summary for a file you did not read.
- If a file is listed in an index but no longer exists, say so — do not silently
  delete the line. A missing file may be a mistake worth surfacing.
- Use `vault_write` rather than `write` for anything inside the vault. It keeps
  the document tree's rules — it refuses `memory/`, refuses non-Markdown, and
  cannot escape the vault. Plain `write` on `target: "host"` has none of those
  guards and would let a wrong path land anywhere on the machine.
- Every command you run is logged where the operator reads it. A `find` across
  the vault is ordinary; rummaging outside it while "gardening" is not.
