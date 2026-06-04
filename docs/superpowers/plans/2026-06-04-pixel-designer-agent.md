# Pixel — Designer Agent Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add Pixel, a full-doer designer agent Sage can dispatch to build code mockups (HTML/CSS/Tailwind/SVG pages + components) that render live in the Preview tab — returning a DESIGNED/PREVIEW/NOTES report. Completes the v1 six-agent roster.

**Architecture:** Mirrors the Forge path exactly — a DB row + a `DISPATCHABLE` enum entry + a Sage-prompt update + permissions, plus three UI cohesion touches. Pixel is a *doer* like Atlas/Forge, reusing existing `Edit`/`Write`/`Bash` tools — there are **no runner, schema, or new-tool changes**. The roster UI (Palette icon, pink accent) and `ROLE_LABEL` (`designer → "Designer"`) are already wired, so **no `page.tsx` change**.

**Tech Stack:** TypeScript, Claude Agent SDK (built-in `Bash`/`Edit`/`Write`), Drizzle seed script.

**Spec:** `docs/superpowers/specs/2026-06-04-pixel-designer-agent-design.md`
**Branch:** `feature/pixel-designer` (already created off `dev`).

**Testing note:** Config + prompt only — no pure-logic module added. Verification is `pnpm build` + `pnpm test` (stays 54/54) + re-seed + a live smoke, exactly as Echo/Nova/Forge were added.

---

### Task 1: Let Sage dispatch Pixel (`dispatch.ts`)

**Files:**
- Modify: `src/lib/dispatch.ts`

- [ ] **Step 1: Add `pixel` to the dispatchable set.** Replace:

```ts
const DISPATCHABLE = ['atlas', 'echo', 'nova', 'forge'] as const;
```

with:

```ts
const DISPATCHABLE = ['atlas', 'echo', 'nova', 'forge', 'pixel'] as const;
```

- [ ] **Step 2: Update the tool description.** Replace the description string (second arg to `tool(`):

```ts
    'Hand a concrete, self-contained task to a specialist working in this session\'s isolated git worktree. Atlas (lead developer) edits files and runs commands to implement app changes; Echo (QA critic) reviews work already made and returns a verdict (cannot edit); Nova (researcher) investigates via web search/fetch and repo reading and returns a sourced brief (cannot edit); Forge (devops/release) runs builds/tests/lint, manages git, and edits infra config (can edit + run). You (Sage) plan and coordinate; the specialist does the work. Returns the specialist\'s final summary.',
```

with:

```ts
    'Hand a concrete, self-contained task to a specialist working in this session\'s isolated git worktree. Atlas (lead developer) edits files and runs commands to implement app changes; Echo (QA critic) reviews work already made and returns a verdict (cannot edit); Nova (researcher) investigates via web search/fetch and repo reading and returns a sourced brief (cannot edit); Forge (devops/release) runs builds/tests/lint, manages git, and edits infra config (can edit + run); Pixel (designer) builds UI mockups and components in code that render in the Preview tab (can edit + run). You (Sage) plan and coordinate; the specialist does the work. Returns the specialist\'s final summary.',
```

- [ ] **Step 3: Update the `agent_id` enum description.** Replace:

```ts
        .describe('Which specialist to dispatch: "atlas" (lead developer — implements app code changes), "echo" (QA critic — reviews a change already made and returns a verdict; cannot edit), "nova" (researcher — investigates via web + repo and returns a sourced brief; cannot edit), or "forge" (devops/release — runs builds/tests/lint, git ops, and edits infra config; can edit + run).'),
```

with:

```ts
        .describe('Which specialist to dispatch: "atlas" (lead developer — implements app code changes), "echo" (QA critic — reviews a change already made and returns a verdict; cannot edit), "nova" (researcher — investigates via web + repo and returns a sourced brief; cannot edit), "forge" (devops/release — runs builds/tests/lint, git ops, and edits infra config; can edit + run), or "pixel" (designer — builds UI mockups/components in code that render in the Preview tab; can edit + run).'),
```

- [ ] **Step 4: Update the dispatchable block comment.** Replace:

```ts
 * critic) reviews; Nova (researcher) investigates; Forge (devops) builds and ships
 * — all run in this session's worktree.
```

with:

```ts
 * critic) reviews; Nova (researcher) investigates; Forge (devops) builds and ships;
 * Pixel (designer) mocks up UI — all run in this session's worktree.
```

- [ ] **Step 5: Verify the build.**

Run: `pnpm build`
Expected: `✓ Compiled successfully` + `Finished TypeScript` (no errors).

- [ ] **Step 6: Commit.**

