# Front-Door Polish Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the AKIRA front door a clean home base — she digests instead of dumping (prompt), long replies fold, the conversation reads like a real window, and the tab is identifiable.

**Architecture:** Client-side UI changes to `conversation-view.tsx` + `hud.tsx`, a page-level tab title on the server-component `page.tsx`, and a prompt rewrite in `prompt.ts`. No new deps, no migration.

**Tech Stack:** Next.js 16 (server + client components), React, the existing AKIRA front-door components.

## Global Constraints

- **Home-base model:** the front door is self-sufficient; AKIRA digests depth into it and never dumps a full doc or deflects to the dashboard (see the spec + [[front-door-is-home-base]]).
- UI/prompt changes are verified manually (this repo does not unit-test React components/routes). Keep any genuinely-pure helper testable, but don't force TDD onto rendering.
- **The prompt change needs an agent reseed** (`pnpm seed`) on deploy — AKIRA's `system_prompt` is DB-sourced and `ensureAkiraThread` is `onConflictDoNothing`. Bundle with the pending fast-follow reseed.
- Don't regress the v1.13.4 constraint: the input + "scroll into Mission Control" cue must stay on-screen (the orb-shrink in Task 2 is what buys the room for the taller window in Task 3).

---

### Task 1: Tab title — "AXOD — AKIRA" on the front door

**Files:**
- Modify: `src/app/page.tsx`

- [ ] **Step 1: Add a page-level metadata export**

`page.tsx` is a server component, so a page `metadata` export overrides the root layout title for `/` only. Add near the top (after the imports, before `export const dynamic`):

```ts
export const metadata = { title: "AXOD — AKIRA" };
```

- [ ] **Step 2: Verify**

Run: `npx tsc --noEmit`
Expected: EXIT 0. (Manual: `/` tab reads "AXOD — AKIRA", `/dashboard` still "AXOD Mission Control".)

- [ ] **Step 3: Commit**

```bash
git add src/app/page.tsx
git commit -m "feat(front-door): tab title 'AXOD — AKIRA' on / (dashboard unchanged)"
```

---

### Task 2: Orb steps back when a conversation is active

**Files:**
- Modify: `src/components/akira/hud.tsx`

- [ ] **Step 1: Shrink the orb once a conversation is present**

In `hud.tsx`, the orb is `<Orb mode={mode} size={historyOpen ? 132 : 320} />`. A full 320px orb dominates the top half even mid-exchange. Derive `conversationActive` from the state already in scope (`turns`, `reply`, `mode`) and use a three-way size. Just above the `<section style={hero}>` return (or inline), add:

```tsx
  const conversationActive = turns.length > 0 || reply.length > 0 || mode === "thinking";
```

Change the orb line to:

```tsx
          <Orb mode={mode} size={historyOpen ? 132 : conversationActive ? 200 : 320} />
```

The big 320 orb stays only for the empty/greeting state; once he's talking, the orb steps back to 200 and frees vertical space for the (taller) window.

- [ ] **Step 2: Verify**

Run: `npx tsc --noEmit`
Expected: EXIT 0. (Manual: orb is 320 on a fresh load, shrinks to 200 after the first message, 132 when history opens.)

- [ ] **Step 3: Commit**

```bash
git add src/components/akira/hud.tsx
git commit -m "feat(front-door): orb shrinks to 200 when a conversation is active"
```

---

### Task 3: Bigger, framed conversation window

**Files:**
- Modify: `src/components/akira/conversation-view.tsx`

- [ ] **Step 1: Raise the caps + widen**

In `conversation-view.tsx`, bump the scroll caps and widths:

```ts
const expandedScroll: React.CSSProperties = { maxHeight: "70vh", overflowY: "auto", overflowX: "hidden", paddingRight: 4 };
const collapsedScroll: React.CSSProperties = { maxHeight: "58vh", overflowY: "auto", overflowX: "hidden", paddingRight: 4 };
```

In `streamStyle`, change `maxWidth: 680` → `maxWidth: 720`. In `akiraBlock`, change `maxWidth: 640` → `maxWidth: 680`.

- [ ] **Step 2: Add the panel frame**

Give the stream a subtle window frame so it reads as a distinct surface. Add these to `streamStyle` (keep the existing props):

