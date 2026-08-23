# AKIRA Host Reach — Slice C1 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give AKIRA a shell and filesystem on the Mini itself — a third companion target, `host`, running as root — with every action logged before it is dispatched.

**Architecture:** `CompanionTarget` gains `'host'`. The existing `room-agent/` package is renamed `mini-agent/` and becomes mode-aware, so one codebase serves both the container and the host; the two differ only by an `ExecPolicy`. On the Mission Control side, `room-shell.ts` generalizes to `agent-shell.ts` (target-parameterised), `shell-log.ts` to `action-log.ts`, and the four `room_*` tools collapse into `list` / `read` / `write` / `bash` with a `target` argument.

**Tech Stack:** TypeScript, Next.js 16, `node:test` via `tsx`, Claude Agent SDK MCP tools, systemd on Ubuntu.

**Spec:** `docs/superpowers/specs/2026-08-22-akira-host-reach-design.md`

## Global Constraints

- **Read the Next.js guides before writing route code.** `node_modules/next/dist/docs/` — this version has breaking changes vs. training data (repo `AGENTS.md`).
- **Tests:** `pnpm test` runs `tsx --test`. Use **extensionless imports** — a `.ts` extension breaks `tsc` and the Next build.
- **`server-only` modules cannot be unit-tested.** Anything `pnpm test` must exercise goes in a non-`server-only` module. This is why `room-shell.ts` exists separately from `room-tools.ts`; keep that split.
- **Never branch-switch this repo** — it is the live app dir for the MC project. Work in an isolated worktree off `dev`.
- **Never push to `main`.** Feature branch → `dev`.
- **`protocol.ts` has THREE byte-identical copies** (`src/lib/companion/`, `companion/src/`, `room-agent/src/`) enforced by `protocol-copies.test.ts`. Renaming the third one means updating that test.
- **Commit trailer** on every commit:
  ```
  Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
  ```
- **D2 — no gates on host.** The host path never calls `classifyShell` and never opens an operator gate. Do not add one "just in case"; it contradicts the spec.
- **D7 — the Discord feed never carries command output.** C1 adds no Discord code, but do not add an output field to any log row that C2 will read.

---

## Why `mini-agent/` and not a new `host-agent/`

The spec says "a sibling package to `room-agent/`". Reading the code changed this:
`shell-ops.ts` is 242 lines of process-group kill, UTF-8/surrogate-safe output
capping, and SIGPIPE disambiguation carrying comments like "Fix round 3
(coordinator review)". `shell-gate.ts` is 575 lines. A second copy of that would
drift, and a fix would need applying twice — `protocol.ts` already needs a test
to hold three copies identical.

So: one package, two modes, two systemd units, two tokens. The room's behaviour
is pinned by its existing tests, which must keep passing unchanged.

**The running container is not affected by the rename** until it is
re-provisioned, which is a deliberate operator step in Task 9.

---

## File Structure

**Renamed:**
- `room-agent/` → `mini-agent/` (git mv, history preserved)

**Created:**
- `mini-agent/src/policy.ts` — the `ExecPolicy` discriminated union; pure
- `src/lib/akira/self-affecting.ts` — pure classifier for self-restart commands
- `src/lib/akira/self-affecting.test.ts`
- `src/lib/akira/action-log.ts` — generalized from `shell-log.ts`
- `src/lib/akira/action-log.test.ts`
- `src/lib/akira/agent-shell.ts` — generalized from `room-shell.ts`
- `deploy/akira-host-agent.service` — the systemd unit, installed by hand

**Modified:**
- `src/lib/companion/registry.ts` — `CompanionTarget` union
- `src/lib/companion/auth.ts` — `CompanionSecrets.host`, `resolveTarget`
- `src/lib/companion/target-param.ts` — accept `host`
- `mini-agent/src/config.ts` — mode-aware
- `mini-agent/src/shell-ops.ts`, `fs-ops.ts` — take `ExecPolicy`
- `mini-agent/src/index.ts` — mode wiring
- `src/lib/akira/room-tools.ts` → tool surface with `target`
- `src/lib/akira-turn.ts`, `src/lib/akira/prompt.ts`, `src/lib/akira/agent.ts`, `scripts/seed.ts`
- `docs/runbook-mini-desktop.md`

**Deleted:**
- `src/lib/akira/room-shell.ts`, `src/lib/akira/shell-log.ts` (renamed, not dropped)

---

### Task 1: `host` becomes a real target

**Files:**
- Modify: `src/lib/companion/registry.ts:14`
- Modify: `src/lib/companion/auth.ts:17-40`
- Modify: `src/lib/companion/target-param.ts`
- Test: `src/lib/companion/auth.test.ts`, `src/lib/companion/registry.test.ts`

**Interfaces:**
- Consumes: nothing (first task).
- Produces: `CompanionTarget = 'laptop' | 'room' | 'host'`; `CompanionSecrets` gains `host: string | null | undefined`; `targetFromParam` returns `'host'` for `"host"`.

- [ ] **Step 1: Write the failing tests**

Append to `src/lib/companion/auth.test.ts`:

```ts
test('a host token resolves to the host target', () => {
  const secrets = { laptop: 'L', room: 'R', host: 'H' };
  assert.equal(resolveTarget('H', secrets), 'host');
  assert.equal(resolveTarget('R', secrets), 'room');
  assert.equal(resolveTarget('L', secrets), 'laptop');
  assert.equal(resolveTarget('nope', secrets), null);
});

test('laptop wins a duplicated secret so host fails closed', () => {
  // Same ordering rule the room already relies on: a mis-set env var must not
  // silently grant the laptop's authority to another machine.
  assert.equal(resolveTarget('SAME', { laptop: 'SAME', room: null, host: 'SAME' }), 'laptop');
});

test('an absent host secret never matches', () => {
  assert.equal(resolveTarget('', { laptop: 'L', room: 'R', host: null }), null);
  assert.equal(resolveTarget('H', { laptop: 'L', room: 'R', host: undefined }), null);
});
```

Append to `src/lib/companion/target-param.test.ts` (create the file if absent, with `import { targetFromParam } from './target-param'`):

```ts
test('targetFromParam recognises host, room, and defaults to laptop', () => {
  assert.equal(targetFromParam('host'), 'host');
  assert.equal(targetFromParam('room'), 'room');
  assert.equal(targetFromParam('laptop'), 'laptop');
  assert.equal(targetFromParam(null), 'laptop');
  assert.equal(targetFromParam('HOST'), 'laptop', 'exact match only');
});
```

Append to `src/lib/companion/registry.test.ts`:

