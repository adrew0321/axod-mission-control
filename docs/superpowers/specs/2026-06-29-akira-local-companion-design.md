# AKIRA Local Companion — Design

**Status:** Implemented — 2026-06-30

## Goal

Give AKIRA (the concierge running on the Mini) **hands on the user's laptop**: a
small local agent that drives a real browser — navigate, read, type, click — and
logs into the user's accounts via a persistent profile, so AKIRA can carry out
web tasks ("open my Outlook and pull the latest invoice") while the user watches.
This v1 is the **foundation + browser automation**; launching native apps and
moving files laptop↔Mini are later slices.

> AKIRA is the brain (Mini). The Companion is the hands (laptop). The Mini stays
> the database source of truth; the Companion only acts on the laptop's browser.
> See [[akira-phase-1-shipped]], [[akira-agent-name]].

## Scope decisions (locked during brainstorming)

- **Transport:** the Companion dials **outbound** to the Mini (laptop stays
  private behind NAT). Implemented as an **outbound SSE command channel +
  HTTPS POST results** — functionally the chosen "outbound WebSocket," built on
  the codebase's existing SSE infrastructure (no custom WS server in Next 16).
- **v1 capability:** foundation (laptop agent + Mini gateway + security model) +
  a **persistent Playwright browser** (navigate/read/type/click + interactive
  login). NOT app-launch or file-movement.
- **Login:** **persistent pre-authenticated profile** — the user logs into each
  site once, interactively, in the watched browser; the session persists and is
  reused. AKIRA never sees or stores passwords.
- **Safety:** **approve the task once, hard-gate the dangerous actions** — and
  the hard gate is enforced by the Companion (the hands), not trusted to AKIRA.
- **HUD:** approvals/confirmations surface in the AKIRA HUD as a **smooth**
  proposal-card interaction (no jarring layout jumps).

> **Update (2026-07-02):** The native laptop HUD is specced separately in
> [2026-07-02-akira-companion-hud-design.md](2026-07-02-akira-companion-hud-design.md)
> and moves hard-gate approvals local (companion-held queue over a localhost bridge).

## Out of scope for v1 (named to prevent creep)

- Launching native apps; moving files laptop↔Mini — next Companion slices.
- A browser **extension** driving the user's *everyday* Chrome (v1 uses the
  Companion's own persistent Playwright browser).
- Multi-device / per-device tokens; password-manager integration; autostart/tray
  packaging (v1 runs via `pnpm companion`).
- AKIRA's autonomous cross-project router (separate Phase 2).

---

## Architecture

Three pieces:

1. **The Companion** — a Node process on the laptop (`pnpm companion`). Owns a
   persistent Playwright Chromium, exposes an allowlisted action set, holds local
   config (Mini URL, pre-shared token, profile path, sensitive-domain list).
2. **The Mini gateway** — endpoints in the Mission Control app the Companion
   connects to, plus an in-memory presence + command/result bus.
3. **AKIRA's browser tools** — new `browser_*` MCP tools that enqueue a command
   for the connected Companion and await its result.

### Transport

- Companion opens an **outbound SSE stream** to `GET /api/companion/stream`
  (token-authenticated) — the live channel AKIRA **pushes commands down**.
- Companion **POSTs results** to `/api/companion/result` (token-authenticated).
- Laptop stays private (outbound only, NAT-friendly), reusing the SSE pattern
  already used by `/api/akira/stream` and the session stream route.

### Auth

A **pre-shared token** generated once, stored in the Companion's local config and
the Mini's `.env` as `COMPANION_TOKEN`. Every SSE connect and result POST carries
it; the Mini rejects anything else. (Per-device/rotating tokens are out of scope —
single laptop for v1.)

### Presence

While the Companion's SSE stream is open the Mini holds "laptop online" with a
heartbeat (stale after ~30s of silence). AKIRA's prompt/snapshot includes
companion status, so she **only offers browser actions when the laptop is
connected**, and says so plainly when it isn't ("I can't drive the browser — your
laptop companion isn't connected") rather than failing.

---

## Browser automation

**The browser.** One **headful** Playwright Chromium with a **persistent
context** at a fixed profile dir on the laptop (e.g. `~/.akira-companion/profile`).
Headful so the user watches; persistent so sessions/logins survive runs. One
reused window, not a fresh browser per task. One active browser task at a time
per Companion (a second is queued or rejected) so actions can't interleave.

**Action set** (each `browser_*` tool maps to a Companion action against the live
page):

- `browser_navigate(url)` — go to a page (url resolved through the existing
  destinations registry so "open my Outlook" still works).
- `browser_read()` — return a trimmed snapshot: visible text + interactive
  elements with **stable refs** AKIRA can target.
- `browser_type(ref, text)` — type into a field.
- `browser_click(ref)` — click an element.
- `browser_wait()` — await navigation/load.

AKIRA works the **read → act → read** loop: read the page, choose the next
element, act, re-read. Many small turns — which is why AKIRA runs on a cheap, fast
model (Haiku). A **stuck-loop guard** caps iterations per task (~25) so a confused
run stops and asks rather than churning.

### Login flow

AKIRA never types the password. On hitting a login wall:

