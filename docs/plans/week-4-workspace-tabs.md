# Week 4 — Workspace tabs (Preview · Code · Plan · Terminal)

> **Goal:** Turn the right-hand workspace from mostly-mock panels into four live, useful views of what the agents are doing. By Friday: the **Code** tab shows a real Monaco diff (not raw text), the **Preview** tab renders the worktree's running site in a sandboxed iframe, the **Terminal** tab streams real command output, and the **Plan** tab reflects Sage's actual plan — all driven by live session data.
>
> **Where week 3 left the tabs:** Code = live `git diff` rendered as colored raw text (Day-4 work). Plan + Terminal = still seed/mock artifacts. Preview = doesn't exist yet. The SSE plumbing, worktree isolation, and per-agent tool streaming (`tool` events) are all in place to build on.

## Inherited context (read before starting)
- The agent runner already yields `tool` events (name + input) and dispatch streams `dispatch_token` / `dispatch_activity`. Terminal + Plan can subscribe to these rather than inventing new channels.
- Each session has a real worktree (`sessions.worktree_path`, branch `mc/<id>` off `dev`) — Preview and any build/serve must run there, not in the main repo.
- `data/` is git-ignored and excluded from `tsconfig`; anything generated under it won't pollute typecheck/build.
- **AGENTS.md rule:** this Next.js has breaking changes from training data — read `node_modules/next/dist/docs/` for the relevant API before writing route/server code.

---

## Day 1 — Code tab: real Monaco diff
**Goal:** Replace the raw colored-text diff with a proper side-by-side / inline Monaco diff editor, per changed file.

### Tasks
- [ ] Add `@monaco-editor/react` (+ monaco). Confirm it works under Next 16 / React 19 / Turbopack (client component, dynamic import, `ssr: false`).
- [ ] The `/api/sessions/[id]/diff` route already returns `{ base, files, diff }`. Extend it (or add a sibling) to return per-file **original** and **modified** contents so Monaco's `DiffEditor` can show both sides — `git show base:path` for original, read the worktree file for modified.
- [ ] File picker (the `files` list) on the left of the Code tab; Monaco diff on the right. Keep the existing "Refresh" + auto-refresh-after-dispatch behavior.
- [ ] Empty state + binary/large-file guard.

### Day 1 gotchas (predicted)
- Monaco + Turbopack can be fussy about web workers; may need the `loader` config or to pin a CDN. Verify early.
- Don't ship Monaco to the initial bundle — lazy-load only when the Code tab opens.

### Day 1 — what actually happened (2026-05-28): done, operator-verified
- `@monaco-editor/react` added. It loads the editor via its **default CDN loader (jsdelivr)**, which neatly sidesteps the predicted Turbopack web-worker bundling problem — no worker config needed. **Follow-up for week 5:** self-host the editor assets so the deployed app doesn't depend on the CDN (if the CDN is blocked the Code tab shows a perpetual "Loading editor…").
- `worktree.ts` → `diffWorktreeFiles(wtPath, base)`: per-file `original` (`git show base:path`, '' for added) + `modified` (worktree file, '' for deleted), with a binary (NUL-byte via `String.fromCharCode(0)`) and >256KB guard → `skipped`. (Aside: a raw NUL literal in source briefly turned the file "binary"; use `String.fromCharCode(0)`, never a literal NUL.)
- `/api/sessions/[id]/diff` now returns `{ base, files: WorktreeFileDiff[] }` (dropped the raw unified `diff` string — Monaco computes its own from original/modified).
- New `DiffViewer` client component: changed-files picker + lazy `DiffEditor` (`next/dynamic`, `ssr:false`), language inferred from extension, Refresh + auto-refresh-after-dispatch retained, skipped/empty states.
- Verified: tsc + build clean; live test data was `M src/components/Hero.astro`; operator confirmed the side-by-side diff renders.

---

## Day 2 — Preview tab: sandboxed live site
**Goal:** Render the worktree's running site in an iframe so the operator sees Atlas's changes visually.

