# Front-Door Polish — Design (AKIRA digests, bigger window, tab title)

**Status:** Approved design (2026-07-11).
**Feature:** Make the AKIRA front door feel like the operator's **home base** — she digests depth
into short, substantive briefs instead of dumping walls of text; the conversation reads like a real
window (bigger, framed, orb out of the way); long replies fold; and the browser tab is identifiable.

Triggered by a real conversation where AKIRA pasted a 13-section design doc into the concierge chat
and answered simple questions with multi-section essays.

---

## Product model (the frame for every decision)

Per [[front-door-is-home-base]]: the **front door (AKIRA, `/`) is home base** — self-sufficient,
where the operator lives day-to-day. The **Mission Control dashboard (`/dashboard`) is a deliberate
deep-dive** he visits on purpose to start/inspect a project and watch Sage's team. So AKIRA must
**digest** relayed results into the front door (takeaways + the one decision owed), never (a) paste
the full document nor (b) deflect "go read it in the dashboard." The dashboard is an *option*, not a
redirect. This mirrors how Claude Code works with him: lead with the answer, keep chat scannable,
put long-form artifacts where they belong and summarize.

## Locked decisions

- **Response behavior:** AKIRA digests + stays concise (prompt). Never authors or pastes a full
  design/audit/plan in chat.
- **Reply cap:** long replies fold with an **inline "Show more" / "Show less"** (depth stays in the
  front door, collapsed — read in place). No per-reply dashboard redirect. The dashboard link is the
  existing soft "scroll into Mission Control" affordance, unchanged.
- **Window:** bigger + framed; the orb shrinks when a conversation is active.
- **Tab title:** front door → **"AXOD — AKIRA"**; dashboard stays "AXOD Mission Control".

## Components

### 1. AKIRA prompt — digest + brevity (`src/lib/akira/prompt.ts`)

Rewrite the Style + Formatting section of `AKIRA_SYSTEM_PROMPT` to the chief-of-staff model:
- **Lead with the answer.** Default **2–4 sentences**. Only go longer when he explicitly asks for
  the full picture — and even then, structure it, don't ramble.
- **One structural device max** per reply — a short bullet list *or* a short table, never stacked
  sections/headings. No multi-section reports in chat.
