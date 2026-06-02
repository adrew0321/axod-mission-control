# Clear Session Log Design

**Date:** 2026-06-02
**Branch:** `feature/clear-session-log` (off `dev`)
**Scope:** A "Clear" control that resets the conversation to a **true fresh start** — the cleared messages leave both the on-screen log *and* Sage's memory, persistently. Nothing is deleted (messages stay in the DB), and the same session/worktree/branch is kept.

> **Revised after live feedback (2026-06-02):** the first cut was cosmetic-only (`setMessages([])`, Sage kept memory). In use, asking Sage a question made it recite the just-cleared conversation. Operator chose **Option A**: clearing persists and Sage forgets the cleared messages. No "restore" affordance. Plus a friendly empty-state message after clearing.

---

## Behavior (operator-approved)

- A **Clear** button in the chat header sets a per-session **`cleared_at`** marker (server-side). After that:
  - The **on-screen log** shows only messages created after `cleared_at` (so it's empty right after clearing; **stays clear across reloads**).
  - **Sage's memory** (the transcript fed to the model) also includes only messages after `cleared_at` — so Sage genuinely starts fresh and won't resurface cleared chat.
- **Nothing deleted.** Cleared messages remain in the `messages` table (archived, just unsurfaced). No un-clear UI (operator chose simple).
- **The work is untouched.** Clearing only affects the conversation; Atlas's edits stay in the worktree, so Sage can still inspect "what changed in the repo" via its read tools at any time.
- **Cost/token meter** stays session-accurate (sums all messages, not filtered) — money spent is money spent.
- After clearing (empty log), show a subtle empty-state line: **"Let's start fresh then…"**

## Architecture

### 1. Schema + migration
Add a nullable column to `sessions` in `src/db/schema.ts`:
```ts
cleared_at: integer('cleared_at', { mode: 'timestamp' }),
```
Generate + apply the migration (`pnpm db:generate` → `pnpm db:migrate`). Nullable, so existing sessions are unaffected (no clear).

### 2. Clear API — `src/app/api/sessions/[id]/clear/route.ts` (new)
`POST` (auth-gated like the other session routes): `update(sessions).set({ cleared_at: new Date() }).where(eq(sessions.id, id))`. Returns `{ ok: true }`.

### 3. Display filter — `src/app/page.tsx`
The `messageRows` query gains a clause: when `currentSessionRow.cleared_at` is set, `and(gt(messages.created_at, currentSessionRow.cleared_at))`. The **totals** (cost/tokens) query is left unfiltered (whole-session).

### 4. Memory filter — `src/app/api/sessions/[id]/stream/route.ts`
The `conversation` query (which feeds `buildOrchestratorPrompt`) gains the same `cleared_at` clause, so Sage's transcript starts after the clear. `session.cleared_at` is already loaded with the session row.

### 5. Client — `src/components/mission-control.tsx`
- The existing Clear button's `onClick` now `POST`s to `/api/sessions/<id>/clear`, then `setMessages([])` (optimistic). On failure, surface a small error and don't clear.
- Empty-state: when `messages.length === 0`, render a centered muted line "Let's start fresh then…" in the conversation area (replaces the blank space).

## Edge cases

- **New messages after clear** append normally; they're after `cleared_at`, so they show + Sage sees them.
- **Cost meter** unaffected (intentional).
- **Clearing an already-empty log** is a harmless no-op (the button only shows when `messages.length > 0`).

## Out of scope

Restore/un-clear UI · deleting messages · clearing Terminal/Plan tabs · resetting the cost meter · multi-session switching.

## Verification

- `pnpm db:generate` produces one migration adding `cleared_at`; `pnpm db:migrate` applies it; `pnpm build` clean; `pnpm test` unchanged (51/51).
- Live: have a conversation → **Clear** → log empties and shows "Let's start fresh then…"; **reload** → still empty; ask Sage "what did we talk about?" → fresh-slate answer (no recital of cleared chat); ask "what changed in the repo?" → Sage can still read the worktree. The cost meter still reflects the full session.
