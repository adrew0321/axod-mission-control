# Nova — Researcher Agent Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add Nova, a read-only researcher Sage can dispatch to do web search/fetch + repo reading and return a sourced research brief.

**Architecture:** Mirrors the Echo path — a DB row + a `DISPATCHABLE` enum entry + a Sage-prompt update + permissions, plus three small UI cohesion touches. Web tools (`WebFetch`/`WebSearch`) are SDK built-ins already passed through by the runner, so there are **no runner, schema, or new-tool changes**.

**Tech Stack:** TypeScript, Claude Agent SDK (built-in `WebSearch`/`WebFetch`), Drizzle seed script.

**Spec:** `docs/superpowers/specs/2026-06-02-nova-researcher-agent-design.md`
**Branch:** `feature/nova-researcher` (already created off `dev`).

**Testing note:** Config + prompt only — no pure-logic module added. Verification is `pnpm build` + `pnpm test` (stays 51/51) + re-seed + a live smoke, exactly as Echo was added. No brittle SDK/MCP test.

---

### Task 1: Let Sage dispatch Nova (`dispatch.ts`)

**Files:**
- Modify: `src/lib/dispatch.ts`

- [ ] **Step 1: Add `nova` to the dispatchable set.** Replace:

```ts
const DISPATCHABLE = ['atlas', 'echo'] as const;
```

with:

```ts
const DISPATCHABLE = ['atlas', 'echo', 'nova'] as const;
```

- [ ] **Step 2: Update the tool description.** Replace the description string (the second arg to `tool(`):

```ts
    'Hand a concrete, self-contained task to a specialist working in this session\'s isolated git worktree. Atlas (lead developer) edits files and runs commands to implement changes; Echo (QA critic) reviews work already made and returns a verdict but cannot edit. You (Sage) plan and coordinate; the specialist does the work. Returns the specialist\'s final summary.',
```

with:

```ts
    'Hand a concrete, self-contained task to a specialist working in this session\'s isolated git worktree. Atlas (lead developer) edits files and runs commands to implement changes; Echo (QA critic) reviews work already made and returns a verdict (cannot edit); Nova (researcher) investigates via web search/fetch and repo reading and returns a sourced brief (cannot edit). You (Sage) plan and coordinate; the specialist does the work. Returns the specialist\'s final summary.',
```

- [ ] **Step 3: Update the `agent_id` enum description.** Replace:

```ts
        .describe('Which specialist to dispatch: "atlas" (lead developer — implements code changes) or "echo" (QA critic — reviews a change already made in the worktree and returns a verdict; cannot edit).'),
```

with:

```ts
        .describe('Which specialist to dispatch: "atlas" (lead developer — implements code changes), "echo" (QA critic — reviews a change already made and returns a verdict; cannot edit), or "nova" (researcher — investigates via web + repo and returns a sourced brief; cannot edit).'),
```

- [ ] **Step 4: Verify the build.**

Run: `pnpm build`
Expected: `✓ Compiled successfully` + `Finished TypeScript` (no errors).

- [ ] **Step 5: Commit.**

```bash
git add src/lib/dispatch.ts
git commit -m "feat(nova): allow Sage to dispatch nova (researcher)"
```

---

### Task 2: Seed Nova (`seed.ts`)

**Files:**
- Modify: `scripts/seed.ts`

- [ ] **Step 1: Add the `NOVA_SYSTEM_PROMPT` constant.** Insert it immediately **after** the `ECHO_SYSTEM_PROMPT` definition (the line `If you could not verify something (e.g., tests did not run), say so rather than guessing.\`;`), before `async function main()`:

```ts
const NOVA_SYSTEM_PROMPT = `You are Nova, the researcher on AXOD's agent team.

Sage dispatches you to investigate — find prior art, compare approaches, dig into docs/APIs, or summarize how something works — using web search/fetch and by reading this repo for context. You do NOT edit code or run commands. You gather, verify, and report.

How you work:
- Use WebSearch / WebFetch for outside information; read the repo (Read/Glob/Grep) for in-codebase context. Prefer primary sources; corroborate claims.
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
- Keep it tight and decision-useful — Sage relays this to the operator.`;
```

