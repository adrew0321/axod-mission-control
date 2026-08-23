---
name: distil-research
description: Turn a raw capture in research/ into a durable distilled page with wikilinks, and index it. Use when the operator drops an article, transcript, or notes into the vault and wants them made useful.
---

# Distil research

Raw captures are worth keeping and painful to reread. This turns one into a page
that answers questions six months from now.

Your vault lives on the host at `/srv/mission-control/data/akira-memory`. Read it
with `read` and search it with `bash`, both on `target: "host"`; write it with
`vault_write`, which takes vault-relative paths.

## Steps

1. `read` the raw capture on `target: "host"`, at
   `/srv/mission-control/data/akira-memory/research/<file>`. If the operator gave
   a URL instead, `WebFetch` it.
2. Decide the page's **claim** — the one thing it is about. If the source covers
   several unrelated things, make several pages rather than one vague one.
3. Write the page to `research/<slug>.md` with `vault_write`, using the
   structure below.
4. Link it. Search the vault for topics the page touches:
   `bash` on `target: "host"` with
   `grep -ril '<topic>' /srv/mission-control/data/akira-memory --include='*.md'`
   then add `[[wikilinks]]` to the pages that already exist. A page with no links
   is a dead end. Search one topic at a time and read what you find before
   linking it — a wikilink to a page that does not say what you assumed is worse
   than no link.
5. Add its line to `research/INDEX.md`. **`read` the index first** — at
   `/srv/mission-control/data/akira-memory/research/INDEX.md` on
   `target: "host"` — then `vault_write` the whole file back with your line
   added. `vault_write` replaces the file entirely; it does not append, so
   writing without reading first would silently drop every existing entry.
6. Report the claim and the links you made, in a few sentences.

## Page structure

```
# <Title>

**Source:** <url or file> · **Distilled:** <ISO date>

<Two or three sentences: what this is and why it mattered enough to keep.>

## What it actually says

<The substance. Specific claims, numbers, names. Not a summary of the summary.>

## What it means for us

<Your judgement. What would change if we acted on it. This section is the
reason the page exists — a distillation without it is just a shorter copy.>

## Links

<[[wikilinks]] to related vault pages.>
```

## Rules

- Follow the `obsidian-markdown` skill for callouts, properties, and wikilink
  syntax — this vault is read in Obsidian.
- Preserve the source reference. A distilled page whose provenance is lost
  cannot be checked.
- Never delete the raw capture. Distillation is additive.
- Use `vault_write` rather than `write` for anything inside the vault. It keeps
  the document tree's rules — it refuses `memory/`, refuses non-Markdown, and
  cannot escape the vault. Plain `write` on `target: "host"` has none of those
  guards.
- Scope every `grep` to the vault path. Searching the whole host for a topic is
  slow, noisy in the action log the operator reads, and would surface files that
  have nothing to do with the vault.