```ts
const streamStyle: React.CSSProperties = {
  width: "100%",
  maxWidth: 720,
  margin: "8px auto 0",
  display: "flex",
  flexDirection: "column",
  gap: 14,
  transition: "opacity .8s ease",
  border: "1px solid rgba(127,220,255,.12)",
  background: "rgba(7,13,22,.45)",
  borderRadius: 16,
  padding: "16px 18px",
};
```

Because the container now has padding, the scroll caps still bound the inner content; the frame stays put and the content scrolls within it.

- [ ] **Step 3: Verify**

Run: `npx tsc --noEmit`
Expected: EXIT 0. (Manual: the conversation reads as a framed window, noticeably taller/wider; input + Mission Control cue remain on-screen with the orb shrunk from Task 2.)

- [ ] **Step 4: Commit**

```bash
git add src/components/akira/conversation-view.tsx
git commit -m "feat(front-door): bigger + framed conversation window (58vh/70vh, framed)"
```

---

### Task 4: Reply-cap fold ("Show more" / "Show less")

**Files:**
- Modify: `src/components/akira/conversation-view.tsx`

- [ ] **Step 1: Add a CollapsibleReply wrapper**

Add `useState` to the React import:

```ts
import { useEffect, useRef, useState } from "react";
```

Add the component + constants (below `ReplyBody`):

```tsx
const COLLAPSE_PX = 320; // ~10–12 lines before an AKIRA reply folds
const FADE_MASK = "linear-gradient(180deg, #000 72%, transparent)";

/** An AKIRA reply that clamps with a fade + "Show more" when it overflows. */
function CollapsibleReply({ text }: { text: string }) {
  const innerRef = useRef<HTMLDivElement>(null);
  const [overflows, setOverflows] = useState(false);
  const [expanded, setExpanded] = useState(false);
  useEffect(() => {
    const el = innerRef.current;
    if (el) setOverflows(el.scrollHeight > COLLAPSE_PX + 8);
  }, [text]);
  const clamped = overflows && !expanded;
  return (
    <div>
      <div
        ref={innerRef}
        style={{
          maxHeight: clamped ? COLLAPSE_PX : "none",
          overflow: "hidden",
          ...(clamped ? { WebkitMaskImage: FADE_MASK, maskImage: FADE_MASK } : {}),
        }}
      >
        <ReplyBody text={text} />
      </div>
      {overflows && (
        <button type="button" style={cueBtn} onClick={() => setExpanded((v) => !v)}>
          {expanded ? "⌃ Show less" : "⌄ Show more"}
        </button>
      )}
    </div>
  );
}
```

- [ ] **Step 2: Use it for finalized AKIRA replies (not the live stream)**

In `AkiraTurn`, swap `ReplyBody` for `CollapsibleReply`:

```tsx
function AkiraTurn({ content, at }: { content: string; at?: number }) {
  return (
    <div>
      <div style={akiraLabel}>
        <span style={akiraDot} />
        AKIRA{at != null ? ` · ${fmtClock(at)}` : ""}
      </div>
      <div style={akiraBlock(isLongReply(content))}>
        <CollapsibleReply text={content} />
      </div>
    </div>
  );
}
```

In `ConversationStream`'s collapsed branch, the **finalized** tail reply (the `tailIsAkira` case) also folds; the **live streaming** reply stays a raw `ReplyBody` (it grows naturally, pinned to newest). Change only the `tailIsAkira` block:

```tsx
          ) : tailIsAkira ? (
            <div style={akiraBlock(isLongReply(turns[turns.length - 1].content))}>
              <CollapsibleReply text={turns[turns.length - 1].content} />
            </div>
          ) : null}
```

Leave the `showLive` block (`<ReplyBody text={liveReply} />`) unchanged — the fold applies once the reply finalizes into a turn.

- [ ] **Step 3: Verify**

Run: `npx tsc --noEmit`
Expected: EXIT 0. (Manual: a long AKIRA reply clamps with a fade + "Show more"; expanding shows all + "Show less"; a short reply shows no cue; the streaming reply grows live, then folds when it lands as a turn.)

- [ ] **Step 4: Commit**

```bash
git add src/components/akira/conversation-view.tsx
git commit -m "feat(front-door): fold long AKIRA replies with inline Show more/less"
```

---

### Task 5: Prompt — AKIRA digests, stays concise

