# AKIRA Self-Improvement v2 — Design (nightly reflection)

**Status:** Approved design (2026-07-11).
**Feature:** A nightly **reflection pass** that keeps AKIRA sharp: a dedicated Opus reflector
reviews her recent conversations + current lessons and (A) **auto-distills/dedupes her lessons**
(git-tracked) and (B) **proposes a SOUL edit** for the operator to approve in the PIN-locked
Settings panel.

Builds directly on the SOUL + self-improvement v1 pillar (v1.16.0): v1 gave AKIRA an editable
SOUL and in-the-moment `type:'lesson'` notes; v2 adds the deliberate, periodic self-improvement
loop the Nous "Hermes" 5-pillar model calls for — without letting her rewrite her own identity
unsupervised.

---

## Why / strategic frame

Lessons inject in FULL as standing directives (bounded ≤20 / ≤4 KB), so an unmanaged, growing,
duplicative lesson set degrades her behavior over time. A nightly distillation keeps them
high-signal. SOUL proposals give her a safe path to evolve her core (the "she proposes, you
approve" middle rung deferred in v1) — the operator stays the owner of who she is.

**Portability mandate holds:** the reflector is *server infrastructure* (a background job on the
Claude SDK), independent of AKIRA's live turn loop. When AKIRA later moves to a self-hosted model
([[akira-sovereignty-self-host-target]]), the reflector can stay on Claude and her lessons + SOUL
+ proposals are plain vault Markdown that travel 1:1.

## Locked decisions

- **Reflector:** a dedicated nightly pass (Opus), modeled on Dreaming/Curator — NOT AKIRA herself,
  NOT folded into the Dreaming run.
- **Lessons:** the reflector **auto-applies** the distilled set (they're AKIRA's own; the vault is
  git-synced so every change is auditable/revertible). Surfaces a one-line summary.
- **SOUL:** the reflector **proposes**; the operator **approves/rejects** in the PIN-locked
  Settings panel. SOUL is never auto-edited.
- **Cadence:** nightly, at hour **4** (staggered after Dreaming's hour 3 so two Opus jobs don't
  overlap).
- **Distillation shape:** the reflector returns the full **consolidated lesson set**; the job
  replaces the `type:'lesson'` notes with it (git diff is the safety net) — not incremental ops.
- **One pending SOUL proposal at a time:** a fresh reflection replaces an unapproved proposal.

## Architecture

```
nightly ticker (hour 4, isReflectionDue) ──> runReflection():
  gather: AKIRA's recent conversation (session 'akira') since last reflection
        + current lessons (type:'lesson' notes) + current SOUL
        │
        ▼  Reflector agent (Opus, read-only tools)
  returns JSON: { lessons:[…consolidated…], soulProposal:{text,reason}|null }
        │
        ├── AUTO: replace type:'lesson' notes with the consolidated set  → git commit
        ├── if soulProposal: write data/akira-memory/SOUL.proposed.md    → git commit
        └── record a `reflections` row (counts + soul_proposed)

Settings panel (PIN)  ── shows current-vs-proposed SOUL diff + reason ──> Approve → writeSoul + rm proposal
                                                                          Reject  → rm proposal
FleetSnapshot.soulProposalPending ──> AKIRA mentions it in her brief
```

### Component 1 — Reflection pass (`src/lib/akira/reflect.ts`, new)

Modeled on `src/lib/dream.ts`.

- `REFLECTOR_MODEL = 'claude-opus-4-7'`; `REFLECTOR_SYSTEM_PROMPT` — a Curator-style prompt scoped
  to AKIRA: "you are reviewing AKIRA's own recent conduct + her current lessons + her SOUL; produce
  a consolidated lesson set (merge duplicates, sharpen, drop the obsolete/contradicted) and,
  ONLY if warranted, a proposed SOUL refinement with a short reason. Ground everything in the
  transcript; do not invent." Output = ONLY a JSON object (optionally in a ```json fence):
  `{ "lessons": [ { "title", "description", "body" } … ], "soulProposal": { "text", "reason" } | null }`.
- `runReflection(): Promise<RunReflectionResult>` — single-in-flight via `globalThis`, never throws
  (failures land as an `error` reflections row). Steps:
  1. Read last reflection time from the `reflections` table; gather AKIRA-session messages since
     then (bounded like Dreaming: MAX_MESSAGES / MAX_CONTEXT_CHARS), plus `lessonsText()`-style full
     lesson bodies and `readSoul()`.
  2. If there are no lessons AND no new conversation → record an `empty` row, return.
  3. Run the Reflector (Opus, read-only `['Read','Glob','Grep']`), parse JSON via `parseReflection`.
  4. **Lessons:** if the consolidated set differs, replace all `type:'lesson'` notes with it
     (delete-then-write, or a planned diff — see Component 4), `gitCommitPush('reflect: distilled
     N→M lessons')`.
  5. **SOUL proposal:** if present, `writeSoulProposal(text, reason)` (overwrites any prior
     pending), `gitCommitPush('reflect: proposed a soul edit')`.
  6. Insert a `reflections` row (status ok/empty/error, lessons_before, lessons_after,
     soul_proposed).
- `startReflecting()` — idempotent ticker (globalThis flag), 15-min interval, `isReflectionDue`
  gate at hour 4. Started alongside the other tickers in the server bootstrap.

### Component 2 — `reflections` table (additive migration)

```
reflections(
  id TEXT PK, created_at INTEGER, status TEXT,          -- 'ok'|'empty'|'error'
  lessons_before INTEGER, lessons_after INTEGER,
  soul_proposed INTEGER,                                 -- 0/1
  error TEXT NULL
)
```
Additive `CREATE TABLE` only (no table rebuild → safe under `pnpm db:migrate`; not the
[[drizzle-table-rebuild-migration-gotcha]] case). Gives the ticker its last-run time + a future
reflection-log view.

### Component 3 — SOUL proposal storage + Settings review

- **Storage** (`src/lib/akira/memory/soul.ts`, extend): `SOUL_PROPOSAL_FILE = 'SOUL.proposed.md'`.
  `writeSoulProposal(text, reason, dir?)` (frontmatter `reason`/`created` + body = proposed SOUL,
  atomic write, overwrites prior); `readSoulProposal(dir?): { text, reason, created } | null`;
  `clearSoulProposal(dir?)`. Excluded from the memory note scan (like `SOUL.md`/`INDEX.md`).
- **API** (`/api/memory/soul`, extend the v1 route):
  - On unlock (`POST /api/memory`), also return `soulProposal` (or null).
  - `POST /api/memory/soul` with `{ pin, action: 'approve' | 'reject' }`: approve →
    `writeSoul(proposal.text)` + `clearSoulProposal()` + git commit; reject → `clearSoulProposal()`
    + git commit. PIN + rate-limiter as today.
- **Panel** (`src/components/akira/memory-panel.tsx`, extend): when a proposal exists, render a
  **SOUL PROPOSAL** block above the SOUL editor — the reason, a current-vs-proposed view (simple
  two-column or before/after text), and **Approve** / **Reject** buttons.

### Component 4 — Pure lesson-distillation planner (`src/lib/akira/reflect-plan.ts`, new)

`planLessonReplace(current: Note[], distilled: {title,description,body}[]): { deletes: string[]; writes: {…}[] } | null`
— returns the note operations to make the vault match the distilled set, or `null` when they are
already equivalent (no-op → no git commit). Pure, unit-tested. Keeps the destructive replace logic
out of the I/O path and testable.

### Component 5 — AKIRA awareness (`src/lib/fleet-snapshot.ts` + `fleet-contributors.ts`)

Add `soulProposalPending: boolean` and `soulProposalReason?: string` to `FleetSnapshot`, populated
from `readSoulProposal()`. Render one line in `renderSnapshot` so AKIRA can say, in her brief,
that a soul change is waiting in Settings. (A genuinely new *kind* of thing → warrants the snapshot
addition per the ship-mc-feature "keep AKIRA aware" note.)

## Data flow

nightly hour 4 → gather AKIRA convo + lessons + SOUL → Opus reflector → consolidated lessons
(auto-applied, git) + optional SOUL proposal (`SOUL.proposed.md`, git) + `reflections` row →
snapshot flag → AKIRA mentions it → operator approves/rejects in PIN-locked Settings → `writeSoul`
or discard.

## Error handling

- Reflector call/JSON-parse failure → `error` reflections row; lessons + SOUL untouched (fail
  closed). Never throws out of `runReflection`.
- Empty (no lessons, no new convo) → `empty` row, no LLM call.
- Parse yields fewer/garbled lessons → the planner still runs, but a **safety floor**: if the
  distilled set is empty while `current` is non-empty, treat as a no-op (never wipe all lessons on
  a bad parse).
- Proposal write/approve is best-effort git (logged, never blocks), same as memory writes.
- Vault not configured → the pass no-ops (nothing to reflect on).

## Testing

- **Pure, TDD (`tsx --test`):**
  - `isReflectionDue` (nightly hour gate + staleness) — mirror `dream-due.test.ts`.
  - `parseReflection` — valid object, ```json fence, missing `soulProposal` → null, malformed →
    safe default (empty lessons, null proposal).
  - `planLessonReplace` — identical sets → null; added/removed/changed → correct deletes+writes;
    **empty distilled + non-empty current → null (safety floor)**.
  - `soul.ts` proposal helpers — write/read/clear round-trip; freshest-wins overwrite; exclusion
    from the note scan.
- **`runReflection` + routes/UI:** manual E2E (trigger a reflection, confirm lessons consolidate +
  a proposal appears in Settings + Approve writes SOUL + the snapshot flag clears). Matches the
  Dreaming/route convention (not unit-tested).

## Rollout

Code + one additive migration (`reflections` table), no new deps. Ships via ship-mc-feature. The
new ticker needs a server restart to start. **Prompt note:** this does not change
`AKIRA_SYSTEM_PROMPT` itself, but `renderSnapshot` gains a line — no agent reseed needed for this
slice (the snapshot is built per-turn, not DB-sourced). (The pending fast-follow reseed is separate.)

## Out of scope (→ later)

- In-the-moment SOUL proposals (v2 is nightly-only).
- A reflection-history view in the dashboard (the table supports it; UI later).
- Auto-applying SOUL edits (always operator-gated).
- Cross-project/team reflection (that's Dreaming's job).

## Resolved decisions

- Reflector: **dedicated nightly Opus pass** (not AKIRA, not Dreaming).
- Lessons **auto-applied** (git-tracked); SOUL **proposed + approved** in PIN-locked Settings.
- Cadence: nightly **hour 4** (staggered from Dreaming).
- Distillation: reflector returns the **full consolidated set**; job replaces (git safety net),
  with an empty-distilled safety floor.
- One pending SOUL proposal; **freshest wins**.
