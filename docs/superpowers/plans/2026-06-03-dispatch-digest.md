# Dispatch Digest Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make a dispatched-via-Sage turn speak in Sage's voice with personality — a persona flavor line on the dispatch card, the specialist's raw reply collapsed (expandable), Sage's summary as the visible voice — while direct `@`-mention replies stay full.

**Architecture:** Add one nullable `dispatched_via` column to `messages` (the orchestrator id, or `null` for primary/`@`-addressed). Set it only on the dispatch persist path. Thread it to the client `Message` type; derive attribution + collapse from it. Add two pure helpers (`dispatchFlavor`, `dispatchAttribution`) in a new testable module. Rendering: card shows the flavor line instead of the raw task; dispatched reply bubbles render collapsed with a toggle.

**Tech Stack:** TypeScript, Drizzle ORM + drizzle-kit (SQLite migrations), Next.js React client, node:test via tsx.

**Spec:** `docs/superpowers/specs/2026-06-03-dispatch-digest-design.md`
**Branch:** `feature/dispatch-digest` (already created off `dev`).

**Key anchors (verified):**
- `Message` interface: `src/lib/mock-data.ts:33-54` (shared by `page.tsx` + `mission-control.tsx`).
- Server reload mapping + attribution heuristic: `src/app/page.tsx:138-154`.
- Dispatch persist path: `src/app/api/sessions/[id]/stream/route.ts` `persistMessage` (~156-168); primary path `flushPrimary` (~102-112).
- Live dispatch bubble creation: `src/components/mission-control.tsx:557-581` (specialist bubble gets `attribution: "via Sage"`).
- Agent bubble render (segments): `src/components/mission-control.tsx:985-1005`.
- Dispatch card (raw task at): `src/components/mission-control.tsx:1019-1052` (task `<p>` at line 1049).

---

### Task 1: Add the `dispatched_via` column + migration

**Files:**
- Modify: `src/db/schema.ts:38-49` (messages table)
- Generate: `drizzle/0002_*.sql` (via drizzle-kit)

- [ ] **Step 1: Add the column to the schema.** In `src/db/schema.ts`, in the `messages` table definition, add the `dispatched_via` line immediately after the `agent_id` line (line 41):

```ts
  agent_id: text('agent_id').references(() => agents.id),
  dispatched_via: text('dispatched_via').references(() => agents.id),
```

- [ ] **Step 2: Generate the migration.**

Run: `pnpm db:generate`
Expected: drizzle-kit reports a new migration file `drizzle/0002_*.sql` containing `ALTER TABLE \`messages\` ADD \`dispatched_via\` text REFERENCES agents(id);` (SQLite adds the nullable column).

- [ ] **Step 3: Apply the migration to the local DB.**

Run: `pnpm db:migrate`
Expected: applies `0002`; no error.

- [ ] **Step 4: Confirm the column exists.**

Run: `node -e "const D=require('better-sqlite3');const db=new D(process.env.DATABASE_PATH||'./data/mission-control.db');console.log(db.prepare('PRAGMA table_info(messages)').all().map(c=>c.name))"`
Expected: the printed array includes `dispatched_via`.

- [ ] **Step 5: Commit.**

```bash
git add src/db/schema.ts drizzle/
git commit -m "feat(dispatch-digest): add nullable messages.dispatched_via column + migration"
```

---

### Task 2: Pure presentation helpers (TDD)

**Files:**
- Create: `src/lib/dispatch-presentation.ts`
- Test: `src/lib/dispatch-presentation.test.ts`

- [ ] **Step 1: Write the failing test.** Create `src/lib/dispatch-presentation.test.ts`:

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { dispatchFlavor, dispatchAttribution } from './dispatch-presentation';

test('dispatchFlavor returns the persona line for each known specialist', () => {
  assert.equal(dispatchFlavor('atlas', 'Atlas'), 'Atlas heads to the anvil');
  assert.equal(dispatchFlavor('echo', 'Echo'), 'Echo uncaps the red pen');
  assert.equal(dispatchFlavor('nova', 'Nova'), 'Nova trains the telescope');
  assert.equal(dispatchFlavor('forge', 'Forge'), 'Forge fires up the pipeline');
});

test('dispatchFlavor falls back to "<name> gets to work" for unknown or null ids', () => {
  assert.equal(dispatchFlavor('pixel', 'Pixel'), 'Pixel gets to work');
  assert.equal(dispatchFlavor(null, 'Someone'), 'Someone gets to work');
  assert.equal(dispatchFlavor(undefined, 'Someone'), 'Someone gets to work');
});