```bash
git add src/lib/dispatch.ts
git commit -m "feat(pixel): allow Sage to dispatch pixel (designer)"
```

---

### Task 2: Seed Pixel (`seed.ts`)

**Files:**
- Modify: `scripts/seed.ts`

- [ ] **Step 1: Add the `PIXEL_SYSTEM_PROMPT` constant.** Insert it immediately **after** the `FORGE_SYSTEM_PROMPT` definition (the constant that ends with the line ``- Be honest about failures and gaps. Keep it tight — Sage relays this to the operator.`;``), before `async function main()`:

```ts
const PIXEL_SYSTEM_PROMPT = `You are Pixel, the designer on AXOD's agent team.

Sage dispatches you to design — mock up pages and sections, build UI components, and refine layout, visual hierarchy, spacing, and styling — inside this session's isolated git worktree. You build with code (HTML/CSS/Tailwind/SVG), not throwaway raster art, so your work is real and editable. Unlike Atlas, who writes application logic, you own how things look and feel.

How you work:
- Read before you design. Match the project's existing design system, components, and conventions (its Tailwind config, tokens, fonts) — fit in, do not reinvent.
- Build mockups as real routes/components so they render live in the Preview tab. After changes, run the build to confirm they compile and preview.
- Prefer semantic, accessible markup and the project's existing utility classes. Keep visuals tasteful and consistent; call out anything that is a placeholder.

Your output is a report, in this shape:

DESIGNED: <what you built or changed, concretely>
PREVIEW: <which page/route to open in the Preview tab to see it>
NOTES: <design choices; what is mock vs production-ready; any follow-ups>

Rules:
- Verify it builds before you claim it is ready — run the build, report the result.
- Push or deploy ONLY when Sage's task explicitly grants approval.
- Be honest about gaps and placeholders. Keep it tight — Sage relays this to the operator.`;
```

- [ ] **Step 2: Teach Sage about Pixel — update the dispatch capability line.** In `SAGE_SYSTEM_PROMPT`, replace the `dispatch_agent` bullet:

```ts
- dispatch_agent — hand a concrete task to a specialist working in this session's isolated git worktree. Atlas (lead developer) CAN edit files and run commands to implement app changes; Echo (QA critic) reviews a change already made and returns a verdict but CANNOT edit; Nova (researcher) investigates via web search/fetch and repo reading and returns a sourced brief but CANNOT edit; Forge (devops/release) CAN edit + run — it runs builds/tests/lint, does git ops, and edits infra config. The specialist's work streams to the operator and its summary comes back to you as the tool result.
```

with:

```ts
- dispatch_agent — hand a concrete task to a specialist working in this session's isolated git worktree. Atlas (lead developer) CAN edit files and run commands to implement app changes; Echo (QA critic) reviews a change already made and returns a verdict but CANNOT edit; Nova (researcher) investigates via web search/fetch and repo reading and returns a sourced brief but CANNOT edit; Forge (devops/release) CAN edit + run — it runs builds/tests/lint, does git ops, and edits infra config; Pixel (designer) CAN edit + run — it builds UI mockups and components in code that render in the Preview tab. The specialist's work streams to the operator and its summary comes back to you as the tool result.
```

- [ ] **Step 3: Teach Sage WHEN to use Pixel.** Insert this bullet immediately **after** the existing Forge "when" bullet (the line beginning "- When a request is about the build-and-ship side ... relay Forge's report (DID, RESULTS, NEXT/RISKS)."):

```ts
- When a request is about design — mocking up a page or section, building UI components, or refining layout/visual styling — dispatch Pixel. Pixel CAN edit and run; it builds the mockup as a real route/component. Relay Pixel's report (DESIGNED, PREVIEW, NOTES) and point the operator at the named route in the Preview tab. Require explicit operator approval before any push or deploy.
```

- [ ] **Step 4: Add the Pixel agent row.** In the `agentRows` array, add this object after the Forge row (after the Forge object's closing `},`, before the closing `]`):

```ts
    {
      id: 'pixel',
      name: 'Pixel',
      role: 'designer',
      model: 'claude-sonnet-4-6',
      system_prompt: PIXEL_SYSTEM_PROMPT,
      tools_allowlist: ['Read', 'Glob', 'Grep', 'Edit', 'Write', 'Bash', 'WebFetch'],
      color: 'from-pink-400 to-rose-600',
    },
