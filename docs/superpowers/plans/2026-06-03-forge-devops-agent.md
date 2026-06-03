# Forge — DevOps / Release Agent Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add Forge, a full-doer devops/release agent Sage can dispatch to run builds/tests/lint, manage git (branch/commit/tag), and edit infra config — returning a structured report (DID, RESULTS, NEXT/RISKS).

**Architecture:** Mirrors the Echo/Nova path — a DB row + a `DISPATCHABLE` enum entry + a Sage-prompt update + permissions, plus three small UI cohesion touches. Forge is a *doer* like Atlas, so it reuses Atlas's existing tools (`Edit`/`Write`/`Bash`) — there are **no runner, schema, or new-tool changes**. The roster UI (Cog icon, amber accent) and `ROLE_LABEL` (`devops → "DevOps"`) are already wired, so **no `page.tsx` change**.

**Tech Stack:** TypeScript, Claude Agent SDK (built-in `Bash`/`Edit`/`Write` already passed through by the runner), Drizzle seed script.

**Spec:** `docs/superpowers/specs/2026-06-03-forge-devops-agent-design.md`
**Branch:** `feature/forge-devops` (already created off `dev`).

**Testing note:** Config + prompt only — no pure-logic module added. Verification is `pnpm build` + `pnpm test` (stays 51/51) + re-seed + a live smoke, exactly as Echo and Nova were added. No brittle SDK/MCP test.

---

### Task 1: Let Sage dispatch Forge (`dispatch.ts`)

**Files:**
- Modify: `src/lib/dispatch.ts`

- [ ] **Step 1: Add `forge` to the dispatchable set.** Replace:

```ts
const DISPATCHABLE = ['atlas', 'echo', 'nova'] as const;
```

with:

```ts
const DISPATCHABLE = ['atlas', 'echo', 'nova', 'forge'] as const;
```

- [ ] **Step 2: Update the tool description.** Replace the description string (the second arg to `tool(`):

```ts
    'Hand a concrete, self-contained task to a specialist working in this session\'s isolated git worktree. Atlas (lead developer) edits files and runs commands to implement changes; Echo (QA critic) reviews work already made and returns a verdict (cannot edit); Nova (researcher) investigates via web search/fetch and repo reading and returns a sourced brief (cannot edit). You (Sage) plan and coordinate; the specialist does the work. Returns the specialist\'s final summary.',
```

with:

```ts
    'Hand a concrete, self-contained task to a specialist working in this session\'s isolated git worktree. Atlas (lead developer) edits files and runs commands to implement app changes; Echo (QA critic) reviews work already made and returns a verdict (cannot edit); Nova (researcher) investigates via web search/fetch and repo reading and returns a sourced brief (cannot edit); Forge (devops/release) runs builds/tests/lint, manages git, and edits infra config (can edit + run). You (Sage) plan and coordinate; the specialist does the work. Returns the specialist\'s final summary.',
```

- [ ] **Step 3: Update the `agent_id` enum description.** Replace:

```ts
        .describe('Which specialist to dispatch: "atlas" (lead developer — implements code changes), "echo" (QA critic — reviews a change already made and returns a verdict; cannot edit), or "nova" (researcher — investigates via web + repo and returns a sourced brief; cannot edit).'),
```

with:

```ts
        .describe('Which specialist to dispatch: "atlas" (lead developer — implements app code changes), "echo" (QA critic — reviews a change already made and returns a verdict; cannot edit), "nova" (researcher — investigates via web + repo and returns a sourced brief; cannot edit), or "forge" (devops/release — runs builds/tests/lint, git ops, and edits infra config; can edit + run).'),
```

- [ ] **Step 4: Verify the build.**

Run: `pnpm build`
Expected: `✓ Compiled successfully` + `Finished TypeScript` (no errors).

- [ ] **Step 5: Commit.**

```bash
git add src/lib/dispatch.ts
git commit -m "feat(forge): allow Sage to dispatch forge (devops)"
```

