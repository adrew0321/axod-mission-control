# AKIRA's Room — Slice 1 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give AKIRA an isolated container on the Mini ("the room") that she can read and write files in, reached through the existing companion protocol, with a narrow shared doorway to the operator's desktop.

**Architecture:** The room runs a small agent that dials out to Mission Control over SSE exactly as the laptop companion does. The in-memory registry that today holds one companion sink gains a `target` dimension (`'laptop' | 'room'`), defaulting to `'laptop'` so every existing call site and the deployed laptop companion keep working untouched. File operations travel as new `fs_*` actions on the existing `Command`/`Result` wire, and every path is validated against the room root and the doorway mount before it touches disk.

**Tech Stack:** TypeScript, Next.js (App Router), `node:test` via `tsx`, LXD, pnpm workspaces.

**Spec:** `docs/superpowers/specs/2026-08-13-akiras-room-design.md`

## Status — 2026-08-14

**Tasks 1–7 (the code half) are DONE and merged to `dev`** as merge commit `341d392`, built via
subagent-driven-development. Verified on the merged result: `pnpm test` 426/426, `pnpm exec tsc
--noEmit` clean, `pnpm build` exit 0. Not released, not pushed, not deployed — version stays 1.19.0.

**Task 8 is NOT done.** It provisions the LXD container on the production Mini and depends on slice 0
(`docs/runbook-mini-desktop.md`), which has not been run. Until it is, this work is inert for the
running system: the room tools only enter AKIRA's toolset when `isOnline('room')` is true.

Two deliberate deviations from the text below, both reviewed:

- **Task 4** — `execFs` now rejects a non-fs action *before* validating the path. As written, the gate
  short-circuited first and returned `blocked: 'empty path'` for a misrouted browser command, which
  misreports a routing bug as a boundary refusal and made this task's own `default:` branch unreachable.
- **Task 7** — the `ctx.emit({ type: 'hard_gate', … })` call on a blocked path was dropped. `hard_gate`
  renders an "approve?" prompt in the HUD, and `/api/companion/approve` sends `{action:'click'}` to the
  **laptop** — so approving a room path refusal would fire a bogus browser click carrying a filesystem
  path at the operator's machine, then tell AKIRA to continue, contradicting the tool's own "do not
  retry" text. `execFs` never reads `cmd.approved`, so a path refusal is not approvable at all.

Three prerequisites for slice 2 came out of this build — symlink resolution, a per-target token, and a
guard on the registry's unregister rejection loop. They are recorded in the spec under
"Carried into slice 2".

## Global Constraints

- **Slice 0 must be complete first.** `~/AKIRA/inbox` and `~/AKIRA/playground` must exist on the Mini — see `docs/runbook-mini-desktop.md`.
- **Container runtime is LXD.** Not Docker, not systemd-nspawn.
- **Network egress from the room is unrestricted** in this slice.
- **`protocol.ts` has three byte-identical copies:** `src/lib/companion/protocol.ts`, `companion/src/protocol.ts`, `room-agent/src/protocol.ts`. Any change to one changes all three. Task 2 adds a test that enforces this.
- **Imports are extensionless.** `import { x } from './paths'` — never `'./paths.ts'`. The `.ts` extension breaks `tsc` and the Next build.
- **Tests run from the repo root** via `pnpm test`, which already globs `companion/src/*.test.ts`. Add `room-agent/src/*.test.ts` to that glob in Task 3.
- **Never edit `/srv/mission-control` directly.** It is the running application.
- **The room can never reach prod.** No mount, no route, no credential. Task 3 has an explicit test for this.
- Default target is `'laptop'` everywhere it is optional — back-compat for the deployed companion, which sends no target.

---

### Task 1: Registry gains a target dimension

**Files:**
- Modify: `src/lib/companion/registry.ts`
- Test: `src/lib/companion/registry.test.ts`

**Interfaces:**
- Consumes: nothing (first task)
- Produces: `export type CompanionTarget = 'laptop' | 'room'`; `registerCompanion(s: CompanionSink, target?: CompanionTarget): () => void`; `isOnline(target?: CompanionTarget): boolean`; `sendCommand(cmd: Omit<Command,'id'>, timeoutMs?: number, target?: CompanionTarget): { id: string; result: Promise<Result> }`. All three default `target` to `'laptop'`.

- [x] **Step 1: Write the failing tests**

Append to `src/lib/companion/registry.test.ts`:

```ts
test('laptop and room are independent sinks', () => {
  const laptop: { id: string }[] = [];
  const room: { id: string }[] = [];
  const unregL = registerCompanion({ send: (c) => laptop.push(c) }, 'laptop');
  const unregR = registerCompanion({ send: (c) => room.push(c) }, 'room');

  assert.equal(isOnline('laptop'), true);
  assert.equal(isOnline('room'), true);

  sendCommand({ action: 'fs_list', path: '.' }, 1000, 'room');
  assert.equal(room.length, 1);
  assert.equal(laptop.length, 0, 'a room command must not reach the laptop sink');

  unregL();
  unregR();
});

test('disconnecting the room does not fail laptop commands', async () => {
  const unregL = registerCompanion({ send: () => {} }, 'laptop');
  const unregR = registerCompanion({ send: () => {} }, 'room');

  const laptopCmd = sendCommand({ action: 'read' }, 1000, 'laptop');
  const roomCmd = sendCommand({ action: 'fs_list', path: '.' }, 1000, 'room');

  unregR(); // room drops

  await assert.rejects(() => roomCmd.result, /disconnected/i);
  resolveResult({ id: laptopCmd.id, status: 'ok', text: 'still here' });
  assert.equal((await laptopCmd.result).text, 'still here');

  unregL();
});

test('target defaults to laptop', () => {
  const seen: { id: string }[] = [];
  const unreg = registerCompanion({ send: (c) => seen.push(c) }); // no target
  assert.equal(isOnline(), true);
  assert.equal(isOnline('room'), false);
  sendCommand({ action: 'read' }); // no target
  assert.equal(seen.length, 1);
  unreg();
});
```

- [x] **Step 2: Run tests to verify they fail**

