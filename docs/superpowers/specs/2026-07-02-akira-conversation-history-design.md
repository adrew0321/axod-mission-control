# AKIRA Front-Door Conversation History — Design

**Date:** 2026-07-02
**Status:** Approved (design)
**Feature branch:** `feat/akira-conversation-history`
**Related:** reply formatting (merged `3f21de9`); [Obsidian long-term memory] is a separate later feature.

## Summary

The AKIRA front door (`/`) shows only her single latest reply — your messages and
prior turns are invisible, even though every turn is **already persisted** to her
reserved thread in the DB ([akira-turn.ts](../../../src/lib/akira-turn.ts) inserts
both the user message and her reply). This feature surfaces that history as a
**Hybrid** layout: the hero stays exactly as it is, and past turns stack in a
scroll-back conversation stream above the current reply.

## Goals

- Show recent conversation history (your turns + hers) on the front door.
- Keep the current hero intact — big orb, greeting, idle-rest fade, and
  "scroll into Mission Control" all unchanged.
- Reuse the reply formatting just shipped (`ReplyBody`, centered-unless-long).
- No new persistence, no new API, no migration — load server-side from the
  existing `messages` table.

## Non-Goals

- Full/deep archive on the front door (that belongs in the dashboard). The front
  door loads a shallow window (~8 messages).
- Editing/deleting turns, search, or multi-thread switching.
- Obsidian-backed cross-session long-term *memory* — a separate later feature
  (this shows what's already stored; it does not change what AKIRA remembers).

## Layout (Hybrid)

Inside the existing hero, top → bottom:

```
        ( big orb )
     Good afternoon, A'Keem.
   ┌─ conversation stream ──────┐
   │  … older turns (scroll up) │
   │  you →      (bubble)       │
   │  ● her reply (ReplyBody)   │  ← newest, sits just above input
   └────────────────────────────┘
     [ Ask AKIRA…            ↑ ]
   SCROLL INTO MISSION CONTROL ⌄
```

- Stream renders **oldest → newest**; newest reply lands right above the input
  (where the reply is today). History fills upward; scroll up to see more.
- **Your turns:** right-aligned bubbles. **Her turns:** `ReplyBody`
  (centered-unless-long, bullets, links).
- Idle-rest: after 100s the whole stream + greeting + input fade to just the orb;
  any interaction wakes it — same behavior as today, applied to the stream.

## Data flow

`page.tsx` (server component) already loads a recent brief; it will instead load
recent **turns** and pass them to `Hud`.

- **`getRecentTurns(limit)`** (new, `src/lib/akira/history.ts`) — query the last
  `limit` messages for `AKIRA_SESSION_ID` (both roles), oldest-first, and map to
  `Turn[]` via a pure `toTurns()` helper.
- **`toTurns(rows)`** (pure, unit-tested) — map DB rows → `Turn = { role: 'you' |
  'akira'; content: string; at: number }`, and **filter out synthetic user
  messages** that aren't real operator input: the brief instruction
  (`Brief the operator…`), the gate-approval continuation
  (`I approved the gated action — continue.`), and relay/attachment wrappers.
  These would otherwise show as spurious "you" bubbles.

**Token-saving unchanged:** if the newest turn is an agent message younger than
the brief TTL (`AKIRA_BRIEF_TTL_MINUTES`, default 4h), the HUD reuses it — no fresh
Claude call. Otherwise it runs a brief as today, which becomes the newest turn.
`getRecentTurns` returns the turns plus whether the newest agent turn is fresh, so
`page.tsx` can decide (replacing the current `getRecentBrief` call).

## Client model (`hud.tsx`)

- New state `turns: Turn[]`, seeded from `initialTurns`.
- The live streaming reply stays in `reply` (as today); it renders as the newest
  agent turn while streaming.
- **On send:** push `{ role: 'you', content: text }` optimistically (appears
  instantly above), then stream the answer into `reply`.
- **On `persisted`:** push `{ role: 'akira', content: <final reply> }` to `turns`
  and clear `reply`. Net: one consistent stream, newest at the bottom.
- Idle-rest fades the stream container (extends today's reply-fade to the whole
  stream).

## Components (keeps `hud.tsx` from bloating)

- **`src/components/akira/conversation-view.tsx`** (new) — move `ReplyBody` here
  from `hud.tsx`, and add:
  - `ConversationStream({ turns, liveReply, dim })` — renders the turns (user
    bubbles + `ReplyBody`) followed by the live reply block.
  - Owns the reply/stream styles that currently live in `hud.tsx`.
- **`src/lib/akira/history.ts`** (new) — `getRecentTurns` + pure `toTurns` + the
  `Turn` type + the synthetic-message filter list.
- **`hud.tsx`** — consume `initialTurns`, hold `turns` state, render
  `ConversationStream`, append on send/complete. (Net-smaller once `ReplyBody`
  moves out.)
- **`page.tsx`** — swap `getRecentBrief` for `getRecentTurns`; pass `initialTurns`.

## Error handling

- Empty history (fresh install / cleared thread): stream is empty; behaves exactly
  like today (runs a brief). No special-casing.
- A malformed/empty message row is skipped by `toTurns`.
- If `getRecentTurns` throws (DB hiccup), `page.tsx` falls back to no history +
  a fresh brief — the front door still renders.

## Testing

- **Automated (pure, `node:test` via tsx):** `toTurns` — ordering (oldest→newest),
  role mapping (`user`→`you`, `agent`→`akira`), the synthetic-message filter, and
  the limit/window behavior.
- **Manual:** the rendered stream, scroll-up-for-history, optimistic user bubble,
  streaming reply landing as newest, and idle-rest fading the whole stream.

## Conventions

- Branch `feat/akira-conversation-history` off `dev`; merge to `dev` when green
  (`pnpm test` + `pnpm exec tsc --noEmit` + `pnpm build`). **Hold the release** —
  ships in the same `dev`→`main` cut as the companion HUD, not separately.
- Extensionless TS imports; tests via `tsx --test`; no new dependency; no migration.
