# AKIRA Phase 1 — Design

**Status:** Implemented (Phase 1) on branch `feat/akira-phase-1` — 2026-06-28
**Visual reference:** `docs/design/akira-hud.html` (locked HUD mockup)

## Goal

Make AKIRA the **front door** to Mission Control: a full-screen voice-and-HUD
landing that briefs you on the whole fleet, talks with you, takes you into the
right project, relays a request into a project's Sage on your behalf, and opens
web destinations for you. The existing dashboard and per-project Sage world keep
working exactly as they do today; AKIRA is a new layer beside them, not inside
them.

> AKIRA is female (she/her). "Hermes" was the earlier working name and is retired.

## Scope decisions (locked during brainstorming)

- **Phase 1 = experience shell**, not the autonomous cross-project router. AKIRA
  briefs, navigates, relays (human-confirmed), opens, and talks. The fully
  autonomous cross-project dispatcher is **Phase 2**.
- **Abilities:** brief you · navigate you · relay a request (one-shot, confirmed)
  · open web destinations (with search templates) · voice both ways.
- **Routing:** AKIRA HUD at `/`; existing dashboard moves to `/dashboard`.
- **Brief source:** always AKIRA-generated narrative (chosen Option 2) — every
  landing runs her brief turn over the live fleet snapshot.
- **Memory:** persistent thread — she remembers across landings.
- **Agent model:** dedicated AKIRA runner (Approach A) — no worktree, no
  dispatch tool, read-only + controlled action tools.

## Out of scope for Phase 1 (named to prevent creep)

- Cross-project autonomous dispatch / AKIRA running work unattended — **Phase 2**
  (relay stays human-confirmed in Phase 1).
- **AKIRA Local Companion** (future phase): launching *native* apps, focusing/
  arranging OS windows, page automation (driving a page's own controls,
  checkout), and moving files laptop↔Mini. Requires a local allowlisted agent on
  the user's machine; only works at the machine it's installed on.
- Premium voices (OpenAI Realtime / ElevenLabs) — Phase 2 swap behind the voice
  wrapper.
- Always-on wake-word listening.
- Apple Calendar / phone integrations; Postiz / social / YouTube — later phases.
- Thread *summarization* (vs. simple trim) — fast-follow if needed.

---

## Architecture & data model

AKIRA sits beside the per-project Sage world. She reads across everything and
routes you in; projects keep running unchanged.

- **New agent row.** Add `akira` to the `agents` table (id `akira`, role
  `concierge`, own system prompt + model). She is **not** in dispatch.ts's
  `DISPATCHABLE` enum — Sage can't dispatch her, and she isn't a coding
  specialist.
- **Her conversation lives outside the project/session model.** Project sessions
  are tied to repo + worktree + branch; AKIRA has none. Reuse the `messages`
  table via **one reserved `sessions` row** (well-known id, e.g. `akira`) with
  **nullable `project_id` / `repo_path`** and no worktree. This reuses all
  existing message plumbing (persist, load, clear) instead of a parallel store.
  The AKIRA runner simply never calls `ensureWorktree` for it.
- **Blast radius.** AKIRA never gets a worktree, the `dispatch_agent` tool, or
  any file-edit tool. Her tools are read-only DB queries + three controlled
  action tools (`navigate`, `relay`, `open`).
- **Migration:** one new migration — make `sessions.project_id` /
  `sessions.repo_path` nullable, seed the `akira` agent row, and create the
  reserved AKIRA session row.

---

## Staying current as Mission Control grows

AKIRA's awareness must be query-driven and extensible, never a hardcoded list
that goes stale.

1. **New instances are free.** The fleet snapshot queries live tables at request
   time, so new projects/sessions/proposals/jobs appear automatically.
2. **New *kinds* plug in via a contributor registry.** The snapshot is a list of
   small contributors (one per subsystem). Teaching AKIRA about a brand-new
   subsystem = one new contributor file registered in one place.
3. **Roster/capabilities come from the DB, not her prompt.** Her prompt renders
   the live `agents` table and project list each turn, so new specialists are
   known with zero prompt edits.
4. **On-demand drill-down read tools** let her look up specifics live rather than
   being limited to the snapshot.

**Standing rule (add to docs + the `ship-mc-feature` skill):** when a feature
adds a new user-visible subsystem, add an AKIRA snapshot contributor for it.

---

## Components

### Fleet snapshot — `src/lib/fleet-snapshot.ts`

One function `getFleetSnapshot()` returning a compact structured picture, built
from a registry of per-subsystem contributors. Each contributor is isolated
(try/catch); one failing contributor degrades only its slice.