Run: `pnpm exec tsx --test src/lib/companion/registry.test.ts`
Expected: FAIL — `registerCompanion` currently takes one argument, so `isOnline('room')` returns `true` after any registration and the independence assertion fails.

- [x] **Step 3: Rewrite the registry**

Replace the body of `src/lib/companion/registry.ts` below the imports:

```ts
export interface CompanionSink {
  send: (cmd: Command) => void;
  close?: () => void;
}

/** Which machine a command is bound for. 'laptop' is the operator's (replaceable) work
 *  machine; 'room' is AKIRA's container on the Mini. */
export type CompanionTarget = 'laptop' | 'room';

const DEFAULT_TIMEOUT_MS = 60_000;

const sinks = new Map<CompanionTarget, CompanionSink>();
const pending = new Map<
  string,
  { target: CompanionTarget; resolve: (r: Result) => void; reject: (e: Error) => void; timer: ReturnType<typeof setTimeout> }
>();

export function newId(): string {
  return `cmd_${bytesToHex(randomBytes(6))}`;
}

export function registerCompanion(s: CompanionSink, target: CompanionTarget = 'laptop'): () => void {
  sinks.get(target)?.close?.();
  sinks.set(target, s);
  return () => {
    if (sinks.get(target) === s) sinks.delete(target);
    // Fail only this target's in-flight commands — never silently hang, and never
    // take down the other machine's work.
    for (const [id, p] of pending) {
      if (p.target !== target) continue;
      clearTimeout(p.timer);
      p.reject(new Error('companion disconnected'));
      pending.delete(id);
    }
  };
}

export function isOnline(target: CompanionTarget = 'laptop'): boolean {
  return sinks.has(target);
}

export function hasPending(): boolean {
  return pending.size > 0;
}

export function sendCommand(
  cmd: Omit<Command, 'id'>,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  target: CompanionTarget = 'laptop',
): { id: string; result: Promise<Result> } {
  const id = newId();
  const sink = sinks.get(target);
  if (!sink) {
    return { id, result: Promise.reject(new Error(`companion offline: ${target}`)) };
  }
  const full: Command = { ...cmd, id };
  const result = new Promise<Result>((resolve, reject) => {
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(new Error('companion command timeout'));
    }, timeoutMs);
    pending.set(id, { target, resolve, reject, timer });
  });
  sink.send(full);
  return { id, result };
}

export function resolveResult(r: Result): void {
  const p = pending.get(r.id);
  if (!p) return;
  clearTimeout(p.timer);
  pending.delete(r.id);
  p.resolve(r);
}
```

Update the file's header comment — it currently says "Single laptop: one sink at a time":

```ts
// In-memory bridge between AKIRA's tools and the connected companions.
// One sink per target (laptop / room). Not server-only — pure promise/bus logic,
// unit-tested with fake sinks.
```

- [x] **Step 4: Run tests to verify they pass**

Run: `pnpm exec tsx --test src/lib/companion/registry.test.ts`
Expected: PASS, 6 tests. The three pre-existing tests must still pass — they call the no-target form, which is the back-compat path.

- [x] **Step 5: Verify no call site broke**

Run: `pnpm exec tsc --noEmit`
Expected: no errors. All seven existing callers (`approve/route.ts`, `status/route.ts`, `stream/route.ts`, `page.tsx`, `browser-tools.ts`, `tools.ts`, `akira-turn.ts`) use the defaulted form and need no changes.

- [x] **Step 6: Commit**

```bash
git add src/lib/companion/registry.ts src/lib/companion/registry.test.ts
git commit -m "feat(companion): registry supports multiple targets (laptop/room)"
```

---

### Task 2: Protocol gains fs actions, with a drift guard

**Files:**
- Modify: `src/lib/companion/protocol.ts`
- Modify: `companion/src/protocol.ts`
- Create: `room-agent/src/protocol.ts`
- Create: `src/lib/companion/protocol-copies.test.ts`

**Interfaces:**
- Consumes: Task 1's `CompanionTarget` (not directly imported; conceptual)
- Produces: `CommandAction` extended with `'fs_list' | 'fs_read' | 'fs_write'`; `Command` gains optional `path?: string` and `content?: string`.

- [x] **Step 1: Write the failing test**

Create `src/lib/companion/protocol-copies.test.ts`:

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

// pnpm test runs from the repo root.
const COPIES = [
  'src/lib/companion/protocol.ts',
  'companion/src/protocol.ts',
  'room-agent/src/protocol.ts',
];

test('all protocol copies are byte-identical', () => {
  const contents = COPIES.map((p) => readFileSync(join(process.cwd(), p), 'utf8'));
  const [first, ...rest] = contents;
  rest.forEach((c, i) => {
    assert.equal(c, first, `${COPIES[i + 1]} has drifted from ${COPIES[0]}`);
  });
});

test('the protocol declares the fs actions', () => {
  const src = readFileSync(join(process.cwd(), COPIES[0]), 'utf8');
  for (const action of ['fs_list', 'fs_read', 'fs_write']) {
    assert.ok(src.includes(`'${action}'`), `CommandAction is missing ${action}`);
  }
});
```

- [x] **Step 2: Run test to verify it fails**

Run: `pnpm exec tsx --test src/lib/companion/protocol-copies.test.ts`
Expected: FAIL with `ENOENT` on `room-agent/src/protocol.ts` — the file does not exist yet.

- [x] **Step 3: Write the protocol, three times**

This exact content goes in **all three** paths — `src/lib/companion/protocol.ts`, `companion/src/protocol.ts`, and `room-agent/src/protocol.ts` (create the directory first):

```ts
// Shared wire types for the AKIRA Local Companion and the room agent. Pure — no deps.
// THREE byte-identical copies exist: src/lib/companion/protocol.ts,
// companion/src/protocol.ts, room-agent/src/protocol.ts.
// protocol-copies.test.ts enforces that they stay identical.

export type CommandAction =
  | 'navigate'
  | 'read'
  | 'type'
  | 'click'
  | 'wait'
  | 'fs_list'
  | 'fs_read'
  | 'fs_write';

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
  /** Set true only after the operator explicitly approved a hard-gated action. */
  approved?: boolean;
}