- [ ] **Step 2: Teach Sage about Nova — update the dispatch capability line.** In `SAGE_SYSTEM_PROMPT`, replace the `dispatch_agent` bullet:

```ts
- dispatch_agent — hand a concrete task to a specialist working in this session's isolated git worktree. Atlas (lead developer) CAN edit files and run commands to implement changes; Echo (QA critic) reviews a change already made and returns a verdict but CANNOT edit. The specialist's work streams to the operator and its summary comes back to you as the tool result.
```

with:

```ts
- dispatch_agent — hand a concrete task to a specialist working in this session's isolated git worktree. Atlas (lead developer) CAN edit files and run commands to implement changes; Echo (QA critic) reviews a change already made and returns a verdict but CANNOT edit; Nova (researcher) investigates via web search/fetch and repo reading and returns a sourced brief but CANNOT edit. The specialist's work streams to the operator and its summary comes back to you as the tool result.
```

- [ ] **Step 3: Teach Sage WHEN to use Nova.** Insert this bullet immediately **after** the existing "After Atlas (or any specialist) makes a change, consider dispatching Echo..." bullet:

```ts
- When a request needs outside or in-depth information — prior art, how others solve a problem, API/library details, or a docs summary — dispatch Nova to research it (typically before dispatching Atlas to build). Pass Nova a specific question. Relay Nova's findings and sources.
```

