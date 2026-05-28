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

### Day 1 — what actually happened (2026-05-28)

- **Architecture decision: local agent SDK, not Managed Agents.** Invoking the `claude-api` skill surfaced that Anthropic now offers *Managed Agents* (server-hosted agent loop + container) as an alternative to the local `@anthropic-ai/claude-agent-sdk`. Confirmed with the operator and chose the **local SDK** — it matches the v1 spec (local git worktrees on a $5 VPS operating on real local repos, direct Anthropic API). Managed Agents would mount repos into Anthropic's container (or need a self-hosted sandbox worker) and re-architect the whole thing. Revisit Managed Agents only if we ever want Anthropic to host the compute. (No new ADR written — ADR-001 already commits to the local model; this just reaffirms it against a newer option.)
- Pinned `@anthropic-ai/claude-agent-sdk@^0.3.152`.
- **Actual SDK API** (read from `node_modules/@anthropic-ai/claude-agent-sdk/sdk.d.ts`, NOT guessed):
  - `query({ prompt, options })` returns an async iterable of `SDKMessage`.
  - With `options.includePartialMessages: true`, token deltas arrive as `{type:'stream_event', event: <BetaRawMessageStreamEvent>}` — the inner `event` is the same shape as the raw Anthropic streaming API (`content_block_delta` → `delta.text`). So the Day-4 stub's parser logic ported over almost directly.
  - Final summary is `{type:'result', subtype:'success', result, total_cost_usd, usage:{input_tokens, output_tokens}}`.
  - Key `options`: `cwd` (working dir → repo path), `model`, `systemPrompt`, `allowedTools`, `canUseTool` (the permission hook — this is the Day-3 approval-gate primitive), `abortController`.
