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

## Steps

1. Ask which zone, unless the operator already said. Valid zones: `projects`,
   `ops`, `research`, `outputs`, `personal`, `skills`.
2. `Glob` the zone for `**/*.md`. Exclude every `INDEX.md` from the results.
3. `Read` the zone's `INDEX.md`.
4. For each folder that has documents, compute which of its files have no line
   in that folder's `INDEX.md`.
5. For each missing file, `Read` it and write **one line** that says what it is
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
