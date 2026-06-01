# Echo — QA Critic Agent Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add Echo, a read-only QA-critic agent that Sage can dispatch to review a specialist's work in the session worktree against the task brief and return a structured verdict.

**Architecture:** Echo is a normal dispatchable specialist — a DB row plus an entry in the dispatch enum. No new mechanism: the existing `dispatch.ts` runner runs Echo in the shared session worktree, where it inspects Atlas's changes via `git diff`. No UI changes (the roster already renders Echo). No schema migration (agents are seeded).

**Tech Stack:** TypeScript, the Claude Agent SDK (`runClaudeAgent` + in-process MCP dispatch tool), Drizzle/better-sqlite3 seed script.

**Spec:** `docs/superpowers/specs/2026-06-01-echo-qa-agent-design.md`

**Branch:** `feature/echo-qa-agent` (already created off `dev`).

**Testing note:** This change is agent **configuration + prompt**, not new pure-logic. The project's `node:test` suite covers pure `src/lib/*.ts` modules only; adding Echo introduces no such module. So verification is `pnpm build` + `pnpm test` (unchanged, stays 39/39) + a re-seed + a live end-to-end smoke — exactly how Atlas was added and verified in Week 3. We deliberately do **not** fabricate a brittle test that imports the SDK/MCP tool.

---

### Task 1: Let Sage dispatch Echo (`dispatch.ts`)