- [ ] **Step 4: Add the Nova agent row.** In the `agentRows` array, add this object after the Echo row (after the Echo object's closing `},`, before the closing `]`):

```ts
    {
      id: 'nova',
      name: 'Nova',
      role: 'researcher',
      model: 'claude-sonnet-4-6',
      system_prompt: NOVA_SYSTEM_PROMPT,
      tools_allowlist: ['Read', 'Glob', 'Grep', 'WebFetch', 'WebSearch'],
      color: 'from-emerald-400 to-teal-600',
    },
```

- [ ] **Step 5: Add Nova's tool_permissions.** In the `tool_permissions` `.values([...])` array, add these rows after the existing Echo rows (after `{ agent_id: 'echo', ... tool_name: 'run_command', policy: 'ask' },`):

```ts
      { agent_id: 'nova', project_id: 'axod-creative', tool_name: 'read_file', policy: 'always' },
      { agent_id: 'nova', project_id: 'axod-creative', tool_name: 'glob', policy: 'always' },
      { agent_id: 'nova', project_id: 'axod-creative', tool_name: 'grep', policy: 'always' },
      { agent_id: 'nova', project_id: 'axod-creative', tool_name: 'web_fetch', policy: 'always' },
      { agent_id: 'nova', project_id: 'axod-creative', tool_name: 'web_search', policy: 'always' },
```

- [ ] **Step 6: Type-check the seed compiles.**

Run: `pnpm exec tsc --noEmit -p tsconfig.json`
Expected: no errors.

- [ ] **Step 7: Commit.**

```bash
git add scripts/seed.ts
git commit -m "feat(nova): seed Nova agent + perms, teach Sage to dispatch it for research"
```

---

### Task 3: UI cohesion touches (`mission-control.tsx`)

**Files:**
- Modify: `src/components/mission-control.tsx`

- [ ] **Step 1: Add Nova's thread bubble tint.** In `speakerStyle`, add a `nova` branch before the fallback `return`:

```ts
  if (agentId === "echo") return { accent: "#8b5cf6", tint: "rgba(139,92,246,0.08)" };
  if (agentId === "nova") return { accent: "#10b981", tint: "rgba(16,185,129,0.08)" };
  return { accent: "#93c5fd", tint: "rgba(147,197,253,0.06)" };
```

- [ ] **Step 2: Add a Nova idle line.** In `IDLE_STATE`, add:

```ts
const IDLE_STATE: Record<string, string> = {
  sage: "Standing by at the helm",
  atlas: "Hammer cooled — ready to forge",
  echo: "Red pen capped — for now",
  nova: "Telescope stowed — ready to dig",
};
```

- [ ] **Step 3: Add Nova's activity voice.** In `friendlyActivity`, add a `nova` branch immediately after the `echo` branch (after the `if (agentId === "echo") { ... }` block, before the `// Sage — the calm navigator...` comment):

```ts
  if (agentId === "nova") {
    // Nova — the researcher with a telescope.
    switch (tool) {
      case "WebSearch":
      case "WebFetch":
        return "Scouring the web…";
      case "Read":
        return `Reading up on ${file}`;
      case "Grep":
        return input?.pattern ? `Digging for "${clip(input.pattern, 28)}"` : "Digging through the code…";
      case "Glob":
        return "Casing the codebase…";
      case "TodoWrite":
        return "Outlining the findings…";
      default:
        return genericFallback();
    }
  }
```

- [ ] **Step 4: Verify the build.**

Run: `pnpm build`
Expected: `✓ Compiled successfully` + `Finished TypeScript`.

- [ ] **Step 5: Commit.**

```bash
git add src/components/mission-control.tsx
git commit -m "feat(nova): roster + thread cohesion (emerald tint, researcher voice, idle line)"
```

---

### Task 4: Apply the seed + full verification

**Files:** none

- [ ] **Step 1: Re-seed the local database.**

Run: `pnpm seed`
Expected: `Seed complete: { ... agents: 4, ... }` (sage, atlas, echo, nova).

- [ ] **Step 2: Confirm Nova landed correctly.**

Run: `node -e "const D=require('better-sqlite3');const db=new D(process.env.DATABASE_PATH||'./data/mission-control.db');console.log(db.prepare('select id,name,role,model,tools_allowlist,color from agents where id=?').get('nova'))"`
Expected: a row with `id: 'nova'`, `role: 'researcher'`, `model: 'claude-sonnet-4-6'`, `tools_allowlist` containing `Read,Glob,Grep,WebFetch,WebSearch`, `color: 'from-emerald-400 to-teal-600'`.

- [ ] **Step 3: Build + full test suite.**

Run: `pnpm build && pnpm test`
Expected: build clean; `tests 51 / pass 51 / fail 0`.

- [ ] **Step 4: Roster check (visual, no commit).** Run `pnpm dev`, open the app, log in — Nova appears in the roster with the Telescope icon + emerald accent (from the existing `AGENT_ICON`/`AGENT_ACCENT` maps), role "Researcher".

---

### Task 5: Live end-to-end smoke (operator-run)

**Files:** none

- [ ] **Step 1: Drive a research dispatch.** With `pnpm dev` running and logged in, ask Sage a research question, e.g.: *"Sage, have Nova research the current recommended way to self-host fonts in an Astro site, with sources."*

- [ ] **Step 2: Verify the flow.** Expect: Sage dispatches Nova ("Nova · via Sage", emerald), Nova's status shows "Scouring the web…", and Nova's reply contains a `FINDINGS / SOURCES / SUMMARY` brief with **real URLs**. Confirm Nova made **no edits** (its allowlist has no Edit/Write/Bash). Sage relays the brief.

- [ ] **Step 3: Note the result** in the spec's wrap-up (web-tool behavior, citation quality — prompt-tuning candidates).

---

## Wrap-up (after Task 5 passes)

- [ ] Add a short "what actually happened" note to `docs/superpowers/specs/2026-06-02-nova-researcher-agent-design.md`.
- [ ] Update `README.md` — move Nova from `v1.2` to ✅ shipped in the team table + roadmap.
- [ ] Integrate `feature/nova-researcher` → `dev` (operator confirms); release when appropriate.

## Self-review (done at authoring)

- **Spec coverage:** DB row → Task 2.4; tools_allowlist → 2.4; NOVA_SYSTEM_PROMPT/output contract → 2.1; DISPATCHABLE + descriptions → Task 1; Sage-prompt (capability + when) → 2.2/2.3; tool_permissions → 2.5; UI polish (speakerStyle/IDLE_STATE/friendlyActivity) → Task 3; verification → Tasks 4/5. No gaps.
- **Placeholders:** the `<key point>`/`<url>`/`<file>`/`<pattern>` tokens are the intentional prompt/voice templates, not plan placeholders.
- **Consistency:** `nova` id, `role: 'researcher'`, `claude-sonnet-4-6`, `['Read','Glob','Grep','WebFetch','WebSearch']`, `from-emerald-400 to-teal-600`, `#10b981`, and `DISPATCHABLE = ['atlas','echo','nova']` are identical everywhere they appear.