test('dispatchAttribution returns "via Sage" only when a dispatcher is set', () => {
  assert.equal(dispatchAttribution('sage'), 'via Sage');
  assert.equal(dispatchAttribution('atlas'), 'via Sage');
  assert.equal(dispatchAttribution(null), undefined);
  assert.equal(dispatchAttribution(undefined), undefined);
  assert.equal(dispatchAttribution(''), undefined);
});
```

- [ ] **Step 2: Run the test to verify it fails.**

Run: `pnpm exec tsx --test src/lib/dispatch-presentation.test.ts`
Expected: FAIL — cannot find module `./dispatch-presentation` (not created yet).

- [ ] **Step 3: Write the minimal implementation.** Create `src/lib/dispatch-presentation.ts`:

```ts
// Presentation helpers for dispatched-specialist turns. Pure (no React/DOM) so
// they're unit-testable and shared by page.tsx (reload) and mission-control.tsx (live).

/** A short, in-character line shown on the dispatch card instead of the raw task brief. */
export function dispatchFlavor(agentId: string | null | undefined, name: string): string {
  switch (agentId) {
    case 'atlas':
      return 'Atlas heads to the anvil';
    case 'echo':
      return 'Echo uncaps the red pen';
    case 'nova':
      return 'Nova trains the telescope';
    case 'forge':
      return 'Forge fires up the pipeline';
    default:
      return `${name} gets to work`;
  }
}

/**
 * Attribution label for an agent message. `dispatchedVia` is the orchestrator id that
 * dispatched the reply (or null when the agent spoke as the primary / @-addressed agent).
 * v1 has only Sage as an orchestrator, so any non-empty value reads "via Sage".
 */
export function dispatchAttribution(dispatchedVia: string | null | undefined): string | undefined {
  return dispatchedVia ? 'via Sage' : undefined;
}
```

- [ ] **Step 4: Run the test to verify it passes.**

Run: `pnpm exec tsx --test src/lib/dispatch-presentation.test.ts`
Expected: PASS — all 3 tests pass.

- [ ] **Step 5: Confirm the full suite still passes.**

Run: `pnpm test`
Expected: `tests 54 / pass 54 / fail 0` (existing 51 + 3 new).

- [ ] **Step 6: Commit.**

```bash
git add src/lib/dispatch-presentation.ts src/lib/dispatch-presentation.test.ts
git commit -m "feat(dispatch-digest): dispatchFlavor + dispatchAttribution helpers (tested)"
```

---

### Task 3: Persist `dispatched_via` on the dispatch path

**Files:**
- Modify: `src/app/api/sessions/[id]/stream/route.ts` (`persistMessage` inside `createDispatchServer({...})`, ~156-168)

- [ ] **Step 1: Set the column when persisting a dispatched reply.** In the `persistMessage` closure passed to `createDispatchServer`, add `dispatched_via: primaryId` to the `db.insert(messages).values({...})` object. The result should read:

```ts
          persistMessage: async (agentId, content, usage) => {
            const now = new Date();
            await db.insert(messages).values({
              id: `msg_${bytesToHex(randomBytes(8))}`,
              session_id: sessionId,
              agent_id: agentId,
              dispatched_via: primaryId,
              role: 'agent',
              content,
              token_count_in: usage.tokensIn,
              token_count_out: usage.tokensOut,
              cost_usd: usage.costUsd,
              created_at: now,
            });
          },
```

Note: `dispatchServer` is only constructed when `!addressed`, so `primaryId` here is always `'sage'`. The `flushPrimary` insert (~102-112) is left unchanged, so primary / `@`-addressed replies keep `dispatched_via` null.

- [ ] **Step 2: Type-check / build.**

Run: `pnpm build`
Expected: `✓ Compiled successfully` + `Finished TypeScript` (no errors). A pre-existing `next.config.ts` NFT warning is acceptable noise.

- [ ] **Step 3: Commit.**

```bash
git add src/app/api/sessions/[id]/stream/route.ts
git commit -m "feat(dispatch-digest): record dispatched_via='sage' on dispatched replies"
```

---

### Task 4: Thread `dispatched_via` to the client `Message`

**Files:**
- Modify: `src/lib/mock-data.ts:33-54` (Message interface)
- Modify: `src/app/page.tsx:138-154` (reload mapping + attribution)
- Modify: `src/components/mission-control.tsx:557-581` (live dispatch bubble)

- [ ] **Step 1: Add the field to the `Message` interface.** In `src/lib/mock-data.ts`, add `dispatchedVia` after `attribution` (line 40):

```ts
  attribution?: string;
  dispatchedVia?: string;
  isStreaming?: boolean;
```

- [ ] **Step 2: Derive attribution from the flag on reload.** In `src/app/page.tsx`, import the helper at the top with the other `@/lib` imports:

```ts
import { dispatchAttribution } from "@/lib/dispatch-presentation";
```

Then in the `messageRows.map((m) => {...})` block (lines 142-153), replace the `attribution` computation and the returned object so it uses the flag:

```ts
    const attribution = dispatchAttribution(m.dispatched_via);

    return {
      id: m.id,
      role: m.role as Message["role"],
      agentId: m.agent_id ?? undefined,
      senderName,
      content: m.content,
      timestamp: formatTime(m.created_at),
      attribution,
      dispatchedVia: m.dispatched_via ?? undefined,
    };