- **Digest relayed work.** When Sage (or a specialist) finishes something, report the meaningful
  outcome + the one decision he owes in a few sentences (e.g. "Sage's Task Router design is done —
  recommends observability first, shadow-mode routing, ~4–5 weeks across 4 phases; the queue's
  blocked on the server-side turn runner. Want the gist of a phase?"). **Never reproduce the
  document in chat**, and don't tell him to go read it — bring the substance to him. If he wants the
  full artifact he'll open the dashboard himself.
- **Cut the filler:** no meta-questions ("does that land?", "ready to fire?"), no throat-clearing
  ("but I'll be straight", "you're asking the right question"), no narrating your own tools/planning.

This is a text change to the static prompt → **needs an agent reseed** on deploy (AKIRA's
`system_prompt` is DB-sourced; `ensureAkiraThread` is `onConflictDoNothing`). Bundles with the
pending fast-follow reseed.

### 2. Reply-cap fold (`src/components/akira/conversation-view.tsx`)

A new `<CollapsibleReply>` wrapper around `ReplyBody` for AKIRA turns:
- Measures the rendered height (a `useRef` + `scrollHeight` after render). If it exceeds a threshold
  (~`COLLAPSE_PX = 320`, roughly 10–12 lines), render it clamped to that height with a bottom **fade
  mask** and a centered **"Show more"** cue; expanded shows the full reply + **"Show less"**.
- Only shows the toggle when the content actually overflows (short replies render untouched — no cue).
- Applies to AKIRA replies in BOTH the collapsed hero (the current/last reply) and the expanded
  history list; the live-streaming reply is exempt while streaming (it grows naturally, pinned to the
  newest line as today) and gains the fold once it finalizes.
- Pure display; no new heuristics, no dashboard-redirect logic.

### 3. Bigger, framed conversation window (`src/components/akira/conversation-view.tsx`)

- Raise the scroll caps: `collapsedScroll` **40vh → 58vh**, `expandedScroll` **50vh → 70vh** (the
  orb-shrink in Component 4 frees the vertical room this needs without pushing the input off-screen —
  the v1.13.4 constraint that set 40vh).
- Widen: `streamStyle.maxWidth` **680 → 720**, and `akiraBlock`'s `maxWidth` 640 → 680.
- **Panel frame:** wrap the stream in a subtle container — `border: 1px solid rgba(127,220,255,.12)`,
  `background: rgba(7,13,22,.45)`, `borderRadius: 16`, inner padding — so it reads as a distinct
  window (matching the HUD/Settings panel language) instead of floating text. Keep it unobtrusive
  (low-contrast) so the hero still feels airy when a reply is short.

### 4. Orb shrinks when a conversation is active (`src/components/akira/hud.tsx`)

Today the orb is `size={historyOpen ? 132 : 320}` — so a full 320px orb dominates the top half even
when there's an active exchange. Change the size to also shrink when a conversation is present:
`size = historyOpen ? 132 : conversationActive ? 200 : 320`, where `conversationActive` = there are
turns OR a live reply OR thinking. The big 320 orb stays only for the empty/greeting state; once he's
talking, the orb steps back and the (now taller) conversation window gets the space.

### 5. Tab title (`src/app/page.tsx`)

`page.tsx` is a server component, so add a page-level metadata export:
```ts
export const metadata = { title: "AXOD — AKIRA" };
```
This overrides the root `layout.tsx` title ("AXOD Mission Control") for `/` only; the dashboard route
keeps the root title. Each tab is then identifiable (he runs several).

## Data flow / behavior

Operator talks to AKIRA → she answers concisely (2–4 sentences, digested) → if a reply is long it
folds with "Show more" → the conversation lives in a bigger, framed window with the orb stepped back
→ the tab reads "AXOD — AKIRA". Depth/artifacts remain in the dashboard for when he chooses to dig in.

## Testing

- **Manual (matches the front-door convention — these are React/prompt changes, not unit-tested):**
  - Prompt: talk to AKIRA about a relayed result; confirm she digests it (a few sentences + the
    decision), does not paste a doc, does not just deflect to the dashboard.
  - Reply cap: a long reply folds with "Show more"/"Show less"; a short reply shows no cue; the
    streaming reply grows live then folds when done.
  - Window: bigger + framed; orb shrinks to 200 once a conversation is active; input + "scroll into
    Mission Control" cue stay on-screen (no regression of the v1.13.4 fix).
  - Tab: `/` shows "AXOD — AKIRA"; `/dashboard` shows "AXOD Mission Control".
- **Pure (if extracted):** an `overflowsAt(height, cap)` helper is trivial; the existing
  `parseReply`/`isLongReply` tests still cover formatting.

## Rollout

Code-only; **no new deps, no DB migration.** The prompt change needs an **agent reseed** (`pnpm seed`)
on deploy — bundle it with the pending fast-follow reseed so it's one seed. UI changes take effect on
the next build+restart.

## Out of scope (→ later)

- A per-reply structured "relay result card" with a session deep-link (the digest + existing
  scroll-into-dashboard affordance covers it; revisit if he wants one-click open).
- In-the-moment relay-result summaries generated server-side (AKIRA's prompt handles digesting).
- Voice/HUD experience-layer work (separate slice).

## Resolved decisions

- Front door = home base; AKIRA **digests**, never dumps, never deflects.
- Reply cap: **inline Show more/less** (depth stays in the front door); dashboard link soft/optional.
- Window: caps 58vh/70vh, widened, **framed**; orb shrinks to 200 when a conversation is active.
- Tab: `/` = **"AXOD — AKIRA"** via a page-level metadata export (server component).
- Prompt change → **reseed on deploy** (bundle with the pending fast-follow reseed).