```ts
test('a disconnecting host fails only host commands', () => {
  const hostSink = { send() {}, close() {} };
  const roomSink = { send() {}, close() {} };
  const unregisterHost = registerCompanion(hostSink, 'host');
  registerCompanion(roomSink, 'room');

  const hostCmd = sendCommand({ action: 'shell', command: 'true' }, 5000, 'host');
  const roomCmd = sendCommand({ action: 'shell', command: 'true' }, 5000, 'room');
  const roomSettled = { done: false };
  roomCmd.result.then(() => { roomSettled.done = true; }, () => { roomSettled.done = true; });

  unregisterHost();

  return hostCmd.result.then(
    () => assert.fail('host command should have rejected'),
    (e) => {
      assert.match(String(e.message), /disconnected/);
      assert.equal(roomSettled.done, false, "the room's in-flight command must survive");
    },
  );
});

test('isOnline is per target', () => {
  assert.equal(isOnline('host'), false);
  const un = registerCompanion({ send() {} }, 'host');
  assert.equal(isOnline('host'), true);
  assert.equal(isOnline('room'), false);
  un();
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm exec tsx --test src/lib/companion/auth.test.ts src/lib/companion/registry.test.ts src/lib/companion/target-param.test.ts`
Expected: FAIL — type errors on `host` in `CompanionSecrets`, and `targetFromParam('host')` returning `'laptop'`.

- [ ] **Step 3: Implement**

`src/lib/companion/registry.ts` — replace the `CompanionTarget` declaration:

```ts
/** Which machine a command is bound for. 'laptop' is the operator's (replaceable) work
 *  machine; 'room' is AKIRA's container on the Mini; 'host' is the Mini itself, running
 *  as root — see docs/superpowers/specs/2026-08-22-akira-host-reach-design.md. */
export type CompanionTarget = 'laptop' | 'room' | 'host';
```

`src/lib/companion/auth.ts` — extend the secrets and the resolver:

```ts
/** The three shared secrets, one per target. Passed in so the resolver stays pure. */
export interface CompanionSecrets {
  laptop: string | null | undefined;
  room: string | null | undefined;
  host: string | null | undefined;
}

export function resolveTarget(
  input: string | null | undefined,
  secrets: CompanionSecrets,
): CompanionTarget | null {
  if (tokenMatches(input, secrets.laptop)) return 'laptop';
  if (tokenMatches(input, secrets.room)) return 'room';
  if (tokenMatches(input, secrets.host)) return 'host';
  return null;
}

function envSecrets(): CompanionSecrets {
  return {
    laptop: process.env.COMPANION_TOKEN,
    room: process.env.ROOM_COMPANION_TOKEN,
    host: process.env.HOST_COMPANION_TOKEN,
  };
}
```

`src/lib/companion/target-param.ts`:

```ts
import type { CompanionTarget } from './registry';

/** Parse the ?target= query parameter. Anything unrecognised — including absent,
 *  which is what the already-deployed laptop companion sends — is 'laptop'. */
export function targetFromParam(raw: string | null): CompanionTarget {
  if (raw === 'room') return 'room';
  if (raw === 'host') return 'host';
  return 'laptop';
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm exec tsx --test src/lib/companion/*.test.ts` then `pnpm exec tsc --noEmit`
Expected: PASS, and a clean typecheck.

- [ ] **Step 5: Commit**

```bash
git add src/lib/companion/
git commit -m "feat(companion): add 'host' as a third target

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 2: `action-log.ts` — logging that carries a target

**Files:**
- Create: `src/lib/akira/action-log.ts` (from `shell-log.ts`)
- Create: `src/lib/akira/action-log.test.ts`
- Delete: `src/lib/akira/shell-log.ts`, `src/lib/akira/shell-log.test.ts`

**Interfaces:**
- Consumes: `CompanionTarget` (Task 1).
- Produces: `ActionLogEvent { at, target, event, command, cwd?, exitCode?, status?, reason? }` where `event: 'dispatch' | 'intent' | 'gated' | 'approved' | 'denied' | 'result'`; `formatActionLogLine(e): string`; `appendActionLog(e): void`; `actionLogPath(): string`.

- [ ] **Step 1: Write the failing test**

Create `src/lib/akira/action-log.test.ts`:

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { formatActionLogLine, actionLogPath } from './action-log';

test('a log line carries the target and is one JSON object', () => {
  const line = formatActionLogLine({
    at: new Date('2026-08-22T12:00:00.000Z'),
    target: 'host',
    event: 'dispatch',
    command: 'systemctl status mission-control',
  });
  assert.ok(line.endsWith('\n'));
  const row = JSON.parse(line);
  assert.equal(row.target, 'host');
  assert.equal(row.event, 'dispatch');
  assert.equal(row.at, '2026-08-22T12:00:00.000Z');
});

test('a newline in a command cannot forge a second log entry', () => {
  const line = formatActionLogLine({
    at: new Date(),
    target: 'host',
    event: 'dispatch',
    command: 'echo one\n{"forged":true}',
  });
  assert.equal(line.split('\n').length, 2, 'exactly one newline: the terminator');
  assert.equal(JSON.parse(line).command, 'echo one\n{"forged":true}');
});

test('optional fields are omitted rather than emitted as undefined', () => {
  const row = JSON.parse(formatActionLogLine({
    at: new Date(), target: 'room', event: 'result', command: 'true', exitCode: 0,
  }));
  assert.equal(row.exitCode, 0);
  assert.equal('cwd' in row, false);
  assert.equal('reason' in row, false);
});

test('actionLogPath prefers AKIRA_ACTION_LOG, falls back to ROOM_SHELL_LOG', () => {
  const saved = { a: process.env.AKIRA_ACTION_LOG, r: process.env.ROOM_SHELL_LOG };
  try {
    delete process.env.AKIRA_ACTION_LOG;
    process.env.ROOM_SHELL_LOG = '/tmp/legacy.log';
    assert.equal(actionLogPath(), '/tmp/legacy.log', 'an existing Mini keeps writing where it did');
    process.env.AKIRA_ACTION_LOG = '/tmp/new.log';
    assert.equal(actionLogPath(), '/tmp/new.log', 'the new name wins when both are set');
  } finally {
    if (saved.a === undefined) delete process.env.AKIRA_ACTION_LOG; else process.env.AKIRA_ACTION_LOG = saved.a;
    if (saved.r === undefined) delete process.env.ROOM_SHELL_LOG; else process.env.ROOM_SHELL_LOG = saved.r;
  }
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm exec tsx --test src/lib/akira/action-log.test.ts`
Expected: FAIL — `Cannot find module './action-log'`.

- [ ] **Step 3: Implement**

Create `src/lib/akira/action-log.ts`:

```ts
// Every action AKIRA takes on any target is logged where the operator can read
// it. Under the host-reach spec's D2 (awareness, not veto) this log is the
// primary control, not diagnostics.
//
// It lives HERE, on the Mission Control side — never on the target. A log on the
// machine being acted on is a log that machine's shell can rewrite. Actions are
// logged BEFORE dispatch, so one that hangs, kills the agent, or restarts
// Mission Control itself still leaves a trace.
//
// Honest limit: this is not tamper-proof against AKIRA. Under D1 she can write
// this host. It defends against a command that dies mid-flight, not against
// deliberate rewriting — no log on this machine could.
import { appendFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { CompanionTarget } from '@/lib/companion/registry';

export interface ActionLogEvent {
  at: Date;
  /** Which machine the action was bound for. */
  target: CompanionTarget;
  /** 'intent' is logged before a fire-and-forget command that is expected to end
   *  the turn (a Mission Control restart); no 'result' will follow it. */
  event: 'dispatch' | 'intent' | 'gated' | 'approved' | 'denied' | 'result';
  command: string;
  cwd?: string;
  exitCode?: number | null;
  /** The process outcome ('ok' / 'error') on a 'result' event. Never repurposed
   *  to carry the gate's reason text — see `reason` for that. */
  status?: string;
  /** Human-readable "why": the gate's reason on a 'gated' event, or the failure
   *  detail on an error 'result'. Kept separate from `status` so a field means
   *  the same thing on every line. */
  reason?: string;
}

/** AKIRA_ACTION_LOG is the current name. ROOM_SHELL_LOG is honoured as a fallback
 *  so a Mini already configured for the room keeps writing where it did. */
export function actionLogPath(): string {
  return (
    process.env.AKIRA_ACTION_LOG ||
    process.env.ROOM_SHELL_LOG ||
    join(process.cwd(), 'data', 'akira-actions.log')
  );
}

/** One JSON object per line. JSON.stringify escapes newlines, so nothing in a
 *  command string can forge a second log entry. Pure. */
export function formatActionLogLine(e: ActionLogEvent): string {
  const row: Record<string, unknown> = {
    at: e.at.toISOString(),
    target: e.target,
    event: e.event,
    command: e.command,
  };
  if (e.cwd !== undefined) row.cwd = e.cwd;
  if (e.exitCode !== undefined) row.exitCode = e.exitCode;
  if (e.status !== undefined) row.status = e.status;
  if (e.reason !== undefined) row.reason = e.reason;
  return JSON.stringify(row) + '\n';
}

/** Append to the log and mirror to stdout (journald). Best-effort: a logging
 *  failure must never take down a turn. */
export function appendActionLog(e: ActionLogEvent): void {
  const line = formatActionLogLine(e);
  console.log('[akira-action]', line.trimEnd());
  try {
    const p = actionLogPath();
    mkdirSync(dirname(p), { recursive: true });
    appendFileSync(p, line, 'utf8');
  } catch (err) {
    console.warn('[akira-action] log append failed:', err instanceof Error ? err.message : err);
  }
}
```

Then delete the old modules:

```bash
git rm src/lib/akira/shell-log.ts src/lib/akira/shell-log.test.ts
```

`room-shell.ts` still imports `appendShellLog` and will not compile until Task 7. That is expected — Task 7 is where it is rewritten. To keep this task independently committable, apply the minimal edit to `room-shell.ts` now: change its import to `import { appendActionLog } from './action-log'` and add `target: 'room'` to each of its four call sites.

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm exec tsx --test src/lib/akira/action-log.test.ts && pnpm exec tsc --noEmit`
Expected: PASS and a clean typecheck.

- [ ] **Step 5: Commit**

```bash
git add -A src/lib/akira/
git commit -m "refactor(akira): shell-log becomes action-log, carrying a target

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 3: `isSelfAffecting` — the self-restart classifier

**Files:**
- Create: `src/lib/akira/self-affecting.ts`
- Create: `src/lib/akira/self-affecting.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `isSelfAffecting(command: string): boolean`.

Per spec D5, a command that restarts or stops `mission-control` kills the turn
issuing it. This classifier decides which commands get the fire-and-forget
treatment in Task 7. It is a heuristic and a miss degrades gracefully — the turn
dies and the pre-dispatch log entry still explains why.

- [ ] **Step 1: Write the failing test**

Create `src/lib/akira/self-affecting.test.ts`:

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isSelfAffecting } from './self-affecting';

test('systemctl verbs that end the turn are caught', () => {
  for (const c of [
    'systemctl restart mission-control',
    'sudo systemctl restart mission-control',
    'systemctl stop mission-control.service',
    'sudo -n systemctl restart mission-control',
    'systemctl  restart   mission-control',
  ]) {
    assert.equal(isSelfAffecting(c), true, c);
  }
});

test('read-only systemctl verbs are NOT self-affecting', () => {
  for (const c of [
    'systemctl status mission-control',
    'systemctl is-active mission-control',
    'systemctl cat mission-control',
    'journalctl -u mission-control -n 50',
  ]) {
    assert.equal(isSelfAffecting(c), false, c);
  }
});

test('another unit is not self-affecting', () => {
  assert.equal(isSelfAffecting('systemctl restart cloudflared'), false);
  assert.equal(isSelfAffecting('systemctl restart akira-host-agent'), false);
});

test('a compound command containing a restart still counts', () => {
  assert.equal(isSelfAffecting('cd /srv/mission-control && systemctl restart mission-control'), true);
  assert.equal(isSelfAffecting('pnpm build; sudo systemctl restart mission-control'), true);
});

test('pkill / killall against the server process count', () => {
  assert.equal(isSelfAffecting('pkill -f "next start"'), true);
  assert.equal(isSelfAffecting('killall -9 node'), true);
});

test('ordinary commands do not', () => {
  for (const c of ['ls -la /srv/mission-control', 'cat .env', 'git -C /srv/mission-control status']) {
    assert.equal(isSelfAffecting(c), false, c);
  }
});

test('an empty or whitespace command is not self-affecting', () => {
  assert.equal(isSelfAffecting(''), false);
  assert.equal(isSelfAffecting('   '), false);
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm exec tsx --test src/lib/akira/self-affecting.test.ts`
Expected: FAIL — `Cannot find module './self-affecting'`.

- [ ] **Step 3: Implement**

Create `src/lib/akira/self-affecting.ts`:

```ts
// Spec D5. A command that restarts or stops Mission Control kills the turn that
// issued it: the host agent survives, the turn does not. Such commands are
// dispatched fire-and-forget, and AKIRA is told what she STARTED rather than
// handed a result that will never arrive.
//
// This is a heuristic and it will miss creative phrasings (a script that
// restarts the unit, `kill` by pid). A miss degrades to the ordinary case: the
// turn dies mid-flight and the pre-dispatch log entry still explains why. The
// classifier improves the message, not the safety.

/** The systemd unit Mission Control runs as. */
const UNIT = 'mission-control';

/** systemctl verbs that would take the process down. Read-only verbs (status,
 *  cat, is-active, show) are deliberately absent — she should use those freely. */
const DISRUPTIVE_VERBS = ['restart', 'stop', 'kill', 'try-restart', 'reload-or-restart'];

/** Matches e.g. `systemctl restart mission-control`, with or without a sudo
 *  prefix, extra flags, or a `.service` suffix — anywhere in a compound line. */
function hasDisruptiveSystemctl(command: string): boolean {
  const verbs = DISRUPTIVE_VERBS.join('|');
  const re = new RegExp(
    `\\bsystemctl\\b[^;&|]*?\\b(?:${verbs})\\b[^;&|]*?\\b${UNIT}(?:\\.service)?\\b`,
    'i',
  );
  return re.test(command);
}

/** `pkill -f "next start"`, `killall node` — blunt instruments that reach the
 *  server process. Narrow on purpose: `pkill` against something else is fine. */
function killsTheServerProcess(command: string): boolean {
  return /\b(?:pkill|killall)\b[^;&|]*\b(?:node|next|next start)\b/i.test(command);
}

export function isSelfAffecting(command: string): boolean {
  const c = (command ?? '').trim();
  if (!c) return false;
  return hasDisruptiveSystemctl(c) || killsTheServerProcess(c);
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm exec tsx --test src/lib/akira/self-affecting.test.ts`
Expected: PASS, 6 tests.

- [ ] **Step 5: Commit**

```bash
git add src/lib/akira/self-affecting.ts src/lib/akira/self-affecting.test.ts
git commit -m "feat(akira): classify commands that would end the turn issuing them

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 4: `room-agent/` becomes `mini-agent/`, with a mode

**Files:**
- Rename: `room-agent/` → `mini-agent/` (`git mv`)
- Create: `mini-agent/src/policy.ts`, `mini-agent/src/policy.test.ts`
- Modify: `mini-agent/src/config.ts`, `mini-agent/package.json`
- Modify: `package.json` (the `test` script's room-agent glob)
- Modify: `src/lib/protocol-copies.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `AgentMode = 'room' | 'host'`; `ExecPolicy = { mode: 'room'; roots: Roots } | { mode: 'host'; defaultCwd: string }`; `loadConfig()` returns `{ miniUrl, token, policy }`.

- [ ] **Step 1: Rename and re-wire the globs**

```bash
git mv room-agent mini-agent
```

In the repo root `package.json`, change the `test` script's `room-agent/src/*.test.ts` to `mini-agent/src/*.test.ts`.

In `mini-agent/package.json`, change `"name": "akira-room-agent"` to `"name": "akira-mini-agent"`.

In `src/lib/protocol-copies.test.ts`, change the `room-agent/src/protocol.ts` path to `mini-agent/src/protocol.ts`.

Run: `pnpm exec tsx --test src/lib/protocol-copies.test.ts && pnpm test`
Expected: PASS — the rename alone changes no behaviour.

- [ ] **Step 2: Write the failing policy test**

Create `mini-agent/src/policy.test.ts`:

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isRoom, isHost, type ExecPolicy } from './policy';

const room: ExecPolicy = { mode: 'room', roots: { room: '/home/akira/workshop', doorway: '/mnt/doorway' } };
const host: ExecPolicy = { mode: 'host', defaultCwd: '/' };

test('the policy narrows by mode', () => {
  assert.equal(isRoom(room), true);
  assert.equal(isHost(room), false);
  assert.equal(isHost(host), true);
  assert.equal(isRoom(host), false);
});

test('narrowing gives access to the mode-specific fields', () => {
  if (isRoom(room)) assert.equal(room.roots.doorway, '/mnt/doorway');
  else assert.fail('room policy should narrow to room');
  if (isHost(host)) assert.equal(host.defaultCwd, '/');
  else assert.fail('host policy should narrow to host');
});
```

- [ ] **Step 3: Run it to verify it fails**

Run: `pnpm exec tsx --test mini-agent/src/policy.test.ts`
Expected: FAIL — `Cannot find module './policy'`.

- [ ] **Step 4: Implement the policy and mode-aware config**

Create `mini-agent/src/policy.ts`:

```ts
// One agent codebase, two deployments. The room is path-scoped and gated; the
// host is neither — that is the entire point of sub-project C. Everything else
// (the wire, the reconnect loop, the process-group kill, the output cap) is
// shared, because duplicating shell-ops.ts would mean fixing every future bug
// in it twice.
import type { Roots } from './paths';

export type AgentMode = 'room' | 'host';

export type ExecPolicy =
  | { mode: 'room'; roots: Roots }
  | { mode: 'host'; defaultCwd: string };

export function isRoom(p: ExecPolicy): p is { mode: 'room'; roots: Roots } {
  return p.mode === 'room';
}

export function isHost(p: ExecPolicy): p is { mode: 'host'; defaultCwd: string } {
  return p.mode === 'host';
}
```

Replace `mini-agent/src/config.ts`:

```ts
import 'dotenv/config';
import type { ExecPolicy, AgentMode } from './policy';

export interface AgentConfig {
  miniUrl: string;
  token: string;
  mode: AgentMode;
  policy: ExecPolicy;
}