export interface RawEl {
  ref: string;
  tag: string;
  role?: string;
  name?: string;
  type?: string;
  href?: string;
}

export interface Snapshot {
  url: string;
  title: string;
  text: string;
  elements: RawEl[];
}

export type ResultStatus = 'ok' | 'error' | 'blocked';

export interface Result {
  id: string;
  status: ResultStatus;
  snapshot?: Snapshot;
  text?: string;
  reason?: string;
}
```

- [x] **Step 4: Run test to verify it passes**

Run: `pnpm exec tsx --test src/lib/companion/protocol-copies.test.ts`
Expected: PASS, 2 tests.

- [x] **Step 5: Commit**

```bash
git add src/lib/companion/protocol.ts companion/src/protocol.ts room-agent/src/protocol.ts src/lib/companion/protocol-copies.test.ts
git commit -m "feat(protocol): add fs_list/fs_read/fs_write actions + copy drift guard"
```

---

### Task 3: Doorway path validation

**Files:**
- Create: `room-agent/src/paths.ts`
- Create: `room-agent/src/paths.test.ts`
- Modify: `package.json` (test glob)

**Interfaces:**
- Consumes: nothing
- Produces: `export interface Roots { room: string; doorway: string }`; `export type PathVerdict = { ok: true; abs: string } | { ok: false; reason: string }`; `export function validatePath(roots: Roots, requested: string): PathVerdict`.

- [x] **Step 1: Write the failing test**

Create `room-agent/src/paths.test.ts`:

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validatePath, type Roots } from './paths';

const ROOTS: Roots = { room: '/home/akira/workshop', doorway: '/mnt/doorway' };

test('accepts a relative path inside the room', () => {
  const v = validatePath(ROOTS, 'notes/today.md');
  assert.equal(v.ok, true);
  assert.equal(v.ok && v.abs, '/home/akira/workshop/notes/today.md');
});

test('accepts the room root itself', () => {
  assert.equal(validatePath(ROOTS, '.').ok, true);
});

test('accepts an absolute path inside the doorway', () => {
  const v = validatePath(ROOTS, '/mnt/doorway/inbox/resume.docx');
  assert.equal(v.ok, true);
  assert.equal(v.ok && v.abs, '/mnt/doorway/inbox/resume.docx');
});

test('rejects traversal out of the room', () => {
  const v = validatePath(ROOTS, '../../etc/passwd');
  assert.equal(v.ok, false);
  assert.match(v.ok === false ? v.reason : '', /outside/i);
});

test('rejects an absolute path outside both roots', () => {
  assert.equal(validatePath(ROOTS, '/etc/passwd').ok, false);
});

test('rejects reaching production', () => {
  // The room must never be able to name prod's database.
  assert.equal(validatePath(ROOTS, '/srv/mission-control/data/mission-control.db').ok, false);
});

test('rejects a sibling directory sharing the root prefix', () => {
  // Classic startsWith bug: /home/akira/workshop-evil must NOT count as inside
  // /home/akira/workshop.
  assert.equal(validatePath(ROOTS, '/home/akira/workshop-evil/x').ok, false);
});

test('rejects an empty path', () => {
  assert.equal(validatePath(ROOTS, '').ok, false);
});

test('rejects a null byte', () => {
  assert.equal(validatePath(ROOTS, 'ok\0/../../etc/passwd').ok, false);
});
```

- [x] **Step 2: Run test to verify it fails**

Run: `pnpm exec tsx --test room-agent/src/paths.test.ts`
Expected: FAIL — cannot resolve `./paths`.

- [x] **Step 3: Write the implementation**

Create `room-agent/src/paths.ts`:

```ts
// Path gate for the room agent. Every fs_* command goes through validatePath
// before it touches disk. Pure — no fs access, unit-tested with fake roots.
import { resolve, sep } from 'node:path';

export interface Roots {
  /** The container-local workspace, e.g. /home/akira/workshop */
  room: string;
  /** The bind-mounted shared folder, e.g. /mnt/doorway */
  doorway: string;
}

export type PathVerdict = { ok: true; abs: string } | { ok: false; reason: string };

function within(parent: string, child: string): boolean {
  const p = resolve(parent);
  const c = resolve(child);
  // Compare against parent + separator so /x/workshop-evil is not "inside" /x/workshop.
  return c === p || c.startsWith(p.endsWith(sep) ? p : p + sep);
}

export function validatePath(roots: Roots, requested: string): PathVerdict {
  if (!requested || requested.trim() === '') return { ok: false, reason: 'empty path' };
  if (requested.includes('\0')) return { ok: false, reason: 'null byte in path' };

  // A relative path is relative to the room; an absolute one resolves as itself.
  const abs = resolve(roots.room, requested);

  if (within(roots.room, abs) || within(roots.doorway, abs)) return { ok: true, abs };
  return { ok: false, reason: 'path outside the room and doorway' };
}
```

- [x] **Step 4: Run test to verify it passes**

Run: `pnpm exec tsx --test room-agent/src/paths.test.ts`
Expected: PASS, 9 tests.

- [x] **Step 5: Add room-agent to the root test glob**

In `package.json`, append `room-agent/src/*.test.ts` to the `test` script:

```json
"test": "tsx --test src/lib/*.test.ts src/lib/akira/*.test.ts src/lib/akira/memory/*.test.ts src/lib/voice/*.test.ts src/lib/companion/*.test.ts companion/src/*.test.ts src/lib/routing/*.test.ts room-agent/src/*.test.ts"
```

- [x] **Step 6: Run the whole suite**

Run: `pnpm test`
Expected: PASS. Confirms the new files are picked up and nothing else regressed.

- [x] **Step 7: Commit**

```bash
git add room-agent/src/paths.ts room-agent/src/paths.test.ts package.json
git commit -m "feat(room): path gate confining fs actions to the room and doorway"
```

---

### Task 4: Filesystem executor

**Files:**
- Create: `room-agent/src/fs-ops.ts`
- Create: `room-agent/src/fs-ops.test.ts`

