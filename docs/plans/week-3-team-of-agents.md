# Week 3 — Sage + team-of-agents (Atlas as first specialist)

> **Goal:** Turn the single read-only Sage into a real orchestrator that dispatches **Atlas** (developer) to make actual code changes — in an isolated git worktree, behind a working approval gate. By Friday: type a request → Sage plans → dispatches Atlas → Atlas edits in a worktree → each risky tool call gates for operator approval → the diff shows up. This is the v1 spec's core loop.
>
> **This week is the forcing function for the two things week 2 deferred.** Days 1–2 are explicitly about un-deferring them, because Atlas-writes-code is impossible without both. If Day 1 (the gate) can't be solved, the whole week is blocked — so it goes first.

## Inherited blockers (must resolve early — see week-2 Day 3/4 notes)

1. **Approval gate is built but dormant.** `canUseTool` is never invoked by `claude` CLI 2.1.150 under `@anthropic-ai/claude-agent-sdk` 0.3.152 — gated tools hang. The infra (`src/lib/permissions.ts`, `POST /api/approvals/[id]/decision`, approval card + SSE handlers in `mission-control.tsx`) is ready to wire to whatever mechanism works.
2. **Worktree helper is built but not wired.** `src/lib/worktree.ts` (`ensureWorktree`/`removeWorktree`/`listWorktrees`) is verified on Windows incl. the apostrophe path. Not yet called from the live flow.

---

## Day 1 — Make the approval gate actually fire (unblock)

**Goal:** A gated tool call pauses, surfaces the (already-built) approval card, and resumes on the operator's decision. Without this, Atlas can't safely write — so nothing else this week proceeds.

### Tasks
- [ ] Re-run the week-2 probe (`canUseTool` + a Bash prompt) against the **currently-installed** CLI/SDK. Versions move fast; it may already be fixed.
- [ ] If still broken, work the fallbacks in order, cheapest first:
  1. **Pin a known-good CLI/SDK pair.** Find a version combo where `canUseTool` fires; pin both in `package.json` / document the CLI version.
  2. **`PreToolUse` hook** (`options.hooks`). Probe whether hooks fire where `canUseTool` doesn't — they may share the control channel, so test before investing.
  3. **Spawn outside the nested Claude Code env.** We're running inside Claude Code; the spawned CLI inherits `CLAUDECODE=1` etc. Scrubbing those env vars didn't help in week 2, but a real (non-nested) deploy might behave differently — worth one check on the VPS.
  4. **Static pre-authorization fallback** (last resort): `allowedTools` = `always` tools, `disallowedTools` = the rest. Safe, no inline card. Ship this if nothing else works and revisit.
- [ ] Once a mechanism fires: wire the dormant `checkPermission` flow (policy lookup → `always` allow / `deny` block / `ask` → pending approval + SSE + `waitForDecision`, persisting `always`) into the runner via that mechanism.
- [ ] End-to-end test with Sage + a temporarily-granted write tool: gate fires → card → approve → tool runs → `always` persists → second call auto-runs.

### Day 1 gotchas (predicted)
- If only the static fallback works, the product loses the inline approval card for v1. Flag to the operator — it's a real UX downgrade and may warrant a different SDK approach.

### Day 1 — what actually happened (2026-05-28): hang FIXED, inline gate not achievable → static model adopted

**Root cause of the week-2 hang found and fixed.** SDK 0.3.152's executable resolution fell back to the **mismatched global `claude` CLI 2.1.150** under pnpm's symlink layout; that SDK/CLI pair never completes the permission control handshake, so any tool needing a decision hung the stream. **Upgrading to SDK 0.3.153** (`93d05c4`) fixes it — its default resolution uses the **bundled** CLI (2.1.153), and a Bash prompt that hung on 0.3.152 now runs cleanly.