export function loadConfig(): AgentConfig {
  // Defaults to 'room' so an already-deployed container's .env keeps working
  // untouched after the rename.
  const mode: AgentMode = process.env.AGENT_MODE === 'host' ? 'host' : 'room';

  // Each target has its OWN credential, checked on the Mission Control side
  // against COMPANION_TOKEN / ROOM_COMPANION_TOKEN / HOST_COMPANION_TOKEN.
  // Never share one between targets.
  const token = (mode === 'host' ? process.env.HOST_TOKEN : process.env.ROOM_TOKEN) ?? '';
  if (!token) {
    throw new Error(
      mode === 'host'
        ? 'HOST_TOKEN is required (set it in mini-agent/.env on the host)'
        : 'ROOM_TOKEN is required (set it in mini-agent/.env in the room)',
    );
  }

  const policy: ExecPolicy =
    mode === 'host'
      ? { mode: 'host', defaultCwd: process.env.HOST_DEFAULT_CWD || '/' }
      : {
          mode: 'room',
          roots: {
            room: process.env.ROOM_ROOT || '/home/akira/workshop',
            doorway: process.env.ROOM_DOORWAY || '/mnt/doorway',
          },
        };

  return {
    // The room reaches Mission Control over the host bridge; the host agent is
    // already on the box, so it uses loopback.
    miniUrl:
      process.env.MINI_URL || (mode === 'host' ? 'http://127.0.0.1:3000' : 'http://10.0.0.1:3000'),
    token,
    mode,
    policy,
  };
}
```

`connection.ts` types its parameter as `RoomConfig`; change that import and
annotation to `AgentConfig`. It must also send the target on the stream URL —
find the `/api/companion/stream` URL it builds and append `?target=${cfg.mode}`
(the room previously relied on `?target=room`; keep that exact behaviour for
room mode, which `cfg.mode` now supplies).

- [ ] **Step 5: Run tests to verify they pass**

Run: `pnpm exec tsx --test mini-agent/src/*.test.ts && pnpm exec tsc --noEmit`
Expected: PASS. Every existing room test must still pass unchanged.

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "refactor(agent): room-agent becomes mini-agent with a room/host mode

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 5: `execShell` and `execFs` take an `ExecPolicy`

**Files:**
- Modify: `mini-agent/src/shell-ops.ts:19-50`, `mini-agent/src/fs-ops.ts:14-21`
- Test: `mini-agent/src/shell-ops.test.ts`, `mini-agent/src/fs-ops.test.ts`

**Interfaces:**
- Consumes: `ExecPolicy`, `isRoom`, `isHost` (Task 4).
- Produces: `execShell(policy: ExecPolicy, cmd: Command, timeoutMs?): Promise<Result>`; `execFs(policy: ExecPolicy, cmd: Command): Promise<Result>`.

In host mode: no `classifyShell` gate (D2), no `validatePathReal`. Everything
else — the process-group kill, the output cap, the SIGPIPE handling — is shared
untouched.

- [ ] **Step 1: Write the failing tests**

Append to `mini-agent/src/shell-ops.test.ts`:

```ts
import { type ExecPolicy } from './policy';

const hostPolicy: ExecPolicy = { mode: 'host', defaultCwd: '/' };

test('host mode runs a command the room gate would have blocked', async () => {
  // `sleep 30 &` is exactly what classifyShell refuses in the room (Decision 7).
  // On the host there is no gate at all (spec D2), so it must simply run.
  const r = await execShell(hostPolicy, {
    id: 'c1', action: 'shell', command: 'echo started',
  }, 10_000);
  assert.equal(r.status, 'ok');
  assert.equal(r.gated, undefined, 'host mode must never return a gated result');
  assert.match(r.text ?? '', /started/);
});

test('host mode honours an absolute cwd outside any room root', async () => {
  const r = await execShell(hostPolicy, {
    id: 'c2', action: 'shell', command: 'pwd', cwd: '/tmp',
  }, 10_000);
  assert.equal(r.status, 'ok');
  assert.match(r.text ?? '', /tmp/);
});

test('host mode still reports a non-zero exit code truthfully', async () => {
  const r = await execShell(hostPolicy, { id: 'c3', action: 'shell', command: 'exit 3' }, 10_000);
  assert.equal(r.status, 'ok');
  assert.equal(r.exitCode, 3);
});
```

Append to `mini-agent/src/fs-ops.test.ts`:

```ts
test('host mode reads a path no room root contains', async () => {
  const d = mkdtempSync(join(tmpdir(), 'mini-host-'));
  try {
    writeFileSync(join(d, 'x.txt'), 'hello');
    const r = await execFs({ mode: 'host', defaultCwd: '/' }, {
      id: 'f1', action: 'fs_read', path: join(d, 'x.txt'),
    });
    assert.equal(r.status, 'ok');
    assert.equal(r.text, 'hello');
  } finally { rmSync(d, { recursive: true, force: true }); }
});

test('host mode still refuses a path that does not exist, as an error not a block', async () => {
  const r = await execFs({ mode: 'host', defaultCwd: '/' }, {
    id: 'f2', action: 'fs_read', path: '/definitely/not/here.txt',
  });
  assert.equal(r.status, 'error');
  assert.equal(r.reason?.includes('ENOENT'), true);
});
```

- [ ] **Step 2: Run them to verify they fail**

Run: `pnpm exec tsx --test mini-agent/src/shell-ops.test.ts mini-agent/src/fs-ops.test.ts`
Expected: FAIL — the first argument is still `Roots`, so these are type errors.

- [ ] **Step 3: Implement**

In `mini-agent/src/shell-ops.ts`, change the import block and the signature/gate/cwd section only. Replace:

```ts
import { classifyShell } from './shell-gate';
import { validatePathReal } from './paths-real';
import type { Roots } from './paths';
```

with:

```ts
import { classifyShell } from './shell-gate';
import { validatePathReal } from './paths-real';
import { isRoom, type ExecPolicy } from './policy';
```

Replace the signature and the gate/cwd block (everything from `export async function execShell` down to and including the `let cwd = ...` block) with:

```ts
export async function execShell(
  policy: ExecPolicy,
  cmd: Command,
  timeoutMs = SHELL_TIMEOUT_MS,
): Promise<Result> {
  if (cmd.action !== 'shell') {
    return { id: cmd.id, status: 'error', reason: `unsupported action: ${cmd.action}` };
  }
  const command = (cmd.command ?? '').trim();
  if (!command) return { id: cmd.id, status: 'error', reason: 'empty command' };
  if (command.includes('\0')) return { id: cmd.id, status: 'error', reason: 'null byte in command' };

  let cwd: string;
  if (isRoom(policy)) {
    // Room only: the long-running gate (Decision 7) and the path scope.
    const gate = classifyShell(command);
    if (gate.gated && !cmd.approved) {
      // The ONLY 'blocked' cause an operator approval can clear. Every other
      // 'blocked' result below is a plain refusal — `gated` stays unset so
      // agent-shell.ts never mistakes it for something the operator can approve.
      return { id: cmd.id, status: 'blocked', gated: true, reason: gate.reason ?? 'gated command' };
    }
    cwd = policy.roots.room;
    if (cmd.cwd) {
      const verdict = await validatePathReal(policy.roots, cmd.cwd);
      if (!verdict.ok) return { id: cmd.id, status: 'blocked', reason: verdict.reason };
      cwd = verdict.abs;
    }
  } else {
    // Host: no gate, no path scope. Spec D1/D2 — this is the point of slice C1.
    cwd = cmd.cwd || policy.defaultCwd;
  }
```

Everything below (the `return new Promise<Result>(...)` body) is unchanged.

In `mini-agent/src/fs-ops.ts`, replace the import of `Roots` with
`import { isRoom, type ExecPolicy } from './policy';` and replace the signature
plus the validation block:

```ts
export async function execFs(policy: ExecPolicy, cmd: Command): Promise<Result> {
  if (cmd.action !== 'fs_list' && cmd.action !== 'fs_read' && cmd.action !== 'fs_write') {
    return { id: cmd.id, status: 'error', reason: `unsupported action: ${cmd.action}` };
  }

  let abs: string;
  if (isRoom(policy)) {
    const verdict = await validatePathReal(policy.roots, cmd.path ?? '');
    if (!verdict.ok) return { id: cmd.id, status: 'blocked', reason: verdict.reason };
    abs = verdict.abs;
  } else {
    // Host: no scope. A relative path resolves against the configured default
    // cwd so a bare "data/x.md" still means something predictable.
    const p = cmd.path ?? '';
    if (!p) return { id: cmd.id, status: 'error', reason: 'empty path' };
    abs = resolve(policy.defaultCwd, p);
  }
```

Add `resolve` to the existing `node:path` import in that file.

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm exec tsx --test mini-agent/src/*.test.ts && pnpm exec tsc --noEmit`
Expected: PASS — including every pre-existing room test, unchanged.

- [ ] **Step 5: Commit**

```bash
git add mini-agent/src/
git commit -m "feat(agent): execShell/execFs take a policy; host mode is unscoped and ungated

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 6: Wire the mode in `index.ts`

**Files:**
- Modify: `mini-agent/src/index.ts`

**Interfaces:**
- Consumes: `loadConfig()` (Task 4), `execShell`/`execFs` (Task 5).
- Produces: a runnable agent in both modes.

The doorway watcher is room-only: there is no doorway on the host, and
`watchDoorway` would throw on a missing path.

- [ ] **Step 1: Implement**

Replace `mini-agent/src/index.ts`:

```ts
import { loadConfig } from './config';
import { connect } from './connection';
import { execFs } from './fs-ops';
import { execShell } from './shell-ops';
import { watchDoorway } from './watcher';
import { isRoom } from './policy';
import type { Command } from './protocol';

const cfg = loadConfig();
const tag = `[${cfg.mode}]`;

// One-at-a-time chain so writes never interleave — same discipline as the
// laptop companion's command chain.
let chain: Promise<void> = Promise.resolve();

const conn = connect(cfg, (cmd: Command) => {
  chain = chain
    .then(async () => {
      console.log(tag, 'exec', cmd.action, cmd.command ?? cmd.path ?? '');
      const result = cmd.action === 'shell'
        ? await execShell(cfg.policy, cmd)
        : await execFs(cfg.policy, cmd);
      if (result.status !== 'ok') console.warn(tag, result.status, result.reason);
      await conn.postResult(result);
    })
    .catch((err) => console.error(tag, 'command chain error:', err));
});

// Room only: there is no doorway on the host, and watchDoorway would throw on a
// path that isn't there.
const watcher = isRoom(cfg.policy)
  ? watchDoorway(cfg.policy.roots, (drop) => {
      console.log(tag, 'drop', drop.zone, drop.name, `${drop.sizeBytes}b`);
      void conn.postDrop(drop);
    })
  : null;

console.log(
  tag,
  'AKIRA mini agent started;',
  isRoom(cfg.policy)
    ? `room: ${cfg.policy.roots.room} doorway: ${cfg.policy.roots.doorway}`
    : `host, default cwd: ${cfg.policy.defaultCwd}`,
);

function shutdown() {
  console.log(`\n${tag} shutting down…`);
  watcher?.stop();
  conn.stop();
  process.exit(0);
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
```

- [ ] **Step 2: Verify both modes start**

Run: `pnpm exec tsc --noEmit`
Expected: clean.

Run (host mode smoke, from the repo root):
```bash
AGENT_MODE=host HOST_TOKEN=dummy MINI_URL=http://127.0.0.1:9 pnpm -C mini-agent start
```
Expected: it prints `[host] AKIRA mini agent started; host, default cwd: /` and then retries the connection (the port is closed by design). Ctrl-C to stop. It must NOT throw about a missing doorway.

- [ ] **Step 3: Commit**

```bash
git add mini-agent/src/index.ts
git commit -m "feat(agent): wire the mode; the doorway watcher is room-only

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 7: `agent-shell.ts` — dispatch with a target and D5 handling

**Files:**
- Create: `src/lib/akira/agent-shell.ts` (from `room-shell.ts`)
- Create: `src/lib/akira/agent-shell.test.ts` (from `room-shell.test.ts`)
- Delete: `src/lib/akira/room-shell.ts`, `src/lib/akira/room-shell.test.ts`

**Interfaces:**
- Consumes: `appendActionLog` (Task 2), `isSelfAffecting` (Task 3), `CompanionTarget` (Task 1).
- Produces: `runShell(command, cwd, target, ctx): Promise<ToolResult>`; `SHELL_TIMEOUT_MS`.

Two behaviours differ by target. Room keeps its operator gate exactly as it is.
Host never gates, and a self-affecting command is logged as `intent` and
dispatched without awaiting the result.

- [ ] **Step 1: Write the failing test**

Create `src/lib/akira/agent-shell.test.ts` by copying `room-shell.test.ts`,
adding `'room'` as the third argument to every existing `runShell(...)` call, and
appending:

```ts
test('a self-affecting host command returns immediately and never awaits a result', async () => {
  let sent = 0;
  let awaited = false;
  mockSendCommand(() => {
    sent += 1;
    // A restart kills the server: this promise would never settle in reality.
    return { id: 'x', result: new Promise<never>(() => { awaited = true; }) };
  });

  const r = await runShell('sudo systemctl restart mission-control', undefined, 'host', ctx());

  assert.equal(sent, 1, 'the command was dispatched');
  assert.equal(r.isError, undefined);
  assert.match(
    r.content[0].text,
    /restart/i,
    'she is told what was started, not handed a result that will never arrive',
  );
  assert.equal(awaited, true, 'the promise was created but runShell did not block on it');
});

test('an ordinary host command is awaited normally', async () => {
  mockSendCommand(() => ({ id: 'x', result: Promise.resolve({ id: 'x', status: 'ok', text: 'hi', exitCode: 0 }) }));
  const r = await runShell('echo hi', undefined, 'host', ctx());
  assert.match(r.content[0].text, /hi/);
});

test('the host path never opens an operator gate', async () => {
  let gateOpened = false;
  mockOpenGate(() => { gateOpened = true; return Promise.resolve(true); });
  mockSendCommand(() => ({
    id: 'x',
    // Even if an agent wrongly returned gated:true, the host path must not gate.
    result: Promise.resolve({ id: 'x', status: 'blocked', gated: true, reason: 'nope' }),
  }));
  await runShell('echo hi', undefined, 'host', ctx());
  assert.equal(gateOpened, false);
});
```

Reuse whatever `mockSendCommand` / `mockOpenGate` / `ctx` helpers
`room-shell.test.ts` already defines; if it stubs the modules differently, follow
its existing pattern rather than inventing a new one.

- [ ] **Step 2: Run it to verify it fails**

Run: `pnpm exec tsx --test src/lib/akira/agent-shell.test.ts`
Expected: FAIL — `Cannot find module './agent-shell'`.

- [ ] **Step 3: Implement**

Create `src/lib/akira/agent-shell.ts` from `room-shell.ts` with these changes:

```ts
import { sendCommand } from '@/lib/companion/registry';
import type { CompanionTarget } from '@/lib/companion/registry';
import { openGate } from '@/lib/companion/gates';
import { appendActionLog } from './action-log';
import { isSelfAffecting } from './self-affecting';
import { type AkiraToolContext, type ToolResult, ok, err } from './tool-actions';

export const SHELL_TIMEOUT_MS = 150_000;

export async function runShell(
  command: string,
  cwd: string | undefined,
  target: CompanionTarget,
  ctx: AkiraToolContext,
): Promise<ToolResult> {
  // Spec D5: a command that takes Mission Control down ends this turn. Log the
  // INTENT before dispatch — no result will ever arrive to log — then fire and
  // forget, and tell her what she started rather than a fabricated outcome.
  if (target === 'host' && isSelfAffecting(command)) {
    appendActionLog({ at: new Date(), target, event: 'intent', command, cwd });
    void sendCommand({ action: 'shell', command, cwd }, SHELL_TIMEOUT_MS, target).result.catch(
      () => { /* the server is going down; nobody is left to receive this */ },
    );
    return ok(
      `Started: ${command}\n\nThis restarts Mission Control, which ends this turn — I will not see the result. Check back in a moment.`,
    );
  }

  appendActionLog({ at: new Date(), target, event: 'dispatch', command, cwd });
  try {
    const first = await sendCommand({ action: 'shell', command, cwd }, SHELL_TIMEOUT_MS, target).result;
    // Room only: the operator gate. The host never gates (spec D2), so a
    // `gated` flag arriving from a host agent is ignored rather than honoured.
    if (!first.gated || target !== 'room') {
      appendActionLog({ at: new Date(), target, event: 'result', command, cwd, exitCode: first.exitCode, status: first.status });
      return present(first);
    }
```

Everything from the gate branch onward is the existing `room-shell.ts` body with
`'room'` hard-coded in its `sendCommand` retry replaced by `target`, and every
`appendShellLog({...})` replaced by `appendActionLog({ ..., target })`. Keep
`present()` exactly as it is.

Then:

```bash
git rm src/lib/akira/room-shell.ts src/lib/akira/room-shell.test.ts
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm exec tsx --test src/lib/akira/agent-shell.test.ts && pnpm exec tsc --noEmit`
Expected: PASS. `room-tools.ts` still imports `runShell` from `./room-shell` and will fail the typecheck — fix that import to `./agent-shell` and pass `'room'` as the third argument for now; Task 8 replaces the call site properly.

- [ ] **Step 5: Commit**

```bash
git add -A src/lib/akira/
git commit -m "feat(akira): agent-shell dispatches by target; a self-restart is fire-and-forget

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 8: The tool surface — `list` / `read` / `write` / `bash` with a target

**Files:**
- Modify: `src/lib/akira/room-tools.ts` (rename the file to `src/lib/akira/agent-tools.ts`)
- Modify: `src/lib/akira/tool-actions.ts` (tool-name constants)
- Modify: `src/lib/akira/tools.ts`, `src/lib/akira-turn.ts`
- Modify: `src/lib/akira/prompt.ts`, `src/lib/akira/agent.ts`, `scripts/seed.ts`

**Interfaces:**
- Consumes: `runShell(command, cwd, target, ctx)` (Task 7), `isOnline` (Task 1).
- Produces: `AGENT_TOOL_NAMES`, exporting `AKIRA_LIST`, `AKIRA_READ`, `AKIRA_WRITE`, `AKIRA_BASH`; `agentToolDefs(ctx)`.

Per spec D3 the `room_*` names are removed, not aliased — a dead alias costs
tokens on every turn forever.

- [ ] **Step 1: Rename constants**

In `src/lib/akira/tool-actions.ts`, replace the four `AKIRA_ROOM_*` constants:

```ts
export const AKIRA_LIST = 'mcp__akira__list';
export const AKIRA_READ = 'mcp__akira__read';
export const AKIRA_WRITE = 'mcp__akira__write';
export const AKIRA_BASH = 'mcp__akira__bash';
```

- [ ] **Step 2: Implement the tools**

`git mv src/lib/akira/room-tools.ts src/lib/akira/agent-tools.ts`, then replace
its body:

```ts
import 'server-only';
import { z } from 'zod';
import { tool } from '@anthropic-ai/claude-agent-sdk';
import { sendCommand, type CompanionTarget } from '@/lib/companion/registry';
import {
  type AkiraToolContext,
  type ToolResult,
  ok,
  err,
  AKIRA_LIST,
  AKIRA_READ,
  AKIRA_WRITE,
  AKIRA_BASH,
} from './tool-actions';
import { appendActionLog } from './action-log';
import { runShell } from './agent-shell';

export { AKIRA_LIST, AKIRA_READ, AKIRA_WRITE, AKIRA_BASH };
export const AGENT_TOOL_NAMES = [AKIRA_LIST, AKIRA_READ, AKIRA_WRITE, AKIRA_BASH];

const FS_TIMEOUT_MS = 30_000;

/** 'host' is the Mini itself; 'room' is her container. Both are on the same box. */
const targetArg = z
  .enum(['host', 'room'])
  .describe("Which machine: 'host' is the Mini itself (Mission Control, your vault, the operator's home); 'room' is your container.");

async function runFs(
  action: 'fs_list' | 'fs_read' | 'fs_write',
  target: CompanionTarget,
  args: Record<string, unknown>,
): Promise<ToolResult> {
  const label = `${action} ${String(args.path ?? '')}`;
  appendActionLog({ at: new Date(), target, event: 'dispatch', command: label });
  try {
    const r = await sendCommand({ action, ...args }, FS_TIMEOUT_MS, target).result;
    appendActionLog({ at: new Date(), target, event: 'result', command: label, status: r.status });
    if (r.status === 'blocked') {
      return ok(`That path was refused (${r.reason ?? 'refused'}). Do not retry the same path.`);
    }
    if (r.status === 'error') return err(r.reason ?? 'the action failed');
    return ok(r.text ?? 'done');
  } catch (e) {
    const reason = e instanceof Error ? e.message : String(e);
    appendActionLog({ at: new Date(), target, event: 'result', command: label, status: 'error', reason });
    return err(reason);
  }
}

export function agentToolDefs(ctx: AkiraToolContext) {
  return [
    tool(
      'list',
      'List a directory on the Mini. Use target "host" for the machine itself (Mission Control at /srv/mission-control, your vault at /srv/mission-control/data/akira-memory, the operator\'s home) or "room" for your container.',
      { target: targetArg, path: z.string().min(1).describe('Directory to list.') },
      (a) => runFs('fs_list', a.target, { path: a.path }),
    ),
    tool(
      'read',
      'Read a text file on the Mini. Large files are refused. Use this to read your own vault documents, your SOUL, a skill, or Mission Control\'s source.',
      { target: targetArg, path: z.string().min(1) },
      (a) => runFs('fs_read', a.target, { path: a.path }),
    ),
    tool(
      'write',
      "Write a text file on the Mini. Parent directories are created. For your vault's documents prefer vault_write, and for memory notes use remember — those keep the note model and the indexes correct.",
      { target: targetArg, path: z.string().min(1), content: z.string() },
      (a) => runFs('fs_write', a.target, { path: a.path, content: a.content }),
    ),
    tool(
      'bash',
      'Run a shell command on the Mini. Target "host" runs as root on the machine itself — systemctl, journalctl, git, the deploy. Target "room" runs in your container, where commands that would outlive the turn pause for the operator\'s approval. Restarting mission-control ends your turn; say what you are doing before you do it.',
      {
        target: targetArg,
        command: z.string().min(1).describe('The command line, run through bash -lc.'),
        cwd: z.string().optional().describe('Working directory.'),
      },
      (a) => runShell(a.command, a.cwd, a.target, ctx),
    ),
  ];
}
```

- [ ] **Step 3: Rewire the server and the turn**

In `src/lib/akira/tools.ts`: replace the `roomToolDefs` import with
`agentToolDefs` from `./agent-tools`, and replace the room spread. The room
tools were gated on `isOnline('room')`; the merged tools should be present when
**either** agent is online, since the target is now an argument:

```ts
    ...(isOnline('room') || isOnline('host') ? agentToolDefs(ctx) : []),
```

In `src/lib/akira-turn.ts`: replace the `ROOM_TOOL_NAMES` import with
`AGENT_TOOL_NAMES` from `./akira/agent-tools`, and replace `...ROOM_TOOL_NAMES`
in `extraAllowedTools` with `...AGENT_TOOL_NAMES`.

- [ ] **Step 4: Update her prompt**

In `src/lib/akira/prompt.ts`, replace the `## YOUR ROOM` section's first
paragraph with:

```
You have a container on the Mini that is yours, and you can also reach the Mini itself.
\`list\`/\`read\`/\`write\`/\`bash\` all take a \`target\`: "host" is the machine — Mission Control at
\`/srv/mission-control\`, your own vault at \`/srv/mission-control/data/akira-memory\`, the operator's
home, systemd, the logs. "room" is your container: install what you need, convert documents, use git,
break it if you have to — it can be restored from a snapshot. The host cannot.

On the host you run as root and nothing is gated. Every command you run is logged where A'Keem can
read it, so act as if he is reading — because he is. Restarting \`mission-control\` ends your own turn:
say what you are about to do before you do it, and expect not to see the result.
```

Also update the tools list line added in v1.23.0 — replace the "You have NO file
tools" clause with:

```
- list / read / write / bash — the Mini, on target "host" or "room". You DO have file access now.
```

- [ ] **Step 5: Run the full suite**

Run: `pnpm test && pnpm exec tsc --noEmit`
Expected: PASS, clean typecheck. Any test still importing `room-tools` or
`ROOM_TOOL_NAMES` must be updated to the new names.

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "feat(akira): one tool surface for both machines, selected by target

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 9: The unit file and the runbook

**Files:**
- Create: `deploy/akira-host-agent.service`
- Modify: `docs/runbook-mini-desktop.md`

**Interfaces:**
- Consumes: everything above.
- Produces: the operator procedure. No code.

- [ ] **Step 1: Write the unit**

Create `deploy/akira-host-agent.service`:

```ini
[Unit]
Description=AKIRA host agent (unscoped root reach on the Mini)
After=network.target mission-control.service

[Service]
Type=simple
# Root by design — sub-project C. See
# docs/superpowers/specs/2026-08-22-akira-host-reach-design.md
User=root
WorkingDirectory=/srv/mission-control/mini-agent
EnvironmentFile=/srv/mission-control/mini-agent/.env.host
ExecStart=/usr/bin/env pnpm start
Restart=on-failure
RestartSec=5
# Deliberately NOT bound to mission-control: the agent must survive the restarts
# AKIRA issues through it, which is the whole point of spec D5.

[Install]
WantedBy=multi-user.target
```

- [ ] **Step 2: Write the runbook section**

Append to `docs/runbook-mini-desktop.md`:

````markdown
## Host agent (sub-project C, slice C1)

The host agent gives AKIRA root reach on the Mini. Installing it is an operator
step: root is NOPASSWD-allowlisted for `restart`/`daemon-reload` only, so this
cannot be automated from a session.

1. Mint the credential and put **the same value** in two places:
   ```bash
   HOST_TOKEN=$(openssl rand -hex 32)
   # Mission Control's side:
   echo "HOST_COMPANION_TOKEN=$HOST_TOKEN" | sudo -u mc tee -a /srv/mission-control/.env
   # The agent's side:
   printf 'AGENT_MODE=host\nHOST_TOKEN=%s\n' "$HOST_TOKEN" \
     | sudo tee /srv/mission-control/mini-agent/.env.host
   sudo chmod 600 /srv/mission-control/mini-agent/.env.host
   ```
   It must differ from `COMPANION_TOKEN` and `ROOM_COMPANION_TOKEN` — `resolveTarget`
   checks laptop first, so a duplicated value silently downgrades the host.

2. Install and start the unit:
   ```bash
   sudo cp /srv/mission-control/deploy/akira-host-agent.service /etc/systemd/system/
   sudo systemctl daemon-reload
   sudo systemctl enable --now akira-host-agent
   ```

3. Restart Mission Control so it picks up `HOST_COMPANION_TOKEN`:
   ```bash
   sudo systemctl restart mission-control
   ```

4. Verify — the agent must report connected, and `systemctl --failed` must be empty:
   ```bash
   journalctl -u akira-host-agent -n 20 --no-pager
   systemctl --failed
   ```

5. Re-provision the room's copy after the `room-agent` → `mini-agent` rename.
   The container keeps running the old copy until you do this; it is safe to
   defer, but the two will drift.

6. Confirm in a live turn: ask AKIRA to run `systemctl is-active mission-control`
   on target `host`. Then check the log carries it:
   ```bash
   sudo -u mc tail -5 /srv/mission-control/data/akira-actions.log
   ```
````

- [ ] **Step 3: Commit**

```bash
git add deploy/akira-host-agent.service docs/runbook-mini-desktop.md
git commit -m "docs(runbook): install the host agent

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

## Finishing

Run `pnpm test` and `pnpm exec tsc --noEmit` one final time — both must be green
before the branch merges. Then follow `superpowers:finishing-a-development-branch`
to merge the feature branch into `dev`, and `ship-mc-feature` Phase 4/5 to
release and deploy.

**The reseed is mandatory.** Her prompt changed in Task 8, and a stale seeded
prompt is a recurring trap in this repo.

**Deploy order:** install and start the host agent (runbook above) BEFORE
restarting Mission Control, so the token exists when MC reloads its env.
