# AKIRA's Room — Slice 2 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give AKIRA a shell inside her room — gated only on long-running processes, logged where she cannot rewrite the log — and a doorway watcher that turns a file dropped in `~/AKIRA/inbox` into a proposal the operator approves before any full-cost turn runs.

**Architecture:** Three layers, in dependency order. First the credential split: `verifyCompanionToken` becomes target-aware so the room holds a secret that is useless anywhere but the room — a blocker, because a shell makes that secret readable. Then `shell` joins the `fs_*` actions on the existing `Command`/`Result` wire; the room agent classifies each command, refuses long-running ones unless `approved`, and runs the rest under a wall-clock timeout in its own process group. A pure in-memory gate broker (mirroring `registry.ts`) parks the refused command while the HUD asks the operator, so AKIRA gets the real output in the same turn. Finally a watcher in the room reports doorway drops to a new token-authed endpoint: `inbox/` becomes a row in `room_proposals` surfaced through the existing proposal UI and Discord poller, `playground/` starts a turn directly.

**Tech Stack:** TypeScript, Next.js (App Router), Drizzle + SQLite, `node:test` via `tsx`, LXD, pnpm workspaces.

**Spec:** `docs/superpowers/specs/2026-08-13-akiras-room-design.md` — read "Slice 2 — decisions (2026-08-15)" and "Carried into slice 2" before starting.

## Global Constraints

- **Slice 1 is deployed and live** as v1.21.0+ (container `akira-room`, agent connected, doorway mounted). This plan builds on that running system.
- **`protocol.ts` has THREE byte-identical copies:** `src/lib/companion/protocol.ts`, `companion/src/protocol.ts`, `room-agent/src/protocol.ts`. Any change to one changes all three. `src/lib/companion/protocol-copies.test.ts` enforces it and will fail the build otherwise.
- **Imports are extensionless.** `import { x } from './paths'` — never `'./paths.ts'`. The `.ts` extension breaks `tsc` and the Next build.
- **Tests run from the repo root** via `pnpm test`, which already globs `src/lib/*.test.ts`, `src/lib/akira/*.test.ts`, `src/lib/companion/*.test.ts`, `companion/src/*.test.ts`, and `room-agent/src/*.test.ts`. New test files in those directories are picked up with no script change.
- **Development is on Windows; the room is Linux.** Two of this slice's test files exercise POSIX-only behaviour — spawning `bash` with a process group (`shell-ops.test.ts`) and creating symlinks without elevation (`paths-real.test.ts`). Both guard on `process.platform` and skip on Windows, so `pnpm test` stays green on the laptop. They run for real on the Mini; Task 16 verifies the same behaviour end to end there.
- **The registry's unregister rejection loop is already fixed** (`aa4f400`, ahead of this slice). Carried-prerequisite 3 needs no work — do not re-apply it.
- **Default target is `'laptop'`** everywhere it is optional. The deployed laptop companion sends no `?target=` and must keep working untouched.
- **Egress from the room stays open** (Decision 4). Do not add allowlists, proxies, or command-string network filtering — the spec rejects all three by name.
- **Doorway writes are NOT gated** (Decision 7). `fs_write` to the doorway ships ungated in slice 1; `shell` must not gate it either. The folder carries the permission.
- **`Bash` gates exactly one thing: long-running or unbounded processes** (Decision 7). Not "irreversible-looking" commands. Not `rm`. Not `git push`.
- **Commits and pushes are ungated** (Decision 6). The workshop remote is a bare repo on the Mini.
- **Never edit `/srv/mission-control` directly.** It is the running application.
- **The room can never reach prod.** No mount, no route, no credential.
- Release target for this slice: **v1.22.0**.

---

### Task 1: Per-target companion secrets (the pure core)

Decision 5. Today `verifyCompanionToken` checks one shared secret, so `ROOM_TOKEN === COMPANION_TOKEN` and the room authenticates as the same principal as the laptop. A compromised room could connect as `?target=laptop`, displace the operator's real companion, and receive browser commands meant for the machine holding his logged-in sessions. Slice 1 left this reachable only in theory — AKIRA had no shell. This slice hands her one, so the split lands first.

`tokenMatches` is already the reusable pure core; only the layer above it changes.

**Files:**
- Modify: `src/lib/companion/auth.ts`
- Modify: `src/lib/companion/registry.ts`
- Test: `src/lib/companion/auth.test.ts`
- Test: `src/lib/companion/registry.test.ts`

**Interfaces:**
- Consumes: `tokenMatches(input, secret): boolean` (unchanged), `CompanionTarget = 'laptop' | 'room'` from `./registry`.
- Produces:
  - `CompanionSecrets = { laptop: string | null | undefined; room: string | null | undefined }`
  - `resolveTarget(input: string | null | undefined, secrets: CompanionSecrets): CompanionTarget | null` — pure.
  - `verifyCompanionToken(input: string | null | undefined, target?: CompanionTarget): boolean` — target defaults to `'laptop'`.
  - `identifyCompanionToken(input: string | null | undefined): CompanionTarget | null`
  - `resolveResult(r: Result, target?: CompanionTarget): void` — when `target` is given, a result only settles a command dispatched to that same target.

- [ ] **Step 1: Write the failing tests for the pure resolver**

Append to `src/lib/companion/auth.test.ts`:

```ts
import { resolveTarget } from './auth';

const SECRETS = { laptop: 'laptop-secret', room: 'room-secret' };

test('resolveTarget identifies the laptop secret', () => {
  assert.equal(resolveTarget('laptop-secret', SECRETS), 'laptop');
});

test('resolveTarget identifies the room secret', () => {
  assert.equal(resolveTarget('room-secret', SECRETS), 'room');
});

test('the room secret does NOT authenticate as the laptop', () => {
  // This is the whole point of Decision 5: a compromised room must not be able
  // to connect as ?target=laptop and receive the operator's browser commands.
  assert.notEqual(resolveTarget('room-secret', SECRETS), 'laptop');
});

test('resolveTarget returns null for an unknown token', () => {
  assert.equal(resolveTarget('neither', SECRETS), null);
});

test('resolveTarget returns null when the token is empty', () => {
  assert.equal(resolveTarget('', SECRETS), null);
  assert.equal(resolveTarget(undefined, SECRETS), null);
});

test('an unset room secret authenticates nobody as the room', () => {
  // Fail closed. Falling back to COMPANION_TOKEN would silently re-create the
  // very hole this task closes.
  assert.equal(resolveTarget('laptop-secret', { laptop: 'laptop-secret', room: undefined }), 'laptop');
  assert.equal(resolveTarget('anything', { laptop: 'laptop-secret', room: '' }), null);
});

test('when both secrets are the same value, laptop wins and the room fails closed', () => {
  // A misconfiguration (operator copies COMPANION_TOKEN into ROOM_COMPANION_TOKEN)
  // must be loud, not silent: the room's connect attempts 401 in its retry loop.
  const same = { laptop: 'shared', room: 'shared' };
  assert.equal(resolveTarget('shared', same), 'laptop');
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm exec tsx --test src/lib/companion/auth.test.ts`
Expected: FAIL — `resolveTarget is not a function` / no export named `resolveTarget`.

- [ ] **Step 3: Implement the target-aware auth layer**

Replace the bottom half of `src/lib/companion/auth.ts` (keep `tokenMatches` exactly as it is):

```ts
import type { CompanionTarget } from './registry';

/** The two shared secrets, one per target. Passed in so the resolver stays pure. */
export interface CompanionSecrets {
  laptop: string | null | undefined;
  room: string | null | undefined;
}

/**
 * Which target a presented token authenticates as, or null for none.
 * Pure — the caller supplies the secrets.
 *
 * Laptop is checked first, so if the operator ever sets both env vars to the
 * same value the room fails closed (loudly, in its retry loop) rather than
 * silently inheriting the laptop's authority.
 */
export function resolveTarget(
  input: string | null | undefined,
  secrets: CompanionSecrets,
): CompanionTarget | null {
  if (tokenMatches(input, secrets.laptop)) return 'laptop';
  if (tokenMatches(input, secrets.room)) return 'room';
  return null;
}

function envSecrets(): CompanionSecrets {
  return { laptop: process.env.COMPANION_TOKEN, room: process.env.ROOM_COMPANION_TOKEN };
}

/** True iff the presented token authenticates as exactly `target` (constant-time). */
export function verifyCompanionToken(
  input: string | null | undefined,
  target: CompanionTarget = 'laptop',
): boolean {
  return resolveTarget(input, envSecrets()) === target;
}

/** Which target the presented token authenticates as, or null. For routes that
 *  serve both machines and learn the target from the credential itself. */
export function identifyCompanionToken(input: string | null | undefined): CompanionTarget | null {
  return resolveTarget(input, envSecrets());
}
```

The `import type { CompanionTarget } from './registry'` is type-only and creates no runtime cycle — `registry.ts` does not import `auth.ts`.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `pnpm exec tsx --test src/lib/companion/auth.test.ts`
Expected: PASS, including the pre-existing `tokenMatches` tests.

- [ ] **Step 5: Write the failing test for target-matched result settling**

Append to `src/lib/companion/registry.test.ts`:

```ts
test('a result may only settle a command dispatched to its own target', async () => {
  // Defence in depth behind the token split: even if a credential leaked, a
  // POST from the room must not settle a command that went to the laptop.
  const unregL = registerCompanion({ send: () => {} }, 'laptop');
  const unregR = registerCompanion({ send: () => {} }, 'room');

  const laptopCmd = sendCommand({ action: 'read' }, 1000, 'laptop');

  resolveResult({ id: laptopCmd.id, status: 'ok', text: 'from the room' }, 'room');
  // Still pending — the room's post was ignored.
  resolveResult({ id: laptopCmd.id, status: 'ok', text: 'from the laptop' }, 'laptop');
  assert.equal((await laptopCmd.result).text, 'from the laptop');

  unregL();
  unregR();
});

test('resolveResult with no target still settles (back-compat)', async () => {
  const unreg = registerCompanion({ send: () => {} }, 'laptop');
  const cmd = sendCommand({ action: 'read' }, 1000);
  resolveResult({ id: cmd.id, status: 'ok', text: 'ok' });
  assert.equal((await cmd.result).text, 'ok');
  unreg();
});
```

- [ ] **Step 6: Run it to verify it fails**

Run: `pnpm exec tsx --test src/lib/companion/registry.test.ts`
Expected: FAIL — the first test times out or resolves with `'from the room'`, because `resolveResult` ignores its second argument today.

- [ ] **Step 7: Add the target check to `resolveResult`**

In `src/lib/companion/registry.ts`:

```ts
export function resolveResult(r: Result, target?: CompanionTarget): void {
  const p = pending.get(r.id);
  if (!p) return;
  // When the caller knows which machine posted this result, a result may only
  // settle a command that was dispatched to that same machine.
  if (target && p.target !== target) return;
  clearTimeout(p.timer);
  pending.delete(r.id);
  p.resolve(r);
}
```

- [ ] **Step 8: Run the tests to verify they pass**

Run: `pnpm exec tsx --test src/lib/companion/registry.test.ts`
Expected: PASS — all pre-existing registry tests included.

- [ ] **Step 9: Commit**

```bash
git add src/lib/companion/auth.ts src/lib/companion/auth.test.ts src/lib/companion/registry.ts src/lib/companion/registry.test.ts
git commit -m "feat(companion): per-target token verification (the room gets its own secret)"
```

---

### Task 2: Wire the per-target secret through every route and config

Task 1 changed the core; nothing calls it with a target yet, so the room still authenticates as the laptop. This task closes that, and it is the reviewer gate that matters: after it, the room's credential is useless anywhere but the room.