```

(This replaces the old `m.agent_id && m.agent_id !== "sage" && m.role === "agent" ? "via Sage" : undefined` heuristic, fixing the direct-`@`-reply mislabel.)

- [ ] **Step 2b: Verify the row exposes the column.** `messageRows` is selected via Drizzle from the `messages` table, so `m.dispatched_via` is present automatically once Task 1's column exists. If `messageRows` is built with an explicit column list (not a full-row select), add `dispatched_via` to that list. Grep to confirm:

Run: `git grep -n "messageRows" -- src/app/page.tsx`
Expected: a `db.select()...from(messages)` / `db.query.messages.findMany` style full-row read — no explicit column list to amend. If it IS an explicit list, add `dispatched_via`.

- [ ] **Step 3: Set `dispatchedVia` on the live dispatched bubble.** In `src/components/mission-control.tsx`, in the `dispatch_start` handler where the specialist bubble is pushed (currently lines 571-580), add `dispatchedVia: "sage"` alongside the existing `attribution: "via Sage"`:

```ts
              {
                id: newBubbleId,
                role: "agent" as const,
                agentId: dispatchAgentId,
                senderName: dispatchAgentName,
                attribution: "via Sage",
                dispatchedVia: "sage",
                content: "",
                timestamp: new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }),
                isStreaming: true,
              },
```

- [ ] **Step 4: Build.**

Run: `pnpm build`
Expected: clean compile, no TS errors.

- [ ] **Step 5: Commit.**

```bash
git add src/lib/mock-data.ts src/app/page.tsx src/components/mission-control.tsx
git commit -m "feat(dispatch-digest): thread dispatchedVia to client + attribution from flag"
```

---

### Task 5: Persona flavor line on the dispatch card

**Files:**
- Modify: `src/components/mission-control.tsx` (import + card render at line 1049)

- [ ] **Step 1: Import the flavor helper.** Add to the imports at the top of `src/components/mission-control.tsx` (with the other `@/lib` imports):

```ts
import { dispatchFlavor } from "@/lib/dispatch-presentation";
```

- [ ] **Step 2: Replace the raw task paragraph with the flavor line.** In the dispatch-card render, replace line 1049:

```ts
                            <p className="text-[11px] text-[#8b949e] mt-1">{msg.dispatch.task}</p>
```

with:

```ts
                            <p className="text-[11px] text-[#8b949e] mt-1 italic">
                              {dispatchFlavor(msg.dispatch.agentId, msg.dispatch.agentName)}
                            </p>
```

- [ ] **Step 3: Build.**

Run: `pnpm build`
Expected: clean compile. (The `task` field stays on the `Message['dispatch']` type and in the dispatch event — only the card stops rendering it.)

- [ ] **Step 4: Commit.**

```bash
git add src/components/mission-control.tsx
git commit -m "feat(dispatch-digest): show persona flavor line on the dispatch card"
```

---

### Task 6: Collapse the dispatched reply (expandable)

**Files:**
- Modify: `src/components/mission-control.tsx` (expand state + agent-bubble render at 985-1005)

- [ ] **Step 1: Add expand state.** Near the other `useState` hooks (e.g. just after `const [messages, setMessages] = useState<Message[]>(initialMessages);` at line 252), add:

```ts
  // Dispatched-via-Sage replies render collapsed; this tracks which the operator expanded.
  const [expandedReplies, setExpandedReplies] = useState<Set<string>>(new Set());
  const toggleReply = (id: string) =>
    setExpandedReplies((prev) => {
      const next = new Set(prev);
      next.has(id) ? next.delete(id) : next.add(id);
      return next;
    });
```

- [ ] **Step 2: Collapse dispatched replies in the agent bubble.** In the `msg.role === "agent"` render block, the segments are mapped at lines 990-1005 inside `<div className="space-y-1.5">`. Wrap the segments so a collapsed dispatched reply shows a toggle instead. Replace the segments map block (lines 990-1005):

```ts
                      {segments.map((segment, i) => (
                        <div
                          key={i}
                          className="text-xs leading-relaxed p-3 rounded-md border border-l-2 border-[#1e2632] text-[#8b949e]"
                          style={{ borderLeftColor: accent, backgroundColor: tint }}
                        >
                          <Markdown>{segment}</Markdown>
                          {msg.isStreaming && i === segments.length - 1 && (
                            <span
                              aria-hidden
                              className="inline-block w-[7px] h-3.5 ml-0.5 align-text-bottom rounded-sm animate-blink"
                              style={{ backgroundColor: accent }}
                            />
                          )}
                        </div>
                      ))}
