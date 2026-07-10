# AKIRA SOUL + Self-Improvement — Design

**Status:** Approved design (2026-07-10).
**Feature:** Give AKIRA a first-class **SOUL** (her identity/voice/values as an editable vault
doc) and a **self-improvement** pillar (she writes *lessons* in the moment that actively steer
her). Both are portable vault data so they survive AKIRA's eventual move to a self-hosted model.

This formalizes two of the Nous "Hermes Agent OS" 5 pillars that MC was only doing partially —
**Soul** (was baked into code) and **Self-improvement** (was incidental). Memory (the Obsidian
vault, v1.12.0), Crons (Scheduler/Dreaming), and Skills (ship-mc-feature + the make-a-skill
standing instruction) are already covered.

---

## Why now / strategic frame

A'Keem's long-term target is to **self-host AKIRA on an open model (DeepSeek) for sovereignty**,
keeping Sage + the specialist team on Claude (see the sovereignty memory note). He is not buying
GPU hardware yet, so the near-term move is: keep AKIRA on Haiku/Claude, and build these pillars
**model-agnostically** so the future migration inherits them.

**Design mandate — portability:** SOUL and lessons are plain Markdown in the Obsidian vault
(`data/akira-memory/`) plus **pure injection functions**. The ONLY Claude-Agent-SDK-specific
piece is the `remember` tool wiring. When AKIRA migrates to self-hosted DeepSeek, her SOUL and
every lesson transfer 1:1; only the thin tool layer is re-implemented.

## Locked decisions

- **SOUL scope:** identity + voice + values only. Operational rules (job, tools, grounding,
  formatting, memory mechanics) stay in the code prompt.
- **SOUL ownership:** PIN-locked — operator-only, edited through the existing memory Settings
  panel (`AKIRA_MEMORY_PIN`). AKIRA reads her SOUL every turn but cannot rewrite it.
- **Lessons ownership:** AKIRA's. She writes them herself.
- **Learning trigger:** in-the-moment only (no periodic reflection pass in v1).
- **Lessons are injected in FULL as active guidance** (bounded), not merely indexed — this is what
  makes self-improvement actually change behavior.
- **SOUL.md is seeded from her exact current persona** so nothing about how she feels regresses.

## Architecture

```
data/akira-memory/                         akira-turn.ts (every turn):
  SOUL.md          ── (full text) ─────────►  ## SOUL       (who she is)
  <lesson notes>   ── (full text, bounded) ─► ## LESSONS    (what she's learned)  } steer
  <other notes>    ── (INDEX.md descriptions)► ## MEMORY     (facts, recalled on demand)
                                              ## FLEET SNAPSHOT / ## ROSTER / ## CONVERSATION
  remember(type:'lesson')  ◄── AKIRA writes a lesson in the moment
  Settings panel (PIN)     ──► edits SOUL.md
```

### Component 1 — SOUL storage + default (`src/lib/akira/memory/soul.ts`, new)

- `SOUL_FILE = 'SOUL.md'` — a **special vault file**, NOT a memory note.
- `DEFAULT_SOUL` constant = AKIRA's current persona/voice/values, lifted verbatim from the
  identity sentence in `prompt.ts` (calm, warm, precise, a little wry; first person; addresses
  him directly; his concierge who is the front door). This is BOTH the seed and the fallback.
- `readSoul(dir?): string` — returns the file's contents, or `DEFAULT_SOUL` if the file is
  missing/empty (safety: AKIRA always has a soul even before seeding).
- `writeSoul(text, dir?): void` — atomic write (temp + rename), best-effort git commit via the
  existing store helper.
- `seedSoulIfMissing(dir?): void` — writes `DEFAULT_SOUL` to `SOUL.md` only if absent. Called from
  AKIRA bootstrap (`ensureAkiraThread`) so a fresh deploy has an editable soul.
- Pure/`node:`-only so it unit-tests under `tsx --test`.

### Component 2 — Lessons as a note type

- Add `'lesson'` to the note `type` set. The note model (`note.ts`) already carries `type` and is
  tolerant, so no schema change — only the `remember` tool enum and the injection partition change.
- **`remember` tool** (`tools.ts`): extend the `type` enum to include `'lesson'`, and expand the
  tool description so AKIRA knows to use it when she learns something durable about how to serve
  A'Keem better (a preference in how he wants things done, a recurring correction, a working-style
  lesson) — distinct from a `fact`/`preference` she merely recalls.
