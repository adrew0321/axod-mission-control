# Clear Session Log Design

**Date:** 2026-06-02
**Branch:** `feature/clear-session-log` (off `dev`)
**Scope:** A "Clear" control that empties the on-screen conversation log so the operator can declutter the chat — **purely cosmetic**. Nothing is deleted, the same session/worktree is kept, and Sage's memory is untouched.

---

## Behavior (operator-approved)

- A **Clear** button in the chat-column header ("Session Logs · ID: …" bar) empties the visible conversation.
- **Client-side only.** `setMessages([])` — no backend call, no DB write, no schema change.
- **Sage still remembers everything.** Its memory comes from the server-side transcript built from the DB (`stream/route.ts` → `buildOrchestratorPrompt`), which this never touches. Clearing the view does not change what Sage sees.
- **Nothing deleted.** Messages remain in the `messages` table. **A page reload restores the full log** (re-fetched from the DB) — this doubles as the undo.
- You keep working after clearing; new messages append to the now-clean view.
- **Scope:** the conversation log only. The Terminal/Plan workspace tabs are independent and left alone.
- **No confirmation dialog** — non-destructive and reload-reversible.

## Implementation

Single file: `src/components/mission-control.tsx`.
- Import the lucide `Eraser` icon.
- In the chat header (`<div className="h-11 … justify-between">`, ~line 807), wrap the existing "Target Directory" block and a new button in a right-aligned flex container.
- The button (shown only when `messages.length > 0`), styled like the existing small header buttons (e.g. the diff Refresh button): `text-[9.5px] font-mono`, muted → cyan on hover, `bg-[#161c25] border border-[#2a3441]`. `onClick={() => setMessages([])}`, `title="Clear the conversation view (kept in history; reload to restore)"`.

## Out of scope

Persisting the clear across reloads · clearing Terminal/Plan tabs · deleting or archiving messages · resetting Sage's memory · resetting the cost/token meter (it stays session-accurate).

## Verification

- `pnpm build` clean; `pnpm test` unchanged (51/51 — pure presentational, no logic module).
- Live: click Clear → the log empties; send a new message → it appears in the clean view AND Sage responds with full prior context (memory intact); reload → the full log returns.