```

with:

```ts
                      {msg.dispatchedVia && hasText && !expandedReplies.has(msg.id) ? (
                        <button
                          onClick={() => toggleReply(msg.id)}
                          className="text-[10.5px] font-mono text-[#5c6470] hover:text-[#00e0ff] flex items-center gap-1 px-2 py-1 rounded border border-[#1e2632] hover:border-cyan-500/30 transition-colors"
                        >
                          <ChevronDown className="w-3 h-3" />
                          view {msg.senderName}&apos;s report
                        </button>
                      ) : (
                        <>
                          {segments.map((segment, i) => (
                            <div
                              key={i}
                              className="text-xs leading-relaxed p-3 rounded-md border border-l-2 border-[#1e2632] text-[#8b949e]"
                              style={{ borderLeftColor: accent, backgroundColor: tint }}
                            >
                              <Markdown>{segment}</Markdown>
                              {msg.isStreaming && i === segments.length - 1 && (
                                <span
                                  aria-hidden
                                  className="inline-block w-[7px] h-3.5 ml-0.5 align-text-bottom rounded-sm animate-blink"
                                  style={{ backgroundColor: accent }}
                                />
                              )}
                            </div>
                          ))}
                          {msg.dispatchedVia && hasText && (
                            <button
                              onClick={() => toggleReply(msg.id)}
                              className="text-[10.5px] font-mono text-[#5c6470] hover:text-[#00e0ff] flex items-center gap-1 px-2 py-1 rounded border border-[#1e2632] hover:border-cyan-500/30 transition-colors"
                            >
                              <ChevronUp className="w-3 h-3" />
                              hide {msg.senderName}&apos;s report
                            </button>
                          )}
                        </>
                      )}
```

- [ ] **Step 3: Ensure the chevron icons are imported.** Confirm `ChevronDown` and `ChevronUp` are in the `lucide-react` import. Grep:

Run: `git grep -n "ChevronDown\|ChevronUp" -- src/components/mission-control.tsx`
Expected: both used in the new code; if either is missing from the top `import { ... } from "lucide-react";` line, add it. (`ChevronDown` is commonly already imported; add `ChevronUp` if absent.)

- [ ] **Step 4: Build.**

Run: `pnpm build`
Expected: clean compile, no TS errors (no unused-import or missing-import errors).

- [ ] **Step 5: Commit.**

```bash
git add src/components/mission-control.tsx
git commit -m "feat(dispatch-digest): collapse dispatched replies with view/hide toggle"
```

---

### Task 7: Full verification + manual smoke

**Files:** none

- [ ] **Step 1: Build + full test suite.**

Run: `pnpm build && pnpm test`
Expected: build clean; `tests 54 / pass 54 / fail 0`.

- [ ] **Step 2: Manual thread check (operator-run).** With `pnpm dev` running and logged in:
  - Ask Sage to dispatch a specialist (e.g. *"Sage, have Forge run the build and report"*). Confirm: the dispatch card shows the **flavor line** ("Forge fires up the pipeline"), the specialist's reply renders **collapsed** ("view Forge's report ▾"), and clicking it expands/collapses. Sage's summary follows in Sage's voice.
  - Directly `@`-address a specialist (e.g. *"@Forge echo hello"*). Confirm its reply renders **in full** (no collapse, no "via Sage").
  - Reload the page. Confirm the collapse + attribution persist correctly from the DB (`dispatched_via`), and that the earlier direct `@` reply is **not** labeled "via Sage".

---

## Wrap-up (after Task 7 passes)

- [ ] Add a short "what actually happened" note to `docs/superpowers/specs/2026-06-03-dispatch-digest-design.md`.
- [ ] Integrate `feature/dispatch-digest` → `dev` (operator confirms).

## Self-review (done at authoring)

- **Spec coverage:** schema column → Task 1; helpers + tests → Task 2; persist path → Task 3; attribution from flag + client threading + live bubble → Task 4; flavor line on card → Task 5; collapse/expand reply → Task 6; verification → Task 7; wrap-up/integrate → Wrap-up. All spec sections covered.
- **Placeholder scan:** no TBD/TODO; every code step shows full code; the `{name}`/`${name}` tokens are intentional template literals.
- **Type consistency:** `dispatched_via` (DB/snake_case) ↔ `dispatchedVia` (client Message/camelCase) used consistently; `dispatchFlavor(agentId, name)` and `dispatchAttribution(dispatchedVia)` signatures match between Task 2 (definition) and Tasks 4/5 (use); `expandedReplies`/`toggleReply` names consistent between Task 6 Step 1 and Step 2. Expected test count 51 → 54 consistent across Tasks 2 and 7.
