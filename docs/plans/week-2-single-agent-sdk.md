# Week 2 — Single agent via Claude Agent SDK

> **Goal:** Replace the CLI subprocess stub from week 1 with the real `@anthropic-ai/claude-agent-sdk`, gate every tool call through an approval prompt, and isolate each session in its own git worktree. By Friday evening, Sage should be a real agent (not a CLI shell) that can read files, propose edits, and only execute them when the operator approves.
>
> Five working days. Each day has a single deliverable. If a day slips, cut scope on the NEXT day to keep the rhythm.

## Why the stub has to go

Week 1's `src/lib/agent-runner-stub.ts` works but has three load-bearing problems:

1. **Cost** — every spawn re-bills the SessionStart hooks (~22k cache-creation tokens, ~$0.14 cold, ~$0.05 steady-state). A long-lived SDK session amortizes that across all turns.
2. **Tool use is opaque** — the CLI returns text. We can't intercept `Bash`/`Edit`/`Write` tool calls before they happen. The whole approval-gate story in the spec is impossible from the CLI side.
3. **No multi-turn** — every prompt is a fresh process with no memory of previous turns in the same session. That's not what Sage needs to be.

The SDK fixes all three.

## Pre-week setup (do this Sunday or before day 1)

- [ ] Re-read the [v1 spec § Architecture](../specs/v1-mvp-spec.md) section and [team-of-agents](../architecture/team-of-agents.md) doc
- [ ] Find the latest published version of `@anthropic-ai/claude-agent-sdk` on npm and pin it
- [ ] Read the SDK's `permission_callback` / hooks docs end-to-end — that's the approval-gate primitive we'll be building on
- [ ] Confirm `git worktree add` works on Windows for the AXOD CREATIVE repo (`git worktree add ../wt-test feature/dummy && git worktree remove ../wt-test`)

---

## Day 1 — Install the SDK, replace the runner stub