1. She navigates; `browser_read` detects a login form / logged-out state.
2. The Companion **pauses and surfaces a nudge** in the HUD ("Outlook needs you to
   sign in — I've opened it, go ahead"); the user types credentials + 2FA
   **directly in the watched browser window**.
3. On the post-login page (auto-detected, or the user says "done") AKIRA
   continues. The session is saved in the persistent profile, so **next time
   she's already logged in** — no prompt.

Passwords live only in the browser's own profile store on the laptop, exactly as
if the user logged in normally.

---

## Safety model

Three tiers, **enforced at the Companion (the hands), not trusted to AKIRA (the
brain)**:

- **Auto-run (no prompt):** `browser_navigate`, `browser_read`, `browser_wait`,
  and typing/clicking ordinary fields/links. Run live while the user watches.
- **Task approval (once, up front):** before a multi-step browser task AKIRA
  states the goal in the HUD ("Log into Outlook and pull your latest invoice —
  go ahead?"); the user approves once (same propose→confirm pattern as `relay`),
  then she runs the loop.
- **Hard gate (every time, mid-task):** irreversible/costly actions **always**
  pause for a fresh explicit OK, even inside an approved task, and AKIRA cannot
  self-approve them: submitting a **purchase/checkout**, entering **payment**,
  **sending** a message/email/post, **deleting/transferring**, and anything on a
  user-flagged **sensitive domain** (e.g. bank).

**Hard-gate detection — defense in depth:**

1. **Companion-side classification is the source of truth.** Before executing a
   `browser_click`, the Companion inspects the target element/text/URL (e.g.
   matches `/buy|place order|pay|checkout|send|delete|transfer|confirm/i`,
   payment fields, the always-confirm domain allowlist). On a match it **refuses
   to execute until it receives an explicit `approve` for that specific action**,
   regardless of AKIRA's intent.
2. AKIRA is *also* instructed to propose-confirm these — but enforcement does not
   rely on her judgment. The brain can be wrong; the hands hold the brakes.

**Where the user approves:** all prompts (task approval, hard-gate confirmations,
login nudges) surface in the **AKIRA HUD** as a Confirm/Cancel card streamed up
the same channel as her replies; the user watches the clicking happen in the
headful browser. The card interaction must be **smooth** — fade/slide-in, the orb
easing to a calm "waiting" state, clean animate-out on choice; no modal slam, no
layout jump.

**Kill switch:** "Stop" in the HUD (and closing the Companion) immediately aborts
the current action and clears the queue.

---

## Error handling

- **Laptop offline / disconnects mid-task:** AKIRA stops, reports "lost the
  laptop connection"; queued actions are dropped (never silently retried). On
  reconnect she starts fresh — no half-task replay.
- **Command timeout** (hung page / element never appears): Companion returns a
  timeout result; AKIRA reports and re-reads rather than blindly retrying.
- **Element not found / stale ref:** `browser_click` fails cleanly → AKIRA
  re-reads and re-decides (the loop self-heals).
- **Session expired mid-task:** detected on read → pauses to the login flow →
  resumes after re-auth.
- **Browser crash:** Companion relaunches Chromium with the same profile, reports
  the reset; AKIRA restarts the current step.
- **Hard-gate with no response:** treated as **declined** after a window
  (fail-safe — never auto-proceeds on a sensitive action).
- **Stuck loop:** iteration cap per task → stops and asks the user.

---

## Components

**Laptop — new `companion/` package (runs on the laptop, not the Mini):**

| File | Responsibility | Tested |
|------|----------------|--------|
| `companion/index.ts` | Entry (`pnpm companion`): config load, lifecycle | — |
| `companion/connection.ts` | Outbound SSE connect, token auth, heartbeat, result POST, reconnect | — |
| `companion/browser.ts` | Persistent Playwright browser; navigate/read/type/click/wait | — (integration) |
| `companion/page-snapshot.ts` | **Pure:** page → trimmed read model (text + refs) | ✅ |
| `companion/guard.ts` | **Pure:** hard-gate classifier (does this action need approval?) | ✅ (critical) |
| `companion/config.ts` | Mini URL, token, profile path, sensitive-domain list | — |

**Mini — Mission Control app:**

| File | Responsibility | Tested |
|------|----------------|--------|
| `src/app/api/companion/stream/route.ts` | SSE command channel (token-auth, registers presence) | — |
| `src/app/api/companion/result/route.ts` | Result intake (token-auth) | — |
| `src/lib/companion/registry.ts` | In-memory presence + command/result bus AKIRA's tools await | ✅ |
| `src/lib/akira/browser-tools.ts` | `browser_*` MCP tools: enqueue command, await result, task-approval + hard-gate hooks | — |
| HUD (extend proposal card) | Smooth task-approval / hard-gate / login-nudge confirmations + companion-online indicator | — |

---

## Testing

(node:test via tsx — pure logic only, per repo convention; extensionless imports.)

- `guard.test.ts` — hard-gate classifier: buy/send/delete/payment/sensitive-domain
  → requires approval; ordinary links/fields → auto-run. **The critical safety
  test.**
- `page-snapshot.test.ts` — element extraction, ref stability, trimming.
- `registry.test.ts` — presence on/offline transitions; command→result
  correlation; second-task rejection.
- Playwright actions + live SSE: integration/manual (not unit-tested), same as the
  Web Speech APIs in Phase 1.

---

## Component summary

| Unit | Responsibility | Depends on |
|------|----------------|------------|
| Companion process | Drive the laptop browser on AKIRA's behalf | Playwright, Mini gateway, token |
| `guard.ts` | Enforce hard gates at the hands | — (pure) |
| `page-snapshot.ts` | AKIRA's "eyes" on the page | — (pure) |
| Mini gateway (stream/result/registry) | Bridge AKIRA ↔ Companion, track presence | SSE, COMPANION_TOKEN |
| `browser-tools.ts` | Expose browser actions to AKIRA with approval hooks | registry, akira runner |
| HUD proposal card (extended) | Smooth approvals/confirmations + presence | akira stream |