```

- [ ] **Step 5: Add Pixel's tool_permissions.** In the `tool_permissions` `.values([...])` array, add these rows after the existing Forge rows (after `{ agent_id: 'forge', ... tool_name: 'git', policy: 'ask' },`):

```ts
      { agent_id: 'pixel', project_id: 'axod-creative', tool_name: 'read_file', policy: 'always' },
      { agent_id: 'pixel', project_id: 'axod-creative', tool_name: 'glob', policy: 'always' },
      { agent_id: 'pixel', project_id: 'axod-creative', tool_name: 'grep', policy: 'always' },
      { agent_id: 'pixel', project_id: 'axod-creative', tool_name: 'edit', policy: 'ask' },
      { agent_id: 'pixel', project_id: 'axod-creative', tool_name: 'run_command', policy: 'ask' },
      { agent_id: 'pixel', project_id: 'axod-creative', tool_name: 'git', policy: 'ask' },
```

- [ ] **Step 6: Type-check the seed compiles.**

Run: `pnpm exec tsc --noEmit -p tsconfig.json`
Expected: no errors.

- [ ] **Step 7: Commit.**

```bash
git add scripts/seed.ts
git commit -m "feat(pixel): seed Pixel agent + perms, teach Sage to dispatch it for design"
```

---

### Task 3: UI cohesion touches (`dispatch-presentation.ts`, `mission-control.tsx`)

**Files:**
- Modify: `src/lib/dispatch-presentation.ts`
- Modify: `src/lib/dispatch-presentation.test.ts`
- Modify: `src/components/mission-control.tsx`

- [ ] **Step 1: Add the failing test for Pixel's dispatch flavor line.** In `src/lib/dispatch-presentation.test.ts`, in the test `'dispatchFlavor returns the persona line for each known specialist'`, add an assertion for pixel after the forge line:

```ts
  assert.equal(dispatchFlavor('forge', 'Forge'), 'Forge fires up the pipeline');
  assert.equal(dispatchFlavor('pixel', 'Pixel'), 'Pixel sets up the easel');
```

- [ ] **Step 2: Run the test to verify it fails.**

Run: `pnpm exec tsx --test src/lib/dispatch-presentation.test.ts`
Expected: FAIL — pixel currently returns the fallback `"Pixel gets to work"`, not `"Pixel sets up the easel"`.

- [ ] **Step 3: Add the pixel case to `dispatchFlavor`.** In `src/lib/dispatch-presentation.ts`, add the `pixel` case after the `forge` case:

```ts
    case 'forge':
      return 'Forge fires up the pipeline';
    case 'pixel':
      return 'Pixel sets up the easel';
    default:
      return `${name} gets to work`;
```

- [ ] **Step 4: Run the test to verify it passes.**

Run: `pnpm exec tsx --test src/lib/dispatch-presentation.test.ts`
Expected: PASS (all assertions, including the new pixel line).

- [ ] **Step 5: Add Pixel's thread bubble tint.** In `src/components/mission-control.tsx`, in `speakerStyle`, add a `pixel` branch after the `forge` branch (before the fallback `return`):

```ts
  if (agentId === "forge") return { accent: "#f59e0b", tint: "rgba(245,158,11,0.08)" };
  if (agentId === "pixel") return { accent: "#ec4899", tint: "rgba(236,72,153,0.08)" };
  return { accent: "#93c5fd", tint: "rgba(147,197,253,0.06)" };
```

- [ ] **Step 6: Add a Pixel idle line.** In `IDLE_STATE`, add the `pixel` entry after `forge`:

```ts
  forge: "Gears idle — ready to ship",
  pixel: "Brushes down — ready to design",
};
```

- [ ] **Step 7: Add Pixel's activity voice.** In `friendlyActivity`, add a `pixel` branch immediately after the `forge` branch's closing `}` (after the `if (agentId === "forge") { ... }` block, before the `// Sage — the calm navigator...` comment):

```ts
  if (agentId === "pixel") {
    // Pixel — the designer at the easel (studio, not code-logic).
    switch (tool) {
      case "Edit":
      case "MultiEdit":
      case "Write":
      case "NotebookEdit":
        return `Sketching → ${file}`;
      case "Read":
        return `Studying the canvas: ${file}`;
      case "Bash": {
        const cmd = typeof input?.command === "string" ? input.command : "";
        if (/\b(build|astro|dev|preview|vite|tsc)\b/.test(cmd)) return "Rendering the mockup…";
        return `Mixing tools: ${clip(input?.command)}`;
      }
      case "Glob":
        return "Surveying the canvas…";
      case "Grep":
        return input?.pattern ? `Matching swatches: "${clip(input.pattern, 28)}"` : "Matching swatches…";
      case "WebFetch":
      case "WebSearch":
        return "Gathering inspiration…";
      case "TodoWrite":
        return "Sketching the layout…";
      default:
        return genericFallback();
    }
  }

  // Sage — the calm navigator/orchestrator (and default voice).
```