---

### Task 2: Seed Forge (`seed.ts`)

**Files:**
- Modify: `scripts/seed.ts`

- [ ] **Step 1: Add the `FORGE_SYSTEM_PROMPT` constant.** Insert it immediately **after** the `NOVA_SYSTEM_PROMPT` definition (the line ending `Sage relays this to the operator.\`;`), before `async function main()`:

```ts
const FORGE_SYSTEM_PROMPT = `You are Forge, the devops / release engineer on AXOD's agent team.

Sage dispatches you to handle the build-and-ship side inside this session's isolated git worktree: run builds/tests/lint, manage git (branch, commit, tag), and edit infrastructure config (CI workflows, Dockerfile, Caddyfile, deploy scripts). Unlike Atlas, who writes application code, you own the pipeline and the release.

How you work:
- Read before you change. Inspect the existing config/scripts and match the project's conventions.
- Make precise, minimal config edits. After changes, run the relevant build/test/lint to verify, and report exactly what you ran and its result.
- For git/release ops, use clear messages and tags. Push or deploy ONLY when Sage's task explicitly grants approval — never push or run a destructive or remote command on your own initiative.

Your output is a report, in this shape:

DID: <what you changed or ran, concretely>
RESULTS: <commands run + outcomes (build/test/lint pass/fail, etc.)>
NEXT/RISKS: <what's left, any risk, or what needs operator approval>

Rules:
- Verify before you claim success — paste real command output, do not assume.
- Never push, deploy, or run irreversible/remote operations without explicit approval in the task.
- Be honest about failures and gaps. Keep it tight — Sage relays this to the operator.`;
```

- [ ] **Step 2: Teach Sage about Forge — update the dispatch capability line.** In `SAGE_SYSTEM_PROMPT`, replace the `dispatch_agent` bullet:

```ts
- dispatch_agent — hand a concrete task to a specialist working in this session's isolated git worktree. Atlas (lead developer) CAN edit files and run commands to implement changes; Echo (QA critic) reviews a change already made and returns a verdict but CANNOT edit; Nova (researcher) investigates via web search/fetch and repo reading and returns a sourced brief but CANNOT edit. The specialist's work streams to the operator and its summary comes back to you as the tool result.
```

with:

```ts
- dispatch_agent — hand a concrete task to a specialist working in this session's isolated git worktree. Atlas (lead developer) CAN edit files and run commands to implement app changes; Echo (QA critic) reviews a change already made and returns a verdict but CANNOT edit; Nova (researcher) investigates via web search/fetch and repo reading and returns a sourced brief but CANNOT edit; Forge (devops/release) CAN edit + run — it runs builds/tests/lint, does git ops, and edits infra config. The specialist's work streams to the operator and its summary comes back to you as the tool result.
```

- [ ] **Step 3: Teach Sage WHEN to use Forge.** Insert this bullet immediately **after** the existing "When a request needs outside or in-depth information ... dispatch Nova to research it ..." bullet:

```ts
- When a request is about the build-and-ship side — running build/test/lint, git/release ops (branch/commit/tag), or editing CI/Docker/Caddy/deploy config — dispatch Forge. Forge CAN edit and run, but require explicit operator approval before any push or deploy, and relay Forge's report (DID, RESULTS, NEXT/RISKS).
```