**Interfaces:**
- Consumes: `validatePath`, `Roots` from `./paths` (Task 3); `Command`, `Result` from `./protocol` (Task 2)
- Produces: `export async function execFs(roots: Roots, cmd: Command): Promise<Result>`; `export const MAX_READ_BYTES = 262144`.

- [x] **Step 1: Write the failing test**

Create `room-agent/src/fs-ops.test.ts`:

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFs } from './fs-ops';
import type { Roots } from './paths';

async function makeRoots(): Promise<Roots> {
  const base = await mkdtemp(join(tmpdir(), 'room-'));
  const room = join(base, 'workshop');
  const doorway = join(base, 'doorway');
  await mkdir(room, { recursive: true });
  await mkdir(join(doorway, 'inbox'), { recursive: true });
  return { room, doorway };
}

test('fs_list lists a directory', async () => {
  const roots = await makeRoots();
  await writeFile(join(roots.room, 'a.txt'), 'x');
  const r = await execFs(roots, { id: 'c1', action: 'fs_list', path: '.' });
  assert.equal(r.status, 'ok');
  assert.equal(r.text, 'a.txt');
});

test('fs_read returns file contents', async () => {
  const roots = await makeRoots();
  await writeFile(join(roots.room, 'note.md'), 'hello room');
  const r = await execFs(roots, { id: 'c2', action: 'fs_read', path: 'note.md' });
  assert.equal(r.status, 'ok');
  assert.equal(r.text, 'hello room');
});

test('fs_write creates parent directories', async () => {
  const roots = await makeRoots();
  const r = await execFs(roots, { id: 'c3', action: 'fs_write', path: 'deep/nested/out.txt', content: 'written' });
  assert.equal(r.status, 'ok');
  assert.equal(await readFile(join(roots.room, 'deep/nested/out.txt'), 'utf8'), 'written');
});

test('fs_write into the doorway works', async () => {
  const roots = await makeRoots();
  const target = join(roots.doorway, 'inbox', 'reply.md');
  const r = await execFs(roots, { id: 'c4', action: 'fs_write', path: target, content: 'hi' });
  assert.equal(r.status, 'ok');
  assert.equal(await readFile(target, 'utf8'), 'hi');
});

test('a path outside the roots is blocked, not errored', async () => {
  const roots = await makeRoots();
  const r = await execFs(roots, { id: 'c5', action: 'fs_read', path: '/etc/passwd' });
  assert.equal(r.status, 'blocked');
  assert.match(r.reason ?? '', /outside/i);
});

test('a missing file errors rather than throwing', async () => {
  const roots = await makeRoots();
  const r = await execFs(roots, { id: 'c6', action: 'fs_read', path: 'nope.txt' });
  assert.equal(r.status, 'error');
});

test('an oversized file is refused', async () => {
  const roots = await makeRoots();
  await writeFile(join(roots.room, 'big.bin'), 'x'.repeat(300_000));
  const r = await execFs(roots, { id: 'c7', action: 'fs_read', path: 'big.bin' });
  assert.equal(r.status, 'error');
  assert.match(r.reason ?? '', /too large/i);
});
```

- [x] **Step 2: Run test to verify it fails**

Run: `pnpm exec tsx --test room-agent/src/fs-ops.test.ts`
Expected: FAIL — cannot resolve `./fs-ops`.

- [x] **Step 3: Write the implementation**

Create `room-agent/src/fs-ops.ts`:

```ts
// Executes fs_* commands inside the room. Every path goes through the gate first;
// a rejected path returns status 'blocked' (the same shape guard.ts produces for
// the browser), never an exception.
import { readFile, writeFile, readdir, mkdir, stat } from 'node:fs/promises';
import { dirname } from 'node:path';
import { validatePath, type Roots } from './paths';
import type { Command, Result } from './protocol';

export const MAX_READ_BYTES = 256 * 1024;

export async function execFs(roots: Roots, cmd: Command): Promise<Result> {
  const verdict = validatePath(roots, cmd.path ?? '');
  if (!verdict.ok) return { id: cmd.id, status: 'blocked', reason: verdict.reason };
  const abs = verdict.abs;

  try {
    switch (cmd.action) {
      case 'fs_list': {
        const names = await readdir(abs);
        return { id: cmd.id, status: 'ok', text: names.join('\n') };
      }
      case 'fs_read': {
        const s = await stat(abs);
        if (s.size > MAX_READ_BYTES) {
          return {
            id: cmd.id,
            status: 'error',
            reason: `file too large (${s.size} bytes, limit ${MAX_READ_BYTES})`,
          };
        }
        return { id: cmd.id, status: 'ok', text: await readFile(abs, 'utf8') };
      }
      case 'fs_write': {
        await mkdir(dirname(abs), { recursive: true });
        await writeFile(abs, cmd.content ?? '', 'utf8');
        return { id: cmd.id, status: 'ok', text: `wrote ${abs}` };
      }
      default:
        return { id: cmd.id, status: 'error', reason: `unsupported action: ${cmd.action}` };
    }
  } catch (e) {
    return { id: cmd.id, status: 'error', reason: e instanceof Error ? e.message : String(e) };
  }
}
```

- [x] **Step 4: Run test to verify it passes**

Run: `pnpm exec tsx --test room-agent/src/fs-ops.test.ts`
Expected: PASS, 7 tests.

- [x] **Step 5: Commit**

```bash
git add room-agent/src/fs-ops.ts room-agent/src/fs-ops.test.ts
git commit -m "feat(room): filesystem executor for fs_list/fs_read/fs_write"
```

---

### Task 5: Room agent entrypoint

**Files:**
- Create: `room-agent/package.json`
- Create: `room-agent/src/config.ts`
- Create: `room-agent/src/connection.ts`
- Create: `room-agent/src/index.ts`
- Create: `room-agent/.env.example`
- Create: `room-agent/src/config.test.ts`

**Interfaces:**
- Consumes: `execFs` from `./fs-ops` (Task 4); `Roots` from `./paths` (Task 3); `Command`, `Result` from `./protocol` (Task 2); the `?target=room` query parameter added in Task 6
- Produces: `export interface RoomConfig { miniUrl: string; token: string; roots: Roots }`; `export function loadConfig(): RoomConfig`; `export function connect(cfg, onCommand, onStatus?)` returning `{ postResult, stop }`

- [x] **Step 1: Write the failing test**

Create `room-agent/src/config.test.ts`:

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadConfig } from './config';

function withEnv(vars: Record<string, string | undefined>, fn: () => void): void {
  const saved: Record<string, string | undefined> = {};
  for (const k of Object.keys(vars)) {
    saved[k] = process.env[k];
    if (vars[k] === undefined) delete process.env[k];
    else process.env[k] = vars[k];
  }
  try {
    fn();
  } finally {
    for (const k of Object.keys(saved)) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  }
}

test('requires a token', () => {
  withEnv({ ROOM_TOKEN: undefined }, () => {
    assert.throws(() => loadConfig(), /ROOM_TOKEN/);
  });
});

test('defaults the roots to the container layout', () => {
  withEnv({ ROOM_TOKEN: 't', ROOM_ROOT: undefined, ROOM_DOORWAY: undefined }, () => {
    const cfg = loadConfig();
    assert.equal(cfg.roots.room, '/home/akira/workshop');
    assert.equal(cfg.roots.doorway, '/mnt/doorway');
  });
});

test('honours overrides', () => {
  withEnv({ ROOM_TOKEN: 't', ROOM_ROOT: '/tmp/r', ROOM_DOORWAY: '/tmp/d' }, () => {
    const cfg = loadConfig();
    assert.equal(cfg.roots.room, '/tmp/r');
    assert.equal(cfg.roots.doorway, '/tmp/d');
  });
});
```