**But the inline `canUseTool` gate is still not achievable on this SDK.** Across 4 targeted probes (down from week-2's 7), `canUseTool` fired **0 times** regardless of: CLI version (global 2.1.150 / bundled 2.1.152 / bundled 2.1.153), input mode (string → tools auto-run; streaming → hangs), `settingSources: []` (no inherited `~/.claude` rules), and `permissionMode: default`. Conclusion: on SDK 0.3.x (Windows), string-input mode auto-runs tools (bypassing `canUseTool`) and streaming-input mode hangs the control round-trip. The per-call approval card can't be built on it right now.

**Decision (operator, 2026-05-28): accept the static safety model for v1.** No inline approval card. v1 safety = (a) **per-agent capability allowlist** — each agent can only use its `tools_allowlist` (already enforced in `agent-runner-sdk.ts` via `tools` + `allowedTools`; un-listed tools are unavailable), (b) **worktree isolation** (Day 2 — Atlas edits a throwaway `mc/<session>` branch, never `dev`), and (c) **operator review of the resulting diff/PR before merge**. The dormant inline-card infra (`permissions.ts`, decision route, card UI) stays in the repo; revisit if a future SDK fixes the streaming control protocol.

**Net for the rest of week 3:** Days 3–4 change — Atlas's write tools run within its allowlist + worktree rather than gating per call. Day 4 becomes "review Atlas's diff," not "approve each write." The headline loop (Sage → dispatch Atlas → real edits in isolation → operator reviews diff) is intact; only the per-call popup is gone.

---

## Day 2 — Wire worktrees into the live flow

**Goal:** A session that's about to do write work runs in its own worktree, not the main repo. The helper exists; this is wiring + lifecycle.

### Tasks
- [ ] `ensureWorktree(sessionId, project.repo_path, project.default_branch)` when a session first needs to write (or on session activation). Store the path in `sessions.worktree_path`.
- [ ] Pass the worktree path as the agent's `workingDir` (cwd) instead of `repo_path`.
- [ ] Cleanup: on `sessions.status` → `completed`/`errored`, optionally `removeWorktree` (v1: keep for inspection; add a manual "clean up session" action).
- [ ] Confirm on the operator's real landing repo (first real mutation — confirm with operator before the first run). Verify the worktree is on branch `mc/<sessionId>` off `dev`, and edits land there, not on `dev`.

### Day 2 gotchas (predicted)
- First time this mutates the operator's real repo (forks a branch). Get explicit go-ahead.
- `data/worktrees` default root is fine locally; on the VPS set `WORKTREE_ROOT=/srv/worktrees`.

### Day 2 — what actually happened (2026-05-28): wired + verified live

- The stream route now calls `ensureWorktree(sessionId, project.repo_path, project.default_branch)` before running the agent, persists `sessions.worktree_path`, and passes the worktree as the agent's `workingDir` (falls back to the main repo + emits a `worktree_error` SSE event if creation fails). New SSE event `worktree` carries `{path, branch}`.
- **Verified live on the real landing repo** (operator go-ahead given): `git -C landing worktree list` shows `…/data/worktrees/sess_a4f9 [mc/sess_a4f9]` forked off `dev`; the dir is a real Astro checkout (`astro.config.mjs` present). Definitive cwd proof — asked Sage to read `package.json name` from its cwd → returned `"landing"` (the worktree), not `"axod-mission-control"`. So the agent genuinely operates inside the isolated worktree.
- Idempotent: re-streaming reuses the same worktree (no duplicate adds).
- **Deferred:** auto-cleanup on session completion — there's no session-complete trigger in v1 yet; worktrees are kept for inspection (plan's stated v1 choice). Add a manual "clean up session" action later.
- **Observation (prompt-tuning, not Day 2):** when asked "what kind of project is this repo?" Sage answered "AXOD Mission Control" from its system-prompt *identity* instead of reading the cwd. Sage's prompt says "never guess — look"; tighten it (or have it always read before describing a repo) when refining prompts. The worktree wiring is correct regardless.

---

## Day 3 — Atlas as a real SDK agent + `dispatch_agent`

**Goal:** Sage can hand a concrete task to Atlas. Atlas runs as its own SDK `query` (Sonnet 4.6, write toolset) in the session's worktree and reports back through Sage.

### Tasks
- [ ] Give Sage a custom `dispatch_agent` tool (SDK custom tool / MCP) with `{agent_id, task, context}` (enum-restricted agent_id — see team-of-agents doc).
- [ ] Server intercepts the dispatch: persist a dispatch message, spawn Atlas via `runClaudeAgent` with Atlas's model + system prompt + `tools_allowlist` (Read/Glob/Grep/Edit/Write/Bash) in the same worktree.
- [ ] Feed Atlas's final summary back to Sage as the tool result; Sage continues.
- [ ] UI: dispatch card inline in Sage's message ("Atlas → working on X"); Atlas's reply attributed "Atlas · via Sage" (the mockup already has these).

### Day 3 gotchas (predicted)
- Per the SDK, subagent text only surfaces with `forwardSubagentText: true` (or run Atlas as a separate top-level `query` and relay manually — simpler, more control).
- Cost: two agents per turn. Watch the per-turn spend; consider Atlas at lower `effort`.

