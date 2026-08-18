---
name: distil-research
description: Turn a raw capture in research/ into a durable distilled page with wikilinks, and index it. Use when the operator drops an article, transcript, or notes into the vault and wants them made useful.
---

# Distil research

Raw captures are worth keeping and painful to reread. This turns one into a page
that answers questions six months from now.

## Steps

1. `Read` the raw capture. If the operator gave a URL instead, `WebFetch` it.
2. Decide the page's **claim** — the one thing it is about. If the source covers
   several unrelated things, make several pages rather than one vague one.
3. Write the page to `research/<slug>.md` with `vault_write`, using the
   structure below.
4. Link it: search the vault with `Grep` for topics the page touches, and add
   `[[wikilinks]]` to the pages that already exist. A page with no links is a
   dead end.
5. Add its line to `research/INDEX.md`, preserving the existing lines.
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
