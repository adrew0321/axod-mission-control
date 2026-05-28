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

---

## Day 5 — Wire-up, polish, week-5 prep, push
### Tasks
- [ ] Make all four tabs read from live session data; remove remaining `mockArtifacts` reliance in `page.tsx`.
- [ ] Tab badges reflect real counts (diff file count already does; do the same for terminal activity / plan items).
- [ ] Mobile-responsive check of the workspace tabs (spec criterion #9).
- [ ] Update the v1 spec + this plan with what actually happened.
- [ ] Write `docs/plans/week-5-deploy.md` (Docker Compose, Nginx, Let's Encrypt on Hetzner; preview-server port story; secrets).
- [ ] Merge to `dev`, then `dev` → `main` as the week-4 release (operator confirms).

### Day 5 success criteria
- All four workspace tabs show real, live data for the current session: a Monaco diff of Atlas's changes, a working preview of the site, real command output, and Sage's actual plan. Mock artifacts are gone.

## What you've built by Friday of week 4
- A genuinely useful workspace: see the diff, see the running site, see the commands, see the plan — all live. Remaining for v1: VPS deploy + polish (week 5).