- `src/lib/agent-runner-sdk.ts` exposes the **same `AgentEvent` AsyncIterable** as the stub, so the SSE route and the client are unchanged except the import. The route now also reads Sage's `model` + `system_prompt` from the DB and passes them through (small pull-forward from Day 2 — harmless and correct).
- **Day-1 safety gate:** `canUseTool` auto-allows read-only tools (`Read`, `Glob`, `Grep`, `WebFetch`, `WebSearch`, `TodoWrite`) and denies everything else with a message. This prevents the headless SDK from hanging on a permission prompt (no TTY) and is safe until Day 3 wires the real DB-backed approval flow.
- **Auth:** the SDK spawns the Claude Code CLI under the hood and inherits its logged-in session (the earlier `apiKeySource: "none"` probe confirmed it's using the CLI login, not an API key). No `ANTHROPIC_API_KEY` needed locally. On the VPS we'll need to configure auth — flag for week 5.
- **Cost note:** the SDK spawn still pays the SessionStart overhead (~$0.15 for a 7-token "ONLINE" reply, similar to the CLI). The SDK's win over the stub is tool-use interception + multi-turn, not per-spawn cost — a long-lived `query` session (passing an `AsyncIterable<SDKUserMessage>` as the prompt) is the lever for amortizing setup tokens; not wired yet.
- Stub kept at `src/lib/agent-runner-stub.ts` as reference (plan said `.bak`; left the real filename since it still typechecks and documents the CLI-parsing approach). Delete at end of week 2.
- Verified end-to-end via curl: prompt "Reply with exactly the word ONLINE..." streamed back `ONLINE`, persisted as `msg_191844887f42c35e` with `cost_usd=0.1485575, token_count_out=7`.

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

### Day 2 — what actually happened (2026-05-28)

- Rewrote Sage's system prompt to match its **actual** v1 capabilities: orchestrator, read-only (Read/Glob/Grep/WebFetch/WebSearch/TodoWrite), grounds every answer in real repo contents, and for code changes *describes* the dispatch to Atlas rather than pretending to edit (Atlas-as-SDK-agent is week 3). Honesty about current limits is baked into the prompt.
- **`tools_allowlist` now uses real Claude Code tool names** (was fictional `dispatch_to_atlas` etc.). Sage = read-only set; Atlas = `Read/Glob/Grep/Edit/Write/Bash/WebFetch` (staged for week 3).
- **Seed now upserts agents** (`onConflictDoUpdate` on `id`) instead of `onConflictDoNothing`, so re-running `pnpm seed` refreshes prompts/allowlists without a manual DB wipe. The plan flagged that prompts get refined over the build — this makes that cheap.
- Runner takes `allowedTools` and drives both the SDK `allowedTools` option (auto-run) and the `canUseTool` gate from it; the route passes `sage.tools_allowlist`. Allowlist is fully DB-driven now.
- **Allowlist semantics answered:** tools in `allowedTools` auto-execute and never hit `canUseTool`. `canUseTool` is only called for tools *outside* the allowlist — so the gate is the right place for Day-3 approvals. Disallowed tools are denied via the callback (not a silent drop), and the SDK surfaces the deny message to the model, which adapts.
- **Verified Sage genuinely uses tools.** Prompt: "List the top-level config files in this repo… use your tools, don't guess." Sage's streamed narration shows it calling `Glob` (twice — it noticed the first listing was polluted by `node_modules` and re-scoped to the repo root), then `Read` on the key configs, then answered: package.json / astro.config.mjs / tsconfig.json (extends `astro/tsconfigs/strict`) / pnpm files, and correctly identified **Astro v6 + pnpm + TypeScript strict + Cloudflare/wrangler**. Every detail came off disk, not training data. Cost $0.227, 1171 output tokens.
- **Observation for Day 5 polish:** the agent's between-tool "thinking out loud" text is interleaved into the final message content (the SDK streams all assistant text blocks). It reads as nice transparency but we may want to separate interim narration from the final answer later. Not blocking.

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

### Day 3 — what actually happened (2026-05-28): BLOCKED by upstream, gate deferred

**The whole day's mechanism is blocked by a CLI/SDK bug. We built the infra, proved we can't enforce it yet, and deferred the live gate to week 3. Decision made with the operator.**

**What got built (and works / is sound):**
- `src/lib/permissions.ts` — `getPolicy(agent, project, tool)` (defaults to `ask`), `setAlwaysAllow`, `createPendingApproval`, `decideApproval`, `waitForDecision` (polls the row, 5-min timeout → deny).
- `POST /api/approvals/[id]/decision` — zod-validated `{decision: approved|denied|always}`, auth-gated, updates the row.
- `mission-control.tsx` — real approval card with Approve / Always allow / Deny, posts the decision; SSE handlers for `approval_requested` / `approval_resolved`.
- The intended wiring: a `checkPermission` in the stream route that consults policy → `always` allow, `deny` block, `ask` create pending approval + emit SSE + block on `waitForDecision`, with `always` persisting a `tool_permissions` row.

**Why it can't be enforced (root cause, 7 isolated probes):**
- The gate depends on the SDK's `canUseTool` callback. With `@anthropic-ai/claude-agent-sdk@0.3.152` spawning the globally-installed `claude` CLI `2.1.150`, **`canUseTool` is never invoked.** The CLI emits the `tool_use` block, then waits forever for a `can_use_tool` control message it never sends. The stream hangs.
- Ruled out, all still 0 calls: string vs streaming (`AsyncIterable`) input; `tools` restriction on/off; `canUseTool` returning allow vs deny; keeping stdin open in streaming mode; scrubbing the nested-Claude-Code env vars (`CLAUDECODE=1`, `CLAUDE_CODE_*`). `permissionMode: 'dontAsk'` (docs: "deny if not pre-approved") **also hangs** instead of cleanly auto-denying.
- The SDK passes `--permission-prompt-tool stdio` when `canUseTool` is set, but CLI 2.1.150 never drives that control request back. It's a version-pair protocol gap, not our code. Read-only tools (Read/Glob/Grep) are unaffected because the CLI auto-allows them in `default` mode without ever consulting the callback.

**Decision (operator, 2026-05-28): defer the interactive gate; ship read-only.**
- The live runner now uses `allowedTools` = the agent's `tools_allowlist` as BOTH capability and auto-run set (no `canUseTool`, no permission round-trip → no hang). Agents can only use their allowlisted tools, and those run without a per-call gate. Dangerous tools are simply absent from any v1 agent's allowlist (Sage is read-only).
- The permission infra above stays **dormant** in the repo, ready to wire to `canUseTool` the moment the gate works.
- Verified read-only still streams cleanly post-revert: "version field in package.json?" → "0.0.1", no hang, $0.21.

**To revisit in week 3** (when Atlas + write tools need real gating):
- Re-test `canUseTool` against the then-current CLI/SDK; pin a known-good pair if needed.
- If still broken, evaluate: `PreToolUse` hooks (may share the same control-channel fate — probe first), or a static pre-authorization model (`allowedTools` for `always`, `disallowedTools` for the rest — safe but no inline card), or running the agent outside the nested Claude Code env.
- Whichever works, the dormant `permissions.ts` + decision route + card UI plug straight in.

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

### Day 4 — what actually happened (2026-05-28): helper built + verified; live wiring deferred

**The Day-4 trigger ("create the worktree on first *write*-tool approval") depends on write tools, which are deferred with the Day-3 gate. So worktree isolation has no functional trigger in read-only v1** — a pure-read session has nothing to isolate. Rather than wire speculative, repo-mutating machinery into the working read path (or skip the day), I built the helper and **de-risked the plan's #1 flagged risk** cheaply.

**Built — `src/lib/worktree.ts`:**
- `ensureWorktree(sessionId, repoPath, baseBranch='dev')` → idempotent; creates `<WORKTREE_ROOT>/<sessionId>` checked out to a session branch `mc/<sessionId>` forked from `baseBranch` (reattaches if the branch already exists).
- `removeWorktree(sessionId, repoPath)` → idempotent; `worktree remove --force` (leaves the branch — may hold unpushed work — and prunes if already gone).
- `listWorktrees(repoPath)`; `worktreeRoot()` honors `WORKTREE_ROOT` env, defaults to `data/worktrees` (gitignored).
- Uses `execFile` with an **argv array (no shell)**, so apostrophes in paths are literal — no escaping needed.

**Windows/apostrophe risk: RESOLVED.** `scripts/verify-worktree.mjs` runs the real helper against a throwaway repo whose temp path contains an apostrophe (`...\Temp\mc-wt'test-XXXX`). All checks pass: worktree created, correct session branch checked out, files present, `listWorktrees` sees it, idempotent re-call, clean removal. No agent cost, no mutation of the AXOD landing repo. The `execFile`-argv approach is why it just works — the apostrophe never reaches a shell. (Re-run this on the Linux VPS in week 5 to confirm there too.)

**Deferred to week 3 (alongside writes):** wiring `ensureWorktree` into the live flow, populating `sessions.worktree_path`, passing the worktree as the agent cwd, and the completed/errored cleanup hook. None of it is meaningful until an agent actually writes — and creating a worktree (which forks a branch in the operator's real landing repo) is a repo-mutating action best introduced exactly when write isolation is needed, not before. The helper is ready to call.

**Landing repo state (checked, informational):** real git repo, on `dev`, ~12 branches, no stray worktrees — so a `dev`-based worktree will work when we wire it.

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

### Day 5 — what actually happened (2026-05-28)

- **Deleted the CLI stub** (`src/lib/agent-runner-stub.ts`) — fully superseded by `agent-runner-sdk.ts`; nothing in source imported it (only historical doc mentions remain).
- **Cost meter already sums the session** — `page.tsx` computes `SUM(cost_usd)` / `SUM(token_count_*)` across all messages in the session (done in week-2 Day 2). No change needed; verified.
- **Tightened runner error handling** — surface assistant-level errors (`auth_failed`/`rate_limit`/`billing_error`/...) and `result` error subtypes with their `errors[]` detail; treat `AbortError` as a clean stop (not a failure).
- **Stop button + real server-side abort** — wired `req.signal` (fires on client disconnect) into the runner's `AbortController`. The composer shows a **Stop** button while streaming; clicking it closes the `EventSource`, which disconnects the request and aborts the SDK stream server-side (so it stops spending tokens, not just hides output). More valuable in week 3 when Atlas runs are long/agentic.
- **Wrote [week-3 plan](week-3-team-of-agents.md)** — deliberately front-loads the two deferrals: Day 1 = make the approval gate fire (re-test `canUseTool` / pin versions / fallbacks), Day 2 = wire worktrees live, Day 3 = Atlas + `dispatch_agent`, Day 4 = gates on Atlas's writes. Week 3 is the forcing function for everything deferred this week.
- Regression smoke after all the above: read-only prompt still streams + persists cleanly.

### Honest week-2 scorecard

| Day | Planned | Status |
|---|---|---|
| 1 | Swap CLI stub → claude-agent-sdk | ✅ done |
| 2 | Sage: real system prompt + tools, reads the repo | ✅ done |
| 3 | Interactive approval gate | ⚠️ infra built, **enforcement blocked** by canUseTool bug → deferred to week 3 |
| 4 | Git worktree per session | ⚠️ helper built + Windows-risk resolved, **live wiring deferred** to week 3 (needs writes) |
| 5 | Polish + week-3 plan + push | ✅ done |

What works end-to-end today: a logged-in operator chats with **Sage**, a real Opus-4.7 SDK agent that reads the actual target repo (Read/Glob/Grep), streams token-by-token over SSE, persists messages + cost, and can be stopped mid-generation. What's built-but-dormant: the full approval-gate stack and the worktree manager — both waiting on week-3's resolution of the `canUseTool` blocker.

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