### Day 3 — what actually happened (2026-05-28): loop works end-to-end, live-verified

**Mechanism chosen:** in-process MCP tool, not `forwardSubagentText`. Sage gets a custom `dispatch_agent({agent_id, task, context})` tool via `createSdkMcpServer` (`src/lib/dispatch.ts`), passed through `runClaudeAgent`'s new `mcpServers` option and auto-run via the new `extraAllowedTools` (the tool is named `mcp__mission_control__dispatch_agent`). The handler loads the specialist from the DB and runs **Atlas as a nested `runClaudeAgent`** in the *same worktree*, streaming its output to the operator through an `emit` closure and returning Atlas's final summary to Sage as the tool result. `agent_id` is enum-restricted to `atlas`; the dispatched agent gets no dispatch tool (no recursion). Chosen over `forwardSubagentText` for control over streaming + attribution + per-agent persistence.

**Runner changes (`agent-runner-sdk.ts`):** added `mcpServers`, `extraAllowedTools`, and `extraEnv`. `tools` stays the built-in capability set; `allowedTools` = built-ins + MCP tool names (auto-run, no permission round-trip). `tool({alwaysLoad})` / server `alwaysLoad: true` so Sage always sees the tool (not deferred behind tool search).

**Critical gotcha (not predicted): the SDK MCP stream-close timeout.** `createSdkMcpServer`'s docstring warns that MCP calls running >60s need `CLAUDE_CODE_STREAM_CLOSE_TIMEOUT` raised — and Atlas doing real work *always* exceeds 60s. Set `extraEnv: { CLAUDE_CODE_STREAM_CLOSE_TIMEOUT: '600000' }` (10 min) on Sage's query in the stream route. Without this the dispatch would have been killed mid-run.

**UI:** the mockup's `dispatch` + `attribution` fields on `Message` were already there. Wired SSE events `dispatch_start` (Sage gets a dispatch card + a fresh "Atlas · via Sage" bubble opens), `dispatch_token` (streams into it), `dispatch_done`/`dispatch_error` (finalize). Dispatch card now reflects working/done/failed + the real agent's color/avatar/role.

**Prompt/seed:** rewrote Sage's system prompt — it no longer says "you cannot edit," it *has* `dispatch_agent` and is told to dispatch Atlas for real changes. Re-seeded.

**Live verification (operator drove the browser, go-ahead given):** request "have Atlas add a short comment block at the top of the homepage explaining the layout." Sage read `src/pages/index.astro`, dispatched Atlas; the "Atlas · via Sage" bubble streamed Atlas reading the file, inserting a 9-line comment block, and running `astro check` (exit 0); Sage resumed with a summary and correctly flagged the change was worktree-only. **Confirmed by git:** worktree on branch `mc/sess_a4f9` (off `dev`), `src/pages/index.astro` modified there, `dev` untouched.

**Known v1 warts (not blocking):**
- *Reload ordering:* Atlas's message persists mid-turn while Sage's full message (pre+post-dispatch text concatenated) persists at turn end; on reload, `created_at` ordering can put the Atlas bubble slightly out of place. Live streaming order is correct. Fix later (e.g. timestamp Sage's bubble at turn start, or split Sage's pre/post-dispatch messages).
- *Seed demo dispatch card* (`msg_2`) is hardcoded `status: 'working'` so it renders "Running" forever in the demo history — cosmetic, seed-only.
- *Stray `400 thinking/redacted_thinking blocks cannot be modified`* seen once on an unrelated read turn during earlier testing — not dispatch-related; watch for recurrence.

**Tooling hygiene:** excluded `data/` from `tsconfig.json` so the Day-2 worktree checkout (a full Astro repo) stops polluting `tsc`. Build's Turbopack NFT "whole project traced" warning (from `worktree.ts` dynamic fs paths) is pre-existing and non-fatal.

**Day 4 reminder:** per the Day-1 decision, Day 4 is "review Atlas's diff," not per-call approval gates. Atlas already edits within its allowlist + worktree; surfacing the diff in the Code tab is the remaining piece.

---

## Day 4 — Approval gates on Atlas's writes (the real safety loop)

**Goal:** Now that Atlas actually edits/runs commands and the gate fires (Day 1), every Edit/Write/Bash from Atlas hits the approval flow unless the operator set `always`.