**Files:**
- Modify: `src/lib/dispatch.ts` (the `DISPATCHABLE` constant + the dispatch tool's descriptions)

- [ ] **Step 1: Add `echo` to the dispatchable set.** Replace the `DISPATCHABLE` block (the doc comment + the const, around lines 17–23):

```ts
/**
 * Specialists Sage may dispatch. Enum-restricted so Sage can't invent an agent.
 * Sage itself is intentionally absent (no self-dispatch / recursion), as is any
 * agent that isn't yet a real SDK runner. Atlas (developer) implements; Echo (QA
 * critic) reviews — both run in this session's worktree.
 */
const DISPATCHABLE = ['atlas', 'echo'] as const;
```

- [ ] **Step 2: Update the tool description** so Sage understands the two specialists. Replace the second argument to `tool(` (the description string, around line 67):

```ts
    'Hand a concrete, self-contained task to a specialist working in this session\'s isolated git worktree. Atlas (lead developer) edits files and runs commands to implement changes; Echo (QA critic) reviews work already made and returns a verdict but cannot edit. You (Sage) plan and coordinate; the specialist does the work. Returns the specialist\'s final summary.',
```

- [ ] **Step 3: Update the `agent_id` and `task` field descriptions.** Replace the `agent_id` and `task` schema entries (around lines 69–77):

```ts
      agent_id: z
        .enum(DISPATCHABLE)
        .describe('Which specialist to dispatch: "atlas" (lead developer — implements code changes) or "echo" (QA critic — reviews a change already made in the worktree and returns a verdict; cannot edit).'),
      task: z
        .string()
        .min(1)
        .describe(
          'A concrete, self-contained task. For Atlas: which files to change, the change, and how to verify it. For Echo: what to review and the original brief to judge it against. The specialist does not see the operator chat, so include everything it needs.',
        ),
```

- [ ] **Step 4: Verify the build is clean.**

Run: `pnpm build`
Expected: `✓ Compiled successfully` + `Finished TypeScript` (no type errors; `DISPATCHABLE` is still a `readonly` tuple, `z.enum` accepts it).

- [ ] **Step 5: Commit.**

```bash
git add src/lib/dispatch.ts
git commit -m "feat(echo): allow Sage to dispatch echo (QA critic)"
```

---

### Task 2: Seed Echo (`seed.ts`)

**Files:**
- Modify: `scripts/seed.ts` (add `ECHO_SYSTEM_PROMPT`, extend `SAGE_SYSTEM_PROMPT`, add the Echo agent row + tool_permissions)

- [ ] **Step 1: Add the `ECHO_SYSTEM_PROMPT` constant.** Insert it immediately after the `ATLAS_SYSTEM_PROMPT` definition (after line 36), before `async function main()`. (Plain text inside the template literal — no inner backticks, to avoid escaping.)

```ts
const ECHO_SYSTEM_PROMPT = `You are Echo, the QA critic on AXOD's agent team.

Sage dispatches you to review another specialist's work inside this session's isolated git worktree — usually a change Atlas just made. You do NOT edit code. You verify.

How you work:
- Start by running git diff (and git diff --stat) to see exactly what changed. Read the changed files and enough surrounding code to judge them in context.
- Check the change against the task brief Sage gave you: does it do what was asked, correctly and completely?
- Look for correctness bugs, missed requirements, regressions, broken conventions the project actually follows, and anything unsafe.
- When useful and quick, run the project's build/lint/test commands to verify. Report what you ran and what happened.

Your output is a verdict, in this exact shape:

VERDICT: PASS | CONCERNS | FAIL
- <file:line> · <severity: high|med|low> · <what is wrong> · <why it matters>
- ... (one line per issue; omit this list entirely if PASS with nothing to note)
SUMMARY: <2-3 sentences for Sage to relay to the operator>

Rules:
- PASS only if you would ship it. CONCERNS = works but has issues worth surfacing. FAIL = it is wrong, incomplete, or broken.
- Be specific — cite file:line. No vague "looks good" or "could be improved."
- Do NOT rubber-stamp, and do NOT nitpick style the project does not enforce.
- If you could not verify something (e.g., tests did not run), say so rather than guessing.`;
```

- [ ] **Step 2: Teach Sage about Echo — update the dispatch capability line.** In `SAGE_SYSTEM_PROMPT`, replace the `dispatch_agent` bullet (line 21):

```ts
- dispatch_agent — hand a concrete task to a specialist working in this session's isolated git worktree. Atlas (lead developer) CAN edit files and run commands to implement changes; Echo (QA critic) reviews a change already made and returns a verdict but CANNOT edit. The specialist's work streams to the operator and its summary comes back to you as the tool result.
```

- [ ] **Step 3: Teach Sage WHEN to use Echo.** In `SAGE_SYSTEM_PROMPT`, in the "When the operator asks for code changes:" list, insert this bullet immediately after the "Then call dispatch_agent ... report what Atlas did." bullet (after line 26):

```ts
- After Atlas (or any specialist) makes a change, consider dispatching Echo to review it against the original brief before you report the work done — pass Echo the brief and a summary of what changed as its context. Always dispatch Echo when the operator asks for a review. Relay Echo's verdict honestly, including any CONCERNS or FAIL.
```

- [ ] **Step 4: Add the Echo agent row.** In the `agentRows` array, add this object after the Atlas row (after line 76, before the closing `]`):

```ts
    {
      id: 'echo',
      name: 'Echo',
      role: 'qa',
      model: 'claude-sonnet-4-6',
      system_prompt: ECHO_SYSTEM_PROMPT,
      tools_allowlist: ['Read', 'Glob', 'Grep', 'Bash'],
      color: 'from-violet-400 to-purple-600',
    },
```

- [ ] **Step 5: Add Echo's tool_permissions.** In the `tool_permissions` `.values([...])` array, add these rows after the existing Atlas rows (after line 173):

```ts
      { agent_id: 'echo', project_id: 'axod-creative', tool_name: 'read_file', policy: 'always' },
      { agent_id: 'echo', project_id: 'axod-creative', tool_name: 'glob', policy: 'always' },
      { agent_id: 'echo', project_id: 'axod-creative', tool_name: 'grep', policy: 'always' },
      { agent_id: 'echo', project_id: 'axod-creative', tool_name: 'run_command', policy: 'ask' },
```

- [ ] **Step 6: Type-check the seed compiles.**

Run: `pnpm exec tsc --noEmit -p tsconfig.json`
Expected: no errors (the new row matches the inferred `agentRows` element shape; `tools_allowlist` is `string[]`).

- [ ] **Step 7: Commit.**

```bash
git add scripts/seed.ts
git commit -m "feat(echo): seed Echo agent + perms, teach Sage to dispatch it for review"
```

---

### Task 3: Apply the seed + full verification

**Files:** none (runs the seed against the local dev DB)

- [ ] **Step 1: Re-seed the local database.** The seed upserts agents (`onConflictDoUpdate` refreshes Sage's prompt and inserts Echo) and inserts the new `tool_permissions` rows (`onConflictDoNothing`).

Run: `pnpm seed`
Expected: `Seed complete: { ... agents: 3, ... }` (was 2 — Sage, Atlas; now 3 with Echo).

- [ ] **Step 2: Confirm Echo landed correctly.**

Run: `node -e "const D=require('better-sqlite3');const db=new D(process.env.DATABASE_PATH||'./data/mission-control.db');console.log(db.prepare('select id,name,role,model,tools_allowlist,color from agents where id=?').get('echo'))"`
Expected: a row with `id: 'echo'`, `role: 'qa'`, `model: 'claude-sonnet-4-6'`, `tools_allowlist` containing `Read,Glob,Grep,Bash`, `color: 'from-violet-400 to-purple-600'`.

- [ ] **Step 3: Run the build and tests.**

Run: `pnpm build && pnpm test`
Expected: build `✓ Compiled successfully`; tests `tests 39 / pass 39 / fail 0` (unchanged — no pure-module logic added).

- [ ] **Step 4: Confirm the roster renders Echo (no code change needed).** Run `pnpm dev`, open the app, log in, and check the left roster: Echo appears with the violet accent and Bug icon (from the existing `AGENT_ACCENT`/icon maps in `mission-control.tsx`). No commit — this is a visual confirmation.

---

### Task 4: Live end-to-end smoke (operator-run)

**Files:** none (manual verification against a running app)

- [ ] **Step 1: Drive the full third-agent path.** With `pnpm dev` running and logged in, send Sage a small real request that needs a change, e.g.: *"Sage, have Atlas add a short comment to the top of one source file in the repo, then have Echo review it."*

- [ ] **Step 2: Verify the flow.** Expect, in order: Sage dispatches Atlas (dispatch card "Atlas · via Sage", the edit appears in the Code diff) → Sage dispatches Echo (dispatch card "Echo · via Sage") → Echo's reply contains a `VERDICT: PASS|CONCERNS|FAIL` block → Sage relays the verdict. Confirm Echo did **not** edit anything (its allowlist has no Edit/Write — any attempt should fail, not mutate the worktree).

- [ ] **Step 3: Note the result** in the spec's "what actually happened" follow-up (added during the wrap-up), capturing anything surprising about Sage's willingness to dispatch Echo or Echo's verdict quality (prompt-tuning candidates).

---

## Wrap-up (after Task 4 passes)

- [ ] Update `docs/superpowers/specs/2026-06-01-echo-qa-agent-design.md` with a short "what actually happened" note (live result, any prompt tweaks).
- [ ] Per the branch workflow, integrate `feature/echo-qa-agent` → `dev` (operator confirms; `dev` → `main` as part of a release when appropriate).
- [ ] Optional: update `README.md` — move Echo from "next hire (v1.1)" to ✅ shipped once merged.

## Self-review (done at authoring)

- **Spec coverage:** DB row → Task 2.4; tools_allowlist → Task 2.4; ECHO_SYSTEM_PROMPT/output contract → Task 2.1; DISPATCHABLE + enum/desc → Task 1; Sage-prompt update (capability + when) → Task 2.2–2.3; tool_permissions (dormant) → Task 2.5; "no UI/migration changes" → reflected (none); verification (build/test/re-seed/live) → Tasks 3–4. No gaps.
- **Placeholders:** the `<file:line>`/`<severity>` tokens are the intentional prompt output-contract template, not plan placeholders.
- **Consistency:** `echo` id, `role: 'qa'`, `claude-sonnet-4-6`, `['Read','Glob','Grep','Bash']`, and `DISPATCHABLE = ['atlas','echo']` are identical everywhere they appear.