- [ ] **Step 4: Add the Forge agent row.** In the `agentRows` array, add this object after the Nova row (after the Nova object's closing `},`, before the closing `]`):

```ts
    {
      id: 'forge',
      name: 'Forge',
      role: 'devops',
      model: 'claude-sonnet-4-6',
      system_prompt: FORGE_SYSTEM_PROMPT,
      tools_allowlist: ['Read', 'Glob', 'Grep', 'Edit', 'Write', 'Bash', 'WebFetch'],
      color: 'from-amber-400 to-orange-600',
    },
```

- [ ] **Step 5: Add Forge's tool_permissions.** In the `tool_permissions` `.values([...])` array, add these rows after the existing Nova rows (after `{ agent_id: 'nova', ... tool_name: 'web_search', policy: 'always' },`):

```ts
      { agent_id: 'forge', project_id: 'axod-creative', tool_name: 'read_file', policy: 'always' },
      { agent_id: 'forge', project_id: 'axod-creative', tool_name: 'glob', policy: 'always' },
      { agent_id: 'forge', project_id: 'axod-creative', tool_name: 'grep', policy: 'always' },
      { agent_id: 'forge', project_id: 'axod-creative', tool_name: 'edit', policy: 'ask' },
      { agent_id: 'forge', project_id: 'axod-creative', tool_name: 'run_command', policy: 'ask' },
      { agent_id: 'forge', project_id: 'axod-creative', tool_name: 'git', policy: 'ask' },
```

- [ ] **Step 6: Type-check the seed compiles.**

Run: `pnpm exec tsc --noEmit -p tsconfig.json`
Expected: no errors.

- [ ] **Step 7: Commit.**

```bash
git add scripts/seed.ts
git commit -m "feat(forge): seed Forge agent + perms, teach Sage to dispatch it for devops"
```

---

### Task 3: UI cohesion touches (`mission-control.tsx`)

**Files:**
- Modify: `src/components/mission-control.tsx`

- [ ] **Step 1: Add Forge's thread bubble tint.** In `speakerStyle`, add a `forge` branch before the fallback `return` (after the `nova` branch):

```ts
  if (agentId === "nova") return { accent: "#10b981", tint: "rgba(16,185,129,0.08)" };
  if (agentId === "forge") return { accent: "#f59e0b", tint: "rgba(245,158,11,0.08)" };
  return { accent: "#93c5fd", tint: "rgba(147,197,253,0.06)" };
```

- [ ] **Step 2: Add a Forge idle line.** In `IDLE_STATE`, add the `forge` entry after `nova`:

```ts
const IDLE_STATE: Record<string, string> = {
  sage: "Standing by at the helm",
  atlas: "Hammer cooled — ready to forge",
  echo: "Red pen capped — for now",
  nova: "Telescope stowed — ready to dig",
  forge: "Gears idle — ready to ship",
};
```

- [ ] **Step 3: Add Forge's activity voice.** In `friendlyActivity`, add a `forge` branch immediately after the `nova` branch (after the `if (agentId === "nova") { ... }` block, before the `// Sage — the calm navigator...` comment):

```ts
  if (agentId === "forge") {
    // Forge — the devops/release engineer at the controls (machinery, not smithing).
    switch (tool) {
      case "Bash": {
        const cmd = typeof input?.command === "string" ? input.command : "";
        if (/\bgit\s+(tag|commit|push)\b/.test(cmd)) return "Cutting the release…";
        if (/\b(deploy|ship|caddy|docker\s+(build|push)|rsync|scp)\b/.test(cmd)) return "Shipping it…";
        if (/\b(build|test|lint|vitest|jest|pnpm|npm|tsc)\b/.test(cmd)) return "Running the pipeline…";
        return `Turning the gears: ${clip(input?.command)}`;
      }
      case "Edit":
      case "MultiEdit":
      case "Write":
      case "NotebookEdit":
        return `Wiring up → ${file}`;
      case "Read":
        return `Checking the manifest: ${file}`;
      case "Glob":
        return "Mapping the pipeline…";
      case "Grep":
        return input?.pattern ? `Tracing the config: "${clip(input.pattern, 28)}"` : "Tracing the config…";
      case "WebFetch":
      case "WebSearch":
        return "Consulting the ops docs…";
      case "TodoWrite":
        return "Drafting the runbook…";
      default:
        return genericFallback();
    }
  }

  // Sage — the calm navigator/orchestrator (and default voice).
```

- [ ] **Step 4: Verify the build.**

Run: `pnpm build`
Expected: `✓ Compiled successfully` + `Finished TypeScript`.

- [ ] **Step 5: Commit.**

```bash
git add src/components/mission-control.tsx
git commit -m "feat(forge): roster + thread cohesion (amber tint, devops voice, idle line)"
```

---

### Task 4: Apply the seed + full verification

**Files:** none

- [ ] **Step 1: Re-seed the local database.**

Run: `pnpm seed`
Expected: `Seed complete: { ... agents: 5, ... tool_permissions: 21 }` (sage, atlas, echo, nova, forge).

- [ ] **Step 2: Confirm Forge landed correctly.**

Run: `node -e "const D=require('better-sqlite3');const db=new D(process.env.DATABASE_PATH||'./data/mission-control.db');console.log(db.prepare('select id,name,role,model,tools_allowlist,color from agents where id=?').get('forge'))"`
Expected: a row with `id: 'forge'`, `role: 'devops'`, `model: 'claude-sonnet-4-6'`, `tools_allowlist` containing `Read,Glob,Grep,Edit,Write,Bash,WebFetch`, `color: 'from-amber-400 to-orange-600'`.

- [ ] **Step 3: Build + full test suite.**

Run: `pnpm build && pnpm test`
Expected: build clean; `tests 51 / pass 51 / fail 0`.

- [ ] **Step 4: Roster check (visual, no commit).** Run `pnpm dev`, open the app, log in — Forge appears in the roster with the Cog icon + amber accent (from the existing `AGENT_ICON`/`AGENT_ACCENT` maps), role "DevOps".

---

### Task 5: Live end-to-end smoke (operator-run)

**Files:** none

- [ ] **Step 1: Drive a devops dispatch.** With `pnpm dev` running and logged in, ask Sage a devops task, e.g.: *"Sage, have Forge run the build and the test suite and report the results."*

- [ ] **Step 2: Verify the flow.** Expect: Sage dispatches Forge ("Forge · via Sage", amber), Forge's status shows "Running the pipeline…", and Forge's reply contains a `DID, RESULTS, NEXT/RISKS` report with **real command output**. Then ask Forge to make a small config edit (e.g. a comment in a config file) and confirm it CAN edit + commit, but does **not** push without explicit approval.

- [ ] **Step 3: Note the result** in the spec's wrap-up (whether Forge respected the no-push-without-approval rule, report quality — prompt-tuning candidates).

---

## Wrap-up (after Task 5 passes)

- [ ] Add a short "what actually happened" note to `docs/superpowers/specs/2026-06-03-forge-devops-agent-design.md`.
- [ ] Update `README.md` — mark Forge ✅ shipped in the team table; split the v1.3 roadmap row (Forge done, Pixel still pending); note the Sonnet-over-Haiku model decision.
- [ ] Integrate `feature/forge-devops` → `dev` (operator confirms); release when appropriate.

## Self-review (done at authoring)

- **Spec coverage:** DB row → Task 2.4; tools_allowlist → 2.4; FORGE_SYSTEM_PROMPT/output contract → 2.1; DISPATCHABLE + descriptions → Task 1; Sage-prompt (capability + when + approval rule) → 2.2/2.3; tool_permissions → 2.5; UI polish (speakerStyle/IDLE_STATE/friendlyActivity) → Task 3; verification → Tasks 4/5; docs → Wrap-up. No gaps.
- **Placeholders:** the `<key point>`/`<file>`/`<cmd>`/`<pattern>` tokens are the intentional prompt/voice templates, not plan placeholders.
- **Consistency:** `forge` id, `role: 'devops'`, `claude-sonnet-4-6`, `['Read','Glob','Grep','Edit','Write','Bash','WebFetch']`, `from-amber-400 to-orange-600`, `#f59e0b`, `DISPATCHABLE = ['atlas','echo','nova','forge']`, and counts (agents 5, tool_permissions 21) are identical everywhere they appear.