### Tasks
- [ ] Seed/confirm `tool_permissions`: Atlas read tools `always`; Edit/Write/Bash/git `ask`.
- [ ] Full-loop test on the landing repo in a worktree: "add a marching-ants border to the testimonial cards" → Sage plans → dispatches Atlas → Atlas proposes an Edit → **gate fires** → operator approves → edit lands in the worktree → diff visible.
- [ ] Surface the diff (even as raw text in the Code tab) so the operator sees what changed.

### Day 4 gotchas (predicted)
- Multiple gated calls in one Atlas run = multiple cards. "Always allow" per tool keeps it sane.

### Day 4 — what actually happened (2026-05-28): reshaped to diff review (no inline gate)

Per the Day-1 decision, Day 4 is **"review Atlas's diff,"** not per-call approval. There is no approval gate to seed/confirm — `tool_permissions` rows stay dormant. Instead the operator sees exactly what the dispatched agent changed, on demand.

**What shipped:**
- `diffWorktree(wtPath, baseBranch)` in `worktree.ts` — runs `git -C <wt> diff <base> --` (working tree vs the fork point, so it captures both committed-on-`mc/<id>` and uncommitted edits) plus `git diff --name-status` for the file list. Returns `{ diff, files: [{status, path}] }`; empty (not error) when the worktree is missing. No `server-only` guard → tsx-testable.
- `GET /api/sessions/[id]/diff` — auth-gated; resolves `session.worktree_path` + `project.default_branch`, returns `{ base, files, diff }`.
- Code Diff tab is now live: fetches the diff on tab-open, after every `dispatch_done`, and on `persisted`; manual **Refresh** button; dynamic file-count badge + changed-files header (status-colored); unified-diff rendering reusing the existing `+`/`-` line coloring (added `@@`/`diff --git`/`---`/`+++` cases); empty state when there are no changes. Dropped the hardcoded `Testimonials.astro` mock.

**Verified:** `diffWorktree('./data/worktrees/sess_a4f9', 'dev')` returns `files: [{status:'M', path:'src/pages/index.astro'}]` and the correct unified diff of Atlas's Day-3 comment edit. `tsc` + production build clean; the `/api/sessions/[id]/diff` route registers. Browser check of the Code Diff tab pending operator drive.

**Base-diff caveat:** the diff is working-tree-vs-`dev`-tip. `dev` is assumed static during a session; if `dev` advances mid-session the diff would also reflect that drift. Fine for v1; revisit with merge-base if it bites.

---

## Day 5 — Team roster UI, polish, week-4 prep, push

### Pulled forward (2026-05-28): live left-pane agent state + activity
Operator flagged during Day-4 testing that the left pane showed frozen seed text, not what Atlas was actually doing. Done early:
- `runClaudeAgent` now yields a `tool` event for each tool the agent invokes (extracted from `tool_use` blocks on the SDK `assistant` message — complete name + input).
- Dispatch forwards these as `dispatch_activity` SSE; Sage's own tools surface as `activity` SSE from the stream route.
- UI drives the roster from live SSE, not seed `status`/`currentTask`: `workingAgents` + `agentActivity` state, a `friendlyActivity(tool, input)` mapper (Read→"Reading X", Edit/Write→"Editing X", Bash→"Running: …", Grep→"Searching for …", dispatch_agent→"Dispatching …", etc.). Sage STATE box and Atlas's roster card now show the current action live; cleared on persist/stop/error. Seed placeholders no longer shown when idle.
- Verified: `tsc` + build clean; dev server serving, diff endpoint returning 200s. Browser confirmation of the live activity ticking pending operator drive.

### Tasks
- [x] Left pane reflects real agent state (Sage orchestrating / Atlas working) from live session data, not seed placeholders.
- [ ] `@Atlas` direct addressing (optional; bypasses Sage for tight iterations — see team-of-agents doc).
- [ ] Update v1 spec + this plan with what actually happened.
- [ ] Write `docs/plans/week-4-workspace-tabs.md` (Preview iframe, Monaco diff, xterm terminal).
- [ ] Push.

### Day 5 success criteria
- Operator issues one request; Sage plans, dispatches Atlas; Atlas edits real files in an isolated worktree; risky writes gate for approval; the diff is visible. The v1 core loop works end-to-end with two agents.

## What you've built by Friday of week 3
- A working orchestrator (Sage) + specialist (Atlas) with real code edits, worktree isolation, and an enforced approval gate. The headline v1 loop. Remaining for v1: workspace tabs (week 4), VPS deploy + polish (week 5).