- [x] **Step 2: Run test to verify it fails**

Run: `pnpm exec tsx --test room-agent/src/config.test.ts`
Expected: FAIL — cannot resolve `./config`.

- [x] **Step 3: Write config**

Create `room-agent/src/config.ts`:

```ts
import 'dotenv/config';
import type { Roots } from './paths';

export interface RoomConfig {
  miniUrl: string;
  token: string;
  roots: Roots;
}

export function loadConfig(): RoomConfig {
  const token = process.env.ROOM_TOKEN ?? '';
  if (!token) throw new Error('ROOM_TOKEN is required (set it in room-agent/.env)');
  return {
    // The room reaches Mission Control over the LXD bridge gateway, not the public tunnel.
    // No default is safe to hardcode: the lxdbr0 subnet is assigned when the bridge is
    // created. provision.sh discovers it and writes MINI_URL into room-agent/.env.
    miniUrl: process.env.MINI_URL ?? '',
    token,
    roots: {
      room: process.env.ROOM_ROOT ?? '/home/akira/workshop',
      doorway: process.env.ROOM_DOORWAY ?? '/mnt/doorway',
    },
  };
}
```

- [x] **Step 4: Run test to verify it passes**

Run: `pnpm exec tsx --test room-agent/src/config.test.ts`
Expected: PASS, 3 tests.

- [x] **Step 5: Write the connection**

Create `room-agent/src/connection.ts`. This mirrors `companion/src/connection.ts` with one difference — it appends `&target=room` to the stream URL:

```ts
import type { Command, Result } from './protocol';
import type { RoomConfig } from './config';

export function connect(
  cfg: RoomConfig,
  onCommand: (cmd: Command) => void,
  onStatus?: (connected: boolean) => void,
) {
  let stopped = false;
  let controller: AbortController | null = null;

  async function postResult(r: Result): Promise<void> {
    await fetch(`${cfg.miniUrl}/api/companion/result`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-companion-token': cfg.token },
      body: JSON.stringify(r),
    }).catch((e) => console.error('[room] result POST failed:', e?.message ?? e));
  }

  async function loop() {
    while (!stopped) {
      controller = new AbortController();
      try {
        const url = `${cfg.miniUrl}/api/companion/stream?token=${encodeURIComponent(cfg.token)}&target=room`;
        const res = await fetch(url, {
          headers: { Accept: 'text/event-stream' },
          signal: controller.signal,
        });
        if (!res.ok || !res.body) throw new Error(`stream ${res.status}`);
        console.log('[room] connected to', cfg.miniUrl);
        onStatus?.(true);
        const reader = res.body.getReader();
        const dec = new TextDecoder();
        let buf = '';
        for (;;) {
          const { value, done } = await reader.read();
          if (done) break;
          buf += dec.decode(value, { stream: true });
          const frames = buf.split('\n\n');
          buf = frames.pop() ?? '';
          for (const f of frames) {
            const m = f.match(/^data: (.*)$/m);
            if (!m) continue;
            const evt = JSON.parse(m[1]);
            if (evt.type === 'command') onCommand(evt.cmd as Command);
          }
        }
      } catch (e) {
        onStatus?.(false);
        if (!stopped) console.error('[room] stream error, retrying:', (e as Error).message);
      }
      if (!stopped) await new Promise((r) => setTimeout(r, 3000)); // backoff
    }
  }
  void loop();

  return {
    postResult,
    stop() {
      stopped = true;
      controller?.abort();
    },
  };
}
```

- [x] **Step 6: Write the entrypoint**

Create `room-agent/src/index.ts`:

```ts
import { loadConfig } from './config';
import { connect } from './connection';
import { execFs } from './fs-ops';
import type { Command } from './protocol';

const cfg = loadConfig();

// One-at-a-time chain so writes never interleave — same discipline as the
// laptop companion's command chain.
let chain: Promise<void> = Promise.resolve();

const conn = connect(cfg, (cmd: Command) => {
  chain = chain
    .then(async () => {
      console.log('[room] exec', cmd.action, cmd.path ?? '');
      const result = await execFs(cfg.roots, cmd);
      if (result.status !== 'ok') console.warn('[room]', result.status, result.reason);
      await conn.postResult(result);
    })
    .catch((err) => console.error('[room] command chain error:', err));
});

console.log('[room] AKIRA room agent started; room:', cfg.roots.room, 'doorway:', cfg.roots.doorway);

function shutdown() {
  console.log('\n[room] shutting down…');
  conn.stop();
  process.exit(0);
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
```