- **Store partition** (`store.ts`): the memory index (`INDEX.md` / `indexText()`) **excludes**
  `type: lesson` notes (so lessons don't double-appear). Add `lessonsText(dir?, opts?)` returning
  the **full body** of lesson notes, newest first, **bounded** (default cap: 20 notes AND a ~4 KB
  char budget — whichever hits first — to protect Haiku's context), each rendered as a short
  titled block. Lessons stay real notes on disk (viewable/prunable/forgettable like any memory).

### Component 3 — Prompt injection (`akira-turn.ts` + `prompt.ts`)

- **`prompt.ts`:** remove the identity/voice sentence (now sourced from SOUL). Keep everything
  operational. Add one line to the memory section: *"Your SOUL (who you are) and LESSONS (what
  you've learned about serving A'Keem) are given to you each turn. When you learn something
  durable about how he wants things done, save it as a lesson (remember with type 'lesson')."*
- **`akira-turn.ts`:** build the turn prompt in this order —
  `## SOUL\n{readSoul()}` → `## LESSONS\n{lessonsText() or "(none yet)"}` → existing
  `## FLEET SNAPSHOT` → `## MEMORY` (index, now lesson-free) → `## ROSTER` → `## CONVERSATION`.
  SOUL and LESSONS lead because identity + learned guidance should frame everything else.

### Component 4 — SOUL editor in the PIN-locked Settings panel

- Reuse the existing PIN-gated memory Settings UI (`memory-panel.tsx`) + its PIN-protected API
  (`src/app/api/memory/**`). Add:
  - `GET` current SOUL text and `PUT`/save SOUL text, both behind the same PIN check + rate limiter
    the memory routes already use (`pin.ts` / `pin-limiter.ts`).
  - A SOUL textarea in the Settings panel (below/beside the memory controls): load, edit, save,
    with a "reset to default" affordance that writes `DEFAULT_SOUL`.
- Lessons need **no** new UI — they are memory notes, already listed in the memory view; `forget`
  prunes a bad lesson.

### Component 5 — Keep AKIRA aware / registry

No new fleet-snapshot contributor: SOUL and lessons are AKIRA's own prompt substrate, not a new
user-visible fleet subsystem. (The ship-mc-feature "keep AKIRA aware" note only applies to new
*kinds* of fleet things.)

## Data flow

`ensureAkiraThread` seeds `SOUL.md` (if missing) → every AKIRA turn injects `## SOUL` +
`## LESSONS` (full, bounded) ahead of the snapshot/memory-index → AKIRA, mid-conversation, calls
`remember(type:'lesson', …)` when she learns how to serve better → that lesson steers her next
turn. Operator edits `SOUL.md` via the PIN-locked Settings panel; prunes bad lessons via `forget`.

## Error handling

- SOUL file missing/unreadable → `readSoul` returns `DEFAULT_SOUL` (never an empty soul).
- Vault not configured (`vaultReady()` false) → SOUL falls back to `DEFAULT_SOUL`; `remember`
  already returns a friendly "memory isn't configured" error; lessons block renders "(none yet)".
- Lessons over the cap → oldest beyond the bound are simply not injected this turn (they remain on
  disk). Newest-first ordering keeps the most relevant ones in-context; this is acceptable for v1,
  and a future reflection pass (out of scope) would consolidate rather than let lessons grow
  unbounded.
- SOUL save behind the PIN + existing rate limiter; a git push failure is best-effort (logged,
  never blocks the save) — same policy as memory writes.

## Testing

- **Pure, TDD (`tsx --test`):**
  - `soul.ts`: `readSoul` returns file text when present and `DEFAULT_SOUL` when missing/empty;
    `writeSoul` round-trips; `seedSoulIfMissing` writes once and never overwrites an edited soul.
  - `store.ts`: `indexText` excludes `type:'lesson'` notes; `lessonsText` returns full bodies
    newest-first and respects BOTH the count cap and the char budget; empty → "(none yet)"/"".
  - prompt assembly (`akira-turn` helper or a pure builder): section order is
    SOUL → LESSONS → SNAPSHOT → MEMORY → ROSTER → CONVERSATION; lessons absent → a clean "(none)".
  - `note.ts`/`remember`: a `type:'lesson'` note serializes/parses round-trip.
- **Store I/O** against a temp vault dir (existing `store.test.ts` pattern).
- **Route/UI** (SOUL editor + PIN gate): manual check — matches this repo's convention (PIN routes
  and React panels aren't unit-tested); verify the PIN gate + save + reset-to-default by hand.

## Out of scope (→ later)

- Periodic reflection pass (nightly self-review that distills lessons) — v2 of self-improvement.
- AKIRA *proposing* SOUL edits for operator approval — a safe middle rung, addable later with no
  rework.
- Lesson consolidation/dedupe/summarization.
- The DeepSeek self-host migration itself (separate, hardware-gated effort).

## Resolved decisions

- SOUL scope: **identity + voice + values**; operational stays in code.
- SOUL ownership: **PIN-locked, operator-only** (existing Settings gate).
- Lessons: **AKIRA-owned**, `type:'lesson'` memory notes, **in-the-moment** only.
- Lessons injected **in full as guidance** (bounded), excluded from the memory index.
- SOUL.md **seeded from her current persona** (also the missing-file fallback).
- Portability: SOUL + lessons are vault Markdown + pure functions; only the `remember` tool is
  Claude-SDK-specific.