**Goal:** `src/lib/agent-runner-sdk.ts` exists and replaces the stub. Same SSE wire schema as week 1 (so the client doesn't change), but tokens now come from the SDK's stream API and the session is held open across turns within a single HTTP request lifetime.

### Tasks

- [ ] `pnpm add @anthropic-ai/claude-agent-sdk` — pin to a specific version
- [ ] Read the SDK quickstart; identify the lowest-level streaming API (the "query"-style call we'll wrap)
- [ ] Write `src/lib/agent-runner-sdk.ts` that exposes the same `AsyncIterable<AgentEvent>` interface as the stub
- [ ] Update `src/app/api/sessions/[id]/stream/route.ts` to import the SDK runner instead of the stub
- [ ] Keep the stub as `src/lib/agent-runner-stub.ts.bak` for one week as a reference; delete after week 2 ships
- [ ] Re-verify the existing end-to-end test (curl SSE → READY response, persists in DB)

### Day 1 gotchas (predicted)

- SDK on Windows may have different child-process behavior than the CLI — test early
- Authentication: the SDK reads `ANTHROPIC_API_KEY` from env; make sure `.env` is loaded in the Next.js Node runtime (it should be by default)
- The `result` event's token/cost shape may differ from the CLI's — re-map in the wrapper

---

## Day 2 — Tool definitions + system prompt for Sage

**Goal:** Sage has a real system prompt (from `agents.system_prompt` in the DB) and a defined toolset. Operator can ask Sage to "list the files in `src/`" and Sage uses the `Read`/`Glob` tools to actually do it (instead of guessing from training data).

### Tasks

- [ ] Update Sage's system prompt in the seed (`scripts/seed.ts`) — make it explicit about being the orchestrator, about asking before destructive actions, about delegating to Atlas (even though Atlas isn't an SDK agent yet; Sage just narrates the dispatch in v1)
- [ ] Wire the SDK runner to pass Sage's `system_prompt` from the DB
- [ ] Decide v1 tool allowlist for Sage (likely: `Read`, `Glob`, `Grep`, `WebFetch`, `Bash` with a tight whitelist)
- [ ] Use the SDK's `allowed_tools` parameter to enforce the allowlist
- [ ] Test: "list files in src/components" — Sage should call `Glob`, get the answer, summarize

### Day 2 gotchas (predicted)

- Tool allowlist semantics: does the SDK reject disallowed tools silently or surface an error? Test before relying.

---

## Day 3 — Approval gates (the big one)

**Goal:** Any tool call from Sage that's not in the "always allow" list (per `tool_permissions` table) pauses the stream, surfaces an approval card to the operator, and resumes only when the operator decides. This is the core safety feature.

### Tasks

- [ ] Read the SDK's permission-callback / hooks API end-to-end
- [ ] Implement a permission callback that:
  1. Reads `tool_permissions` for (agent, project, tool)
  2. If `policy='always'` → approve immediately
  3. If `policy='deny'` → reject immediately
  4. If `policy='ask'` (or no row) → insert a row into `approvals` with `status='pending'`, emit an SSE `approval_requested` event, and **block** until that row's status changes
- [ ] `POST /api/approvals/:id/decision` route handler: accepts `{ decision: 'approved'|'denied'|'always' }`, updates the `approvals` row, optionally writes a `tool_permissions` row for "always"
- [ ] Client side: when an `approval_requested` event arrives, render the existing approval card UI from the mockup (`mission-control.tsx` already has the design); on approve/deny, POST to the decision endpoint
- [ ] Use SQLite triggers / polling / pub-sub to wake the permission callback when the row updates — the simplest thing that works for v1 is polling every 200ms inside the callback

### Day 3 gotchas (predicted)

- The permission callback must be `async` and may block for a long time (operator might be away from keyboard). The SDK better not have a hard timeout on it.
- If the operator never decides, what happens? Either timeout-and-deny after 5 min, or leave the stream open forever (the operator can come back; but a single dangling stream holds resources). v1: 5 min auto-deny.

---

## Day 4 — Git worktree per session

**Goal:** When a session is created (or first uses a write tool), spawn a `git worktree add /srv/worktrees/<session_id> <branch>` so each session works in its own checkout. Sage's `Bash`/`Edit` tools operate inside that worktree, not the main repo.

### Tasks

- [ ] Add a `worktreeManager` helper in `src/lib/worktree.ts`:
  - `ensureWorktree(sessionId, repoPath, baseBranch)` → creates if missing, returns path
  - `removeWorktree(sessionId)` → cleanup
- [ ] On first write-tool approval in a session, ensure the worktree exists (lazy creation; sessions that are pure-read never get one)
- [ ] Update the SDK runner to pass the worktree path as the agent's working directory
- [ ] Update `sessions.worktree_path` in the DB
- [ ] Cleanup hook: when `sessions.status` transitions to `completed` or `errored`, remove the worktree (or keep it for inspection? — v1: keep for inspection, manual cleanup)
- [ ] Test: ask Sage to read a file in the AXOD CREATIVE repo, then propose an edit — the edit happens in the worktree, not the main repo

### Day 4 gotchas (predicted)

- Worktree paths on Windows: forward vs backslash issues with `git worktree`
- The Windows path with apostrophe (`A'KeemDrew`) might break `git worktree add` — test early; fall back to a non-apostrophe parent dir if needed

---

## Day 5 — Polish, week 3 prep, commit

**Goal:** Smooth the rough edges, write week 3 plan, push.

### Tasks

- [ ] Delete the now-unused stub backup
- [ ] Tighten error handling in the SDK runner (network blips, rate limits, API errors)
- [ ] Update top-bar cost meter to sum across all messages in the session (not just the latest)
- [ ] Add a "stop generating" button that aborts the SDK stream
- [ ] Update the [Week 1 plan](week-1-walking-skeleton.md) and [v1 spec](../specs/v1-mvp-spec.md) with anything that's now wrong
- [ ] Write `docs/plans/week-3-team-of-agents.md` — that's where Atlas as a separate sub-agent is introduced and Sage starts using a `dispatch_to_atlas` tool
- [ ] Push to GitHub

### Day 5 success criteria

- Operator can have a multi-turn conversation with Sage
- Every tool call either runs immediately (allowed), is rejected (denied), or shows an approval card (ask)
- "Always allow" decisions persist as `tool_permissions` rows and are honored on subsequent runs
- Each session has its own worktree
- Cost meter reflects real spend
- Week 3 plan exists

## What you've built by Friday evening of week 2

A working single-agent system with:
- Sage as a real SDK-backed agent (not a CLI shell)
- Multi-turn conversations (state held across turns)
- Approval gates on tool calls with three policy levels
- Per-session git worktree isolation
- Real cost tracking

What you have NOT built (week 3+):
- Atlas as a separate agent
- Multi-agent dispatch
- Workspace tabs beyond the static placeholders
- Nova / Echo / Pixel / Forge
- VPS deploy
