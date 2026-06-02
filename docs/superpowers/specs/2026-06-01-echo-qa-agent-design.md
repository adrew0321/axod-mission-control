# Echo — QA Critic Agent Design

**Date:** 2026-06-01
**Branch:** `feature/echo-qa-agent` (off `dev`)
**Scope:** Add **Echo**, the QA-critic agent — the first post-v1 team member and the proven template for growing the roster. Echo reviews a specialist's work (typically Atlas's) in the session worktree against the original task brief and returns a structured verdict. Read-only: it cannot edit code.

This is roadmap item **v1.1** (re-sequenced ahead of Nova/Pixel because Echo needs **no new tool plumbing**). See `README.md` → "Where we're going" and `docs/architecture/team-of-agents.md` (open question #3).

---

## Why Echo is cheap to add

The team is DB-driven and the dispatch path is generic:
- The roster reads agents from the DB; `mission-control.tsx` already has Echo's icon (Bug) and accent (violet) wired ([`AGENT_ACCENT`](../../../src/components/mission-control.tsx)). **No UI changes.**
- [`dispatch.ts`](../../../src/lib/dispatch.ts) runs every dispatched specialist via `runClaudeAgent` with `workingDir =` the session's git worktree, streaming its output and feeding its summary back to Sage. A second specialist is an enum entry + a DB row — **no new mechanism.**
- Echo uses only existing tool types (`Read`/`Glob`/`Grep`/`Bash`), so nothing new to wire into the runner.

## How Echo sees Atlas's work

All agents in a session **share that session's worktree** (per the team-of-agents architecture). When Sage dispatches Echo, Echo runs in the same `workingDir` where Atlas just made changes. Echo inspects the work with `git diff` / `git diff --stat` and by reading the changed files. Sage passes the **original task brief + a summary of what changed** as the dispatch `context` (Echo does not see the operator chat, exactly like Atlas).

No automatic pipeline: **Sage decides** when a review is warranted (operator-approved). The operator can also ask Sage to "have Echo review this." This keeps the "Sage orchestrates explicitly — not a graph" ethos and avoids chaining code in `dispatch.ts`.

## Identity (the DB row, in `scripts/seed.ts`)

Mirrors the existing Atlas row shape:

```ts
{
  id: 'echo',
  name: 'Echo',
  role: 'qa',
  model: 'claude-sonnet-4-6',
  system_prompt: ECHO_SYSTEM_PROMPT,
  tools_allowlist: ['Read', 'Glob', 'Grep', 'Bash'],
  color: 'from-violet-400 to-purple-600',
}
```

- **No `Edit`/`Write`** → Echo structurally cannot change code. **No `dispatch_agent`** → cannot sub-dispatch (only Sage's runner gets the dispatch MCP server; specialists never do).
- **`Bash`** is included so Echo can run `git diff` and the project's build/lint/test commands — core QA functions. (Operator-approved; Echo still can't edit, and v1 safety = allowlist + worktree isolation + operator diff review.)
- `color` matches the roster's violet accent for `echo`.

## Echo's system prompt (output contract)

`ECHO_SYSTEM_PROMPT` defines a focused critic with a structured verdict. Draft:

```
You are Echo, the QA critic on AXOD's agent team.

Sage dispatches you to review another specialist's work inside this session's
isolated git worktree — usually a change Atlas just made. You do NOT edit code.
You verify.

How you work:
- Start with `git diff` (and `git diff --stat`) to see exactly what changed. Read
  the changed files and enough surrounding code to judge them in context.
- Check the change against the task brief Sage gave you: does it do what was asked,
  correctly and completely?
- Look for: correctness bugs, missed requirements, regressions, broken conventions
  the project actually follows, and anything unsafe.
- When useful and quick, run the project's build/lint/test commands to verify. Report
  what you ran and what happened.

Your output is a verdict, in this exact shape:

  VERDICT: PASS | CONCERNS | FAIL
  - <file:line> · <severity: high|med|low> · <what's wrong> · <why it matters>
  - ... (one line per issue; omit this list entirely if PASS with nothing to note)
  SUMMARY: <2-3 sentences for Sage to relay to the operator>

Rules:
- PASS only if you'd ship it. CONCERNS = works but has issues worth surfacing.
  FAIL = it's wrong, incomplete, or broken.
- Be specific — cite file:line. No vague "looks good" or "could be improved."
- Do NOT rubber-stamp, and do NOT nitpick style the project doesn't enforce.
- If you couldn't verify something (e.g., tests didn't run), say so rather than guessing.
```

## Letting Sage dispatch Echo (`src/lib/dispatch.ts`)

1. Extend the dispatchable set:
   ```ts
   const DISPATCHABLE = ['atlas', 'echo'] as const;
   ```
2. Update the `agent_id` enum description and the tool description so Sage understands Echo is a **reviewer** to dispatch after a change lands (or on operator request), passing the task brief + what changed as `context`.
3. Update `SAGE_SYSTEM_PROMPT` in `scripts/seed.ts`: add Echo to the team list and a one-line cue — after Atlas (or any specialist) makes a change, consider dispatching Echo to review it against the brief before reporting done; always dispatch Echo when the operator asks for a review.

## Permissions (`tool_permissions`) — dormant in v1

Seed rows for consistency (read tools `always`, `Bash` `ask`):
```ts
{ agent_id: 'echo', project_id: 'axod-creative', tool_name: 'read_file', policy: 'always' },
{ agent_id: 'echo', project_id: 'axod-creative', tool_name: 'glob', policy: 'always' },
{ agent_id: 'echo', project_id: 'axod-creative', tool_name: 'grep', policy: 'always' },
{ agent_id: 'echo', project_id: 'axod-creative', tool_name: 'run_command', policy: 'ask' },
```
These feed the **dormant** approval gate (doesn't fire on SDK 0.3.x — Week 3 decision), so at runtime `tools_allowlist` is what actually constrains Echo. The rows are forward-looking for when the gate revives.

## Files touched

- `scripts/seed.ts` — add `ECHO_SYSTEM_PROMPT`, the Echo agent row, Echo `tool_permissions`; extend `SAGE_SYSTEM_PROMPT` to mention Echo. (Seed upserts agents via `onConflictDoUpdate`, so re-running it refreshes Sage's prompt and inserts Echo.)
- `src/lib/dispatch.ts` — `DISPATCHABLE` gains `'echo'`; enum + tool description updated.

No schema migration (agents are seeded, not migrated). No UI changes.

## Out of scope

Automatic post-Atlas review pipeline · Echo editing/fixing code (it only reports) · Echo opening PRs or committing · the other agents (Nova/Forge/Pixel — own cycles) · reviving the approval gate.

## Verification

- `pnpm build` clean; `pnpm test` green (39/39 — no pure-module logic changed; this is config + prompt, like Atlas in Week 3).
- Re-seed: `pnpm seed` upserts Sage's prompt and inserts Echo; the roster shows Echo (violet, Bug icon) with no code change.
- Live end-to-end smoke: operator asks Sage for a small change → Sage dispatches Atlas → Sage dispatches Echo → Echo runs `git diff`, reviews against the brief, returns a `VERDICT:` block → Sage relays it. The dispatch card reads "Echo · via Sage". Confirms the third-agent path works end-to-end.