- [x] **Step 7: Write the package manifest and env example**

Create `room-agent/package.json`:

```json
{
  "name": "akira-room-agent",
  "private": true,
  "type": "module",
  "scripts": {
    "start": "tsx src/index.ts",
    "test": "tsx --test src/*.test.ts"
  },
  "dependencies": {
    "dotenv": "^17.4.2"
  }
}
```

Create `room-agent/.env.example`:

```
# Shared secret — must match COMPANION_TOKEN on the Mission Control host.
ROOM_TOKEN=
# Mission Control, reached over the LXD bridge gateway (not the public tunnel).
# Discover the real value on the Mini — do NOT guess, and do NOT use 10.0.0.1 (that is the
# household router, not the LXD bridge):
#   lxc network get lxdbr0 ipv4.address     # e.g. 10.166.23.1/24 → use http://10.166.23.1:3000
MINI_URL=
ROOM_ROOT=/home/akira/workshop
ROOM_DOORWAY=/mnt/doorway
```

- [x] **Step 8: Verify it typechecks and the suite is green**

Run: `pnpm exec tsc --noEmit && pnpm test`
Expected: no type errors; all tests pass.

- [x] **Step 9: Commit**

```bash
git add room-agent/
git commit -m "feat(room): room agent entrypoint, config, and connection"
```

---

### Task 6: Stream route accepts a target; status reports both

**Files:**
- Modify: `src/app/api/companion/stream/route.ts`
- Modify: `src/app/api/companion/status/route.ts`
- Test: `src/lib/companion/target-param.test.ts` (create)

**Interfaces:**
- Consumes: `registerCompanion`, `isOnline`, `CompanionTarget` from Task 1
- Produces: `export function targetFromParam(raw: string | null): CompanionTarget` in `src/lib/companion/target-param.ts`

- [x] **Step 1: Write the failing test**

Create `src/lib/companion/target-param.test.ts`:

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { targetFromParam } from './target-param';

test('room is recognised', () => {
  assert.equal(targetFromParam('room'), 'room');
});

test('an absent target defaults to laptop (back-compat)', () => {
  assert.equal(targetFromParam(null), 'laptop');
});

test('an unknown target falls back to laptop rather than throwing', () => {
  assert.equal(targetFromParam('mainframe'), 'laptop');
});
```

- [x] **Step 2: Run test to verify it fails**

Run: `pnpm exec tsx --test src/lib/companion/target-param.test.ts`
Expected: FAIL — cannot resolve `./target-param`.

- [x] **Step 3: Write the parser**

Create `src/lib/companion/target-param.ts`:

```ts
import type { CompanionTarget } from './registry';

/** Parse the ?target= query parameter. Anything unrecognised — including absent,
 *  which is what the already-deployed laptop companion sends — is 'laptop'. */
export function targetFromParam(raw: string | null): CompanionTarget {
  return raw === 'room' ? 'room' : 'laptop';
}
```

- [x] **Step 4: Run test to verify it passes**

Run: `pnpm exec tsx --test src/lib/companion/target-param.test.ts`
Expected: PASS, 3 tests.

- [x] **Step 5: Wire it into the stream route**

In `src/app/api/companion/stream/route.ts`, add the import and pass the target through the register closure. `startCompanionStream`'s signature does not change — the target is captured in the closure:

```ts
import { registerCompanion } from '@/lib/companion/registry';
import { startCompanionStream } from '@/lib/companion/stream-lifecycle';
import { verifyCompanionToken } from '@/lib/companion/auth';
import { targetFromParam } from '@/lib/companion/target-param';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(req: Request) {
  const params = new URL(req.url).searchParams;
  const token = params.get('token');
  if (!verifyCompanionToken(token)) {
    return new Response('Unauthorized', { status: 401 });
  }
  const target = targetFromParam(params.get('target'));

  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      startCompanionStream({
        controller,
        register: (sink) => registerCompanion(sink, target),
        signal: req.signal,
      });
    },
  });

  return new Response(stream, {
    headers: {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    },
  });
}
```

- [x] **Step 6: Report both targets from the status route**

Replace the body of `src/app/api/companion/status/route.ts`'s handler return with:

```ts
  return Response.json({
    online: isOnline('laptop'), // kept for existing clients
    laptop: isOnline('laptop'),
    room: isOnline('room'),
  });
```

The `online` key must stay — the HUD and `page.tsx` read it, and this slice does not touch them.

- [x] **Step 7: Verify**

Run: `pnpm exec tsc --noEmit && pnpm test`
Expected: no type errors; all tests pass.

- [x] **Step 8: Commit**

```bash
git add src/lib/companion/target-param.ts src/lib/companion/target-param.test.ts src/app/api/companion/stream/route.ts src/app/api/companion/status/route.ts
git commit -m "feat(companion): route connections by ?target= and report both in status"
```

---

### Task 7: AKIRA's room tools

**Files:**
- Create: `src/lib/akira/room-tools.ts`
- Modify: `src/lib/akira/tools.ts:58,143`
- Modify: `src/lib/akira-turn.ts:28,129-138`

**Interfaces:**
- Consumes: `sendCommand`, `isOnline` from `@/lib/companion/registry` (Task 1); `AkiraToolContext`, `ToolResult`, `ok`, `err` from `./tool-actions`
- Produces: `export const ROOM_TOOL_NAMES: string[]`; `export function roomToolDefs(ctx: AkiraToolContext)`

- [x] **Step 1: Write the tool module**

There is no unit test for this file — it is a thin declarative wrapper over `sendCommand`, exactly like `browser-tools.ts`, which also has none. The behaviour it depends on is covered by Task 1's registry tests. Verification is the E2E smoke in Task 8.

Create `src/lib/akira/room-tools.ts`:

```ts
import 'server-only';
import { z } from 'zod';
import { tool } from '@anthropic-ai/claude-agent-sdk';
import { sendCommand } from '@/lib/companion/registry';
import { type AkiraToolContext, type ToolResult, ok, err } from './tool-actions';