Five routes call `verifyCompanionToken`. Three of them are laptop-only by nature (`ingest`, `writeback`, `writeback/list` — they move repos between the operator's laptop and the Mini) and must reject a room token outright. `stream` learns its target from `?target=` and must verify against *that* target's secret. `result` carries no target on the wire, so it identifies the target from the credential and passes it to `resolveResult`.

**Files:**
- Modify: `src/app/api/companion/stream/route.ts`
- Modify: `src/app/api/companion/result/route.ts`
- Modify: `src/app/api/companion/ingest/route.ts:20`
- Modify: `src/app/api/companion/writeback/route.ts:21`
- Modify: `src/app/api/companion/writeback/list/route.ts:14`
- Modify: `.env.example`
- Modify: `room-agent/.env.example`
- Modify: `room-agent/src/config.ts`
- Modify: `docs/runbook-mini-desktop.md`

**Interfaces:**
- Consumes: `verifyCompanionToken(input, target)`, `identifyCompanionToken(input)`, `resolveResult(r, target)`, `targetFromParam(raw)`.
- Produces: a new env var `ROOM_COMPANION_TOKEN` on the Mission Control host, distinct from `COMPANION_TOKEN`. The room agent's own `ROOM_TOKEN` keeps its name and gets the new value.

- [ ] **Step 1: Make the stream route verify against the claimed target**

In `src/app/api/companion/stream/route.ts`, swap the order so the target is known before the token is checked:

```ts
export async function GET(req: Request) {
  const params = new URL(req.url).searchParams;
  const token = params.get('token');
  const target = targetFromParam(params.get('target'));
  // Verify against THIS target's secret — a room credential cannot claim
  // ?target=laptop and displace the operator's real companion.
  if (!verifyCompanionToken(token, target)) {
    return new Response('Unauthorized', { status: 401 });
  }

  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      startCompanionStream({
        controller,
        register: (sink) => registerCompanion(sink, target),
        signal: req.signal,
      });
    },
  });
  // …headers unchanged
}
```

- [ ] **Step 2: Make the result route identify its poster**

In `src/app/api/companion/result/route.ts`:

```ts
import { resolveResult } from '@/lib/companion/registry';
import type { Result } from '@/lib/companion/protocol';
import { identifyCompanionToken } from '@/lib/companion/auth';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(req: Request) {
  // Both machines post here, so the target comes from the credential itself.
  const target = identifyCompanionToken(req.headers.get('x-companion-token'));
  if (!target) {
    return new Response('Unauthorized', { status: 401 });
  }
  const body = (await req.json().catch(() => null)) as Result | null;
  if (!body || !body.id || !body.status) {
    return new Response('bad result', { status: 400 });
  }
  resolveResult(body, target);
  return Response.json({ ok: true });
}
```

- [ ] **Step 3: Pin the three laptop-only routes to `'laptop'`**

In each of `src/app/api/companion/ingest/route.ts`, `src/app/api/companion/writeback/route.ts`, and `src/app/api/companion/writeback/list/route.ts`, change the single guard line:

```ts
  // Laptop-only: these move repositories between the operator's machine and the
  // Mini. A room credential has no business here.
  if (!verifyCompanionToken(token, 'laptop')) {
```

Leave everything else in those files alone.

- [ ] **Step 4: Add the new env var to `.env.example`**

Replace the `COMPANION_TOKEN` block in `.env.example` (around line 41):

```
# Shared secret the laptop Companion uses to authenticate to the Mini.
COMPANION_TOKEN=
# Shared secret AKIRA's room container uses. MUST be a DIFFERENT value from
# COMPANION_TOKEN — the room holds this on disk, and a shell in the room can
# read it. Unset means the room cannot connect at all (fail closed).
ROOM_COMPANION_TOKEN=
```

- [ ] **Step 5: Correct the room agent's config comment and example**

`room-agent/.env.example`, first two lines:

```
# The ROOM's own secret — must match ROOM_COMPANION_TOKEN on the Mission Control
# host, and must NOT equal that host's COMPANION_TOKEN.
ROOM_TOKEN=
```

`room-agent/src/config.ts` — the error string stays, the comment above `miniUrl` stays; add one line to the doc block:

```ts
export function loadConfig(): RoomConfig {
  // ROOM_TOKEN is the room's OWN credential (Mission Control checks it against
  // ROOM_COMPANION_TOKEN). It is deliberately not the laptop companion's token.
  const token = process.env.ROOM_TOKEN ?? '';
  if (!token) throw new Error('ROOM_TOKEN is required (set it in room-agent/.env)');
```

- [ ] **Step 6: Record the split in the runbook**

Append to `docs/runbook-mini-desktop.md`, under a new `## Slice 2 — the room's own credential` heading:

```markdown
The room no longer shares the laptop's secret. On the Mini:

    # generate a fresh secret, distinct from COMPANION_TOKEN
    openssl rand -hex 32

Set it as `ROOM_COMPANION_TOKEN` in `/srv/mission-control/.env`, restart Mission
Control, then set the SAME value as `ROOM_TOKEN` in the container's
`/home/akira/room-agent/.env` and restart `akira-room`.

**Order matters, and the failure is safe.** Between the two restarts the room's
connect attempts return 401 and it retries on its 3s backoff; nothing is lost.
Verify with `lxc exec akira-room -- journalctl -u akira-room -n 20` — expect
`[room] connected to …`, not a repeating `stream 401`.

If `ROOM_COMPANION_TOKEN` is unset, or equal to `COMPANION_TOKEN`, the room
cannot connect. That is deliberate: falling back to the shared secret would
silently restore the hole this closes.
```

- [ ] **Step 7: Verify the whole suite and the type checker**

Run: `pnpm test`
Expected: PASS (all pre-existing tests plus Task 1's).

Run: `pnpm exec tsc --noEmit`
Expected: exit 0.

- [ ] **Step 8: Commit**

```bash
git add src/app/api/companion .env.example room-agent/.env.example room-agent/src/config.ts docs/runbook-mini-desktop.md
git commit -m "feat(companion): route auth is target-aware; the room can no longer act as the laptop"
```

---

### Task 3: The `shell` action on the wire

**Files:**
- Modify: `src/lib/companion/protocol.ts`
- Modify: `companion/src/protocol.ts` (byte-identical copy)
- Modify: `room-agent/src/protocol.ts` (byte-identical copy)
- Test: `src/lib/companion/protocol-copies.test.ts`

**Interfaces:**
- Produces: `CommandAction` gains `'shell'`; `Command` gains `command?: string`, `cwd?: string`; `Result` gains `exitCode?: number | null`.

- [ ] **Step 1: Write the failing test**

Append to `src/lib/companion/protocol-copies.test.ts`:

```ts
test('the protocol declares the shell action and its fields', () => {
  const src = readFileSync(join(process.cwd(), COPIES[0]), 'utf8');
  assert.ok(src.includes(`'shell'`), 'CommandAction is missing shell');
  assert.ok(/command\?: string/.test(src), 'Command is missing the command field');
  assert.ok(/cwd\?: string/.test(src), 'Command is missing the cwd field');
  assert.ok(/exitCode\?: number \| null/.test(src), 'Result is missing exitCode');
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `pnpm exec tsx --test src/lib/companion/protocol-copies.test.ts`
Expected: FAIL — "CommandAction is missing shell".

- [ ] **Step 3: Edit `src/lib/companion/protocol.ts`**

```ts
export type CommandAction =
  | 'navigate'
  | 'read'
  | 'type'
  | 'click'
  | 'wait'
  | 'fs_list'
  | 'fs_read'
  | 'fs_write'
  | 'shell';

export interface Command {
  id: string;
  action: CommandAction;
  url?: string;
  ref?: string;
  text?: string;
  /** fs_* actions: path relative to the room root, or absolute inside the doorway. */
  path?: string;
  /** fs_write: the bytes to write, UTF-8. */
  content?: string;
  /** shell: the command line, run through `bash -lc` inside the room. */
  command?: string;
  /** shell: working directory. Defaults to the room root; validated like any path. */
  cwd?: string;
  /** Set true only after the operator explicitly approved a hard-gated action. */
  approved?: boolean;
}
```

and in `Result`:

```ts
export interface Result {
  id: string;
  status: ResultStatus;
  snapshot?: Snapshot;
  text?: string;
  reason?: string;
  /** shell: the process exit code, or null when it was killed on timeout. */
  exitCode?: number | null;
}
```

- [ ] **Step 4: Copy the file byte-for-byte to the other two locations**

```bash
cp src/lib/companion/protocol.ts companion/src/protocol.ts
cp src/lib/companion/protocol.ts room-agent/src/protocol.ts
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `pnpm exec tsx --test src/lib/companion/protocol-copies.test.ts`
Expected: PASS — both the byte-identity test and the new field test.

- [ ] **Step 6: Confirm the laptop companion still compiles**

The laptop companion's `describe()` switch in `companion/src/index.ts` has a `default:` branch, so a new action needs no change there. Verify:

Run: `pnpm exec tsc --noEmit`
Expected: exit 0.

- [ ] **Step 7: Commit**

```bash
git add src/lib/companion/protocol.ts companion/src/protocol.ts room-agent/src/protocol.ts src/lib/companion/protocol-copies.test.ts
git commit -m "feat(protocol): add the shell action to all three protocol copies"
```

---

### Task 4: The shell gate classifier

Decision 7: the shell hard-gates **exactly one thing** — a process that will outlive the command. The Mini also hosts prod, so a runaway process is the only thing in the room that can reach out and hurt something the operator cares about. Everything else runs free; `lxc restore` makes breaking the room cheap.

Do not add patterns for `rm`, `git push`, or anything that merely *looks* irreversible. The spec rejects that by name, and `companion/src/guard.ts` stays untouched — it is the browser's classifier, not the shell's.

**Files:**
- Create: `room-agent/src/shell-gate.ts`
- Test: `room-agent/src/shell-gate.test.ts`

**Interfaces:**
- Produces: `classifyShell(command: string): { gated: boolean; reason?: string }` — pure, no fs, no deps. Same return shape as `companion/src/guard.ts`'s `classifyClick`.

- [ ] **Step 1: Write the failing test**

Create `room-agent/src/shell-gate.test.ts`:

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { classifyShell } from './shell-gate';

const ungated = [
  'ls -la',
  'pandoc resume.docx -o resume.md',
  'git add -A && git commit -m "draft"',
  'git push origin main',
  'rm -rf ./scratch',
  'pip install python-docx',
  'python convert.py',
  'grep -r TODO .',
  'sleep 5',
  'cat /mnt/doorway/inbox/resume.docx | head -c 200',
];

for (const cmd of ungated) {
  test(`ungated: ${cmd}`, () => {
    assert.equal(classifyShell(cmd).gated, false, `${cmd} must run free`);
  });
}

const gated = [
  'npm run dev',
  'pnpm dev',
  'next start',
  'python -m http.server 8000',
  'nohup ./worker.sh',
  'tail -f /var/log/syslog',
  './server &',
  'while true; do echo hi; done',
  'sleep 3600',
  'nodemon index.js',
];

for (const cmd of gated) {
  test(`gated: ${cmd}`, () => {
    const v = classifyShell(cmd);
    assert.equal(v.gated, true, `${cmd} must be gated`);
    assert.ok(v.reason && v.reason.length > 0, 'a gated command must carry a reason');
  });
}

test('doorway writes are never gated by the shell', () => {
  // Decision 7: slice 1 already ships ungated fs_write to the doorway. Gating
  // the same action here would buy nothing and make the model incoherent.
  assert.equal(classifyShell('cp resume.md /mnt/doorway/inbox/resume.md').gated, false);
  assert.equal(classifyShell('echo done > /mnt/doorway/playground/reply.txt').gated, false);
});

test('an empty command is not gated (it is an ordinary error)', () => {
  assert.equal(classifyShell('').gated, false);
  assert.equal(classifyShell('   ').gated, false);
});

test('the reason names what was seen, not a generic warning', () => {
  assert.match(classifyShell('npm run dev').reason ?? '', /long-running|server/i);
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `pnpm exec tsx --test room-agent/src/shell-gate.test.ts`
Expected: FAIL — cannot find module `./shell-gate`.

- [ ] **Step 3: Implement the classifier**

Create `room-agent/src/shell-gate.ts`:

```ts
// The room's ONLY brake on `shell`. Decision 7 in the spec: the one thing worth
// spending the operator's attention on is a process that outlives the command,
// because the Mini also hosts prod. Everything else runs free — the room is hers
// to break, and `lxc restore` makes breaking it cheap.
//
// Deliberately NOT gated: irreversible-looking commands (rm, git push, curl),
// and writes into the doorway. The spec rejects both by name.
// Pure — no fs, no deps, no process access.

/** Backgrounded with a trailing `&` (but not `&&`). */
const BACKGROUNDED = /(^|[^&])&\s*$/;

/** Detachers: the process is explicitly meant to survive this command. */
const DETACHED = /(^|[;&|]\s*)(nohup|setsid|screen|tmux|disown|systemctl|service)\b/i;

/** Dev servers and watchers — they never return on their own. */
const SERVER = /\b(?:npm|pnpm|yarn)\s+(?:run\s+)?(?:dev|start|serve|watch)\b|\b(?:next|vite|nodemon|webpack-dev-server)\s+(?:dev|start|serve)?\b|\bhttp\.server\b|\bnpx\s+serve\b|\bflask\s+run\b|\buvicorn\b|\bgunicorn\b/i;

/** Follow-mode readers. */
const FOLLOW = /\btail\s+-\w*f\b|\btail\s+--follow\b|\bjournalctl\s+[^|;]*-f\b|\bwatch\s+-n\b/i;

/** Unbounded loops. */
const LOOP = /\bwhile\s+(?:true|:)\b|\buntil\s+false\b|\bfor\s*\(\(\s*;;\s*\)\)/i;

/** `sleep N` where N exceeds the room's own command timeout is a parked process. */
const MAX_SLEEP_SEC = 60;

function longSleep(command: string): number | null {
  const m = command.match(/\bsleep\s+(\d+(?:\.\d+)?)([smhd]?)\b/i);
  if (!m) return null;
  const n = Number(m[1]);
  const mult = { s: 1, m: 60, h: 3600, d: 86400, '': 1 }[m[2].toLowerCase() as 's' | 'm' | 'h' | 'd' | ''];
  const secs = n * mult;
  return secs > MAX_SLEEP_SEC ? secs : null;
}

/**
 * Returns { gated: true, reason } when a command must wait for explicit operator
 * approval because it starts something that will not finish on its own.
 */
export function classifyShell(command: string): { gated: boolean; reason?: string } {
  const c = (command ?? '').trim();
  if (!c) return { gated: false };

  if (DETACHED.test(c)) return { gated: true, reason: 'starts a detached process that outlives this command' };
  if (BACKGROUNDED.test(c)) return { gated: true, reason: 'backgrounds the process with `&`' };
  if (SERVER.test(c)) return { gated: true, reason: 'starts a long-running server or watcher' };
  if (FOLLOW.test(c)) return { gated: true, reason: 'follows a stream and never returns' };
  if (LOOP.test(c)) return { gated: true, reason: 'runs an unbounded loop' };

  const secs = longSleep(c);
  if (secs !== null) return { gated: true, reason: `sleeps for ${secs}s, longer than a command should run` };

  return { gated: false };
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `pnpm exec tsx --test room-agent/src/shell-gate.test.ts`
Expected: PASS — all `ungated:` and `gated:` cases.

- [ ] **Step 5: Commit**

```bash
git add room-agent/src/shell-gate.ts room-agent/src/shell-gate.test.ts
git commit -m "feat(room): classify shell commands that would outlive the command"
```

---

### Task 5: Resolve symlinks before acting on a path

"Carried into slice 2", prerequisite 1. `room-agent/src/paths.ts` is pure path math and cannot see a symlink planted inside the room or doorway that points outside them. In slice 1 no protocol action could create one; `shell` can. This lands **before** `execShell` so the shell never runs against the unhardened gate.

Note for the reviewer: this is defence in depth *inside* the room. The load-bearing boundary remains the LXD mount namespace — prod and `/home/akeem` are simply not in the container.

**Files:**
- Create: `room-agent/src/paths-real.ts`
- Modify: `room-agent/src/fs-ops.ts`
- Test: `room-agent/src/paths-real.test.ts`

**Interfaces:**
- Consumes: `validatePath(roots, requested): PathVerdict`, `Roots`, `PathVerdict` from `./paths` (unchanged).
- Produces: `validatePathReal(roots: Roots, requested: string): Promise<PathVerdict>`.

- [ ] **Step 1: Write the failing test**

Create `room-agent/src/paths-real.test.ts`:

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { validatePathReal } from './paths-real';

// Creating symlinks on Windows needs elevation or developer mode. The room is
// Linux; these run for real there and in Task 16's on-the-Mini verification.
const skip = process.platform === 'win32' ? 'POSIX only — symlinks need elevation on Windows' : false;

async function fixture() {
  const base = await mkdtemp(join(tmpdir(), 'room-paths-'));
  const room = join(base, 'workshop');
  const doorway = join(base, 'doorway');
  const outside = join(base, 'secrets');
  await mkdir(room, { recursive: true });
  await mkdir(doorway, { recursive: true });
  await mkdir(outside, { recursive: true });
  await writeFile(join(outside, 'prod.env'), 'TOKEN=hunter2');
  return { roots: { room, doorway }, outside };
}

test('an ordinary path inside the room is allowed', { skip }, async () => {
  const { roots } = await fixture();
  await writeFile(join(roots.room, 'notes.md'), 'hi');
  const v = await validatePathReal(roots, 'notes.md');
  assert.equal(v.ok, true);
});

test('a file symlink pointing outside the room is refused', { skip }, async () => {
  const { roots, outside } = await fixture();
  await symlink(join(outside, 'prod.env'), join(roots.room, 'escape'));
  const v = await validatePathReal(roots, 'escape');
  assert.equal(v.ok, false);
  assert.match((v as { reason: string }).reason, /outside/i);
});

test('a directory symlink pointing outside the room is refused', { skip }, async () => {
  const { roots, outside } = await fixture();
  await symlink(outside, join(roots.room, 'out'));
  const v = await validatePathReal(roots, 'out/prod.env');
  assert.equal(v.ok, false);
});

test('a symlink planted in the doorway is refused too', { skip }, async () => {
  const { roots, outside } = await fixture();
  await symlink(outside, join(roots.doorway, 'out'));
  const v = await validatePathReal(roots, join(roots.doorway, 'out', 'prod.env'));
  assert.equal(v.ok, false);
});

test('a not-yet-existing leaf under a real directory is allowed (fs_write creates it)', { skip }, async () => {
  const { roots } = await fixture();
  const v = await validatePathReal(roots, 'reports/new-file.md');
  assert.equal(v.ok, true, 'writing a new file must still work');
});

test('the pure gate still rejects first — no fs call needed for an obvious escape', { skip }, async () => {
  const { roots } = await fixture();
  const v = await validatePathReal(roots, '../../etc/passwd');
  assert.equal(v.ok, false);
});

test('a symlink that stays inside the room is allowed', { skip }, async () => {
  const { roots } = await fixture();
  await mkdir(join(roots.room, 'real'), { recursive: true });
  await writeFile(join(roots.room, 'real', 'a.txt'), 'a');
  await symlink(join(roots.room, 'real'), join(roots.room, 'link'));
  const v = await validatePathReal(roots, 'link/a.txt');
  assert.equal(v.ok, true);
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `pnpm exec tsx --test room-agent/src/paths-real.test.ts`
Expected: FAIL — cannot find module `./paths-real`.

- [ ] **Step 3: Implement the symlink-aware gate**

Create `room-agent/src/paths-real.ts`:

```ts
// Symlink-aware wrapper over the pure path gate. `validatePath` is path MATH: it
// cannot see a symlink inside the room or doorway that points outside them. Slice
// 1 had no action that could create one; `shell` does, so every path is re-checked
// after links are resolved.
//
// This is defence in depth INSIDE the room. The load-bearing boundary is the LXD
// mount namespace — prod and /home/akeem are simply not in the container.
import { realpath } from 'node:fs/promises';
import { dirname, join, basename } from 'node:path';
import { validatePath, type Roots, type PathVerdict } from './paths';

/**
 * realpath the deepest ancestor that actually exists, then re-append the tail
 * that does not. A leaf may legitimately be missing (fs_write creates it), but
 * every directory above it must resolve to somewhere real.
 */
async function realpathDeepest(abs: string): Promise<string> {
  const tail: string[] = [];
  let cur = abs;
  for (;;) {
    try {
      const real = await realpath(cur);
      return tail.length ? join(real, ...tail) : real;
    } catch {
      const parent = dirname(cur);
      if (parent === cur) return abs; // hit the filesystem root; nothing resolved
      tail.unshift(basename(cur));
      cur = parent;
    }
  }
}

/** validatePath, then again against the link-resolved path. */
export async function validatePathReal(roots: Roots, requested: string): Promise<PathVerdict> {
  const first = validatePath(roots, requested);
  if (!first.ok) return first; // obvious escapes never touch the disk
  const real = await realpathDeepest(first.abs);
  const second = validatePath(roots, real);
  if (!second.ok) return { ok: false, reason: 'path resolves outside the room and doorway (symlink)' };
  return second;
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `pnpm exec tsx --test room-agent/src/paths-real.test.ts`
Expected: PASS — all seven.

- [ ] **Step 5: Use it in `fs-ops.ts`**

In `room-agent/src/fs-ops.ts`, change the import and the one gate call:

```ts
import { validatePathReal } from './paths-real';
```

```ts
  const verdict = await validatePathReal(roots, cmd.path ?? '');
  if (!verdict.ok) return { id: cmd.id, status: 'blocked', reason: verdict.reason };
```

Leave the non-fs-action rejection above it exactly where it is — slice 1's review moved it there on purpose.

- [ ] **Step 6: Run the room agent's whole suite**

Run: `pnpm exec tsx --test room-agent/src/*.test.ts`
Expected: PASS — `fs-ops.test.ts` included, unchanged.

- [ ] **Step 7: Commit**

```bash
git add room-agent/src/paths-real.ts room-agent/src/paths-real.test.ts room-agent/src/fs-ops.ts
git commit -m "fix(room): resolve symlinks before acting on a path"
```

---

### Task 6: Execute shell commands in the room

**Files:**
- Create: `room-agent/src/shell-ops.ts`
- Modify: `room-agent/src/index.ts`
- Test: `room-agent/src/shell-ops.test.ts`

**Interfaces:**
- Consumes: `classifyShell(command)`, `validatePathReal(roots, requested)`, `Roots`, `Command`, `Result`.
- Produces:
  - `execShell(roots: Roots, cmd: Command): Promise<Result>`
  - `SHELL_TIMEOUT_MS = 120_000`
  - `MAX_OUTPUT_CHARS = 60_000`

Design notes the implementer needs:

- A command that *ran* returns `status: 'ok'` even on a non-zero exit, with the code in `exitCode` and in the text. `grep` exiting 1 for "no match" is information, not a transport failure. Only a kill-on-timeout, a spawn failure, or a refused `cwd` is not `'ok'`.
- The child is spawned `detached: true` so it gets its own process group, and the timeout kills the **group** (`process.kill(-pid, 'SIGKILL')`). Killing only the leader leaves orphans on a box that also hosts prod — the exact risk Decision 7 is about.
- Output is stdout and stderr interleaved into one string, truncated at `MAX_OUTPUT_CHARS` from the front with an explicit marker.

- [ ] **Step 1: Write the failing test**

Create `room-agent/src/shell-ops.test.ts`:

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execShell } from './shell-ops';
import type { Command } from './protocol';

async function roots() {
  const base = await mkdtemp(join(tmpdir(), 'room-shell-'));
  const room = join(base, 'workshop');
  const doorway = join(base, 'doorway');
  await mkdir(room, { recursive: true });
  await mkdir(doorway, { recursive: true });
  return { room, doorway };
}

const cmd = (over: Partial<Command>): Command => ({ id: 'cmd_1', action: 'shell', ...over });

// The room is Linux. `bash -lc`, detached process groups, and `kill(-pid)` are
// POSIX; these skip on the Windows dev laptop and run for real on the Mini.
const skip = process.platform === 'win32' ? 'POSIX only — the room is Linux' : false;

test('runs a command and returns its output', { skip }, async () => {
  const r = await execShell(await roots(), cmd({ command: 'echo hello' }));
  assert.equal(r.status, 'ok');
  assert.equal(r.exitCode, 0);
  assert.match(r.text ?? '', /hello/);
});

test('a non-zero exit is ok with the code reported, not a transport error', { skip }, async () => {
  const r = await execShell(await roots(), cmd({ command: 'exit 3' }));
  assert.equal(r.status, 'ok', 'the command ran; its exit code is information');
  assert.equal(r.exitCode, 3);
  assert.match(r.text ?? '', /exit code 3/i);
});

test('stderr is captured alongside stdout', { skip }, async () => {
  const r = await execShell(await roots(), cmd({ command: 'echo oops >&2' }));
  assert.match(r.text ?? '', /oops/);
});

test('runs in the room root by default', { skip }, async () => {
  const rts = await roots();
  const r = await execShell(rts, cmd({ command: 'pwd' }));
  assert.ok((r.text ?? '').includes(rts.room), 'the default cwd is the room root');
});

test('a cwd outside the room is blocked', { skip }, async () => {
  const r = await execShell(await roots(), cmd({ command: 'ls', cwd: '/etc' }));
  assert.equal(r.status, 'blocked');
  assert.match(r.reason ?? '', /outside/i);
});

// The gate is pure and platform-independent — no skip.
test('a gated command is blocked with the classifier reason', async () => {
  const r = await execShell(await roots(), cmd({ command: 'npm run dev' }));
  assert.equal(r.status, 'blocked');
  assert.match(r.reason ?? '', /long-running|server/i);
});

test('an approved gated command runs', { skip }, async () => {
  // The gate is the operator's, not a permanent ban.
  const r = await execShell(await roots(), cmd({ command: 'sleep 120 && echo never', approved: true }), 300);
  assert.notEqual(r.status, 'blocked');
});

test('an empty command is an error, not a block', async () => {
  const r = await execShell(await roots(), cmd({ command: '   ' }));
  assert.equal(r.status, 'error');
});

test('a non-shell action is rejected before anything else', async () => {
  const r = await execShell(await roots(), cmd({ action: 'fs_read', path: 'x' }));
  assert.equal(r.status, 'error');
  assert.match(r.reason ?? '', /unsupported action/i);
});

test('a command that overruns the timeout is killed', { skip }, async () => {
  const r = await execShell(await roots(), cmd({ command: 'sleep 5', approved: true }), 200);
  assert.equal(r.status, 'error');
  assert.equal(r.exitCode, null);
  assert.match(r.reason ?? '', /timeout|killed/i);
});

test('output is truncated rather than returned unbounded', { skip }, async () => {
  const r = await execShell(await roots(), cmd({ command: 'head -c 200000 /dev/zero | tr "\\0" "x"' }));
  assert.ok((r.text ?? '').length < 70_000, 'output must be capped');
  assert.match(r.text ?? '', /truncated/i);
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `pnpm exec tsx --test room-agent/src/shell-ops.test.ts`
Expected: FAIL — cannot find module `./shell-ops`.

- [ ] **Step 3: Implement `execShell`**

Create `room-agent/src/shell-ops.ts`:

```ts
// Executes `shell` commands inside the room. Two controls, both here:
//   1. classifyShell refuses anything that would outlive the command (Decision 7),
//      unless the operator already approved it.
//   2. Everything that runs gets a wall-clock timeout and its own process group,
//      so a timeout kills the whole tree rather than orphaning children on a box
//      that also hosts prod.
// A refused command returns status 'blocked' — the same shape guard.ts produces
// for the browser — never an exception.
import { spawn } from 'node:child_process';
import { classifyShell } from './shell-gate';
import { validatePathReal } from './paths-real';
import type { Roots } from './paths';
import type { Command, Result } from './protocol';

export const SHELL_TIMEOUT_MS = 120_000;
export const MAX_OUTPUT_CHARS = 60_000;

function cap(out: string): string {
  if (out.length <= MAX_OUTPUT_CHARS) return out;
  return out.slice(0, MAX_OUTPUT_CHARS) + `\n\n… output truncated at ${MAX_OUTPUT_CHARS} characters.`;
}

export async function execShell(
  roots: Roots,
  cmd: Command,
  timeoutMs = SHELL_TIMEOUT_MS,
): Promise<Result> {
  if (cmd.action !== 'shell') {
    return { id: cmd.id, status: 'error', reason: `unsupported action: ${cmd.action}` };
  }
  const command = (cmd.command ?? '').trim();
  if (!command) return { id: cmd.id, status: 'error', reason: 'empty command' };

  const gate = classifyShell(command);
  if (gate.gated && !cmd.approved) {
    return { id: cmd.id, status: 'blocked', reason: gate.reason ?? 'gated command' };
  }

  let cwd = roots.room;
  if (cmd.cwd) {
    const verdict = await validatePathReal(roots, cmd.cwd);
    if (!verdict.ok) return { id: cmd.id, status: 'blocked', reason: verdict.reason };
    cwd = verdict.abs;
  }

  return new Promise<Result>((resolve) => {
    let out = '';
    let settled = false;
    const child = spawn('bash', ['-lc', command], { cwd, detached: true });

    const finish = (r: Result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(r);
    };

    const timer = setTimeout(() => {
      // Kill the whole process group: killing only the leader orphans its children.
      try {
        if (child.pid) process.kill(-child.pid, 'SIGKILL');
      } catch {
        /* already gone */
      }
      finish({
        id: cmd.id,
        status: 'error',
        exitCode: null,
        reason: `killed after ${timeoutMs}ms timeout`,
        text: cap(out),
      });
    }, timeoutMs);

    child.stdout.on('data', (b: Buffer) => { out += b.toString('utf8'); });
    child.stderr.on('data', (b: Buffer) => { out += b.toString('utf8'); });

    child.on('error', (e) => finish({ id: cmd.id, status: 'error', reason: e.message }));

    child.on('close', (code) => {
      const body = cap(out).trimEnd();
      finish({
        id: cmd.id,
        status: 'ok',
        exitCode: code,
        text: `${body}${body ? '\n\n' : ''}(exit code ${code})`,
      });
    });
  });
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `pnpm exec tsx --test room-agent/src/shell-ops.test.ts`
Expected: PASS — all eleven.

- [ ] **Step 5: Dispatch `shell` in the room agent**

In `room-agent/src/index.ts`, route by action instead of always calling `execFs`:

```ts
import { loadConfig } from './config';
import { connect } from './connection';
import { execFs } from './fs-ops';
import { execShell } from './shell-ops';
import type { Command } from './protocol';

const cfg = loadConfig();

// One-at-a-time chain so writes never interleave — same discipline as the
// laptop companion's command chain.
let chain: Promise<void> = Promise.resolve();

const conn = connect(cfg, (cmd: Command) => {
  chain = chain
    .then(async () => {
      console.log('[room] exec', cmd.action, cmd.command ?? cmd.path ?? '');
      const result = cmd.action === 'shell'
        ? await execShell(cfg.roots, cmd)
        : await execFs(cfg.roots, cmd);
      if (result.status !== 'ok') console.warn('[room]', result.status, result.reason);
      await conn.postResult(result);
    })
    .catch((err) => console.error('[room] command chain error:', err));
});
```

The rest of the file (startup log, `shutdown`) is unchanged.

- [ ] **Step 6: Run the room agent suite and the type checker**

Run: `pnpm exec tsx --test room-agent/src/*.test.ts`
Expected: PASS.

Run: `pnpm exec tsc --noEmit`
Expected: exit 0.

- [ ] **Step 7: Commit**

```bash
git add room-agent/src/shell-ops.ts room-agent/src/shell-ops.test.ts room-agent/src/index.ts
git commit -m "feat(room): execute shell commands, gated on long-running processes"
```

---

### Task 7: The gate broker and a generalized approve route

A gated command has to park somewhere while the operator decides. The laptop companion does this locally (`gate-queue.ts` + its Electron HUD); the room has no local HUD, so the parking spot is server-side.

This mirrors `registry.ts`: an in-memory map, a promise per entry, a timeout that settles it. Because the gate id is minted server-side and the command is stored with it, the browser never gets to choose what runs — it only says approve or deny.

**Files:**
- Create: `src/lib/companion/gates.ts`
- Modify: `src/app/api/companion/approve/route.ts`
- Test: `src/lib/companion/gates.test.ts`

**Interfaces:**
- Consumes: `CompanionTarget` from `./registry`.
- Produces:
  - `GateDecision = 'approved' | 'denied'`
  - `GateEntry = { id: string; target: CompanionTarget; reason: string; command: string; openedAt: number }`
  - `openGate(input: { target: CompanionTarget; reason: string; command: string }, timeoutMs?: number): { id: string; decision: Promise<GateDecision> }`
  - `decideGate(id: string, d: GateDecision): boolean`
  - `getGate(id: string): GateEntry | undefined`
  - `pendingGateCount(): number`
  - `GATE_TIMEOUT_MS = 120_000`

- [ ] **Step 1: Write the failing test**

Create `src/lib/companion/gates.test.ts`:

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openGate, decideGate, getGate, pendingGateCount } from './gates';

test('an approved gate settles with approved', async () => {
  const { id, decision } = openGate({ target: 'room', reason: 'server', command: 'npm run dev' });
  assert.equal(decideGate(id, 'approved'), true);
  assert.equal(await decision, 'approved');
});

test('a denied gate settles with denied', async () => {
  const { id, decision } = openGate({ target: 'room', reason: 'server', command: 'npm run dev' });
  assert.equal(decideGate(id, 'denied'), true);
  assert.equal(await decision, 'denied');
});

test('an un-actioned gate auto-denies after its timeout', async () => {
  const { decision } = openGate({ target: 'room', reason: 'server', command: 'sleep 9999' }, 30);
  assert.equal(await decision, 'denied', 'silence is not consent');
});

test('deciding an unknown or already-decided gate returns false', async () => {
  const { id, decision } = openGate({ target: 'room', reason: 'r', command: 'c' });
  assert.equal(decideGate('gate_nope', 'approved'), false);
  decideGate(id, 'approved');
  await decision;
  assert.equal(decideGate(id, 'denied'), false, 'a gate settles exactly once');
});

test('the gate carries what the operator needs to see, and is cleared once decided', async () => {
  const before = pendingGateCount();
  const { id, decision } = openGate({ target: 'room', reason: 'starts a server', command: 'next dev' });
  const g = getGate(id);
  assert.equal(g?.command, 'next dev');
  assert.equal(g?.reason, 'starts a server');
  assert.equal(g?.target, 'room');
  assert.equal(pendingGateCount(), before + 1);
  decideGate(id, 'approved');
  await decision;
  assert.equal(getGate(id), undefined);
  assert.equal(pendingGateCount(), before);
});

test('gate ids are unique', () => {
  const a = openGate({ target: 'room', reason: 'r', command: 'c' }, 20);
  const b = openGate({ target: 'room', reason: 'r', command: 'c' }, 20);
  assert.notEqual(a.id, b.id);
  a.decision.catch(() => {});
  b.decision.catch(() => {});
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `pnpm exec tsx --test src/lib/companion/gates.test.ts`
Expected: FAIL — cannot find module `./gates`.

- [ ] **Step 3: Implement the broker**

Create `src/lib/companion/gates.ts`:

```ts
// In-memory broker for operator gate decisions, in the shape of registry.ts.
// The laptop companion parks its gated clicks locally (gate-queue.ts + its
// Electron HUD); the room has no local HUD, so a gated room command parks here
// while the front-door HUD asks, and the tool awaiting `decision` gets the real
// answer — and then the real command output — inside the same turn.
//
// The COMMAND is stored server-side against a minted id, so the browser only
// ever says approve/deny. It never gets to choose what runs.
// Pure promise/map logic — no db, no server-only, unit-tested.
import { randomBytes, bytesToHex } from '@noble/hashes/utils.js';
import type { CompanionTarget } from './registry';

export type GateDecision = 'approved' | 'denied';

export interface GateEntry {
  id: string;
  target: CompanionTarget;
  reason: string;
  command: string;
  openedAt: number;
}

/** Silence is not consent: an un-actioned gate auto-denies. Matches the laptop
 *  companion's GATE_TIMEOUT_MS. */
export const GATE_TIMEOUT_MS = 120_000;

const gates = new Map<
  string,
  { entry: GateEntry; settle: (d: GateDecision) => void; timer: ReturnType<typeof setTimeout> }
>();

export function openGate(
  input: { target: CompanionTarget; reason: string; command: string },
  timeoutMs = GATE_TIMEOUT_MS,
): { id: string; decision: Promise<GateDecision> } {
  const id = `gate_${bytesToHex(randomBytes(6))}`;
  const entry: GateEntry = { id, ...input, openedAt: Date.now() };
  const decision = new Promise<GateDecision>((resolve) => {
    const timer = setTimeout(() => {
      gates.delete(id);
      resolve('denied');
    }, timeoutMs);
    gates.set(id, { entry, settle: resolve, timer });
  });
  return { id, decision };
}

/** Settle a gate. False if it is unknown or already settled. */
export function decideGate(id: string, d: GateDecision): boolean {
  const g = gates.get(id);
  if (!g) return false;
  clearTimeout(g.timer);
  gates.delete(id);
  g.settle(d);
  return true;
}

export function getGate(id: string): GateEntry | undefined {
  return gates.get(id)?.entry;
}

export function pendingGateCount(): number {
  return gates.size;
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `pnpm exec tsx --test src/lib/companion/gates.test.ts`
Expected: PASS — all six.

- [ ] **Step 5: Teach the approve route about gate ids**

Rewrite `src/app/api/companion/approve/route.ts`. The existing `{ ref }` browser path must keep working byte-for-byte in behaviour — note that today's `isOnline()` check runs before the body is parsed, and it moves **inside** the `ref` branch (a room gate decision has nothing to do with laptop presence):

```ts
import { cookies } from 'next/headers';
import { SESSION_COOKIE, verifySession } from '@/lib/auth';
import { sendCommand, isOnline } from '@/lib/companion/registry';
import { decideGate } from '@/lib/companion/gates';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(req: Request) {
  const jar = await cookies();
  const token = jar.get(SESSION_COOKIE)?.value;
  if (!token || !(await verifySession(token))) {
    return Response.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const body = (await req.json().catch(() => ({}))) as {
    ref?: string;
    gateId?: string;
    decision?: 'approved' | 'denied';
  };

  // Room gate: the command itself lives server-side against this id — the client
  // only decides. The tool awaiting the decision resumes and reports the output.
  if (body.gateId) {
    const settled = decideGate(body.gateId, body.decision === 'denied' ? 'denied' : 'approved');
    return Response.json({ ok: settled, expired: !settled });
  }

  // Laptop browser gate: unchanged.
  if (!isOnline()) return Response.json({ error: 'companion offline' }, { status: 409 });
  if (!body.ref) return Response.json({ error: 'ref required' }, { status: 400 });

  try {
    const { result } = sendCommand({ action: 'click', ref: body.ref, approved: true });
    const r = await result;
    return Response.json({ ok: r.status === 'ok', status: r.status, text: r.text ?? r.reason ?? '' });
  } catch (e) {
    return Response.json({ error: e instanceof Error ? e.message : String(e) }, { status: 500 });
  }
}
```

- [ ] **Step 6: Verify the suite and types**

Run: `pnpm test`
Expected: PASS.

Run: `pnpm exec tsc --noEmit`
Expected: exit 0.

- [ ] **Step 7: Commit**

```bash
git add src/lib/companion/gates.ts src/lib/companion/gates.test.ts src/app/api/companion/approve/route.ts
git commit -m "feat(companion): server-side gate broker; approve route settles room gates"
```

---

> **Known limitation, closed at the review's final fix wave (not a Task 8 step):**
> `runRoomTurn` (doorway-triggered turns — `room-proposals-data.ts`) calls
> `runAkiraTurn({ instruction })` with no `emit`, so a gated shell command
> inside an inbox-approved or playground turn has no HUD to surface a
> `hard_gate` card to. Left unhandled, it would park in the gate broker for
> the full `GATE_TIMEOUT_MS` (120s), stalling the single serialized
> `turnChain`, then auto-deny anyway. `AkiraToolContext` gained an explicit
> `watched` flag (`akira-turn.ts` sets it `true` only when a real
> operator-facing `emit` is supplied, as `/api/akira/stream` does) so
> `runShell` (`src/lib/akira/room-shell.ts`) can deny immediately instead of
> opening a gate nobody can answer. A persistent pending-gates surface that
> lets a *later* turn or a different channel answer the gate is still
> slice-3 sized and out of scope here.

### Task 8: The `room_bash` tool and the shell command log

Decision 8: every shell command is logged where the operator can read it. Under Decision 4 detection is the primary control, so the log is load-bearing rather than diagnostic — which is exactly why it lives **on the Mission Control side, not in the room**. A log inside the container is a log the shell can rewrite.

**Files:**
- Create: `src/lib/akira/shell-log.ts`
- Create: `src/lib/akira/shell-log.test.ts`
- Modify: `src/lib/akira/room-tools.ts`

**Interfaces:**
- Consumes: `sendCommand(cmd, timeoutMs, target)`, `openGate`, `AkiraToolContext.emit`.
- Produces:
  - `formatShellLogLine(e: ShellLogEvent): string` — one JSON object per line, newline-terminated. Pure.
  - `appendShellLog(e: ShellLogEvent): void` — best-effort append to `data/room-shell.log` plus a `console.log` so journald carries it too.
  - `ShellLogEvent = { at: Date; event: 'dispatch' | 'gated' | 'approved' | 'denied' | 'result'; command: string; cwd?: string; exitCode?: number | null; status?: string }`
  - `AKIRA_ROOM_BASH = 'mcp__akira__room_bash'`, added to `ROOM_TOOL_NAMES`.

- [ ] **Step 1: Write the failing test**

Create `src/lib/akira/shell-log.test.ts`:

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { formatShellLogLine } from './shell-log';

const at = new Date('2026-08-15T09:30:00.000Z');

test('a line is one newline-terminated JSON object', () => {
  const line = formatShellLogLine({ at, event: 'dispatch', command: 'ls -la' });
  assert.ok(line.endsWith('\n'), 'JSONL lines must be newline-terminated');
  const parsed = JSON.parse(line);
  assert.equal(parsed.event, 'dispatch');
  assert.equal(parsed.command, 'ls -la');
  assert.equal(parsed.at, '2026-08-15T09:30:00.000Z');
});

test('a newline inside the command cannot forge a second log line', () => {
  const line = formatShellLogLine({
    at,
    event: 'dispatch',
    command: 'echo a\n{"event":"result","command":"innocent"}',
  });
  assert.equal(line.split('\n').filter(Boolean).length, 1, 'one event, one line');
  assert.match(JSON.parse(line).command, /innocent/);
});

test('optional fields are omitted when absent, present when given', () => {
  assert.equal(JSON.parse(formatShellLogLine({ at, event: 'dispatch', command: 'ls' })).cwd, undefined);
  const withAll = JSON.parse(
    formatShellLogLine({ at, event: 'result', command: 'ls', cwd: '/home/akira/workshop', exitCode: 0, status: 'ok' }),
  );
  assert.equal(withAll.cwd, '/home/akira/workshop');
  assert.equal(withAll.exitCode, 0);
  assert.equal(withAll.status, 'ok');
});

test('a null exit code (killed) survives the round trip', () => {
  const parsed = JSON.parse(formatShellLogLine({ at, event: 'result', command: 'sleep 9999', exitCode: null }));
  assert.equal(parsed.exitCode, null);
  assert.ok('exitCode' in parsed, 'a kill must be distinguishable from "not recorded"');
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `pnpm exec tsx --test src/lib/akira/shell-log.test.ts`
Expected: FAIL — cannot find module `./shell-log`.

- [ ] **Step 3: Implement the log**

Create `src/lib/akira/shell-log.ts`:

```ts
// Decision 8: every shell command AKIRA runs is logged where the operator can
// read it. Under Decision 4 detection is the primary control, so this log is
// load-bearing, not diagnostic.
//
// It lives HERE, on the Mission Control side — never in the room. A log inside
// the container is a log the shell can rewrite. Commands are logged before they
// are dispatched, so a command that hangs or kills the agent still leaves a trace.
import { appendFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';

export interface ShellLogEvent {
  at: Date;
  event: 'dispatch' | 'gated' | 'approved' | 'denied' | 'result';
  command: string;
  cwd?: string;
  exitCode?: number | null;
  status?: string;
}

export function shellLogPath(): string {
  return process.env.ROOM_SHELL_LOG || join(process.cwd(), 'data', 'room-shell.log');
}

/** One JSON object per line. JSON.stringify escapes newlines, so nothing in a
 *  command string can forge a second log entry. Pure. */
export function formatShellLogLine(e: ShellLogEvent): string {
  const row: Record<string, unknown> = { at: e.at.toISOString(), event: e.event, command: e.command };
  if (e.cwd !== undefined) row.cwd = e.cwd;
  if (e.exitCode !== undefined) row.exitCode = e.exitCode;
  if (e.status !== undefined) row.status = e.status;
  return JSON.stringify(row) + '\n';
}

/** Append to the log and mirror to stdout (journald). Best-effort: a logging
 *  failure must never take down a turn. */
export function appendShellLog(e: ShellLogEvent): void {
  const line = formatShellLogLine(e);
  console.log('[room-shell]', line.trimEnd());
  try {
    const p = shellLogPath();
    mkdirSync(dirname(p), { recursive: true });
    appendFileSync(p, line, 'utf8');
  } catch (err) {
    console.warn('[room-shell] log append failed:', err instanceof Error ? err.message : err);
  }
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `pnpm exec tsx --test src/lib/akira/shell-log.test.ts`
Expected: PASS — all four.

- [ ] **Step 5: Add `room_bash` to the room tools**

In `src/lib/akira/room-tools.ts`, add the imports and constants at the top:

```ts
import { openGate } from '@/lib/companion/gates';
import { appendShellLog } from './shell-log';

export const AKIRA_ROOM_BASH = 'mcp__akira__room_bash';

export const ROOM_TOOL_NAMES = [AKIRA_ROOM_LIST, AKIRA_ROOM_READ, AKIRA_ROOM_WRITE, AKIRA_ROOM_BASH];

// Longer than the room's own SHELL_TIMEOUT_MS (120s) so the room's kill-and-report
// wins the race and AKIRA gets output rather than a bare transport timeout.
const SHELL_TIMEOUT_MS = 150_000;
```

Then add the shell runner below the existing `run` helper:

```ts
function present(r: { status: string; text?: string; reason?: string }): ToolResult {
  if (r.status === 'error') return err(r.reason ?? 'the command failed to run');
  return ok(r.text ?? 'done');
}

async function runShell(
  command: string,
  cwd: string | undefined,
  ctx: AkiraToolContext,
): Promise<ToolResult> {
  appendShellLog({ at: new Date(), event: 'dispatch', command, cwd });
  try {
    const first = await sendCommand({ action: 'shell', command, cwd }, SHELL_TIMEOUT_MS, 'room').result;
    if (first.status !== 'blocked') {
      appendShellLog({ at: new Date(), event: 'result', command, cwd, exitCode: first.exitCode, status: first.status });
      return present(first);
    }

    // Gated (Decision 7: a process that would outlive the command). Park it, ask
    // the operator through the HUD, and wait — do not retry, do not work around it.
    const reason = first.reason ?? 'this would start something long-running';
    appendShellLog({ at: new Date(), event: 'gated', command, cwd, status: reason });
    const { id, decision } = openGate({ target: 'room', reason, command });
    ctx.emit({ type: 'hard_gate', gateId: id, ref: '', reason, command });

    const decided = await decision;
    appendShellLog({ at: new Date(), event: decided === 'approved' ? 'approved' : 'denied', command, cwd });
    if (decided === 'denied') {
      return ok(
        `The operator did not approve that command (${reason}). Do not retry it and do not work around it — tell him what you were trying to do and ask how he'd like to proceed.`,
      );
    }

    const second = await sendCommand(
      { action: 'shell', command, cwd, approved: true },
      SHELL_TIMEOUT_MS,
      'room',
    ).result;
    appendShellLog({ at: new Date(), event: 'result', command, cwd, exitCode: second.exitCode, status: second.status });
    return present(second);
  } catch (e) {
    return err(e instanceof Error ? e.message : String(e));
  }
}
```

Finally add the tool to `roomToolDefs` (and drop the `no-unused-vars` disable comment above it — `ctx` is now used):

```ts
    tool(
      'room_bash',
      "Run a shell command in your room on the Mini. Use it for real work — converting documents (pandoc), installing tools, git, scripts. The room is yours; you cannot reach prod or the operator's home from it. Commands that would start something long-running (a dev server, a watcher, a backgrounded process) pause for the operator's approval; wait for his answer rather than retrying.",
      {
        command: z.string().min(1).describe('The command line, run through bash -lc.'),
        cwd: z.string().optional().describe('Working directory. Defaults to your workshop root.'),
      },
      (a) => runShell(a.command, a.cwd, ctx),
    ),
```

- [ ] **Step 6: Verify the suite and types**

Run: `pnpm test`
Expected: PASS.

Run: `pnpm exec tsc --noEmit`
Expected: exit 0.

Run: `pnpm lint`
Expected: no new errors (the removed eslint-disable must not leave an unused-directive warning).

- [ ] **Step 7: Commit**

```bash
git add src/lib/akira/shell-log.ts src/lib/akira/shell-log.test.ts src/lib/akira/room-tools.ts
git commit -m "feat(akira): room_bash tool with an operator-readable command log"
```

---

### Task 9: Approve or deny a room gate from the HUD

Today the HUD's gate card handles one case: an irreversible browser click on the laptop, approved by posting `{ ref }`. A room shell gate is a different sentence to read and needs a real **Deny** (not just "Cancel", which today leaves the tool hanging until it times out).

**Files:**
- Modify: `src/components/akira/hud.tsx:64` (gate state), `:191` (event handler), `:345` (approveGate), `:449` (the card)

**Interfaces:**
- Consumes: the `hard_gate` SSE event, which now carries `gateId?: string` and `command?: string` alongside the existing `ref` and `reason`.
- Produces: POSTs to `/api/companion/approve` with either `{ ref }` (laptop, unchanged) or `{ gateId, decision }` (room).

- [ ] **Step 1: Widen the gate state**

At line 64:

```tsx
  const [gate, setGate] = useState<{
    ref: string;
    reason: string;
    gateId?: string;
    command?: string;
  } | null>(null);
```

- [ ] **Step 2: Carry the new fields off the event**

At line 191, in `runTurn`'s `es.onmessage`:

```tsx
      } else if (e.type === "hard_gate") {
        setGate({ ref: e.ref, reason: e.reason, gateId: e.gateId, command: e.command });
```

- [ ] **Step 3: Replace `approveGate` with a decide function**

At line 345:

```tsx
  // Named resolveGate, not decideGate — `decideGate` is the gate broker's export
  // in src/lib/companion/gates.ts and the two are easy to confuse in review.
  async function resolveGate(decision: "approved" | "denied") {
    if (!gate) return;
    const g = gate;
    setGate(null);
    await fetch("/api/companion/approve", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      // A room gate is settled by id — the command itself never leaves the server.
      body: JSON.stringify(g.gateId ? { gateId: g.gateId, decision } : { ref: g.ref }),
    });
    // A room gate resumes the tool that is still awaiting it inside the live turn,
    // so there is nothing to restart. A laptop click has no such awaiter.
    if (!g.gateId && decision === "approved") {
      runTurn("I approved the gated action — continue.");
    }
  }
```

- [ ] **Step 4: Update the card**

At line 449:

```tsx
        {gate && (
          <div style={{ ...proposalCard, transition: "opacity .3s ease, transform .3s ease" }}>
            <div style={{ marginBottom: 10 }}>
              {gate.command ? (
                <>
                  ⚠ AKIRA wants to run <code style={{ fontFamily: "monospace" }}>{gate.command}</code> in
                  her room — {gate.reason}. Approve?
                </>
              ) : (
                <>⚠ AKIRA wants to do something irreversible: {gate.reason}. Approve?</>
              )}
            </div>
            <button onClick={() => resolveGate("approved")} style={pillStyle}>Approve</button>
            <button onClick={() => resolveGate("denied")} style={{ ...pillStyle, marginLeft: 8 }}>
              {gate.gateId ? "Deny" : "Cancel"}
            </button>
          </div>
        )}
```

- [ ] **Step 5: Verify the build**

Run: `pnpm exec tsc --noEmit`
Expected: exit 0 — in particular, no remaining reference to the old `approveGate`.

Run: `pnpm build`
Expected: exit 0.

- [ ] **Step 6: Commit**

```bash
git add src/components/akira/hud.tsx
git commit -m "feat(hud): approve or deny a gated room command"
```

---

### Task 10: Doorway routing and the bounded first pass

The watcher's first pass is deliberately cheap: filename, type, size, and a truncated head read — **not** a full agent turn. The full-cost turn runs only after approval. This task is that pass, as pure functions.

**Files:**
- Create: `room-agent/src/doorway.ts`
- Test: `room-agent/src/doorway.test.ts`

**Interfaces:**
- Consumes: `Roots` from `./paths`.
- Produces:
  - `DoorwayZone = 'inbox' | 'playground'`
  - `zoneForPath(roots: Roots, abs: string): DoorwayZone | null`
  - `isNoiseName(name: string): boolean`
  - `MAX_HEAD_CHARS = 800`
  - `DropReport = { zone: DoorwayZone; name: string; path: string; sizeBytes: number; ext: string; head: string }`
  - `buildDropReport(input: { zone: DoorwayZone; path: string; sizeBytes: number; raw: Buffer }): DropReport`

- [ ] **Step 1: Write the failing test**

Create `room-agent/src/doorway.test.ts`:

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { zoneForPath, isNoiseName, buildDropReport, MAX_HEAD_CHARS } from './doorway';

const roots = { room: '/home/akira/workshop', doorway: '/mnt/doorway' };

test('a file in inbox routes to inbox', () => {
  assert.equal(zoneForPath(roots, '/mnt/doorway/inbox/resume.docx'), 'inbox');
});

test('a file in playground routes to playground', () => {
  assert.equal(zoneForPath(roots, '/mnt/doorway/playground/sketch.md'), 'playground');
});

test('nested files still carry their folder\'s permission', () => {
  // The folder carries the permission — that must not stop at depth 1.
  assert.equal(zoneForPath(roots, '/mnt/doorway/inbox/old/2024/resume.docx'), 'inbox');
});

test('the doorway root itself is neither zone', () => {
  assert.equal(zoneForPath(roots, '/mnt/doorway/loose.txt'), null);
});

test('a file in the room is not a doorway drop', () => {
  assert.equal(zoneForPath(roots, '/home/akira/workshop/notes.md'), null);
});

test('a sibling folder with a zone-like prefix is not a zone', () => {
  assert.equal(zoneForPath(roots, '/mnt/doorway/inbox-old/x.txt'), null);
});

test('noise names are ignored', () => {
  for (const n of ['.DS_Store', '~$resume.docx', 'resume.docx.crdownload', 'a.txt.part', '.goutputstream-X1', 'x.swp']) {
    assert.equal(isNoiseName(n), true, `${n} must be treated as noise`);
  }
});

test('real files are not noise', () => {
  for (const n of ['resume.docx', 'notes.md', 'photo.JPG', 'archive.tar.gz']) {
    assert.equal(isNoiseName(n), false, `${n} must not be treated as noise`);
  }
});

test('a drop report carries name, ext and size', () => {
  const r = buildDropReport({
    zone: 'inbox',
    path: '/mnt/doorway/inbox/resume.docx',
    sizeBytes: 42_000,
    raw: Buffer.from('PKbinary'),
  });
  assert.equal(r.name, 'resume.docx');
  assert.equal(r.ext, 'docx');
  assert.equal(r.sizeBytes, 42_000);
  assert.equal(r.zone, 'inbox');
});

test('a binary head is reported as binary, not as mojibake', () => {
  const r = buildDropReport({
    zone: 'inbox',
    path: '/mnt/doorway/inbox/resume.docx',
    sizeBytes: 42_000,
    raw: Buffer.from([0x50, 0x4b, 0x03, 0x04, 0x00, 0x01, 0x02]),
  });
  assert.match(r.head, /binary/i);
});

test('a text head is truncated, never unbounded', () => {
  const r = buildDropReport({
    zone: 'inbox',
    path: '/mnt/doorway/inbox/long.md',
    sizeBytes: 999_999,
    raw: Buffer.from('x'.repeat(5000)),
  });
  assert.ok(r.head.length <= MAX_HEAD_CHARS + 40, 'the head read is bounded');
});

test('a file with no extension reports an empty ext', () => {
  const r = buildDropReport({ zone: 'inbox', path: '/mnt/doorway/inbox/README', sizeBytes: 10, raw: Buffer.from('hi') });
  assert.equal(r.ext, '');
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `pnpm exec tsx --test room-agent/src/doorway.test.ts`
Expected: FAIL — cannot find module `./doorway`.

- [ ] **Step 3: Implement the routing and the first pass**

Create `room-agent/src/doorway.ts`:

```ts
// The doorway's first pass. Bounded on purpose: filename, type, size, and a
// truncated head read — NOT a full agent turn. Noticing is cheap and constant;
// working is gated and rare.
//
// The FOLDER carries the permission: inbox/ raises a proposal, playground/ is
// hers to act in directly. There is no global mode to remember — the operator
// chooses per item by where he drops it.
// Pure — no fs, no network.
import { basename, resolve, sep } from 'node:path';
import type { Roots } from './paths';

export type DoorwayZone = 'inbox' | 'playground';

export const MAX_HEAD_CHARS = 800;

export interface DropReport {
  zone: DoorwayZone;
  name: string;
  path: string;
  sizeBytes: number;
  /** Lowercased extension without the dot, or '' when there is none. */
  ext: string;
  head: string;
}

function under(parent: string, child: string): boolean {
  const p = resolve(parent);
  const c = resolve(child);
  return c.startsWith(p.endsWith(sep) ? p : p + sep);
}

/** Which doorway zone an absolute path falls in, or null for neither. */
export function zoneForPath(roots: Roots, abs: string): DoorwayZone | null {
  for (const zone of ['inbox', 'playground'] as const) {
    if (under(resolve(roots.doorway, zone), abs)) return zone;
  }
  return null;
}

/** Editor/download/OS scratch files that appear and vanish mid-copy. */
const NOISE = [
  /^\./,                     // .DS_Store, .goutputstream-…
  /^~\$/,                    // Office lock files
  /\.(crdownload|part|partial|tmp|swp|swx)$/i,
];

export function isNoiseName(name: string): boolean {
  return NOISE.some((re) => re.test(name));
}

function extOf(name: string): string {
  const i = name.lastIndexOf('.');
  return i > 0 ? name.slice(i + 1).toLowerCase() : '';
}

/** Control bytes outside tab/newline/carriage-return mean "not text". */
function looksBinary(raw: Buffer): boolean {
  const probe = raw.subarray(0, 512);
  for (const b of probe) {
    if (b === 0) return true;
    if (b < 9 || (b > 13 && b < 32)) return true;
  }
  return false;
}

export function buildDropReport(input: {
  zone: DoorwayZone;
  path: string;
  sizeBytes: number;
  raw: Buffer;
}): DropReport {
  const name = basename(input.path);
  const ext = extOf(name);
  const head = looksBinary(input.raw)
    ? `(binary ${ext ? ext + ' ' : ''}file — ${input.sizeBytes} bytes; convert it before reading)`
    : input.raw.toString('utf8').slice(0, MAX_HEAD_CHARS);
  return { zone: input.zone, name, path: input.path, sizeBytes: input.sizeBytes, ext, head };
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `pnpm exec tsx --test room-agent/src/doorway.test.ts`
Expected: PASS — all twelve.

- [ ] **Step 5: Commit**

```bash
git add room-agent/src/doorway.ts room-agent/src/doorway.test.ts
git commit -m "feat(room): bounded first pass for doorway drops"
```

---

### Task 11: The doorway watcher

**Files:**
- Create: `room-agent/src/watcher.ts`
- Modify: `room-agent/src/index.ts`
- Modify: `room-agent/src/connection.ts`
- Test: `room-agent/src/watcher.test.ts`

**Interfaces:**
- Consumes: `zoneForPath`, `isNoiseName`, `buildDropReport`, `MAX_HEAD_CHARS`, `Roots`, `RoomConfig`.
- Produces:
  - `watchDoorway(roots: Roots, onDrop: (r: DropReport) => void, opts?: { settleMs?: number }): { stop: () => void }`
  - `connect(...)` gains `postDrop(r: DropReport): Promise<void>`.

Design notes:

- `fs.watch(dir, { recursive: true })` is supported on Linux from Node 20; the container runs Node 22.
- A copy in progress fires many events. Wait until the file's size is **stable across `settleMs`** before reporting, and report each path at most once per settled size.
- Directories are skipped; only files are reported.

- [ ] **Step 1: Write the failing test**

Create `room-agent/src/watcher.test.ts`:

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, appendFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { watchDoorway } from './watcher';
import type { DropReport } from './doorway';

async function fixture() {
  const base = await mkdtemp(join(tmpdir(), 'room-watch-'));
  const room = join(base, 'workshop');
  const doorway = join(base, 'doorway');
  await mkdir(room, { recursive: true });
  await mkdir(join(doorway, 'inbox'), { recursive: true });
  await mkdir(join(doorway, 'playground'), { recursive: true });
  return { room, doorway };
}

function collector() {
  const seen: DropReport[] = [];
  return { seen, onDrop: (r: DropReport) => seen.push(r) };
}

const settle = (ms: number) => new Promise((r) => setTimeout(r, ms));

test('a file dropped in inbox is reported with zone inbox', async () => {
  const roots = await fixture();
  const c = collector();
  const w = watchDoorway(roots, c.onDrop, { settleMs: 40 });
  await writeFile(join(roots.doorway, 'inbox', 'resume.txt'), 'hello world');
  await settle(400);
  w.stop();
  assert.equal(c.seen.length, 1);
  assert.equal(c.seen[0].zone, 'inbox');
  assert.equal(c.seen[0].name, 'resume.txt');
  assert.match(c.seen[0].head, /hello world/);
});

test('a file dropped in playground is reported with zone playground', async () => {
  const roots = await fixture();
  const c = collector();
  const w = watchDoorway(roots, c.onDrop, { settleMs: 40 });
  await writeFile(join(roots.doorway, 'playground', 'sketch.md'), '# idea');
  await settle(400);
  w.stop();
  assert.equal(c.seen.length, 1);
  assert.equal(c.seen[0].zone, 'playground');
});

test('noise files are never reported', async () => {
  const roots = await fixture();
  const c = collector();
  const w = watchDoorway(roots, c.onDrop, { settleMs: 40 });
  await writeFile(join(roots.doorway, 'inbox', '~$resume.docx'), 'lock');
  await writeFile(join(roots.doorway, 'inbox', '.DS_Store'), 'junk');
  await settle(400);
  w.stop();
  assert.equal(c.seen.length, 0);
});

test('a file still being written is reported once, after it settles', async () => {
  const roots = await fixture();
  const c = collector();
  const w = watchDoorway(roots, c.onDrop, { settleMs: 60 });
  const p = join(roots.doorway, 'inbox', 'big.txt');
  await writeFile(p, 'part1');
  await settle(20);
  await appendFile(p, 'part2');
  await settle(20);
  await appendFile(p, 'part3');
  await settle(500);
  w.stop();
  assert.equal(c.seen.length, 1, 'one settled report, not one per write');
  assert.match(c.seen[0].head, /part1part2part3/);
});

test('a directory created in the doorway is not reported as a drop', async () => {
  const roots = await fixture();
  const c = collector();
  const w = watchDoorway(roots, c.onDrop, { settleMs: 40 });
  await mkdir(join(roots.doorway, 'inbox', 'archive'));
  await settle(400);
  w.stop();
  assert.equal(c.seen.length, 0);
});

test('stop() ends reporting', async () => {
  const roots = await fixture();
  const c = collector();
  const w = watchDoorway(roots, c.onDrop, { settleMs: 40 });
  w.stop();
  await writeFile(join(roots.doorway, 'inbox', 'after.txt'), 'x');
  await settle(300);
  assert.equal(c.seen.length, 0);
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `pnpm exec tsx --test room-agent/src/watcher.test.ts`
Expected: FAIL — cannot find module `./watcher`.

- [ ] **Step 3: Implement the watcher**

Create `room-agent/src/watcher.ts`:

```ts
// Watches the two doorway folders and reports settled file drops. The routing and
// the first pass are pure (./doorway); this file is only fs plumbing.
//
// A copy in progress fires many events, so nothing is reported until the file's
// size has been stable for settleMs — otherwise a 40MB drop would raise a
// proposal about its first 4KB.
import { watch, type FSWatcher } from 'node:fs';
import { stat, open } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { zoneForPath, isNoiseName, buildDropReport, MAX_HEAD_CHARS, type DropReport } from './doorway';
import type { Roots } from './paths';

const DEFAULT_SETTLE_MS = 1500;

export function watchDoorway(
  roots: Roots,
  onDrop: (r: DropReport) => void,
  opts: { settleMs?: number } = {},
): { stop: () => void } {
  const settleMs = opts.settleMs ?? DEFAULT_SETTLE_MS;
  const timers = new Map<string, ReturnType<typeof setTimeout>>();
  const reported = new Map<string, number>(); // abs path → last reported size
  const watchers: FSWatcher[] = [];
  let stopped = false;

  async function report(abs: string): Promise<void> {
    if (stopped) return;
    try {
      const s = await stat(abs);
      if (!s.isFile()) return;
      if (reported.get(abs) === s.size) return; // already reported at this size
      const zone = zoneForPath(roots, abs);
      if (!zone) return;

      const fh = await open(abs, 'r');
      try {
        const buf = Buffer.alloc(Math.min(s.size, MAX_HEAD_CHARS * 2));
        if (buf.length) await fh.read(buf, 0, buf.length, 0);
        reported.set(abs, s.size);
        onDrop(buildDropReport({ zone, path: abs, sizeBytes: s.size, raw: buf }));
      } finally {
        await fh.close();
      }
    } catch {
      /* vanished mid-settle (a temp file, a cancelled copy) — nothing to report */
    }
  }

  function touch(abs: string): void {
    clearTimeout(timers.get(abs));
    timers.set(
      abs,
      setTimeout(() => {
        timers.delete(abs);
        void report(abs);
      }, settleMs),
    );
  }

  for (const zone of ['inbox', 'playground'] as const) {
    const dir = resolve(roots.doorway, zone);
    try {
      const w = watch(dir, { recursive: true }, (_event, filename) => {
        if (stopped || !filename) return;
        const name = String(filename);
        const leaf = name.split(/[\\/]/).pop() ?? name;
        if (isNoiseName(leaf)) return;
        touch(join(dir, name));
      });
      w.on('error', (e) => console.error(`[room] watcher error on ${dir}:`, e.message));
      watchers.push(w);
      console.log('[room] watching', dir);
    } catch (e) {
      console.error(`[room] cannot watch ${dir}:`, e instanceof Error ? e.message : e);
    }
  }

  return {
    stop() {
      stopped = true;
      for (const t of timers.values()) clearTimeout(t);
      timers.clear();
      for (const w of watchers) w.close();
    },
  };
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `pnpm exec tsx --test room-agent/src/watcher.test.ts`
Expected: PASS — all six.

- [ ] **Step 5: Add `postDrop` to the connection**

In `room-agent/src/connection.ts`, alongside `postResult`:

```ts
import type { DropReport } from './doorway';
```

```ts
  async function postDrop(r: DropReport): Promise<void> {
    await fetch(`${cfg.miniUrl}/api/companion/room-event`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-companion-token': cfg.token },
      body: JSON.stringify(r),
    }).catch((e) => console.error('[room] drop POST failed:', e?.message ?? e));
  }
```

and add it to the returned object: `return { postResult, postDrop, stop() { … } };`

- [ ] **Step 6: Start the watcher in the room agent**

In `room-agent/src/index.ts`, after `conn` is created:

```ts
import { watchDoorway } from './watcher';
```

```ts
const watcher = watchDoorway(cfg.roots, (drop) => {
  console.log('[room] drop', drop.zone, drop.name, `${drop.sizeBytes}b`);
  void conn.postDrop(drop);
});
```

and in `shutdown()`, before `conn.stop()`:

```ts
  watcher.stop();
```

- [ ] **Step 7: Verify**

Run: `pnpm exec tsx --test room-agent/src/*.test.ts`
Expected: PASS.

Run: `pnpm exec tsc --noEmit`
Expected: exit 0.

- [ ] **Step 8: Commit**

```bash
git add room-agent/src/watcher.ts room-agent/src/watcher.test.ts room-agent/src/connection.ts room-agent/src/index.ts
git commit -m "feat(room): watch the doorway and report settled drops"
```

---

### Task 12: Persist inbox drops as room proposals; act on playground drops

Decision 9: workshop output is reviewed through the existing proposal surface, and for non-code artifacts the proposal carries a short text summary and a path — no rendered preview, no new review surface. The existing `Proposal` type is derived from a session worktree's git diff and cannot represent a dropped file, so room proposals get their own small table and feed the same UI and Discord surfaces.

**Files:**
- Create: `src/lib/room-proposals.ts`
- Create: `src/lib/room-proposals.test.ts`
- Create: `src/lib/room-proposals-data.ts`
- Create: `src/app/api/companion/room-event/route.ts`
- Modify: `src/db/schema.ts`
- Create: `drizzle/0014_*.sql` (generated)

**Interfaces:**
- Consumes: `verifyCompanionToken(token, 'room')`, `runAkiraTurn(opts)` from `@/lib/akira-turn`, `db`.
- Produces:
  - `RoomProposal = { id: string; zone: 'inbox'; name: string; path: string; sizeBytes: number; ext: string | null; head: string | null; summary: string; status: 'open' | 'approved' | 'dismissed'; createdAt: string }`
  - `formatBytes(n: number): string`
  - `summarizeDrop(d: { name: string; ext: string; sizeBytes: number; head: string }): string`
  - `inboxTurnInstruction(p: { name: string; path: string; summary: string }): string`
  - `playgroundTurnInstruction(d: { name: string; path: string; head: string }): string`
  - `getOpenRoomProposals(): Promise<RoomProposal[]>`
  - `runRoomTurn(instruction: string): void` — serialized, fire-and-forget.

- [ ] **Step 1: Write the failing test**

Create `src/lib/room-proposals.test.ts`:

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { formatBytes, summarizeDrop, inboxTurnInstruction, playgroundTurnInstruction } from './room-proposals';

test('formatBytes is readable at every scale', () => {
  assert.equal(formatBytes(0), '0 B');
  assert.equal(formatBytes(512), '512 B');
  assert.equal(formatBytes(2048), '2.0 KB');
  assert.equal(formatBytes(5_400_000), '5.2 MB');
});

test('a summary names the file, its type and its size', () => {
  const s = summarizeDrop({ name: 'resume.docx', ext: 'docx', sizeBytes: 42_000, head: '(binary docx file)' });
  assert.match(s, /resume\.docx/);
  assert.match(s, /docx/i);
  assert.match(s, /41\.0 KB|41 KB/);
});

test('a text summary carries a first line of content, condensed', () => {
  const s = summarizeDrop({
    name: 'notes.md',
    ext: 'md',
    sizeBytes: 300,
    head: '# Q3 plan\n\n\nShip the room.\nThen the browser.\n',
  });
  assert.match(s, /Q3 plan/);
  assert.ok(!s.includes('\n\n\n'), 'blank runs are collapsed');
  assert.ok(s.length <= 280, `summary must stay short, got ${s.length}`);
});

test('a very long head is truncated with an ellipsis', () => {
  const s = summarizeDrop({ name: 'long.md', ext: 'md', sizeBytes: 99_999, head: 'x'.repeat(2000) });
  assert.ok(s.length <= 280);
  assert.match(s, /…$/);
});

test('the inbox instruction names the path and says the operator approved it', () => {
  const i = inboxTurnInstruction({ name: 'resume.docx', path: '/mnt/doorway/inbox/resume.docx', summary: 'resume.docx · docx · 41 KB' });
  assert.match(i, /\/mnt\/doorway\/inbox\/resume\.docx/);
  assert.match(i, /approved/i);
});

test('the playground instruction says she may act directly', () => {
  const i = playgroundTurnInstruction({ name: 'sketch.md', path: '/mnt/doorway/playground/sketch.md', head: '# idea' });
  assert.match(i, /\/mnt\/doorway\/playground\/sketch\.md/);
  assert.match(i, /playground/i);
  assert.ok(!/approv/i.test(i), 'playground work is ungated — do not ask for approval');
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `pnpm exec tsx --test src/lib/room-proposals.test.ts`
Expected: FAIL — cannot find module `./room-proposals`.

- [ ] **Step 3: Implement the pure module**

Create `src/lib/room-proposals.ts`:

```ts
// Pure shaping for doorway drops — no db, no server-only, so the tsx test runner
// can import it (same split as proposals.ts / proposals-data.ts).
//
// Decision 9: a non-code artifact is reviewed as a short text summary plus a
// path. Opening it is an ordinary file read; there is no rendered preview.

export interface RoomProposal {
  id: string;
  zone: 'inbox';
  name: string;
  path: string;
  sizeBytes: number;
  ext: string | null;
  head: string | null;
  summary: string;
  status: 'open' | 'approved' | 'dismissed';
  createdAt: string; // ISO
}

export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

const MAX_SUMMARY = 280;

/** Filename, type, size, and a condensed first look. Bounded on purpose. */
export function summarizeDrop(d: { name: string; ext: string; sizeBytes: number; head: string }): string {
  const kind = d.ext ? d.ext.toLowerCase() : 'file';
  const lead = `${d.name} · ${kind} · ${formatBytes(d.sizeBytes)}`;
  const body = (d.head ?? '')
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean)
    .slice(0, 3)
    .join(' ');
  const out = body ? `${lead} — ${body}` : lead;
  return out.length > MAX_SUMMARY ? out.slice(0, MAX_SUMMARY - 1).trimEnd() + '…' : out;
}

/** The instruction for the full-cost turn, which runs only AFTER approval. */
export function inboxTurnInstruction(p: { name: string; path: string; summary: string }): string {
  return [
    `A'Keem approved an item in your inbox: ${p.path}`,
    ``,
    `First look: ${p.summary}`,
    ``,
    `Work on it now with your room tools. Read it (convert it first with room_bash if it isn't plain text),`,
    `do what it plainly asks for, and write your result back into the doorway so he can open it.`,
    `Tell him in a few sentences what you did and where the result is.`,
  ].join('\n');
}

/** Playground drops are hers to act on directly — the folder carries the permission. */
export function playgroundTurnInstruction(d: { name: string; path: string; head: string }): string {
  return [
    `A'Keem dropped ${d.name} into your playground: ${d.path}`,
    ``,
    `The playground is yours to work in directly — he is not waiting to be asked.`,
    `Take a look and do the obvious useful thing with it, then tell him briefly what you did.`,
  ].join('\n');
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `pnpm exec tsx --test src/lib/room-proposals.test.ts`
Expected: PASS — all six.

- [ ] **Step 5: Add the table to the schema**

Append to `src/db/schema.ts`:

```ts
export const room_proposals = sqliteTable('room_proposals', {
  id: text('id').primaryKey(),
  zone: text('zone').notNull(),               // 'inbox' — playground never proposes
  name: text('name').notNull(),
  path: text('path').notNull(),               // absolute, inside the doorway
  size_bytes: integer('size_bytes').notNull(),
  ext: text('ext'),
  head: text('head'),                         // truncated first bytes
  summary: text('summary').notNull(),
  status: text('status').notNull(),           // 'open' | 'approved' | 'dismissed'
  created_at: integer('created_at', { mode: 'timestamp' }).notNull(),
  decided_at: integer('decided_at', { mode: 'timestamp' }),
});
```

- [ ] **Step 6: Generate the migration**

Run: `pnpm db:generate`
Expected: a new `drizzle/0014_*.sql` containing a single `CREATE TABLE room_proposals`.

Open it and confirm it is a plain `CREATE TABLE` with no table rebuild — a rebuild would need the sqlite3-CLI workaround this repo hit on migration 0010. A new table does not.

Run: `pnpm db:migrate`
Expected: applies cleanly against the local dev database.

- [ ] **Step 7: Write the data module**

Create `src/lib/room-proposals-data.ts`:

```ts
import 'server-only';
import { eq, desc, and } from 'drizzle-orm';
import { randomBytes, bytesToHex } from '@noble/hashes/utils.js';
import { db } from '@/db/client';
import { room_proposals } from '@/db/schema';
import { runAkiraTurn } from '@/lib/akira-turn';
import { type RoomProposal, summarizeDrop } from './room-proposals';

export async function getOpenRoomProposals(): Promise<RoomProposal[]> {
  const rows = await db
    .select()
    .from(room_proposals)
    .where(eq(room_proposals.status, 'open'))
    .orderBy(desc(room_proposals.created_at));
  return rows.map((r) => ({
    id: r.id,
    zone: 'inbox',
    name: r.name,
    path: r.path,
    sizeBytes: r.size_bytes,
    ext: r.ext,
    head: r.head,
    summary: r.summary,
    status: r.status as RoomProposal['status'],
    createdAt: (r.created_at ?? new Date()).toISOString(),
  }));
}

/** Record an inbox drop as an open proposal. Re-dropping the same path at the
 *  same size while one is already open is a no-op, so a re-save does not stack. */
export async function recordInboxDrop(d: {
  name: string;
  path: string;
  sizeBytes: number;
  ext: string;
  head: string;
}): Promise<RoomProposal | null> {
  const existing = await db
    .select({ id: room_proposals.id })
    .from(room_proposals)
    .where(
      and(
        eq(room_proposals.path, d.path),
        eq(room_proposals.size_bytes, d.sizeBytes),
        eq(room_proposals.status, 'open'),
      ),
    )
    .limit(1);
  if (existing.length) return null;

  const row = {
    id: `rprop_${bytesToHex(randomBytes(6))}`,
    zone: 'inbox' as const,
    name: d.name,
    path: d.path,
    size_bytes: d.sizeBytes,
    ext: d.ext || null,
    head: d.head || null,
    summary: summarizeDrop(d),
    status: 'open' as const,
    created_at: new Date(),
    decided_at: null,
  };
  await db.insert(room_proposals).values(row);
  return {
    id: row.id,
    zone: 'inbox',
    name: row.name,
    path: row.path,
    sizeBytes: row.size_bytes,
    ext: row.ext,
    head: row.head,
    summary: row.summary,
    status: 'open',
    createdAt: row.created_at.toISOString(),
  };
}

// AKIRA has ONE persistent thread. Two turns writing it concurrently would
// interleave her conversation, so doorway-triggered turns run one at a time —
// the same chain discipline the room agent uses for commands.
let turnChain: Promise<unknown> = Promise.resolve();

/** Queue a headless AKIRA turn. Fire-and-forget by design: the caller is an
 *  HTTP handler that must not block on a full agent turn. */
export function runRoomTurn(instruction: string): void {
  turnChain = turnChain
    .then(() => runAkiraTurn({ instruction }))
    .catch((e) => console.error('[room-event] turn failed:', e instanceof Error ? e.message : e));
}
```

- [ ] **Step 8: Write the room-event endpoint**

Create `src/app/api/companion/room-event/route.ts`:

```ts
import { verifyCompanionToken } from '@/lib/companion/auth';
import { recordInboxDrop, runRoomTurn } from '@/lib/room-proposals-data';
import { playgroundTurnInstruction } from '@/lib/room-proposals';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

interface DropBody {
  zone?: string;
  name?: string;
  path?: string;
  sizeBytes?: number;
  ext?: string;
  head?: string;
}

export async function POST(req: Request) {
  // Room-only: this endpoint exists because of Task 1/2. The laptop has no
  // doorway and no business posting drops.
  if (!verifyCompanionToken(req.headers.get('x-companion-token'), 'room')) {
    return new Response('Unauthorized', { status: 401 });
  }
  const b = (await req.json().catch(() => null)) as DropBody | null;
  if (!b || !b.path || !b.name || typeof b.sizeBytes !== 'number') {
    return new Response('bad drop', { status: 400 });
  }
  const drop = { name: b.name, path: b.path, sizeBytes: b.sizeBytes, ext: b.ext ?? '', head: b.head ?? '' };

  // The folder carries the permission: inbox asks first, playground acts.
  if (b.zone === 'inbox') {
    const created = await recordInboxDrop(drop);
    return Response.json({ ok: true, proposed: Boolean(created), id: created?.id ?? null });
  }
  if (b.zone === 'playground') {
    runRoomTurn(playgroundTurnInstruction(drop));
    return Response.json({ ok: true, acting: true });
  }
  return new Response('unknown zone', { status: 400 });
}
```

- [ ] **Step 9: Verify**

Run: `pnpm test`
Expected: PASS.

Run: `pnpm exec tsc --noEmit`
Expected: exit 0.

- [ ] **Step 10: Commit**

```bash
git add src/lib/room-proposals.ts src/lib/room-proposals.test.ts src/lib/room-proposals-data.ts src/app/api/companion/room-event src/db/schema.ts drizzle/
git commit -m "feat(room): inbox drops become proposals, playground drops start a turn"
```

---

### Task 13: Review room proposals in the Proposals view

**Files:**
- Create: `src/app/api/room-proposals/route.ts`
- Create: `src/app/api/room-proposals/[id]/approve/route.ts`
- Create: `src/app/api/room-proposals/[id]/dismiss/route.ts`
- Modify: `src/components/proposals-view.tsx`
- Modify: `src/components/mission-control.tsx:301` area, `:1009` area
- Modify: `src/app/dashboard/page.tsx`

**Interfaces:**
- Consumes: `getOpenRoomProposals()`, `runRoomTurn(instruction)`, `inboxTurnInstruction(p)`, `RoomProposal`.
- Produces: `ProposalsViewProps` gains `roomProposals: RoomProposal[]` and `onRefreshRoom: () => Promise<void>`; `MissionControlProps` gains `initialRoomProposals: RoomProposal[]`.

- [ ] **Step 1: Write the list route**

Create `src/app/api/room-proposals/route.ts`:

```ts
import { cookies } from 'next/headers';
import { SESSION_COOKIE, verifySession } from '@/lib/auth';
import { getOpenRoomProposals } from '@/lib/room-proposals-data';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET() {
  const jar = await cookies();
  const token = jar.get(SESSION_COOKIE)?.value;
  if (!token || !(await verifySession(token))) {
    return Response.json({ error: 'Unauthorized' }, { status: 401 });
  }
  return Response.json(await getOpenRoomProposals());
}
```

- [ ] **Step 2: Write the approve route**

Create `src/app/api/room-proposals/[id]/approve/route.ts`:

```ts
import { cookies } from 'next/headers';
import { eq, and } from 'drizzle-orm';
import { SESSION_COOKIE, verifySession } from '@/lib/auth';
import { db } from '@/db/client';
import { room_proposals } from '@/db/schema';
import { runRoomTurn } from '@/lib/room-proposals-data';
import { inboxTurnInstruction } from '@/lib/room-proposals';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const jar = await cookies();
  const token = jar.get(SESSION_COOKIE)?.value;
  if (!token || !(await verifySession(token))) {
    return Response.json({ error: 'Unauthorized' }, { status: 401 });
  }
  const { id } = await params;

  const row = await db
    .select()
    .from(room_proposals)
    .where(and(eq(room_proposals.id, id), eq(room_proposals.status, 'open')))
    .limit(1)
    .then((r) => r[0]);
  if (!row) return Response.json({ error: 'no open proposal' }, { status: 404 });

  await db
    .update(room_proposals)
    .set({ status: 'approved', decided_at: new Date() })
    .where(eq(room_proposals.id, id));

  // The full-cost turn runs only now, after approval.
  runRoomTurn(inboxTurnInstruction({ name: row.name, path: row.path, summary: row.summary }));
  return Response.json({ ok: true });
}
```

- [ ] **Step 3: Write the dismiss route**

Create `src/app/api/room-proposals/[id]/dismiss/route.ts` — identical to approve except it sets `status: 'dismissed'` and starts no turn:

```ts
import { cookies } from 'next/headers';
import { eq, and } from 'drizzle-orm';
import { SESSION_COOKIE, verifySession } from '@/lib/auth';
import { db } from '@/db/client';
import { room_proposals } from '@/db/schema';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const jar = await cookies();
  const token = jar.get(SESSION_COOKIE)?.value;
  if (!token || !(await verifySession(token))) {
    return Response.json({ error: 'Unauthorized' }, { status: 401 });
  }
  const { id } = await params;
  await db
    .update(room_proposals)
    .set({ status: 'dismissed', decided_at: new Date() })
    .where(and(eq(room_proposals.id, id), eq(room_proposals.status, 'open')));
  return Response.json({ ok: true });
}
```

- [ ] **Step 4: Add the section to `ProposalsView`**

In `src/components/proposals-view.tsx`, extend the props and render a room section above the existing list. Import `Inbox` from `lucide-react` alongside the existing icons.

```tsx
import type { RoomProposal } from "@/lib/room-proposals";

interface ProposalsViewProps {
  proposals: Proposal[];
  roomProposals: RoomProposal[];
  onSelectSession: (sessionId: string) => Promise<void>;
  onRefresh: () => Promise<void>;
  onRefreshRoom: () => Promise<void>;
}

export default function ProposalsView({
  proposals,
  roomProposals,
  onSelectSession,
  onRefresh,
  onRefreshRoom,
}: ProposalsViewProps) {
  // …existing state…
  const [roomBusyId, setRoomBusyId] = useState<string | null>(null);

  async function decideRoom(id: string, decision: "approve" | "dismiss") {
    setRoomBusyId(id);
    try {
      await fetch(`/api/room-proposals/${id}/${decision}`, { method: "POST" });
      await onRefreshRoom();
    } finally {
      setRoomBusyId(null);
    }
  }
```

Inside the scrolling body, before the git-diff proposals, render:

```tsx
        {roomProposals.length > 0 && (
          <div className="border-b border-[#1e2632]">
            <div className="px-4 py-2 flex items-center gap-2">
              <Inbox className="w-3 h-3 text-[#5c6470]" />
              <span className="text-[10px] font-mono uppercase tracking-wide text-[#5c6470]">
                AKIRA&apos;s inbox — dropped in ~/AKIRA/inbox
              </span>
            </div>
            {roomProposals.map((p) => (
              <div key={p.id} className="px-4 py-3 border-t border-[#1e2632]">
                <div className="text-xs text-[#e6edf3] font-medium">{p.name}</div>
                <div className="text-[10px] font-mono text-[#5c6470] mt-0.5 break-all">{p.path}</div>
                <div className="text-[11px] text-[#8b949e] mt-1.5 whitespace-pre-wrap">{p.summary}</div>
                <div className="mt-2 flex gap-2">
                  <button
                    disabled={roomBusyId === p.id}
                    onClick={() => decideRoom(p.id, "approve")}
                    className="text-[10px] font-mono px-2 py-1 rounded border border-[#2a3441] bg-[#161c25] text-[#e6edf3] disabled:opacity-50"
                  >
                    {roomBusyId === p.id ? <Loader2 className="w-3 h-3 animate-spin" /> : "Have her work on it"}
                  </button>
                  <button
                    disabled={roomBusyId === p.id}
                    onClick={() => decideRoom(p.id, "dismiss")}
                    className="text-[10px] font-mono px-2 py-1 rounded border border-[#2a3441] text-[#5c6470] disabled:opacity-50"
                  >
                    Dismiss
                  </button>
                </div>
              </div>
            ))}
          </div>
        )}
```

- [ ] **Step 5: Thread the data through `mission-control.tsx`**

Add to the props interface and to the component:

```tsx
import type { RoomProposal } from "@/lib/room-proposals";
```

```tsx
  const [roomProposals, setRoomProposals] = useState<RoomProposal[]>(initialRoomProposals);

  const refreshRoomProposals = useCallback(async () => {
    const res = await fetch(`/api/room-proposals`);
    if (res.ok) setRoomProposals((await res.json()) as RoomProposal[]);
  }, []);
```

Pass them through at the `ProposalsView` call site (~line 1009):

```tsx
          <ProposalsView
            proposals={proposals}
            roomProposals={roomProposals}
            onSelectSession={handleSelectSession}
            onRefresh={refreshProposals}
            onRefreshRoom={refreshRoomProposals}
          />
```

The sidebar badge at `counts={{ proposals: proposals.length }}` becomes `proposals.length + roomProposals.length` so an inbox item is visible without opening the section.

- [ ] **Step 6: Load them server-side**

In `src/app/dashboard/page.tsx`, add the import next to the existing one on line 12:

```tsx
import { getOpenRoomProposals } from "@/lib/room-proposals-data";
```

then, directly after `const initialProposals = await getProposals();` (line 206):

```tsx
  const initialRoomProposals = await getOpenRoomProposals();
```

and pass it at the `<MissionControl …>` call site, next to `initialProposals={initialProposals}` (line 229):

```tsx
      initialRoomProposals={initialRoomProposals}
```

- [ ] **Step 7: Verify**

Run: `pnpm exec tsc --noEmit`
Expected: exit 0.

Run: `pnpm build`
Expected: exit 0.

Run: `pnpm lint`
Expected: no new errors.

- [ ] **Step 8: Commit**

```bash
git add src/app/api/room-proposals src/components/proposals-view.tsx src/components/mission-control.tsx src/app/dashboard/page.tsx
git commit -m "feat(proposals): review AKIRA's inbox drops in the proposals surface"
```

---

### Task 14: Discord embeds for room proposals

Decision 9 names the Discord embeds from the ~30s poller as part of the review surface. `diffProposals(prev: Set, curr: Set)` is already generic over id sets and is reused as-is — no new diff helper.

**Files:**
- Modify: `src/lib/discord-format.ts`
- Modify: `src/lib/discord-notify.ts`
- Test: `src/lib/discord-format.test.ts`

**Interfaces:**
- Consumes: `diffProposals(prev, curr)`, `getOpenRoomProposals()`, `RoomProposal`, `postToProject(client, projectId, embed)`.
- Produces: `roomProposalEmbed(p: RoomProposal): APIEmbed`.

- [ ] **Step 1: Write the failing test**

Append to `src/lib/discord-format.test.ts`:

```ts
import { roomProposalEmbed } from './discord-format';

const drop = {
  id: 'rprop_abc',
  zone: 'inbox' as const,
  name: 'resume.docx',
  path: '/mnt/doorway/inbox/resume.docx',
  sizeBytes: 42_000,
  ext: 'docx',
  head: '(binary docx file)',
  summary: 'resume.docx · docx · 41.0 KB',
  status: 'open' as const,
  createdAt: '2026-08-15T09:30:00.000Z',
};

test('a room proposal embed names the file and where it landed', () => {
  const e = roomProposalEmbed(drop);
  assert.match(e.title ?? '', /resume\.docx/);
  assert.match(JSON.stringify(e), /inbox/i);
  assert.match(e.description ?? '', /41\.0 KB/);
});

test('the embed carries the path so it can be opened without the UI', () => {
  assert.match(JSON.stringify(roomProposalEmbed(drop)), /\/mnt\/doorway\/inbox\/resume\.docx/);
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `pnpm exec tsx --test src/lib/discord-format.test.ts`
Expected: FAIL — no export named `roomProposalEmbed`.

- [ ] **Step 3: Add the embed builder**

Append to `src/lib/discord-format.ts`, matching the style of the existing `proposalEmbed`:

```ts
import type { RoomProposal } from './room-proposals';

/** A file the operator dropped in ~/AKIRA/inbox, awaiting his go-ahead.
 *  No action row: approving starts a full agent turn, which belongs on the
 *  dashboard rather than behind a Discord button. */
export function roomProposalEmbed(p: RoomProposal): APIEmbed {
  return {
    title: `📥 ${p.name} is in AKIRA's inbox`,
    description: p.summary,
    fields: [{ name: 'path', value: `\`${p.path}\``, inline: false }],
    footer: { text: 'Approve it in Proposals to have her work on it' },
    timestamp: p.createdAt,
  };
}
```

If `APIEmbed` is not already imported in that file, add `import type { APIEmbed } from 'discord.js';`.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `pnpm exec tsx --test src/lib/discord-format.test.ts`
Expected: PASS.

- [ ] **Step 5: Post them from the poller**

In `src/lib/discord-notify.ts`, add the cursor next to the existing ones:

```ts
let roomProposalCursor = new Set<string>();
```

In `tick()`, after the existing proposals are gathered:

```ts
  const roomProps = await getOpenRoomProposals();
  const currRoomIds = new Set(roomProps.map((p) => p.id));
  const roomProp = diffProposals(roomProposalCursor, currRoomIds);
```

Prime it with the others in the `if (!primed)` block:

```ts
    roomProposalCursor = roomProp.next;
```

and post after the existing proposal loop:

```ts
  // --- AKIRA's inbox: route to the home project channel (drops are not project-scoped) ---
  for (const id of roomProp.newIds) {
    const p = roomProps.find((x) => x.id === id);
    if (p && (await postToProject(client, DREAM_PROJECT_ID, roomProposalEmbed(p)))) {
      roomProposalCursor.add(id);
    }
  }
  roomProposalCursor = new Set([...roomProposalCursor].filter((id) => currRoomIds.has(id)));
```

Add the two imports: `getOpenRoomProposals` from `./room-proposals-data` and `roomProposalEmbed` to the existing `./discord-format` import list.

- [ ] **Step 6: Verify**

Run: `pnpm test`
Expected: PASS.

Run: `pnpm exec tsc --noEmit`
Expected: exit 0.

- [ ] **Step 7: Commit**

```bash
git add src/lib/discord-format.ts src/lib/discord-format.test.ts src/lib/discord-notify.ts
git commit -m "feat(discord): post an embed when something lands in AKIRA's inbox"
```

---

### Task 15: Teach AKIRA about her shell and her doorway

The tool descriptions in Task 8 tell her *what* `room_bash` does. Her system prompt has to tell her how the two doorway folders differ and what to do when a command is gated — and the "stop and wait, don't retry" language already exists in this repo and is reused verbatim rather than reinvented.

**Files:**
- Modify: `src/lib/akira/prompt.ts`
- Test: `src/lib/akira/prompt.test.ts`

- [ ] **Step 1: Write the failing test**

Append to `src/lib/akira/prompt.test.ts`:

```ts
test('the prompt explains the two doorway folders and which one asks first', () => {
  assert.match(AKIRA_SYSTEM_PROMPT, /inbox/i);
  assert.match(AKIRA_SYSTEM_PROMPT, /playground/i);
  assert.match(AKIRA_SYSTEM_PROMPT, /~\/AKIRA/);
});

test('the prompt tells her to stop and wait on a gated command, not retry', () => {
  assert.match(AKIRA_SYSTEM_PROMPT, /do not retry|don't retry/i);
});

test('the prompt says her room work is hers and prod is off limits', () => {
  assert.match(AKIRA_SYSTEM_PROMPT, /room/i);
  assert.match(AKIRA_SYSTEM_PROMPT, /prod|Mission Control/i);
});
```

`AKIRA_SYSTEM_PROMPT` is already imported at the top of that test file — no import change needed.

- [ ] **Step 2: Run it to verify it fails**

Run: `pnpm exec tsx --test src/lib/akira/prompt.test.ts`
Expected: FAIL on the doorway assertions.

- [ ] **Step 3: Add the section to `AKIRA_SYSTEM_PROMPT`**

Insert this block where the prompt describes her tools (keep the surrounding voice and terseness — the front-door brevity rules from v1.13.1 still apply):

```
## YOUR ROOM

You have a container on the Mini that is yours. `room_list`/`room_read`/`room_write` read and write
files in it; `room_bash` runs shell commands in it. Install what you need, convert documents, use git.
Break it if you have to — it can be restored from a snapshot. You cannot reach Mission Control's own
files or A'Keem's home directory from there, and you should not try.

Two folders are shared with his desktop at `~/AKIRA`, and the folder carries the permission:

- `~/AKIRA/inbox` (`/mnt/doorway/inbox`) — he drops something here when he wants you to ASK first.
  You'll be handed it as an instruction once he approves; don't go trawling the inbox unprompted.
- `~/AKIRA/playground` (`/mnt/doorway/playground`) — yours to act in directly, no approval needed.

Write your results back into the doorway so he can open them in his own file manager.

If `room_bash` tells you a command is gated, that is A'Keem's brake on things that would keep running
after the command ends. Stop and wait for his answer — do not retry, and do not look for another way
to do the same thing.
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `pnpm exec tsx --test src/lib/akira/prompt.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/lib/akira/prompt.ts src/lib/akira/prompt.test.ts
git commit -m "feat(akira): prompt language for the room shell and the two doorway folders"
```

> ⚠️ **A prompt change needs a reseed on deploy.** Task 16 covers it. AKIRA's live prompt is stored in
> the database; editing this file alone changes nothing on the Mini.

---

### Task 16: Deploy slice 2 to the Mini

Ops. No unit tests — the verification steps are the test. Do not start any of this until every task above is merged to `dev`, `pnpm test` is green, `pnpm exec tsc --noEmit` is clean, and `pnpm build` exits 0.

Use the `ship-mc-feature` skill for the release itself. Target version **v1.22.0**.

**Files:**
- Modify: `deploy/room/provision.sh` (workshop remote)
- Modify: `docs/runbook-mini-desktop.md`

**Interfaces:**
- Consumes: everything above.
- Produces: a live room with a shell, a watcher, and its own credential.

- [ ] **Step 1: Add the workshop bare remote to the provisioner**

Decision 6: her work survives a container rebuild via a bare repo on the Mini, not a public host. Append to `deploy/room/provision.sh`, before the final `echo`:

```bash
# Decision 6: the workshop's remote is a bare repo on the Mini — outside the
# container, reachable over the bridge. Durability without a public push channel.
WORKSHOP_REMOTE="$HOME/akira-workshop.git"
if [ ! -d "$WORKSHOP_REMOTE" ]; then
  git init --bare "$WORKSHOP_REMOTE"
  echo "created workshop remote at $WORKSHOP_REMOTE"
fi

lxc config device remove "$CONTAINER" workshop-remote 2>/dev/null || true
lxc config device add "$CONTAINER" workshop-remote disk source="$WORKSHOP_REMOTE" path=/mnt/workshop-remote

lxc exec "$CONTAINER" -- sudo -u akira bash -lc '
  cd /home/akira/workshop
  git rev-parse --git-dir >/dev/null 2>&1 || git init
  git remote get-url origin >/dev/null 2>&1 || git remote add origin /mnt/workshop-remote
  git config user.email "akira@axodcreative.com"
  git config user.name "AKIRA"
'
```

- [ ] **Step 2: Cut the release**

Follow `ship-mc-feature`: merge `dev` → `main`, bump to `1.22.0`, tag `v1.22.0`, push.

- [ ] **Step 3: Deploy Mission Control to the Mini**

```bash
ssh akeem@10.0.0.219
sudo -n -u mc git -C /srv/mission-control pull
sudo -n -u mc pnpm -C /srv/mission-control install
sudo -n -u mc pnpm -C /srv/mission-control db:migrate    # migration 0014: room_proposals
sudo -n -u mc pnpm -C /srv/mission-control build
```

Set the new secret **before** restarting:

```bash
openssl rand -hex 32      # note this value; it is NOT the laptop's COMPANION_TOKEN
sudo -n -u mc tee -a /srv/mission-control/.env <<< "ROOM_COMPANION_TOKEN=<the value>"
sudo systemctl restart mission-control
```

Then reseed — the prompt changed in Task 15, and AKIRA's live prompt lives in the database:

```bash
sudo -n -u mc pnpm -C /srv/mission-control seed
```

- [ ] **Step 4: Verify prod came back**

```bash
curl -s localhost:3000/api/health          # expect 1.22.0
systemctl --failed                         # expect 0 failed units
```

`systemctl --failed` after every deploy is a standing rule in this repo, not a suggestion.

- [ ] **Step 5: Re-provision and update the room**

```bash
bash deploy/room/provision.sh                       # adds the workshop remote; idempotent
lxc file push -r room-agent/src akira-room/home/akira/room-agent/
lxc exec akira-room -- bash -lc "printf 'ROOM_TOKEN=%s\n' '<the ROOM_COMPANION_TOKEN value>' >> /home/akira/room-agent/.env"
```

Edit the container's `.env` so `ROOM_TOKEN` holds **only** the new value (remove the old line, which was a copy of `COMPANION_TOKEN`), then:

```bash
lxc exec akira-room -- systemctl restart akira-room
lxc exec akira-room -- journalctl -u akira-room -n 30 --no-pager
```

Expect `[room] connected to http://10.138.75.1:3000` and two `[room] watching …` lines. A repeating `stream 401` means the two token values do not match — or that you pasted `COMPANION_TOKEN` into both, which fails closed by design.

- [ ] **Step 6: Verify the token split actually holds**

From inside the container, try to connect as the laptop. This must fail:

```bash
lxc exec akira-room -- bash -lc 'TOK=$(grep ^ROOM_TOKEN= /home/akira/room-agent/.env | cut -d= -f2); curl -s -o /dev/null -w "%{http_code}\n" "http://10.138.75.1:3000/api/companion/stream?token=$TOK&target=laptop"'
```

Expected: `401`. If it returns 200, Decision 5 is not in force — stop and fix it before going further.

- [ ] **Step 7: Verify the shell end to end**

From the front door at `bridge.axodcreative.com`, ask AKIRA to run something ordinary:

> "Run `uname -a && df -h /` in your room."

Expect output in her reply. Then confirm the log exists and is on the **Mission Control** side, not in the room:

```bash
sudo -n -u mc tail -5 /srv/mission-control/data/room-shell.log
```

Expect JSONL lines with `"event":"dispatch"` and `"event":"result"`.

- [ ] **Step 8: Verify the gate**

Ask her:

> "Start a dev server in your room on port 8080."

Expect: the HUD shows the gate card naming the command, and she stops rather than retrying. Click **Deny** and confirm she reports back that it wasn't approved. Then repeat and click **Approve**, and confirm the command runs.

- [ ] **Step 9: Verify the doorway loop**

On the Mini's desktop, drop a file into `~/AKIRA/inbox`. Within seconds:

- `journalctl` in the container shows `[room] drop inbox <name>`
- the Proposals section in the dashboard shows it under "AKIRA's inbox"
- a Discord embed appears in the `mission-control` channel within ~30s

Click **Have her work on it** and confirm a turn runs and a result appears in the doorway.

Then drop a file into `~/AKIRA/playground` and confirm a turn starts **without** any proposal.

- [ ] **Step 10: Snapshot the working room**

```bash
lxc snapshot akira-room clean-slice2
lxc info akira-room | grep -A5 Snapshots
```

- [ ] **Step 11: Record the outcome**

Append a `## Slice 2 — EXECUTED <date>` section to `docs/runbook-mini-desktop.md` with: the release version, the migration applied, the two-secret setup, the snapshot name, and anything that differed from these steps. Update the slice table in `docs/superpowers/specs/2026-08-13-akiras-room-design.md` to mark slice 2 shipped, and strike the two prerequisites this slice resolved under "Carried into slice 2".

```bash
git add docs/
git commit -m "docs(runbook): record the slice 2 deploy"
```

---

## Verification checklist

Before calling this slice done, all of these must be true with output you have actually seen:

- [ ] `pnpm test` passes, including the new `gates`, `shell-gate`, `shell-ops`, `paths-real`, `doorway`, `watcher`, `shell-log`, and `room-proposals` suites.
- [ ] `pnpm exec tsc --noEmit` exits 0.
- [ ] `pnpm build` exits 0.
- [ ] `pnpm lint` reports no new errors.
- [ ] A room credential presented at `?target=laptop` returns 401 **on the Mini** (Task 16 step 6).
- [ ] `systemctl --failed` shows 0 failed units after the deploy.
- [ ] A shell command runs from the front door and appears in `data/room-shell.log`.
- [ ] A gated command shows the HUD card, and both Deny and Approve behave correctly.
- [ ] An inbox drop produces a proposal in the UI **and** a Discord embed; approving it runs a turn.
- [ ] A playground drop runs a turn with no proposal.
- [ ] `lxc snapshot` `clean-slice2` exists.

## Deliberate scope boundaries

Stated so a reviewer does not read them as omissions:

- **Egress stays open.** No allowlist, no proxy, no network filtering (Decision 4).
- **`Bash` gates only long-running processes.** Not `rm`, not `git push`, not "irreversible-looking" commands (Decision 7).
- **Doorway writes are ungated everywhere**, in `shell` as in `fs_write` (Decision 7).
- **Room proposals have no rendered preview** — a summary and a path, opened as an ordinary file read (Decision 9).
- **Chrome and Xvfb are slice 3.** The room browser is not built here.
- **Approving a room proposal is a dashboard action.** The Discord embed announces; it carries no action row, because approval starts a full agent turn.
