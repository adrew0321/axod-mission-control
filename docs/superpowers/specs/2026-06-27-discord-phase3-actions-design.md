# Discord Phase 3 — Approve & Merge / Discard buttons (design)

**Date:** 2026-06-27
**Status:** Design approved, pending spec review
**Builds on:** Discord Phase 1 (chat) + Phase 2 (notifications) —
[2026-06-25-discord-notifications-design.md](2026-06-25-discord-notifications-design.md)

## Why / scope

Phase 2 posts a **proposal-ready** embed to the bound channel when a session's worktree diverges
from its base branch. Phase 3 makes that embed **actionable**: an **Approve & Merge** button and a
**Discard** button that run the same `mergeWorktree` / `discardWorktree` the web Proposals view
uses — so you can review and ship from your phone.

**Out of scope (deliberately):** `/mc new-session` — it belongs to a separate, web-first
**session + branch management** feature (the operator can't yet create/switch sessions or choose a
branch in the web UI either; Discord should mirror the web UI, not outrun it). Also out: the
empty-content chat hint (the Message-Content-Intent bug it diagnosed is fixed).

## Components

### Pure helpers (unit-tested) — `src/lib/discord-format.ts`

- `buildActionId(action: 'merge' | 'discard', sessionId: string): string` → `mc:<action>:<sessionId>`.
- `parseActionId(customId: string): { action: 'merge' | 'discard'; sessionId: string } | null` →
  parses `mc:merge:…` / `mc:discard:…`; returns `null` for anything else (foreign/unknown buttons
  are ignored by the handler). Session ids (`sess_xxxxxxxx`) keep the id well under Discord's
  100-char `custom_id` limit.
- `proposalActionRow(sessionId: string): APIActionRowComponent<APIMessageActionRowComponent>` →
  one action row with a green (`ButtonStyle.Success`) **Approve & Merge** button
  (`custom_id = buildActionId('merge', sessionId)`) and a red (`ButtonStyle.Danger`) **Discard**
  button (`custom_id = buildActionId('discard', sessionId)`). Pure JSON, no live client.

(`discord.js` button/component **types** are imported `import type` — erased at runtime, keeps the
module pure and loadable under `tsx --test`. The enum *values* `ButtonStyle.Success/Danger` are
small runtime constants; to stay pure-testable, use their literal numeric values `3` (Success) and
`4` (Danger) with a comment, rather than importing the enum at runtime.)

### Wiring — `src/lib/discord-notify.ts`

`postToProject(client, projectId, embed, components?)` gains an optional `components` argument; when
present it sends `{ embeds: [embed], components }`. The **proposal** branch of the tick passes
`[proposalActionRow(p.sessionId)]`; the schedule and dream branches pass nothing (button-less).

### Button handler — `src/lib/discord-bot.ts` (effectful; runtime-verified)

`handleInteraction` currently returns unless `interaction.isChatInputCommand()`. Add a button
branch (keep the existing slash-command branch unchanged):

1. `if (!interaction.isButton()) return;` guard for the new branch (after the slash-command path).
2. `parseActionId(interaction.customId)` → if `null`, ignore (return).
3. **Re-check the allowlist** (`isAllowed(interaction.user.id, allowed)`) — buttons are clickable
   by anyone who can see the channel. Not allowed → `interaction.reply({ content: 'Not authorized.',
   flags: MessageFlags.Ephemeral })` and return.
4. `await interaction.deferUpdate()` — a merge can take a few seconds; defer to beat Discord's 3s
   limit while keeping the original message.
5. Load the session (`sessions` by id) + its project (`projects` by `session.project_id`),
   mirroring the merge route. If the session is missing or `worktree_path` is null (already
   merged/discarded) → edit the message to a "already resolved" state with buttons removed; return.
6. **merge:** `mergeWorktree(sessionId, project.repo_path, project.default_branch ?? 'dev')`:
   - `{ ok: true }` → `db.update(sessions).set({ worktree_path: null })`; edit the message:
     status line **"✅ Merged into `<baseBranch>`"**, `components: []`.
   - `{ ok: false, conflict: true }` → edit: **"⚠️ Merge conflict — resolve in Mission Control"**,
     `components: []` (retrying the button would just re-conflict; resolution happens in the web UI).
7. **discard:** `discardWorktree(sessionId, project.repo_path)` + clear `worktree_path` → edit:
   **"🗑️ Discarded"**, `components: []`.
8. Wrap the body in try/catch: on an unexpected error, send an ephemeral "action failed: …" and
   leave the message + buttons intact so the operator can retry.

"Edit the message" = `interaction.message.edit({ embeds: [updatedEmbed], components })` (or
`interaction.editReply` after `deferUpdate`). The updated embed adds/sets a short status line on the
existing proposal embed; a tiny pure helper `proposalResultEmbed(kind, baseBranch?)` returns the
status text + color so the rendering is testable.

## Data flow / consistency

A merged/discarded proposal has its `worktree_path` cleared, so `getProposals()` no longer returns
it and the Phase 2 notifier's `proposalCursor` drops it — no re-notification. The message is edited
in place to show the resolved state, so the channel reflects reality. Concurrent web-UI action on
the same proposal is handled by the `worktree_path`-null check (step 5) → "already resolved".

## Testing

- **Unit (`discord-format.test.ts`, `node:test` via tsx):**
  - `buildActionId` → `parseActionId` round-trips for both actions; `parseActionId` returns `null`
    for foreign / malformed ids (`'other:x'`, `'mc:bogus:x'`, `''`).
  - `proposalActionRow(sessionId)` has 2 buttons with the right custom_ids, labels
    ("Approve & Merge", "Discard"), and styles (3 / 4).
  - `proposalResultEmbed` color/text per kind (`merged` green, `discarded` grey, `conflict` amber).
- **Effectful** (`discord-notify.ts`, `discord-bot.ts`): not unit-testable (`server-only` + live
  discord.js) — verified by `tsc --noEmit` + full suite (no regressions) + a runtime check on the
  test guild: a proposal embed shows the two buttons; **Approve & Merge** merges and edits the
  message to "✅ Merged"; **Discard** edits to "🗑️ Discarded"; a non-allowlisted click gets the
  ephemeral "Not authorized"; an already-resolved proposal click shows "already resolved".

## Out of scope

`/mc new-session` and session/branch management (separate feature); changing how proposals are
detected or how `mergeWorktree` works; pagination/threading of notifications.