export const AKIRA_ROOM_LIST = 'mcp__akira__room_list';
export const AKIRA_ROOM_READ = 'mcp__akira__room_read';
export const AKIRA_ROOM_WRITE = 'mcp__akira__room_write';

export const ROOM_TOOL_NAMES = [AKIRA_ROOM_LIST, AKIRA_ROOM_READ, AKIRA_ROOM_WRITE];

const ROOM_TIMEOUT_MS = 30_000;

async function run(
  action: 'fs_list' | 'fs_read' | 'fs_write',
  args: Record<string, unknown>,
  ctx: AkiraToolContext,
): Promise<ToolResult> {
  try {
    const { result } = sendCommand({ action, ...args }, ROOM_TIMEOUT_MS, 'room');
    const r = await result;
    if (r.status === 'blocked') {
      ctx.emit({ type: 'hard_gate', ref: String(args.path ?? ''), reason: r.reason ?? 'path refused' });
      return ok(
        `That path is outside your room (${r.reason ?? 'refused'}). Do not retry — ask the operator to move the file into ~/AKIRA instead.`,
      );
    }
    if (r.status === 'error') return err(r.reason ?? 'room action failed');
    return ok(r.text ?? 'done');
  } catch (e) {
    return err(e instanceof Error ? e.message : String(e));
  }
}

export function roomToolDefs(ctx: AkiraToolContext) {
  return [
    tool(
      'room_list',
      'List a directory in your room on the Mini, or in the shared ~/AKIRA doorway. Paths are relative to your room unless absolute.',
      { path: z.string().min(1).describe('Directory to list, e.g. "." or "/mnt/doorway/inbox".') },
      (a) => run('fs_list', { path: a.path }, ctx),
    ),
    tool(
      'room_read',
      'Read a text file in your room or the doorway. Large files are refused.',
      { path: z.string().min(1) },
      (a) => run('fs_read', { path: a.path }, ctx),
    ),
    tool(
      'room_write',
      'Write a text file in your room or the doorway. Parent directories are created. Anything outside those two places is refused.',
      { path: z.string().min(1), content: z.string() },
      (a) => run('fs_write', { path: a.path, content: a.content }, ctx),
    ),
  ];
}
```

- [x] **Step 2: Register the tools conditionally**

`src/lib/akira/tools.ts:143` currently reads:

```ts
  const tools = isOnline() ? [...base, ...browserToolDefs(ctx)] : base;
```

Replace with:

```ts
  const tools = [
    ...base,
    ...(isOnline('laptop') ? browserToolDefs(ctx) : []),
    ...(isOnline('room') ? roomToolDefs(ctx) : []),
  ];
```

Add the import alongside the existing `browserToolDefs` import at `src/lib/akira/tools.ts:58`:

```ts
import { roomToolDefs } from './room-tools';
```

- [x] **Step 3: Add the tool names to the auto-run list**

Defining a tool is not enough — MCP tool names must also appear in `extraAllowedTools` or the SDK
will not auto-run them. `src/lib/akira-turn.ts:129-138` currently ends with `...BROWSER_TOOL_NAMES`.
Add the room names beside them:

```ts
      extraAllowedTools: [
        AKIRA_NAVIGATE,
        AKIRA_OPEN,
        AKIRA_RELAY,
        AKIRA_LIST_SESSIONS,
        AKIRA_GET_SESSION,
        AKIRA_REMEMBER,
        AKIRA_FORGET,
        ...BROWSER_TOOL_NAMES,
        ...ROOM_TOOL_NAMES,
      ],
```

And the import, beside the existing one at `src/lib/akira-turn.ts:28`:

```ts
import { ROOM_TOOL_NAMES } from './akira/room-tools';
```

Leave `workingDir: process.cwd()` and its comment at line 121 alone. That comment — "AKIRA has only
read tools; never a worktree" — is still true: her *SDK* tools remain read-only. Room writes happen
over the wire in a container, not in the Mission Control process.

- [x] **Step 4: Verify**

Run: `pnpm exec tsc --noEmit && pnpm test && pnpm build`
Expected: no type errors, tests pass, build succeeds. `pnpm build` matters here — `server-only` import errors surface at build time, not in tests.

- [x] **Step 5: Commit**

```bash
git add src/lib/akira/room-tools.ts src/lib/akira/tools.ts src/lib/akira-turn.ts
git commit -m "feat(akira): room_list/room_read/room_write tools"
```

---

### Task 8: Provision the container and verify end to end

**Files:**
- Create: `deploy/room/provision.sh`
- Create: `deploy/room/akira-room.service`
- Modify: `docs/runbook-mini-desktop.md` (append a slice 1 section)

**Interfaces:**
- Consumes: everything above
- Produces: a running `akira-room` container with the agent connected as target `room`

This task is ops. It has no unit tests; its verification steps are the test.

- [ ] **Step 1: Write the provisioning script**

Create `deploy/room/provision.sh`:

```bash
#!/usr/bin/env bash
# Provision AKIRA's room on the Mini. Idempotent — safe to re-run.
# Run as the operator (not root, not mc) on the Mini.
set -euo pipefail

CONTAINER=akira-room
DOORWAY="$HOME/AKIRA"

command -v lxc >/dev/null || { echo "install lxd first: sudo snap install lxd && sudo lxd init --auto"; exit 1; }
[ -d "$DOORWAY/inbox" ] || { echo "missing $DOORWAY/inbox — finish slice 0 first"; exit 1; }

if ! lxc info "$CONTAINER" >/dev/null 2>&1; then
  lxc launch ubuntu:24.04 "$CONTAINER"
  sleep 5
fi

# Map the container's root user to the host operator so files written in the
# doorway are owned by you and open normally in LibreOffice.
printf 'uid %s 0\ngid %s 0\n' "$(id -u)" "$(id -g)" | lxc config set "$CONTAINER" raw.idmap -

lxc config device remove "$CONTAINER" doorway 2>/dev/null || true
lxc config device add "$CONTAINER" doorway disk source="$DOORWAY" path=/mnt/doorway

lxc restart "$CONTAINER"
sleep 5

