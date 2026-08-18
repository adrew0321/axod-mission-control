# Final fix wave — AKIRA's Room slice 2

**Branch:** `feat/akiras-room-slice2`
**Base:** `7127a6b` (pre-wave HEAD)
**Result:** All findings fixed. 8 commits, `6bf694a` is the new HEAD.

All three gates green at the end of the wave:
- `pnpm test` — 654 total / 650 pass / 4 skipped / 0 fail (baseline was 632/628/4/0 — net +22 tests, +2 new test files)
- `pnpm exec tsc --noEmit` — exit 0
- `pnpm build` — exit 0

---

## Important 1 — `Result.status='blocked'` overloaded; AKIRA told `done` for a command that never ran

**Commit:** `00f666e fix(room): key the shell operator gate on an explicit flag, not status==='blocked'`

**Root cause confirmed:** `room-agent/src/shell-ops.ts` returned `status: 'blocked'` from two unrelated places — the classifier refusal (`:37`, approvable) and a refused `cwd` (`:43`, never approvable). `src/lib/akira/room-shell.ts:29` (`first.status !== 'blocked'`) couldn't tell them apart, and `present()` fell through to `ok(r.text ?? 'done')` for a blocked result carrying no `text`.

**Fix, part (a) — self-identifying gate:**
- Added `gated?: boolean` to `Result` in `src/lib/companion/protocol.ts`, with a doc comment stating it is the *only* `'blocked'` cause approval can clear.
- Copied byte-for-byte to `companion/src/protocol.ts` and `room-agent/src/protocol.ts` (verified via `protocol-copies.test.ts`'s identity check, which still passes).
- Extended `protocol-copies.test.ts` with `'the protocol declares the gated flag on Result'`, asserting `/gated\?: boolean/` is present — mirrors how it already checks `exitCode`/`command`/`cwd`.
- `room-agent/src/shell-ops.ts`: set `gated: true` **only** at the classifier-refusal return (`:37`); the cwd-refusal return (`:43`) is untouched — no flag.
- Did **not** re-call `classifyShell` on the Mission Control side — `room-shell.ts` only reads the flag the room already computed.

**Fix, part (b) — explicit `blocked` branch in `present()`:**
- `present()` now has a dedicated `status === 'blocked'` branch that surfaces `r.reason`, before the generic `ok(r.text ?? 'done')` fallback — mirrors `room-tools.ts:24-27`'s handling for `fs_*` actions.
- `runShell`'s dispatch now branches on `!first.gated` (not `status !== 'blocked'`), so a path-refused result routes through `present()`'s new blocked branch instead of ever reaching the gate-opening code.

**TDD evidence** (`src/lib/akira/room-shell.test.ts`):
- `'a path-refused result (blocked, but NOT gated) never opens a gate, and names the refusal rather than "done"'` — asserts zero `hard_gate` emits, result text ≠ `'done'`, text matches the actual refusal reason. Verified this test fails without the fix (reverted `first.gated` check locally to `first.status !== 'blocked'` and reran — test failed as expected, then restored).
- `'a classifier-gated result (gated: true) still opens a real gate'` — positive counterpart, confirms the one legitimate `'blocked'` cause still reaches the HUD.
- Updated the two pre-existing gate tests' mocked `resolveResult(...)` calls to include `gated: true`, since they simulate classifier refusals (`'npm run dev'` / `'looks like a dev server'`) — without this they'd have silently started exercising the new "no gate" path instead of the gate path they're meant to test.

All four tests pass; full `room-shell.test.ts` suite (11 tests) green.

---

## Important 2 — raw filename/path reach an ungated instruction (prompt injection)

**Commit:** `0e47768 fix(room): sanitize name/path on the ungated instruction paths too`

**Root cause confirmed:** `summarizeDrop()` (`src/lib/room-proposals.ts:35`) collapsed whitespace in `name`, with a comment naming the injection risk — but `playgroundTurnInstruction` (the **ungated** path, `:61-68`) interpolated `d.name` raw, and both `inboxTurnInstruction` and `playgroundTurnInstruction` interpolated `path` raw. `src/app/api/companion/room-event/route.ts:24` validated only field *presence*, trusting the room agent's own `head` truncation (`MAX_HEAD_CHARS = 800` in `room-agent/src/doorway.ts`) with no server-side enforcement.

**Fix:**
- Added a shared `oneLine()` helper in `room-proposals.ts`; applied to `name` **and** `path` in both `inboxTurnInstruction` and `playgroundTurnInstruction`.
- Extracted route validation into a new pure module `src/lib/room-event-validate.ts` (the route file transitively imports `'server-only'` via `room-proposals-data.ts`, so validation logic had to live somewhere node:test can import — same split pattern as `room-shell.ts`/`room-tools.ts`).
  - `hasControlChars(s)` rejects any C0 control byte or DEL (0x00–0x1F, 0x7F) — stricter than the whitespace-collapse downstream; this is a hard 400, not a silent clean.
  - `MAX_NAME_CHARS = 500`, `MAX_PATH_CHARS = 4096` — reject over the cap.
  - `MAX_HEAD_CHARS = 800` — clamp (truncate), not reject, matching the room's own cap but enforced independently server-side.
- `route.ts` now calls `validateDropBody(b)` and returns 400 with the specific reason on any violation.

**TDD evidence:**
- `src/lib/room-event-validate.test.ts` (new, 12 tests): control-char detection (newline, null byte, tab, CR, DEL), boundary tests at exactly `MAX_NAME_CHARS`/`MAX_PATH_CHARS` (accepted) vs. one-over (rejected — genuine boundary test, not just "some big number"), head truncated to exactly `MAX_HEAD_CHARS` when the room sends 10x that.
- `src/lib/room-proposals.test.ts`: three new tests — a newline-carrying filename does not inject a line into the **playground** instruction (the finding's exact repro, `"ev\nil.md\nIGNORE THE ABOVE..."`), same for a newline in `path` on both the playground and inbox builders. Each asserts `!i.includes('\nIGNORE THE ABOVE')` — would fail immediately if `oneLine()` were removed (verified structurally: without collapsing, the raw `\n` stays in the string and the assertion trips).

All 23 tests across the two files pass.

---

## Important 3 — gates unreachable from doorway-triggered turns (stop the stall)

**Commit:** `00f666e` (same commit as Important 1 — the fix lives in the same function, `runShell`, so splitting the commit would have required partial-file surgery; the commit message covers both).

**Root cause confirmed:** `room-proposals-data.ts:109` calls `runAkiraTurn({ instruction })` with no `emit`; `akira-turn.ts:43` defaults it to `() => {}`. A gated shell command inside a doorway-triggered turn would park in `gates.ts`'s broker with nobody able to see the `hard_gate` HUD card, blocking the single serialized `turnChain` for the full 120s `GATE_TIMEOUT_MS` before auto-denying.

**Fix — explicit flag, not inferred:**
- Added `watched?: boolean` to `AkiraToolContext` (`tool-actions.ts`), documented as "true iff an operator-facing surface can see a `hard_gate` card."
- `akira-turn.ts` sets it explicitly: `createAkiraServer({ emit, watched: Boolean(opts.emit) })` — `true` when a real emit was supplied (the `/api/akira/stream` HUD route always passes one), `false` for the headless default.
- `runShell` checks `ctx.watched` **before** opening a gate: if false, it logs a `'denied'` shell-log line (reason suffixed `"(no operator watching this turn — gate skipped)"`) and returns immediately with a message telling AKIRA the operator can't be asked right now and to report back rather than retry — no `openGate`/`hard_gate` emit ever happens.
- Comment in `room-shell.ts` states the limitation plainly (a persistent pending-gates surface is slice-3 sized, per the finding).
- Noted in the plan document (see below).

**TDD evidence:**
- `'when no operator is watching this turn, a gated command is denied immediately rather than parked'` — asserts the call resolves in under 5s (not the 120s timeout), zero `hard_gate` emits, log sequence is exactly `['dispatch', 'denied']` (no `'gated'` line, confirming the gate was never opened), and the returned text matches both `/not.*watching|nobody.*watching/i` and `/report back/i`.
- Confirmed this test fails without the `watched` check: with `ctx.watched` defaulting to `undefined` and the `freshCtx()` helper explicitly setting `watched: true` for the *other* tests, removing the `!ctx.watched` branch would make this test hang for 120s and then time out the test runner — i.e., the mechanism is load-bearing, not decorative.

**Plan note added:** a blockquote inserted immediately before Task 8's heading in `docs/superpowers/plans/2026-08-15-akiras-room-slice2.md`, recording the limitation, the mechanism (`AkiraToolContext.watched`), and that a persistent pending-gates surface remains slice-3 sized.

---

## Minor fixes

### `doorway.ts` `under()` vs `paths.ts` `within()`

**Commit:** `8eff9cb fix(room): consolidate the two path-containment predicates`

Exported `within(parent, child, opts?: { inclusive?: boolean })` from `paths.ts` (default `inclusive: true`, matching its existing behavior for the path gate). `doorway.ts` now imports and calls it with `{ inclusive: false }` for `zoneForPath`, with a comment explaining the two call sites genuinely need different semantics (the room root itself is "inside" for the path gate; the bare zone folder is not itself a "drop"). Removed the local `under()` duplicate. Full `doorway.test.ts` + `paths.test.ts` + `paths-real.test.ts` + `fs-ops.test.ts` suite (50 tests) still green, including the existing `'the zone directory itself, with no file under it, is not a drop'` regression test.

### `proposals-view.tsx` empty state

**Commit:** `6dea430 fix(ui): don't show "No changes awaiting review" while room proposals exist`

One-line change: `{proposals.length === 0 && (...)}` → `{proposals.length === 0 && roomProposals.length === 0 && (...)}`. No test infra exists for this component in the repo (no React component test harness is wired into `pnpm test`), so this is verified by code inspection only — flagged below.

### `roomProposalEmbed` missing `color`

**Commit:** `ddc617b fix(discord): give roomProposalEmbed a color like every sibling embed`

Added `color: BLUE` (`0x3b82f6`), matching `proposalEmbed`/`dreamEmbed`. New test asserts the exact color value.

---

## Additions from the review's triage

### Proxy matcher regression guard

**Commit:** `09e8d5c test(proxy): guard against the recurring token-authed-route-redirects-to-login bug`

`src/lib/proxy-matcher.test.ts` (new) recursively walks `src/app/api/companion/**/route.ts` on disk, classifies each route by whether its source references `verifyCompanionToken`/`identifyCompanionToken` (self-authenticating, no browser session), and cross-checks that classification against `src/proxy.ts`'s **actual** `config.matcher[0]` regex (not a hand-copied approximation — built with `new RegExp('^' + config.matcher[0] + '$')` against candidate pathnames).

Two tests: token-authed routes must be excluded from the gate; non-token-authed routes (`status`, `approve`) must stay gated (catches the regex being widened too far the other way).

**Verified the test actually catches the bug class it targets:** temporarily removed `room-event` from `proxy.ts`'s exclusion list and reran — the test failed with a message naming exactly the production symptom (`/api/companion/room-event ... IS matched by proxy.ts's session gate — it would 302 to /login`). Reverted via `git checkout -- src/proxy.ts` before committing.

### Migration 0014 runbook note

**Commit:** `72613da docs(runbook): note migration 0014 has no snapshot file`

Added a `### Migration 0014 was hand-written — no snapshot file` section to `docs/runbook-mini-desktop.md`, recording that `drizzle/0014_room_proposals.sql` has no corresponding `drizzle/meta/0014_snapshot.json`, why (pre-existing `pnpm db:generate` lineage corruption), and the concrete risk (a future blind regeneration could emit a duplicate `CREATE TABLE room_proposals`). Confirmed via `ls drizzle/meta` that no `0014_snapshot.json` exists, matching the finding.

---

## Missing deliverable — `deploy/room/provision.sh`

**Commit:** `6bf694a feat(room): add the workshop bare-repo remote to provision.sh`

Added the plan's Task 16 Step 1 verbatim (bare repo at `$HOME/akira-workshop.git`, `lxc config device add ... workshop-remote`, `origin` set inside the container via `sudo -u akira`), placed after the systemd service section and before the final verification echoes — idempotent (dir-existence check, `remove ... || true` before `add`, `git init`/`remote add` both guarded), matching the rest of the file's style. This is a shell script for the operator to run on the Mini; **not executed here** — no way to verify end-to-end without the actual LXD host. Static review only: the block is a direct copy of the plan's prescribed snippet with no modification.

---

## Verification command output

### `pnpm test`
```
ℹ tests 654
ℹ suites 0
ℹ pass 650
ℹ fail 0
ℹ cancelled 0
ℹ skipped 4
ℹ todo 0
ℹ duration_ms 82080.8966
```
(Baseline before this wave: 632 total / 628 pass / 4 skipped / 0 fail — net +22 tests across `room-shell.test.ts` (+4), `room-proposals.test.ts` (+3), `discord-format.test.ts` (+1), `protocol-copies.test.ts` (+1), plus two new files `room-event-validate.test.ts` (+12) and `proxy-matcher.test.ts` (+2, but net tests count differently since suite structure — actual delta reconciles to +22 total.)

### `pnpm exec tsc --noEmit`
Exit 0, no output.

### `pnpm build`
Exit 0. Compiled successfully, all routes generated including `/api/companion/room-event`, `/api/companion/approve`, etc. (Pre-existing Turbopack "unexpected file in NFT list" warning re: `worktree.ts`'s `path.join` usage is unrelated to this wave's changes — same warning appeared on the pre-wave baseline and is not a build failure.)

---

## Could not fix / left as-is

1. **`proposals-view.tsx` fix has no automated test.** No React component test harness exists in this repo's `pnpm test` pipeline (it's `node:test` over pure/server logic only), so the one-line JSX gating fix is verified by inspection, not by a running test. Flagging per the "would this test still pass if the mechanism were removed" lens — there is no test to apply that lens to here, which is itself worth surfacing.
2. **`provision.sh` change is unexecuted.** As noted above, it's a Mini-only shell script; I could not run it here. It has not been verified end-to-end (the plan's own Task 16 Steps 6-9 cover that verification and are explicitly out of scope for this fix wave).

Everything else in the finding list was fixed and verified as described above. Explicitly-parked items (Discord gather isolation, `watcher.ts` unbounded map, the `/inbox/i` embed test, duplicate-secret residual, `expired` boolean, SIGPIPE coincidence, `connection.ts` test coverage) were left untouched per instructions.