```
getFleetSnapshot() -> {
  projects:  [{ id, name, activeSessionId, status, lastTurnAt }]
  running:   [{ project, sessionId, agent }]          // sessions with running_since set
  proposals: [{ project, sessionId, summary, age }]    // awaiting review
  health:    { verdict: 'pass'|'fail'|'unknown', at }  // latest health-check job
  insights:  [{ project, text, age }]                  // recent / overnight dream insights
  schedules: [{ project, kind, nextRunAt }]            // today's jobs
}
```

Single source of truth for both the deterministic dashboard cards and AKIRA's
prompt context. Assembled from existing helpers (sessions, proposals-data,
health-verdict, dream-insights, schedules-data).

### AKIRA runner — `src/lib/akira-turn.ts`

A sibling to `runSessionTurn`, deliberately not sharing the worktree/dispatch
machinery:

1. Load the AKIRA thread (messages on the reserved session).
2. Build the prompt: her system prompt + rendered fleet snapshot + live roster
   (agents table) + conversation transcript (reuse `buildOrchestratorPrompt`
   rendering).
3. Call `runClaudeAgent` directly — **no worktree** — with her model, her system
   prompt, and her MCP server exposing the action + drill-down tools.
4. Stream tokens out (same SSE event shape the HUD/voice consume) and persist her
   final message to the thread.
5. **Thread trimming:** keep the last N turns verbatim, drop older ones, to bound
   context growth. (Summarization is a fast-follow, out of scope here.)

**The brief is a turn with no user message** — on landing the HUD fires a turn
seeded with an instruction like *"Brief the operator on the current fleet
state."* Same path as a normal reply, so there is exactly one runner.

### Action tools (in-process MCP, same pattern as `dispatch_agent`)

- **`navigate` — `{ projectId, sessionId? }`.** Sets the active project (and
  active session, reusing `projects.active_session_id` + the active-project
  endpoints/cookie) and emits a `navigate` event. The HUD routes the browser to
  `/dashboard?project=…&session=…`. No work runs; no confirmation needed.
- **`relay` — `{ projectId, sessionId, instruction }`, propose-confirm gated.**
  AKIRA never silently starts work:
  1. You ask for something.
  2. She picks the target session, phrases the instruction, and calls `relay` in
     **`propose` mode** — which does **not** start a turn. It emits a
     `relay_proposal` event.
  3. The HUD shows **Confirm / Cancel** (and she says it aloud).
  4. On confirm, the browser calls the existing turn endpoint (or a thin
     `relay/confirm` endpoint) that runs `runSessionTurn(sessionId, instruction)`
     — the same authenticated user-action path used today. AKIRA proposes; the
     human pulls the trigger.
  5. After launch she either reports back on the HUD or `navigate`s you into the
     session to watch.
  **Critical safety invariant:** AKIRA's own turn cannot start a coding turn
  unattended; `relay` in propose mode is side-effect-free.
- **`open` — `{ target, query? }`, Tier 1.** Resolves `target` against a
  **destinations registry** that holds fixed links AND **search templates**
  (e.g. Outlook → `outlook.office.com`; Amazon → `amazon.com/s?k={query}`;
  Google/YouTube similarly). Emits an `open_url` event; the HUD opens it in a new
  browser tab/window — which is on the user's laptop regardless of MC running on
  the Mini. The registry is the allowlist (no arbitrary URLs). AKIRA opens
  doors/results; she does not operate the page behind them (that is the Local
  Companion phase).

### Drill-down read tools (read-only)

`list_sessions(projectId)`, `get_session_detail(sessionId)`,
`get_proposal(sessionId)` — let AKIRA answer specifics without bloating the
snapshot. The registry of destinations and contributors are the extensibility
seams.

### HUD route + page — `/`

- The existing dashboard (`src/app/page.tsx` → `<MissionControl>`) moves to
  **`/dashboard`**, untouched. Login redirects to `/`.
- `/` is the AKIRA HUD — the locked `docs/design/akira-hud.html` ported to a
  Next page + client component.