lxc exec "$CONTAINER" -- bash -lc '
  set -euo pipefail
  id akira &>/dev/null || useradd -m -s /bin/bash akira
  mkdir -p /home/akira/workshop && chown -R akira:akira /home/akira
  apt-get update -qq
  apt-get install -y -qq curl git ca-certificates
  command -v node >/dev/null || {
    curl -fsSL https://deb.nodesource.com/setup_22.x | bash -
    apt-get install -y -qq nodejs
  }
  npm install -g pnpm tsx >/dev/null
'

echo "container ready. Next: copy room-agent/ in, set ROOM_TOKEN, install the service."
```

- [ ] **Step 2: Write the systemd unit**

Create `deploy/room/akira-room.service` — this runs **inside** the container:

```ini
[Unit]
Description=AKIRA room agent
After=network-online.target
Wants=network-online.target

[Service]
User=akira
WorkingDirectory=/home/akira/room-agent
ExecStart=/usr/bin/tsx src/index.ts
Restart=always
RestartSec=5
Environment=NODE_ENV=production

[Install]
WantedBy=multi-user.target
```

- [ ] **Step 3: Provision, on the Mini**

```bash
sudo snap install lxd && sudo lxd init --auto   # first time only
bash deploy/room/provision.sh
```

Expected: `container ready.`

- [ ] **Step 4: Install the agent inside the container**

Discover the bridge gateway first — this is the address the container uses to reach Mission Control
on the host. It is **not** `10.0.0.1` (that is the household router):

```bash
GW=$(lxc network get lxdbr0 ipv4.address | cut -d/ -f1)   # e.g. 10.166.23.1
echo "room will reach MC at http://$GW:3000"
lxc exec akira-room -- curl -sI --max-time 5 "http://$GW:3000/api/health" | head -1
```

That `curl` must return `HTTP/1.1 200` before you go further. If it times out, the host firewall or
`lxdbr0` routing is blocking it and no amount of agent debugging will help.

```bash
lxc file push -r room-agent akira-room/home/akira/
lxc exec akira-room -- bash -lc "printf 'ROOM_TOKEN=%s\nMINI_URL=http://%s:3000\n' \"\$COMPANION_TOKEN\" \"$GW\" > /home/akira/room-agent/.env"
lxc exec akira-room -- bash -lc '
  cd /home/akira/room-agent && pnpm install
  chown -R akira:akira /home/akira/room-agent
'
lxc file push deploy/room/akira-room.service akira-room/etc/systemd/system/
lxc exec akira-room -- systemctl enable --now akira-room
```

`ROOM_TOKEN` must equal the Mission Control host's `COMPANION_TOKEN` — `verifyCompanionToken` checks one shared secret.

- [ ] **Step 5: Verify the room is connected**

```bash
curl -s http://localhost:3000/api/companion/status | jq
```

Expected: `{"online": <bool>, "laptop": <bool>, "room": true}`.

If `room` is false: `lxc exec akira-room -- journalctl -u akira-room -n 50`. The likely causes are a token mismatch or `MINI_URL` pointing somewhere the container cannot reach — re-check it against the bridge gateway: `GW=$(lxc network get lxdbr0 ipv4.address | cut -d/ -f1); lxc exec akira-room -- curl -sI "http://$GW:3000/api/health"`.

- [ ] **Step 6: Verify the doorway end to end**

```bash
echo "hello from the operator" > ~/AKIRA/inbox/test.txt
```

Then, on the front door, ask AKIRA: *"list your doorway inbox and read test.txt."*

Expected: she calls `room_list` and `room_read` and comes back with `hello from the operator`.

Then ask: *"write a file called reply.txt in the inbox saying you got it."*

```bash
cat ~/AKIRA/inbox/reply.txt   # her text
ls -l ~/AKIRA/inbox/reply.txt # owned by YOU, not by 165536 or root
```

The ownership check is the one that proves `raw.idmap` worked. If the file is owned by a high-numbered uid, the idmap did not apply — re-run `provision.sh` and restart the container.

- [ ] **Step 7: Verify the boundary holds**

Ask AKIRA: *"read /srv/mission-control/data/mission-control.db"*

Expected: she reports the path was refused and does **not** retry. This is the invariant the whole design rests on — if this succeeds, stop and fix it before going further.

- [ ] **Step 8: Append the slice 1 section to the runbook**

Add a "Slice 1 — the room" section to `docs/runbook-mini-desktop.md` recording steps 3–7 above as the reproducible procedure, so a rebuild does not require re-reading this plan.

- [ ] **Step 9: Commit**

```bash
git add deploy/room/ docs/runbook-mini-desktop.md
git commit -m "feat(room): LXD provisioning, systemd unit, and operator runbook"
```

---

## Self-review notes

Checked against the spec:

- **Spec coverage.** Slice 1 rows in the spec's slice table are: room container (Task 8), doorway + bind mount + uid mapping (Task 8), room agent on the companion protocol (Tasks 2, 5), `registry.ts` target refactor (Tasks 1, 6), scoped `Write` (Tasks 3, 4, 7). All covered.
- **Deliberately deferred.** The spec's §2 doorway watcher and §4 gated shell are slice 2; §5 browser is slice 3. The spec's plan boundary says slices 0–1 only.
- **Type consistency.** `CompanionTarget` is defined once in `registry.ts` and imported by `target-param.ts`. `Roots` is defined once in `paths.ts` and imported by `fs-ops.ts` and `config.ts`. `Command.path` / `Command.content` are introduced in Task 2 before first use in Task 3.
- **Gap found and fixed during review.** The first draft of Task 7 defined the room tools but never added `ROOM_TOOL_NAMES` to `extraAllowedTools` in `akira-turn.ts`. The tools would have been visible to the model and refused at call time — a failure that looks like a model problem rather than a wiring problem, so worth the extra step. `BROWSER_TOOL_NAMES` is wired at `akira-turn.ts:137`; the room list now sits beside it.
- **Known gap carried from the spec.** Room-agent reconnect across container restarts is untested here; `Restart=always` plus the 3s backoff loop is the mitigation, and the registry's displacement path (`sinks.get(target)?.close?.()`) handles a stale sink. Watch for it during slice 2.
