# Dispatch Digest — a quieter dispatched-agent thread

**Date:** 2026-06-03
**Branch:** `feature/dispatch-digest` (off `dev`)
**Scope:** Reduce conversation-thread clutter when work flows through Sage. A dispatched specialist's turn currently shows (a) the full raw task brief Sage wrote on the dispatch card and (b) the specialist's full raw reply — *and then* Sage's summary of that reply. The operator reads the same work three times. This feature makes a dispatch speak in **Sage's** voice with **personality**: a persona flavor line on the dispatch card, the specialist's raw reply collapsed (expandable on demand), and Sage's summary as the visible voice. **Direct `@`-mention** replies are unaffected — when you address an agent directly, you see its full reply.

---

## Key finding: dispatched vs direct is not recorded

Both invocation paths persist the specialist's reply identically — `role: 'agent'` with the specialist's `agent_id`:
- **Dispatched (via Sage):** persisted through the dispatch server's `persistMessage` in `src/app/api/sessions/[id]/stream/route.ts`, alongside a Sage summary.
- **Direct `@`-mention:** `addressed = true`, the specialist *is* the primary agent (dispatch is disabled), reply persisted via `flushPrimary`.

There is no field on `messages` recording *how* the specialist was invoked, so today `src/app/page.tsx` guesses attribution with `agent_id !== 'sage'` — which mislabels direct `@` replies as "via Sage". A single nullable column fixes both the clutter feature and that latent bug.

## 1. Schema — one nullable column

Add to the `messages` table in `src/db/schema.ts`:
```ts
dispatched_via: text('dispatched_via').references(() => agents.id),
```
- Nullable. Holds the orchestrator id that dispatched this reply (`'sage'`); `null` means the agent spoke as the primary (direct `@`, or Sage itself).
- Migration generated + applied via the existing tooling: `pnpm db:generate` (produces `drizzle/0002_*.sql`) then `pnpm db:migrate`.
- Existing rows stay `null` → render exactly as today (full). No backfill.

## 2. Persist path (`src/app/api/sessions/[id]/stream/route.ts`)

In the dispatch server's `persistMessage` insert, add `dispatched_via: primaryId` (which is `'sage'` on a dispatch turn — the primary agent of a non-addressed turn). The `flushPrimary` insert (primary / `@`-addressed agent) leaves the field unset (`null`). That single difference is the behavioral split.

## 3. Attribution (`src/app/page.tsx`)

Replace the heuristic at the line that currently reads:
```ts
m.agent_id && m.agent_id !== "sage" && m.role === "agent" ? "via Sage" : undefined;
```
with attribution derived from the real flag via the new helper (`dispatchAttribution(m.dispatched_via)`). Fixes the direct-`@`-reply mislabel as a side effect.

## 4. Rendering (`src/components/mission-control.tsx`)

- **Dispatch card:** replace the raw-task paragraph (`<p>{msg.dispatch.task}</p>`, currently line ~1049) with a **persona flavor line** from `dispatchFlavor(agentId, name)`. The task brief is Sage's internal instruction to the specialist — not something the operator acts on — so it is dropped from the card entirely.
- **Dispatched reply bubble** (both the live-streaming bubble and reloaded messages where `dispatched_via` is set): render **collapsed** — a `view {name}'s report ▾` / `hide ▴` toggle that expands to show the full content. Collapse applies during live streaming too; live activity remains visible via the dispatch card's "Running" state and the roster STATUS panel, so nothing is lost. Expand state is local UI: a `Set<string>` of expanded message ids in component state.
- **Direct `@` replies** (`dispatched_via` is `null`): unchanged — full render.

## 5. Flavor + attribution helpers (new module)

Create `src/lib/dispatch-presentation.ts` (pure, no React/DOM) so the logic is unit-testable under the project's `tsx --test src/lib/*.test.ts` setup:

```ts
export function dispatchFlavor(agentId: string | null | undefined, name: string): string {
  switch (agentId) {
    case 'atlas': return 'Atlas heads to the anvil';
    case 'echo':  return 'Echo uncaps the red pen';
    case 'nova':  return 'Nova trains the telescope';
    case 'forge': return 'Forge fires up the pipeline';
    default:      return `${name} gets to work`;
  }
}

export function dispatchAttribution(dispatchedVia: string | null | undefined): string | undefined {
  return dispatchedVia ? 'via Sage' : undefined;
}
```
`mission-control.tsx` and `page.tsx` import from this module.

> Note: `dispatchAttribution` returns the literal "via Sage" for any non-null value; v1 has only Sage as an orchestrator. If a second orchestrator is ever added, this becomes `via <name>` — out of scope now (YAGNI).

## Data flow

- **Dispatch:** operator → Sage turn → `dispatch_agent` → specialist runs → `persistMessage(dispatched_via: 'sage')` → SSE drives the live (collapsed) bubble + card flavor line → on reload, `page.tsx` reads `dispatched_via` → attribution + collapse.
- **Direct `@`:** operator `@Forge …` → `addressed = true` → specialist primary → `flushPrimary` (`dispatched_via` null) → full render.

## Testing

- **Unit (`src/lib/dispatch-presentation.test.ts`, node:test):** `dispatchFlavor` returns the right line for atlas/echo/nova/forge and the `"{name} gets to work"` fallback for unknown/null ids; `dispatchAttribution` returns "via Sage" for a non-null value and `undefined` for null/empty.
- **Build + manual:** `pnpm build` clean; full suite green (existing 51 + the new cases). Manual thread check: dispatched reply renders collapsed with a working expand toggle + flavor line on the card; a direct `@`-mention reply still renders in full.

## Out of scope

Changing how Sage summarizes · varying the flavor line by task/tool (static per-agent is fine for v1) · backfilling `dispatched_via` on old messages · supporting orchestrators other than Sage in `dispatchAttribution`.