### Tasks
- [ ] Decide serve strategy: (a) long-running `astro dev` per session worktree (live HMR, heavier), or (b) `astro build` + serve `dist/` on demand (simpler, no HMR). Start with whichever is cheaper to prove; the landing repo is static Astro.
- [ ] A small per-session dev-server manager (spawn/track/teardown by port), or a build-and-serve endpoint. Reuse the worktree path. Never serve the main repo.
- [ ] Preview tab = sandboxed `<iframe>` (`sandbox="allow-scripts allow-same-origin"` minimally) pointed at the session's preview URL/port, with a reload button and a clear "stale / rebuilding" state.
- [ ] Teardown on session end / a manual "stop preview" action (mirrors the deferred worktree cleanup).

### Day 2 gotchas (predicted)
- Port management + lifecycle is the hard part — orphaned dev servers leak. Track PIDs/ports in memory (single-node v1) and kill on teardown.
- CSP / iframe embedding: the previewed site may set headers that block framing. May need to proxy or relax for localhost preview.
- On the VPS (week 5) this needs a port range + reverse-proxy story — note it, don't solve it yet.

---

## Day 3 — Terminal tab: real command output
**Goal:** Stream actual command output (Atlas's `Bash` calls, builds, test runs) into an xterm.js terminal instead of the mock log.

### Tasks
- [ ] Add `@xterm/xterm` (client-only). Render in the Terminal tab.
- [ ] Surface command output: the runner sees `Bash` tool calls — decide whether to stream the tool *result* (stdout/stderr) over SSE as a `terminal` event, or run an operator-initiated command through a dedicated endpoint. Prefer piggybacking on the agent stream first.
- [ ] Append-only, scrollback, autoscroll, ANSI colors (xterm handles ANSI natively).
- [ ] (Stretch) operator-typed read-only command box that runs in the worktree and streams back — gate carefully (no arbitrary shell to the host; restrict to the worktree).

### Day 3 gotchas (predicted)
- We currently emit the `Bash` tool *name/input* (for the STATE line) but not its *output*. Capturing tool results means reading the SDK's tool_result/user messages in the runner — verify the shape before wiring.
- Don't expose an unsandboxed shell. Anything operator-typed must be constrained to the worktree.

---

## Day 4 — Plan tab: Sage's real plan
**Goal:** The Plan tab reflects the actual plan, not the seed markdown.

### Tasks
- [ ] Source of truth: either Sage's `TodoWrite` calls (already streamed as `tool` events) rendered as a live checklist, or a persisted `artifacts` row of type `plan` that Sage updates. Pick the simpler honest one.
- [ ] Render markdown properly (headings, checkboxes) rather than a `<pre>` blob.
- [ ] Empty state when no plan exists yet.

### Day 4 gotchas (predicted)
- `TodoWrite` content is transient per turn; if the Plan tab should persist across turns, store it in `artifacts`.

### Day 4 — what actually happened (2026-05-31): done
- Chose the **`TodoWrite` live-checklist** route (the simpler honest one) over a persisted `artifacts` row — the plan is the agents' real working checklist, streamed over SSE, no new storage.
- Pure parser `src/lib/plan-events.ts` → `toPlanSnapshot(tool, input, agentId)` returning `PlanSnapshot { agentId, todos }` (defensive: coerces unknown/missing status to `pending`, drops empty todos, returns `null` for non-`TodoWrite`/malformed input). Unit-tested in `src/lib/plan-events.test.ts` (mirrors the Day-3 `terminal-events` pair).
- Presentational `src/components/plan-view.tsx` (`PlanView`): status glyphs (○ pending / ◐ in-progress, uses `activeForm` / ✓ completed, struck through), owner label, live `done / total` count, quiet empty placeholder.
- `mission-control.tsx`: ephemeral `plan` state (latest writer wins, persists across turns, not cleared on Stop), fed `toPlanSnapshot` from both the `activity` (Sage) and `dispatch_activity` (specialist) SSE branches; replaced the mock "Dynamic Plan" `<pre>` with `<PlanView snapshot={plan} />`. Removed the now-dead `artifacts` prop consumption (the `'plan'` artifact type + `art_plan` mock row are swept up in Day 5 cleanup).
- Verified: `pnpm build` clean, `pnpm test` green (39/39). Spec: `docs/superpowers/specs/2026-05-31-plan-tab-live-todowrite-design.md`; plan: `docs/superpowers/plans/2026-05-31-plan-tab-live-todowrite.md`.

---

## Day 5 — Wire-up, polish, week-5 prep, push
### Tasks
- [x] Make all four tabs read from live session data; remove remaining `mockArtifacts` reliance in `page.tsx`.
- [x] Tab badges reflect real counts (diff file count already does; do the same for terminal activity / plan items).
- [x] Mobile-responsive check of the workspace tabs (spec criterion #9). **Done 2026-06-01 — see item C below.**
- [x] Update the v1 spec + this plan with what actually happened.
- [ ] Write `docs/plans/week-5-deploy.md` (Docker Compose, Nginx, Let's Encrypt on Hetzner; preview-server port story; secrets). **Deferred — own session (week-5 planning).**
- [ ] Merge to `dev`, then `dev` → `main` as the week-4 release (operator confirms).

### Day 5 — what actually happened (2026-05-31): cleanup + polish slice done
Day 5 was a basket of six loosely-related closeout items, not one feature. This session landed the safe slice (A cleanup, B badges, E docs); the two pieces with their own design/planning weight were deferred to dedicated sessions.
- **A — mock-data cleanup:** `page.tsx` already read team/session/messages/approvals/totals live from the DB; the only mock left was `artifacts={mockArtifacts}`, and after Day 4 `MissionControl` no longer consumed it. Dropped the prop + import, removed `artifacts` from `MissionControlProps`, and reduced `src/lib/mock-data.ts` to a **types-only** module (deleted dead `mockTeam`/`mockSession`/`mockMessages`/`mockArtifacts`; kept the `Agent`/`Message`/`Session`/`Artifact` interfaces, which the UI still imports). The `'plan'`/`'terminal'`/`'code'` artifact *type* union survives; every mock *row* is gone.
- **B — tab badges:** Plan tab shows `done/total` (e.g. `2/5`), Terminal tab shows accumulated line count — both mirroring the existing Code Diff count badge and appearing only when there's something to count. No new state; both derive from existing `plan` / `terminalLines`.
- **E — docs:** this section + the `v1-mvp-spec.md` status note.
- **Deferred (C):** mobile-responsive workspace tabs — the fixed 3-pane desktop layout needs its own mini-design pass.
- **Deferred (D):** `docs/plans/week-5-deploy.md` — its own week-5 planning effort.

### Day 5 — item C done (2026-06-01): mobile-responsive layout
The fixed three-pane layout now collapses to a single tab-switched pane below `md` (768px); desktop is untouched (every change gated behind a `md:`/`sm:` modifier). One new state field `mobileActiveTab` (`team`|`chat`|`workspace`, default `chat`) drives per-pane visibility (`flex` when active, `hidden md:flex` otherwise). A `md:hidden` bottom tab bar (Team/Chat/Workspace) is the sole navigation, each button carrying a live badge from existing state (green pulse = agents working, amber bounce = pending approval, cyan count = changed files); the footer strip becomes `hidden md:flex`. Header chrome (project/branch/cost/token chips, target-dir readout) progressively hides below `sm`/`md`; workspace tab buttons tighten so all four fit a phone. **Swipe gestures were dropped** (operator decision) — an earlier WIP put a touch-swipe handler on `<main>` that conflicted with horizontal scrolling inside Monaco/terminal; the tab bar is unambiguous and conflict-free. Verified: `pnpm build` clean, `pnpm test` green (39/39). Spec: `docs/superpowers/specs/2026-06-01-mobile-responsive-layout-design.md`.
- Verified: `pnpm build` clean, `pnpm test` green (39/39); dev server recompiled clean and served `GET / 200` after each change. Spec: `docs/superpowers/specs/2026-05-31-day5-cleanup-polish-design.md`.

### Day 5 success criteria
- All four workspace tabs show real, live data for the current session: a Monaco diff of Atlas's changes, a working preview of the site, real command output, and Sage's actual plan. Mock artifacts are gone.

## What you've built by Friday of week 4
- A genuinely useful workspace: see the diff, see the running site, see the commands, see the plan — all live. Remaining for v1: VPS deploy + polish (week 5).