- **Server component** fetches the fleet snapshot and paints the deterministic
  cards immediately (the dashboard summary is useful even while she's thinking).
- **Client component** owns the orb (idle / listening / speaking states),
  AKIRA's conversation stream, and the voice layer.
- On mount it opens an SSE stream and fires the brief turn: orb → `thinking`,
  narrated greeting streams in token-by-token, orb → `speaking`, settle to
  `idle`.
- "Open full dashboard ↗" and the scroll-cue route to `/dashboard`; AKIRA's
  `navigate` events route to `/dashboard?project=…&session=…`.

### Conversation transport

Reuse the existing SSE turn-stream shape. AKIRA's stream carries `token` /
`done` plus new events: `navigate`, `relay_proposal`, `relay_confirmed`,
`open_url`. Orb state is driven by the stream lifecycle (thinking on open,
speaking while tokens flow, idle on done; listening while the mic captures).

### Voice layer — `src/lib/voice/` (client-only)

Browser Web Speech API, wrapped so the rest of the app never touches raw APIs.

- **TTS** — `SpeechSynthesis`. AKIRA's streamed text is spoken in chunks at
  sentence boundaries so it sounds natural. Prefer a high-quality **female**
  voice from `getVoices()`, with a fallback.
- **STT** — `SpeechRecognition` (the "Tap to speak" mic). Captured text becomes a
  message → fires an AKIRA turn. Orb shows `listening` while capturing.
- **Two independent, always-visible toggles in the HUD top bar, persisted to
  localStorage:**
  - **🎙 Mic (input / STT) on/off** — when **off**, `SpeechRecognition` never
    starts, the mic is never accessed, "Tap to speak" is disabled, and the orb
    never enters `listening`. **Off by default** (privacy-first; avoids the
    permission prompt until you opt in).
  - **🔊 Voice (output / TTS) on/off** — independently controls whether she
    speaks replies aloud.
- **Graceful degradation** — uneven browser support (Chrome/Edge solid, Safari
  partial, Firefox lacks STT). Unsupported toggles are disabled with a tooltip;
  silent fallback to a fully-working text experience. Voice is an enhancement,
  never a hard dependency.
- **Wake greeting** — no always-on listening in v1. The brief *displays* on
  landing and is *spoken* after your first interaction (a click/tap unlocks
  audio per browser autoplay rules), or immediately if you arrived via the mic.

---

## Error handling

- **Brief turn fails** (LLM error, expired token, timeout): deterministic cards
  already painted, so the HUD stays useful. Greeting falls back to a templated
  line + a quiet "couldn't compose a brief — tap to retry" note. Orb returns to
  `idle`, never stuck in `thinking`.
- **Snapshot partial failure:** per-contributor try/catch — one subsystem
  throwing degrades only its card to "unavailable" (mirrors the v1.8.3 per-session
  fault-isolation lesson), never blanks the brief.
- **`navigate` to a stale/missing target:** validate it exists; if not, AKIRA
  reports it instead of routing into a 404.
- **`relay` target invalid or session busy** (lease held): the proposal surfaces
  the conflict ("a turn's already running there") rather than failing silently.
- **`open` with an unknown target:** AKIRA says she doesn't have that destination
  yet rather than opening a guessed URL.
- **Voice unsupported / permission denied:** silent fallback to text; toggle
  disabled with tooltip.
- **Thread growth:** trimming bounds context; if a turn still overflows, trim
  harder rather than error.

---

## Testing

(node:test via tsx — extensionless imports, per project convention; no new
runner dependency.)

- `fleet-snapshot.test.ts` — seed a DB, assert each contributor's slice; assert
  one throwing contributor degrades only its slice.
- `akira-turn.test.ts` — prompt assembly (snapshot + roster + transcript),
  thread trimming, the no-worktree path; mock the SDK runner.
- Tool handler unit tests — `navigate` sets active project/session; **`relay` in
  propose mode does NOT start a turn** (the critical safety assertion); confirm
  path calls the turn endpoint; `open` resolves fixed links and search templates
  and rejects unknown targets.
- Voice wrapper — pure logic only (sentence-chunking of streamed text, voice
  selection/fallback). The Web Speech APIs themselves are browser-only and not
  unit-tested.

---

## Component summary

| Unit | Responsibility | Depends on |
|------|----------------|------------|
| `fleet-snapshot.ts` + contributors | Structured live picture of the fleet | sessions, proposals-data, health-verdict, dream-insights, schedules-data |
| `akira-turn.ts` | Run one AKIRA turn (no worktree), persist thread, trim | runClaudeAgent, conversation rendering, snapshot, AKIRA MCP server |
| AKIRA MCP server | `navigate` / `relay` / `open` + drill-down read tools | active-project endpoints, runSessionTurn (confirm path), destinations registry |
| destinations registry | Fixed links + search templates (the open allowlist) | — |
| `/` HUD page + client | Orb, stream, voice, deterministic cards | fleet-snapshot, akira-turn stream, voice layer |
| `src/lib/voice/` | TTS/STT wrappers + mic/voice toggles | Web Speech API |
| migration | nullable session columns, seed `akira` agent + reserved thread row | — |
