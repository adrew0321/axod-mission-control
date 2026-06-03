# Nova — Researcher Agent Design

**Date:** 2026-06-02
**Branch:** `feature/nova-researcher` (off `dev`)
**Scope:** Add **Nova**, the researcher agent — the third specialist Sage can dispatch. Nova does web search/fetch + repo reading for deep dives, prior-art, and summarization, and returns a sourced research brief. Read-only: it never edits code or runs commands. Roadmap item **v1.2**.

---

## Key finding: no new tool plumbing

The roadmap assumed Nova needed new `web_search` / `web_fetch` wiring. It doesn't — **`WebFetch` and `WebSearch` are SDK built-in tools** already passed through by the runner (`src/lib/agent-runner-sdk.ts` `DEFAULT_ALLOWED_TOOLS`) and already used by Sage (`tools_allowlist` includes them). So Nova is as cheap as Echo was: a DB row + a `DISPATCHABLE` entry + a Sage-prompt update + permissions. No runner changes, no new tools, no schema migration.

## Identity (the DB row, in `scripts/seed.ts`)

```ts
{
  id: 'nova',
  name: 'Nova',
  role: 'researcher',
  model: 'claude-sonnet-4-6',
  system_prompt: NOVA_SYSTEM_PROMPT,
  tools_allowlist: ['Read', 'Glob', 'Grep', 'WebFetch', 'WebSearch'],
  color: 'from-emerald-400 to-teal-600',
}
```

- **No `Edit`/`Write`/`Bash`** — a pure researcher; it gathers and summarizes, never changes code or runs commands. **No `dispatch_agent`** (only Sage's runner gets that).
- `color` matches the roster's emerald accent for `nova`.

## Nova's system prompt (output contract)

`NOVA_SYSTEM_PROMPT` — a researcher with a sourced, structured output (plain text, no inner backticks to keep the template literal clean):

```
You are Nova, the researcher on AXOD's agent team.

Sage dispatches you to investigate — find prior art, compare approaches, dig
into docs/APIs, or summarize how something works — using web search/fetch and
by reading this repo for context. You do NOT edit code or run commands. You
gather, verify, and report.

How you work:
- Use WebSearch / WebFetch for outside information; read the repo (Read/Glob/Grep)
  for in-codebase context. Prefer primary sources; corroborate claims.
- Be concrete and current. Distinguish what you verified from what you are inferring.

Your output is a brief, in this shape:

  FINDINGS:
  - <key point> (source: <url or repo path>)
  - ...
  SOURCES:
  - <url / repo path>
  SUMMARY: <2-4 sentences answering Sage's question and a recommendation if asked>

Rules:
- Cite a source for every non-obvious claim. No source = say it is unverified.
- Be honest about gaps, conflicting info, or staleness. Do not invent URLs or facts.
- Keep it tight and decision-useful — Sage relays this to the operator.
```

## Letting Sage dispatch Nova (`src/lib/dispatch.ts`)

1. `const DISPATCHABLE = ['atlas', 'echo', 'nova'] as const;`
2. Update the `agent_id` enum description and the tool description so Sage understands the three specialists: **Atlas** (implements code changes) · **Echo** (reviews work, read-only) · **Nova** (researches, read-only).
3. Update `SAGE_SYSTEM_PROMPT` (`scripts/seed.ts`): add Nova to the team and a cue — dispatch Nova to research/compare/summarize, typically *before* dispatching Atlas to build, or whenever the operator asks a question that needs outside or in-depth information. Relay Nova's findings + sources.

## Permissions (`tool_permissions`) — dormant in v1

Seed rows for consistency (all `always` — research is read-only and safe):
```ts
{ agent_id: 'nova', project_id: 'axod-creative', tool_name: 'read_file', policy: 'always' },
{ agent_id: 'nova', project_id: 'axod-creative', tool_name: 'glob', policy: 'always' },
{ agent_id: 'nova', project_id: 'axod-creative', tool_name: 'grep', policy: 'always' },
{ agent_id: 'nova', project_id: 'axod-creative', tool_name: 'web_fetch', policy: 'always' },
{ agent_id: 'nova', project_id: 'axod-creative', tool_name: 'web_search', policy: 'always' },
```
These feed the dormant approval gate (doesn't fire on SDK 0.3.x); `tools_allowlist` is what constrains Nova at runtime.

## UI polish (`src/components/mission-control.tsx`)

The roster already renders Nova (Telescope icon + emerald accent via `AGENT_ICON`/`AGENT_ACCENT`), and `page.tsx` `ROLE_LABEL` already maps `researcher → "Researcher"`. Three small cohesion touches:
- Add Nova to `speakerStyle` (thread bubble): `{ accent: '#10b981', tint: 'rgba(16,185,129,0.08)' }` so Nova's messages read emerald.
- Add a Nova branch to `friendlyActivity` (researcher voice): WebSearch/WebFetch → "Scouring the web…", Read → "Reading up on <file>", Grep → "Digging for <pattern>", Glob → "Casing the codebase…", default → generic.
- Add a Nova `IDLE_STATE` line (e.g. "Telescope stowed — ready to dig").

## Out of scope

Forge / Pixel (own cycles) · any new tool types · changing the dispatch mechanism · runner/schema changes.

## Verification

- `pnpm build` clean; `pnpm test` 51/51 (config + prompt; no pure-module logic added).
- Re-seed: `pnpm seed` upserts Sage's prompt and inserts Nova; roster shows Nova (emerald, Telescope) — `agents` count 3 → 4.
- Live smoke: operator asks Sage a research question (e.g. "what's the current recommended way to do X?") → Sage dispatches Nova → Nova uses WebSearch/WebFetch, returns a `FINDINGS/SOURCES/SUMMARY` brief with real links → Sage relays. Confirm Nova made no edits.