**Files:**
- Modify: `src/lib/akira/prompt.ts`
- Modify: `src/lib/akira/prompt.test.ts` (if it asserts the changed style/formatting wording)

- [ ] **Step 1: Check the prompt test**

Run: `grep -n "Style\|Formatting\|multi-section\|few sentences" src/lib/akira/prompt.test.ts || echo "no style assertion"`
If it asserts the old style wording, update it in Step 3.

- [ ] **Step 2: Rewrite the Style + Formatting sentences**

In `AKIRA_SYSTEM_PROMPT`, replace the existing `Style:` and `Formatting:` sentences with the digest/chief-of-staff version. Find the current `Style: lead with the answer …` sentence through the end of the `Formatting: …` sentence and replace with:

```
Style: you are his chief of staff, not a report generator. Lead with the answer and keep it to a few sentences (2-4) by default — your replies may be read aloud. Surface the one thing that needs him. When you relay work to a team, say what you're doing in one line and let him confirm; after it runs, DIGEST the result — the meaningful outcome plus the one decision he owes, in a few sentences — never reproduce the document in chat and never tell him to go read it in the dashboard. The front door is where he lives; bring the substance to him. If he wants the full artifact he'll open the dashboard himself. Never author a design, spec, plan, or audit in the chat — that is the team's job; relaying it IS your answer.

Formatting: a quick answer is one to three sentences with no structure. Use at most ONE structural device in a reply — a short "- " bullet list OR a short answer, never stacked sections or headings, never a multi-section report, no tables or code fences unless he asks. Use **bold** sparingly for the key term and write links as [label](url). Cut filler: no meta-questions ("does that land?", "ready to fire?"), no throat-clearing ("but I'll be straight", "you're asking the right question"), and never narrate your own tools or planning. Only go long when he explicitly asks for the full picture — and even then, structure it tightly.
```

(Keep the surrounding `You are AKIRA …`, tools, grounding, SOUL/LESSONS, and Memory sentences exactly as they are.)

- [ ] **Step 3: Fix/confirm the prompt test**

If Step 1 found a style assertion, update it to match the new wording (or assert a stable phrase like "chief of staff"). Run:
Run: `npx tsx --test src/lib/akira/prompt.test.ts`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add src/lib/akira/prompt.ts src/lib/akira/prompt.test.ts
git commit -m "feat(akira): prompt — digest relayed work, stay concise (chief-of-staff)"
```

---

### Task 6: Full verification + finish

- [ ] **Step 1: Gate**

Run: `npx tsc --noEmit && pnpm test`
Expected: tsc clean; tests pass (no logic tests added here; existing suite green).

- [ ] **Step 2: Build**

Run: `pnpm build`
Expected: EXIT 0.

- [ ] **Step 3: Manual E2E (documented)**

1. `/` tab shows "AXOD — AKIRA"; `/dashboard` shows "AXOD Mission Control".
2. Fresh load: orb 320, greeting. After a message: orb 200, framed window taller/wider, input + Mission Control cue still visible.
3. Ask AKIRA something that would previously get an essay → she answers in a few sentences; ask her about a relayed result → she digests (outcome + the decision), no doc dump, no "go read the dashboard."
4. Force a long reply → it folds with "Show more"/"Show less"; short reply → no cue.

- [ ] **Step 4: Finish the branch**

Use superpowers:finishing-a-development-branch → merge into `dev` (never `main`). On Windows unlink the worktree's junctioned `node_modules` before removing it.

---

## Rollout notes (for release/deploy)

- **Reseed required** for the Task 5 prompt change (`pnpm seed` on the Mini) — bundle with the pending fast-follow reseed. No deps, no migration. UI takes effect on build+restart.

## Self-Review

**Spec coverage:** tab title (T1) ✓; orb shrink (T2) ✓; bigger+framed window (T3) ✓; reply-cap fold (T4) ✓; digest/brevity prompt (T5) ✓; reseed note ✓.

**Consistency:** `conversationActive` derived from `turns`/`reply`/`mode` (all in hud scope); `CollapsibleReply` used for finalized replies in both the `AkiraTurn` and collapsed-`tailIsAkira` paths, live stream left raw; caps 58/70vh paired with the orb-shrink that frees the room.

**Placeholder scan:** none — every step carries complete code.