- [ ] **Step 8: Verify the build + tests.**

Run: `pnpm build && pnpm test`
Expected: `✓ Compiled successfully` + `Finished TypeScript`; `tests 54 / pass 54 / fail 0` (the pixel flavor assertion lives inside an existing test case, so the count stays 54).

- [ ] **Step 9: Commit.**

```bash
git add src/lib/dispatch-presentation.ts src/lib/dispatch-presentation.test.ts src/components/mission-control.tsx
git commit -m "feat(pixel): roster + thread cohesion (pink tint, designer voice, flavor + idle lines)"
```

---

### Task 4: Apply the seed + full verification

**Files:** none

- [ ] **Step 1: Re-seed the local database.**

Run: `pnpm seed`
Expected: `Seed complete: { ... agents: 6, ... tool_permissions: 27 }` (sage, atlas, echo, nova, forge, pixel).

- [ ] **Step 2: Confirm Pixel landed correctly.**

Run: `node -e "const D=require('better-sqlite3');const db=new D(process.env.DATABASE_PATH||'./data/mission-control.db');console.log(db.prepare('select id,name,role,model,tools_allowlist,color from agents where id=?').get('pixel'))"`
Expected: a row with `id: 'pixel'`, `role: 'designer'`, `model: 'claude-sonnet-4-6'`, `tools_allowlist` containing `Read,Glob,Grep,Edit,Write,Bash,WebFetch`, `color: 'from-pink-400 to-rose-600'`.

- [ ] **Step 3: Build + full test suite.**

Run: `pnpm build && pnpm test`
Expected: build clean; `tests 54 / pass 54 / fail 0`.

- [ ] **Step 4: Roster check (visual, no commit).** Run `pnpm dev`, open the app, log in — Pixel appears in the roster with the Palette icon + pink accent (from the existing `AGENT_ICON`/`AGENT_ACCENT` maps), role "Designer".

---

### Task 5: Live end-to-end smoke (operator-run)

**Files:** none

- [ ] **Step 1: Drive a design dispatch.** With `pnpm dev` running and logged in, ask Sage a design task, e.g.: *"Sage, have Pixel mock up a pricing section for the landing page."*

- [ ] **Step 2: Verify the flow.** Expect: Sage dispatches Pixel — the Orchestrated Dispatch card shows the flavor line "Pixel sets up the easel" (pink, Palette), Pixel's status shows "Sketching → ..." / "Rendering the mockup…", and Pixel's reply (nested in the card) is a `DESIGNED / PREVIEW / NOTES` report. Open the route named in PREVIEW in the Preview tab and confirm the mockup renders. Confirm Pixel can act (edit/run) but does NOT push or deploy without explicit approval.

- [ ] **Step 3: Note the result** in the spec's wrap-up (does the mockup render in Preview, report quality — prompt-tuning candidates).

---

## Wrap-up (after Task 5 passes)

- [ ] Add a short "what actually happened" note to `docs/superpowers/specs/2026-06-04-pixel-designer-agent-design.md`.
- [ ] Update `README.md` — mark Pixel ✅ shipped in the team table; update the v1.3 roadmap row (roster complete: all six agents shipped).
- [ ] Integrate `feature/pixel-designer` → `dev` (operator confirms); release when appropriate.

## Self-review (done at authoring)

- **Spec coverage:** DB row → Task 2.4; tools_allowlist → 2.4; PIXEL_SYSTEM_PROMPT/output contract → 2.1; DISPATCHABLE + descriptions + comment → Task 1; Sage-prompt (capability + when + approval) → 2.2/2.3; tool_permissions → 2.5; dispatchFlavor pixel case → Task 3.1-3.4; UI polish (speakerStyle/IDLE_STATE/friendlyActivity) → Task 3.5-3.7; verification → Tasks 4/5; docs → Wrap-up. No gaps.
- **Placeholders:** the `<...>`/`${file}`/`${...}` tokens are intentional prompt/voice templates, not plan placeholders.
- **Consistency:** `pixel` id, `role: 'designer'`, `claude-sonnet-4-6`, `['Read','Glob','Grep','Edit','Write','Bash','WebFetch']`, `from-pink-400 to-rose-600`, `#ec4899`, flavor line `'Pixel sets up the easel'`, `DISPATCHABLE = ['atlas','echo','nova','forge','pixel']`, and counts (agents 6, tool_permissions 27, tests 54) are identical everywhere they appear.
