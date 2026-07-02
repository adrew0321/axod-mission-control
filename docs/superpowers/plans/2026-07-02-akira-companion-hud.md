# AKIRA Local Companion HUD — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give the AKIRA Local Companion a native, always-on-top Electron HUD on the laptop, with a localhost bridge that surfaces presence + a local hard-gate approval queue you approve/deny/stop on the laptop.

**Architecture:** The `companion/` Node process gains a localhost-only WebSocket bridge (`bridge.ts`) fed by a pure gate queue (`gate-queue.ts`) and pure wire helpers (`bridge-protocol.ts`). A new standalone `companion-hud/` Electron app connects to that bridge, renders the HUD (full glass panel ⇄ minimized orb), and sends approve/deny/stop. Gated clicks are *held* locally and resolved on the laptop; the Mini approve path stays as fallback.

**Tech Stack:** TypeScript (ESM), Node's `node:test` via `tsx`, `ws` (WebSocket server), Electron. No React in the HUD — plain HTML/CSS/JS renderer.

## Global Constraints

- **Package manager:** `pnpm`. `.npmrc` has `ignore-scripts=true` — do NOT change it. Packages needing install scripts (Electron binary) go in an `onlyBuiltDependencies` allowlist.
- **Branch:** work on `feat/akira-companion-hud` (already created off `dev`). When green, merge to `dev` with `--no-ff`. Do NOT push to `main`, tag, or deploy.
- **Work in the main checkout** on the feature branch — no linked git worktree (Turbopack/Playwright/Electron break on junctioned `node_modules`).
- **Imports:** extensionless relative TS imports (`./guard`, never `./guard.ts`).
- **Tests:** `node:test` + `node:assert/strict`, run by `tsx --test`. Files named `*.test.ts` in `companion/src/` are auto-run by both `cd companion && pnpm test` and root `pnpm test`. **Automated tests cover pure logic only** — no sockets, no Electron, no live browser (those are manual, matching how `browser.ts`/`connection.ts` are already untested).
- **`companion/` and `companion-hud/` are laptop-only**, each a self-contained pnpm project (own `pnpm-workspace.yaml` with `packages: ['.']`), excluded from the root `next build`/`tsc`. Playwright and Electron must never reach the Mini.
- **Theme tokens:** cyan `#7fdcff`, magenta `#ff5acf`, green `#37d39b`, glass-morphism, Inter.

---

### Task 1: Pure gate queue (`gate-queue.ts`)

**Files:**
- Create: `companion/src/gate-queue.ts`
- Test: `companion/src/gate-queue.test.ts`

**Interfaces:**
- Produces:
  - `interface PendingGate { id: string; reason: string; target: string; host: string; requestedAt: number }`
  - `createGateQueue(): { enqueue(g: PendingGate): void; list(): PendingGate[]; remove(id: string): PendingGate | undefined; expired(now: number, timeoutMs: number): PendingGate[]; clear(): PendingGate[] }`

- [ ] **Step 1: Write the failing test**

Create `companion/src/gate-queue.test.ts`:

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createGateQueue, type PendingGate } from './gate-queue';

const gate = (p: Partial<PendingGate>): PendingGate => ({
  id: 'c1', reason: 'irreversible', target: 'Place order', host: 'amazon.com', requestedAt: 1000, ...p,
});

test('enqueue then list returns queued gates in order', () => {
  const q = createGateQueue();
  q.enqueue(gate({ id: 'a' }));
  q.enqueue(gate({ id: 'b' }));
  assert.deepEqual(q.list().map((g) => g.id), ['a', 'b']);
});

test('list returns a copy (mutating it does not affect the queue)', () => {
  const q = createGateQueue();
  q.enqueue(gate({ id: 'a' }));
  q.list().pop();
  assert.equal(q.list().length, 1);
});

test('remove pulls the gate out and returns it; unknown id returns undefined', () => {
  const q = createGateQueue();
  q.enqueue(gate({ id: 'a' }));
  q.enqueue(gate({ id: 'b' }));
  assert.equal(q.remove('a')?.id, 'a');
  assert.deepEqual(q.list().map((g) => g.id), ['b']);
  assert.equal(q.remove('nope'), undefined);
});

test('expired returns only gates older than the timeout', () => {
  const q = createGateQueue();
  q.enqueue(gate({ id: 'old', requestedAt: 1000 }));
  q.enqueue(gate({ id: 'new', requestedAt: 9000 }));
  const exp = q.expired(11000, 5000); // now=11000, timeout=5000 → cutoff 6000
  assert.deepEqual(exp.map((g) => g.id), ['old']);
});

test('clear empties the queue and returns everything that was in it', () => {
  const q = createGateQueue();
  q.enqueue(gate({ id: 'a' }));
  q.enqueue(gate({ id: 'b' }));
  assert.deepEqual(q.clear().map((g) => g.id), ['a', 'b']);
  assert.equal(q.list().length, 0);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd companion && pnpm exec tsx --test src/gate-queue.test.ts`
Expected: FAIL — `Cannot find module './gate-queue'`.

- [ ] **Step 3: Write minimal implementation**

Create `companion/src/gate-queue.ts`:

```ts
// Pure hold-queue for hard-gated commands awaiting the operator's decision.
// No I/O — the async wiring (awaiting a decision) lives in index.ts.

export interface PendingGate {
  id: string;        // the Command.id being held
  reason: string;    // human reason from classifyClick
  target: string;    // element ref or url the click targets
  host: string;      // page host, best-effort ('' if unknown)
  requestedAt: number;
}

export function createGateQueue() {
  let items: PendingGate[] = [];
  return {
    enqueue(g: PendingGate): void {
      items.push(g);
    },
    list(): PendingGate[] {
      return items.slice();
    },
    remove(id: string): PendingGate | undefined {
      const i = items.findIndex((x) => x.id === id);
      return i === -1 ? undefined : items.splice(i, 1)[0];
    },
    expired(now: number, timeoutMs: number): PendingGate[] {
      return items.filter((x) => now - x.requestedAt >= timeoutMs);
    },
    clear(): PendingGate[] {
      const all = items;
      items = [];
      return all;
    },
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd companion && pnpm exec tsx --test src/gate-queue.test.ts`
Expected: PASS — 5 tests pass.

- [ ] **Step 5: Commit**

```bash
git add companion/src/gate-queue.ts companion/src/gate-queue.test.ts
git commit -m "feat(companion): pure hold-queue for hard-gated commands"
```

---

### Task 2: Pure bridge protocol (`bridge-protocol.ts`)

**Files:**
- Create: `companion/src/bridge-protocol.ts`
- Test: `companion/src/bridge-protocol.test.ts`

**Interfaces:**
- Consumes: `PendingGate` from `./gate-queue`.
- Produces:
  - `interface Presence { connected: boolean; operator: string; host: string; uptimeSec: number; task: string }`
  - `interface Security { tokenAuthed: boolean; transport: string; profile: string; sensitiveCount: number }`
  - `interface StateSnapshot { presence: Presence; queue: PendingGate[]; security: Security }`
  - `interface StateMsg extends StateSnapshot { type: 'state' }`
  - `type ClientMsg = { type: 'hello'; token: string } | { type: 'approve'; id: string } | { type: 'deny'; id: string } | { type: 'stop' }`
  - `buildState(s: StateSnapshot): StateMsg`
  - `parseClientMsg(raw: string): ClientMsg | null`

- [ ] **Step 1: Write the failing test**

Create `companion/src/bridge-protocol.test.ts`:

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildState, parseClientMsg, type StateSnapshot } from './bridge-protocol';

const snap: StateSnapshot = {
  presence: { connected: true, operator: 'A\'Keem', host: 'LAPTOP', uptimeSec: 42, task: 'idle' },
  queue: [],
  security: { tokenAuthed: true, transport: 'outbound-only', profile: 'persistent · local', sensitiveCount: 2 },
};

test('buildState tags the snapshot as a state message', () => {
  const m = buildState(snap);
  assert.equal(m.type, 'state');
  assert.equal(m.presence.uptimeSec, 42);
  assert.equal(m.security.sensitiveCount, 2);
});

test('parseClientMsg accepts valid hello/approve/deny/stop', () => {
  assert.deepEqual(parseClientMsg('{"type":"hello","token":"abc"}'), { type: 'hello', token: 'abc' });
  assert.deepEqual(parseClientMsg('{"type":"approve","id":"c1"}'), { type: 'approve', id: 'c1' });
  assert.deepEqual(parseClientMsg('{"type":"deny","id":"c1"}'), { type: 'deny', id: 'c1' });
  assert.deepEqual(parseClientMsg('{"type":"stop"}'), { type: 'stop' });
});

test('parseClientMsg rejects garbage, bad types, and missing fields', () => {
  assert.equal(parseClientMsg('not json'), null);
  assert.equal(parseClientMsg('123'), null);
  assert.equal(parseClientMsg('{"type":"approve"}'), null);   // missing id
  assert.equal(parseClientMsg('{"type":"hello"}'), null);     // missing token
  assert.equal(parseClientMsg('{"type":"launch_nukes"}'), null);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd companion && pnpm exec tsx --test src/bridge-protocol.test.ts`
Expected: FAIL — `Cannot find module './bridge-protocol'`.

- [ ] **Step 3: Write minimal implementation**

Create `companion/src/bridge-protocol.ts`:

```ts
// Pure wire types + parse/build helpers for the localhost HUD bridge.
// No sockets here — bridge.ts owns the WebSocket server.
import type { PendingGate } from './gate-queue';

export interface Presence {
  connected: boolean;   // companion↔Mini SSE link is up
  operator: string;
  host: string;         // laptop hostname
  uptimeSec: number;
  task: string;         // current browser task, e.g. 'idle' | 'reading example.com'
}

export interface Security {
  tokenAuthed: boolean;
  transport: string;    // 'outbound-only'
  profile: string;      // 'persistent · local'
  sensitiveCount: number;
}

export interface StateSnapshot {
  presence: Presence;
  queue: PendingGate[];
  security: Security;
}

export interface StateMsg extends StateSnapshot {
  type: 'state';
}

export type ClientMsg =
  | { type: 'hello'; token: string }
  | { type: 'approve'; id: string }
  | { type: 'deny'; id: string }
  | { type: 'stop' };

export function buildState(s: StateSnapshot): StateMsg {
  return { type: 'state', presence: s.presence, queue: s.queue, security: s.security };
}

export function parseClientMsg(raw: string): ClientMsg | null {
  let o: unknown;
  try {
    o = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!o || typeof o !== 'object') return null;
  const m = o as Record<string, unknown>;
  switch (m.type) {
    case 'hello':
      return typeof m.token === 'string' ? { type: 'hello', token: m.token } : null;
    case 'approve':
      return typeof m.id === 'string' ? { type: 'approve', id: m.id } : null;
    case 'deny':
      return typeof m.id === 'string' ? { type: 'deny', id: m.id } : null;
    case 'stop':
      return { type: 'stop' };
    default:
      return null;
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd companion && pnpm exec tsx --test src/bridge-protocol.test.ts`
Expected: PASS — 3 tests pass.

- [ ] **Step 5: Commit**

```bash
git add companion/src/bridge-protocol.ts companion/src/bridge-protocol.test.ts
git commit -m "feat(companion): pure wire protocol for the HUD bridge"
```

---

### Task 3: Localhost bridge server (`bridge.ts`) + `ws` dependency

**Files:**
- Modify: `companion/package.json` (add `ws` + `@types/ws`)
- Create: `companion/src/bridge.ts`

**Interfaces:**
- Consumes: `parseClientMsg`, `buildState`, `StateSnapshot` from `./bridge-protocol`; `CompanionConfig` from `./config`.
- Produces:
  - `interface BridgeHandlers { getState: () => StateSnapshot; onApprove: (id: string) => void; onDeny: (id: string) => void; onStop: () => void }`
  - `startBridge(h: BridgeHandlers): { hasClient(): boolean; push(): void; stop(): void }`
  - Writes `~/.akira-companion/bridge.json` = `{ port, token }` (mode 600) on listen.

- [ ] **Step 1: Add the `ws` dependency**

Edit `companion/package.json` — add to `dependencies` and `devDependencies`:

```json
  "dependencies": {
    "playwright": "^1.49.0",
    "dotenv": "^17.4.2",
    "ws": "^8.18.0"
  },
  "devDependencies": {
    "tsx": "^4.22.3",
    "typescript": "^5",
    "@types/ws": "^8.5.12"
  },
```

- [ ] **Step 2: Install**

Run: `cd companion && pnpm install`
Expected: `ws` and `@types/ws` added; no errors. (`ws` is pure JS — no build script needed.)

- [ ] **Step 3: Write the bridge server**

Create `companion/src/bridge.ts`:

```ts
// Localhost-only WebSocket bridge to the native HUD. Binds 127.0.0.1 on a random
// port, writes {port, token} to ~/.akira-companion/bridge.json (mode 600) so the
// HUD can find + authenticate to it. No inbound network exposure.
import { WebSocketServer, type WebSocket } from 'ws';
import { writeFileSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { homedir } from 'node:os';
import { randomBytes } from 'node:crypto';
import { buildState, parseClientMsg, type StateSnapshot } from './bridge-protocol';

export interface BridgeHandlers {
  getState: () => StateSnapshot;
  onApprove: (id: string) => void;
  onDeny: (id: string) => void;
  onStop: () => void;
}

export const BRIDGE_FILE = join(homedir(), '.akira-companion', 'bridge.json');

export function startBridge(h: BridgeHandlers) {
  const token = randomBytes(24).toString('hex');
  const wss = new WebSocketServer({ host: '127.0.0.1', port: 0 });
  const authed = new Set<WebSocket>();

  wss.on('listening', () => {
    const addr = wss.address();
    const port = typeof addr === 'object' && addr ? addr.port : 0;
    mkdirSync(dirname(BRIDGE_FILE), { recursive: true });
    writeFileSync(BRIDGE_FILE, JSON.stringify({ port, token }), { mode: 0o600 });
    console.log(`[companion] HUD bridge listening on 127.0.0.1:${port}`);
  });

  wss.on('connection', (ws) => {
    ws.on('message', (data) => {
      const msg = parseClientMsg(data.toString());
      if (!msg) return;
      if (msg.type === 'hello') {
        if (msg.token === token) {
          authed.add(ws);
          ws.send(JSON.stringify(buildState(h.getState())));
        } else {
          ws.close();
        }
        return;
      }
      if (!authed.has(ws)) return; // ignore commands before a valid hello
      if (msg.type === 'approve') h.onApprove(msg.id);
      else if (msg.type === 'deny') h.onDeny(msg.id);
      else if (msg.type === 'stop') h.onStop();
    });
    ws.on('close', () => authed.delete(ws));
    ws.on('error', () => authed.delete(ws));
  });

  return {
    hasClient(): boolean {
      return authed.size > 0;
    },
    push(): void {
      const s = JSON.stringify(buildState(h.getState()));
      for (const ws of authed) {
        try {
          ws.send(s);
        } catch {
          authed.delete(ws);
        }
      }
    },
    stop(): void {
      wss.close();
    },
  };
}
```

- [ ] **Step 4: Type-check**

Run: `cd companion && pnpm exec tsc --noEmit`
Expected: no errors.

- [ ] **Step 5: Smoke-test the server boots and writes the bridge file**

Run:
```bash
cd companion && pnpm exec tsx -e "import('./src/bridge').then(async ({ startBridge, BRIDGE_FILE }) => { const b = startBridge({ getState: () => ({ presence: { connected: false, operator: 'x', host: 'h', uptimeSec: 0, task: 'idle' }, queue: [], security: { tokenAuthed: true, transport: 'outbound-only', profile: 'p', sensitiveCount: 0 } }), onApprove(){}, onDeny(){}, onStop(){} }); await new Promise(r => setTimeout(r, 400)); const fs = await import('node:fs'); console.log('bridge.json:', fs.readFileSync(BRIDGE_FILE, 'utf8')); b.stop(); process.exit(0); });"
```
Expected: logs `HUD bridge listening on 127.0.0.1:<port>` and prints `bridge.json: {"port":<port>,"token":"<hex>"}`.

- [ ] **Step 6: Commit**

```bash
git add companion/package.json companion/pnpm-lock.yaml companion/src/bridge.ts
git commit -m "feat(companion): localhost WebSocket bridge for the native HUD"
```

---

### Task 4: Wire gating, presence, and the bridge into `index.ts`

**Files:**
- Modify: `companion/src/config.ts` (add `operator`)
- Modify: `companion/src/connection.ts` (emit connect/disconnect status)
- Modify: `companion/src/index.ts` (hold gates locally, drive the bridge)

**Interfaces:**
- Consumes: `createGateQueue`, `PendingGate` (Task 1); `startBridge` (Task 3); existing `connect`, `createBrowser`, `Command`, `Result`.
- Produces: the running wired process (no exported API).

- [ ] **Step 1: Add `operator` to config**

Edit `companion/src/config.ts` — add the field to the interface and loader:

```ts
export interface CompanionConfig {
  miniUrl: string;
  token: string;
  profileDir: string;
  sensitiveDomains: string[];
  operator: string;
}
```

In `loadConfig()`, before the `return`:

```ts
  const operator = process.env.COMPANION_OPERATOR ?? 'Operator';
```

and add `operator` to the returned object:

```ts
  return { miniUrl, token, profileDir, sensitiveDomains, operator };
```

- [ ] **Step 2: Emit connection status from `connect`**

Edit `companion/src/connection.ts`. Change the signature to accept an optional status callback:

```ts
export function connect(
  cfg: CompanionConfig,
  onCommand: (cmd: Command) => void,
  onStatus?: (connected: boolean) => void,
) {
```

Inside `loop()`, right after the successful `console.log('[companion] connected to', cfg.miniUrl);` line, add:

```ts
        onStatus?.(true);
```

And in the `catch (e)` block, before the retry log line, add:

```ts
        onStatus?.(false);
```

- [ ] **Step 3: Rewrite `index.ts` to hold gates and drive the bridge**

Replace the entire contents of `companion/src/index.ts` with:

```ts
import { hostname } from 'node:os';
import { loadConfig } from './config';
import { connect } from './connection';
import { createBrowser } from './browser';
import { createGateQueue, type PendingGate } from './gate-queue';
import { startBridge } from './bridge';
import type { Command, Result } from './protocol';

const GATE_TIMEOUT_MS = 120_000; // un-actioned gates auto-deny after 2 min

const cfg = loadConfig();
const browser = createBrowser(cfg);
const queue = createGateQueue();

const startedAt = Date.now();
let connected = false;
let currentTask = 'idle';

// id → resolver for the exec chain awaiting an operator decision
const resolvers = new Map<string, (d: 'approved' | 'denied') => void>();

function describe(cmd: Command): string {
  switch (cmd.action) {
    case 'navigate': return `opening ${cmd.url ?? ''}`.trim();
    case 'read': return 'reading the page';
    case 'type': return 'typing';
    case 'click': return 'clicking';
    case 'wait': return 'waiting';
    default: return 'working';
  }
}

const bridge = startBridge({
  getState: () => ({
    presence: {
      connected,
      operator: cfg.operator,
      host: hostname(),
      uptimeSec: Math.floor((Date.now() - startedAt) / 1000),
      task: currentTask,
    },
    queue: queue.list(),
    security: {
      tokenAuthed: true,
      transport: 'outbound-only',
      profile: 'persistent · local',
      sensitiveCount: cfg.sensitiveDomains.length,
    },
  }),
  onApprove: (id) => decide(id, 'approved'),
  onDeny: (id) => decide(id, 'denied'),
  onStop: () => stopAll(),
});

function decide(id: string, d: 'approved' | 'denied'): void {
  if (!queue.remove(id)) return;
  resolvers.get(id)?.(d);
  resolvers.delete(id);
  bridge.push();
}

function stopAll(): void {
  for (const g of queue.clear()) {
    resolvers.get(g.id)?.('denied');
    resolvers.delete(g.id);
  }
  void browser.close();
  bridge.push();
  console.log('[companion] STOP — activity aborted, queue cleared');
}

// Expire stale gates → auto-deny.
setInterval(() => {
  const now = Date.now();
  for (const g of queue.expired(now, GATE_TIMEOUT_MS)) decide(g.id, 'denied');
}, 5_000);

// Refresh the uptime/timer on the HUD once a second.
setInterval(() => bridge.push(), 1_000);

async function runWithGate(cmd: Command): Promise<Result> {
  const result = await browser.execute(cmd);
  // Not a hard-gate block, or no HUD to approve on → behave exactly as before.
  if (result.status !== 'blocked' || !bridge.hasClient()) return result;

  const gate: PendingGate = {
    id: cmd.id,
    reason: result.reason ?? 'irreversible action',
    target: cmd.ref ?? cmd.url ?? '',
    host: '',
    requestedAt: Date.now(),
  };
  queue.enqueue(gate);
  bridge.push();
  console.log('[companion] gate held for approval:', gate.reason);

  const decision = await new Promise<'approved' | 'denied'>((res) => resolvers.set(cmd.id, res));
  if (decision === 'denied') return { id: cmd.id, status: 'blocked', reason: 'operator denied' };
  return browser.execute({ ...cmd, approved: true });
}

// One-at-a-time queue so page actions never interleave.
let chain: Promise<void> = Promise.resolve();

const conn = connect(
  cfg,
  (cmd: Command) => {
    chain = chain.then(async () => {
      currentTask = describe(cmd);
      bridge.push();
      console.log('[companion] exec', cmd.action, cmd.ref ?? cmd.url ?? '');
      const result = await runWithGate(cmd);
      currentTask = 'idle';
      bridge.push();
      await conn.postResult(result);
    });
  },
  (up) => {
    connected = up;
    bridge.push();
  },
);

console.log('[companion] AKIRA Local Companion started; profile:', cfg.profileDir);

async function shutdown() {
  console.log('\n[companion] shutting down…');
  conn.stop();
  bridge.stop();
  await browser.close();
  process.exit(0);
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
```

- [ ] **Step 4: Type-check the whole companion**

Run: `cd companion && pnpm exec tsc --noEmit`
Expected: no errors.

- [ ] **Step 5: Verify existing + new unit tests still pass**

Run: `cd companion && pnpm test`
Expected: PASS — `guard`, `page-snapshot`, `gate-queue`, `bridge-protocol` suites all green.

- [ ] **Step 6: Commit**

```bash
git add companion/src/config.ts companion/src/connection.ts companion/src/index.ts
git commit -m "feat(companion): hold hard-gates locally and drive the HUD bridge"
```

---

### Task 5: Electron HUD scaffold (`companion-hud/`) — connects + shows the orb

**Files:**
- Create: `companion-hud/package.json`
- Create: `companion-hud/pnpm-workspace.yaml`
- Create: `companion-hud/.gitignore`
- Create: `companion-hud/main.js`
- Create: `companion-hud/preload.js`
- Create: `companion-hud/renderer/index.html`
- Create: `companion-hud/renderer/hud.js`

**Interfaces:**
- Consumes: `~/.akira-companion/bridge.json` (`{ port, token }`) written by Task 3; the bridge `state` messages from Task 2/4; sends `hello`/`approve`/`deny`/`stop`.
- Produces: an always-on-top window. Preload exposes `window.hud.resize(w, h)`.

- [ ] **Step 1: Create the package manifest**

Create `companion-hud/package.json`:

```json
{
  "name": "akira-companion-hud",
  "private": true,
  "version": "0.1.0",
  "description": "AKIRA Local Companion — native always-on-top HUD",
  "main": "main.js",
  "scripts": {
    "start": "electron ."
  },
  "devDependencies": {
    "electron": "^33.2.0"
  },
  "pnpm": {
    "onlyBuiltDependencies": ["electron"]
  }
}
```

- [ ] **Step 2: Isolate as its own pnpm project + ignore node_modules**

Create `companion-hud/pnpm-workspace.yaml`:

```yaml
packages:
  - '.'
onlyBuiltDependencies:
  - electron
```

Create `companion-hud/.gitignore`:

```
node_modules/
dist/
```

- [ ] **Step 3: Install Electron**

Run: `cd companion-hud && pnpm install`
Expected: Electron installed.
**If Electron's binary did not download** (the repo's `ignore-scripts=true` can suppress it), run its installer manually:
`cd companion-hud && node node_modules/electron/install.js`
Then verify: `cd companion-hud && pnpm exec electron --version` prints a version (e.g. `v33.2.0`).

- [ ] **Step 4: Preload — expose a minimal, safe API**

Create `companion-hud/preload.js`:

```js
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('hud', {
  resize: (width, height) => ipcRenderer.send('hud:resize', { width, height }),
});
```

- [ ] **Step 5: Main process — always-on-top frameless window**

Create `companion-hud/main.js`:

```js
const { app, BrowserWindow, ipcMain } = require('electron');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');
const { homedir } = require('node:os');

const BRIDGE_FILE = join(homedir(), '.akira-companion', 'bridge.json');

function readBridge() {
  try {
    return JSON.parse(readFileSync(BRIDGE_FILE, 'utf8'));
  } catch {
    return null;
  }
}

function createWindow() {
  const win = new BrowserWindow({
    width: 360,
    height: 580,
    frame: false,
    transparent: true,
    resizable: false,
    alwaysOnTop: true,
    fullscreenable: false,
    webPreferences: {
      preload: join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  win.setAlwaysOnTop(true, 'screen-saver');

  const b = readBridge();
  const search = b ? `port=${b.port}&token=${encodeURIComponent(b.token)}` : '';
  win.loadFile(join(__dirname, 'renderer', 'index.html'), { search });

  ipcMain.on('hud:resize', (_e, { width, height }) => {
    const [x, y] = win.getPosition();
    win.setBounds({ x, y, width, height });
  });

  return win;
}

app.whenReady().then(() => {
  createWindow();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => app.quit());
```

- [ ] **Step 6: Renderer shell — connect + render just the orb for now**

Create `companion-hud/renderer/index.html`:

```html
<!doctype html>
<html>
  <head>
    <meta charset="utf-8" />
    <style>
      html, body { margin: 0; height: 100%; background: transparent;
        font-family: Inter, system-ui, sans-serif; color: #eaffff; overflow: hidden; }
      #orb { width: 118px; height: 118px; margin: 6px auto; position: relative;
        display: flex; align-items: center; justify-content: center; cursor: pointer;
        -webkit-app-region: drag; }
      #orb .ring { position: absolute; inset: 0; border-radius: 50%; border: 2.5px solid #7fdcff;
        box-shadow: 0 0 26px rgba(127,220,255,.6), inset 0 0 22px rgba(127,220,255,.25);
        transition: border-color .3s, box-shadow .3s; }
      #orb.pending .ring { border-color: #ff5acf; box-shadow: 0 0 30px rgba(255,90,207,.7); }
      #orb .core { width: 88px; height: 88px; border-radius: 50%;
        background: radial-gradient(circle at 40% 33%, #16466a, #06121d 72%);
        display: flex; flex-direction: column; align-items: center; justify-content: center; }
      #orb .a { font-size: 16px; font-weight: 800; letter-spacing: 1px; color: #7fdcff;
        text-shadow: 0 0 12px rgba(127,220,255,.7); }
      #orb .l { font-size: 8px; letter-spacing: 2px; color: #7a8ea0; }
      #orb .dot { position: absolute; top: 14px; right: 20px; width: 12px; height: 12px;
        border-radius: 50%; background: #46506a; border: 2px solid #06121d; }
      #orb.connected .dot { background: #37d39b; box-shadow: 0 0 10px #37d39b; }
    </style>
  </head>
  <body>
    <div id="orb">
      <div class="ring"></div>
      <div class="dot"></div>
      <div class="core"><div class="a">AKIRA</div><div class="l">LOCAL</div></div>
    </div>
    <script src="./hud.js"></script>
  </body>
</html>
```

Create `companion-hud/renderer/hud.js`:

```js
const params = new URLSearchParams(location.search);
const PORT = params.get('port');
const TOKEN = params.get('token');

let ws = null;
let state = null;

const orb = document.getElementById('orb');

function render() {
  const connected = !!state?.presence?.connected;
  const pending = (state?.queue?.length ?? 0) > 0;
  orb.classList.toggle('connected', connected);
  orb.classList.toggle('pending', pending);
}

function connect() {
  if (!PORT) return;
  ws = new WebSocket(`ws://127.0.0.1:${PORT}`);
  ws.onopen = () => ws.send(JSON.stringify({ type: 'hello', token: TOKEN }));
  ws.onmessage = (ev) => {
    const msg = JSON.parse(ev.data);
    if (msg.type === 'state') { state = msg; render(); }
  };
  ws.onclose = () => { state = null; render(); setTimeout(connect, 1500); };
  ws.onerror = () => ws.close();
}

// send helper used by later UI
window.send = (obj) => ws && ws.readyState === 1 && ws.send(JSON.stringify(obj));

connect();
render();
```

- [ ] **Step 7: Manual verification — orb connects to a running companion**

In terminal A: `cd companion && pnpm start` (needs a valid `companion/.env`; it will connect to the Mini or keep retrying — either way the bridge starts and writes `bridge.json`).
In terminal B: `cd companion-hud && pnpm start`.
Expected: a small frameless always-on-top orb appears; its status dot turns **green** once the companion's SSE link is up (green requires the Mini reachable; if the Mini is down the orb still shows but stays grey — that's correct). You can drag the orb around. It stays above other windows.

- [ ] **Step 8: Commit**

```bash
git add companion-hud/package.json companion-hud/pnpm-workspace.yaml companion-hud/.gitignore companion-hud/main.js companion-hud/preload.js companion-hud/renderer/index.html companion-hud/renderer/hud.js
git commit -m "feat(hud): Electron scaffold — always-on-top orb wired to the bridge"
```

---

### Task 6: Full HUD panel — presence, approvals, security, stop, minimize

**Files:**
- Modify: `companion-hud/renderer/index.html` (full panel markup + CSS)
- Modify: `companion-hud/renderer/hud.js` (render live state, wire buttons, orb⇄panel toggle)

**Interfaces:**
- Consumes: `state` messages (`presence`, `queue[]`, `security`); `window.hud.resize`.
- Produces: interactive HUD sending `approve`/`deny`/`stop`.

- [ ] **Step 1: Replace `index.html` with the full HUD**

Replace the entire contents of `companion-hud/renderer/index.html` with:

```html
<!doctype html>
<html>
  <head>
    <meta charset="utf-8" />
    <style>
      html, body { margin: 0; height: 100%; background: transparent;
        font-family: Inter, system-ui, sans-serif; color: #eaffff; overflow: hidden; user-select: none; }
      .hidden { display: none !important; }

      /* ---------- FULL PANEL ---------- */
      #panel { width: 340px; margin: 8px auto; border-radius: 18px; overflow: hidden;
        background: linear-gradient(180deg, rgba(11,20,33,.97), rgba(6,11,20,.98));
        border: 1px solid rgba(127,220,255,.35);
        box-shadow: 0 0 0 1px rgba(127,220,255,.08), 0 20px 60px rgba(0,0,0,.6), 0 0 40px rgba(127,220,255,.14); }
      .head { padding: 15px 16px 12px; border-bottom: 1px solid rgba(127,220,255,.12);
        position: relative; -webkit-app-region: drag; }
      .title { font-size: 17px; font-weight: 800; letter-spacing: 1px; }
      .title b { color: #7fdcff; text-shadow: 0 0 14px rgba(127,220,255,.6); }
      .title small { font-weight: 500; font-size: 11px; letter-spacing: 1.5px; color: #5f7186; margin-left: 6px; }
      .min { position: absolute; top: 13px; right: 13px; width: 24px; height: 24px; border-radius: 6px;
        display: flex; align-items: center; justify-content: center; font-size: 14px; color: #8fb2c9;
        border: 1px solid rgba(127,220,255,.18); background: rgba(127,220,255,.05); cursor: pointer;
        -webkit-app-region: no-drag; }
      .conn { display: flex; align-items: center; gap: 8px; margin-top: 11px; }
      .live { display: flex; align-items: center; gap: 6px; font-size: 13px; font-weight: 700; letter-spacing: .6px; color: #56657a; }
      .live i { width: 8px; height: 8px; border-radius: 50%; background: #46506a; }
      #panel.connected .live { color: #37d39b; }
      #panel.connected .live i { background: #37d39b; box-shadow: 0 0 9px #37d39b; }
      .spacer { flex: 1; }
      .timer .k { font-size: 9px; letter-spacing: 1.2px; color: #5f7186; text-transform: uppercase; text-align: right; }
      .timer .v { font-size: 15px; font-family: ui-monospace, monospace; color: #cfe8f5; letter-spacing: 1px; text-align: right; }

      .sec { margin: 12px; border: 1px solid rgba(127,220,255,.15); border-radius: 12px; padding: 11px 12px;
        background: rgba(127,220,255,.025); }
      .sec.gate { border-color: rgba(255,90,207,.4); background: rgba(255,90,207,.05); box-shadow: 0 0 20px rgba(255,90,207,.1); }
      .sec-h { display: flex; align-items: center; justify-content: space-between; margin-bottom: 9px; }
      .sec-h .t { font-size: 11px; letter-spacing: 1.4px; text-transform: uppercase; color: #8fb2c9; font-weight: 600; }
      .sec-h .n { font-size: 11px; color: #7fdcff; border: 1px solid rgba(127,220,255,.3); border-radius: 20px; padding: 1px 8px; }

      .presence { display: flex; align-items: center; gap: 11px; }
      .avatar { width: 42px; height: 42px; border-radius: 11px; flex: none;
        background: radial-gradient(circle at 35% 30%, #12405e, #071420);
        border: 1.5px solid #7fdcff; box-shadow: 0 0 14px rgba(127,220,255,.35);
        display: flex; align-items: center; justify-content: center; font-weight: 800; color: #7fdcff; font-size: 16px; }
      .who { font-size: 14px; font-weight: 700; }
      .role { font-size: 11px; color: #8092a5; }
      .pstat { display: flex; align-items: center; gap: 6px; font-size: 11px; color: #56657a; margin-top: 3px; }
      .pstat i { width: 6px; height: 6px; border-radius: 50%; background: #46506a; }
      #panel.connected .pstat { color: #37d39b; }
      #panel.connected .pstat i { background: #37d39b; box-shadow: 0 0 6px #37d39b; }
      .loc { font-size: 11px; color: #5f7186; font-family: ui-monospace, monospace; margin-top: 1px; }

      .appr-item { font-size: 12px; padding-top: 10px; }
      .appr-item:first-child { padding-top: 0; }
      .appr-item + .appr-item { border-top: 1px solid rgba(255,90,207,.18); margin-top: 8px; }
      .rsn { color: #ffd0f0; font-weight: 600; }
      .tgt { color: #a9bccd; margin-top: 3px; }
      .tgt b { color: #eaffff; }
      .ts { color: #5f7186; font-family: ui-monospace, monospace; font-size: 10.5px; margin-top: 2px; }
      .btns { display: flex; gap: 8px; margin-top: 10px; }
      .btns button { flex: 1; padding: 7px 0; border-radius: 8px; font-size: 12px; font-weight: 700;
        letter-spacing: .5px; cursor: pointer; font-family: inherit; background: transparent; }
      .btns .deny { border: 1px solid rgba(255,90,207,.55); color: #ff8fdc; }
      .btns .ok { border: 1px solid rgba(127,220,255,.6); color: #04121c; background: #7fdcff; }
      .empty { font-size: 12px; color: #5f7186; }

      .kv { display: flex; justify-content: space-between; font-size: 11.5px; padding: 3px 0; }
      .kv .k { color: #8092a5; }
      .kv .v { color: #cfe8f5; font-family: ui-monospace, monospace; }
      .kv .v.ok { color: #37d39b; }

      .foot { display: flex; padding: 11px 14px 14px; }
      .stop { flex: 1; text-align: center; padding: 8px 0; border-radius: 9px; font-size: 12px; font-weight: 700;
        letter-spacing: 1px; border: 1px solid rgba(255,90,207,.4); color: #ff8fdc; background: rgba(255,90,207,.06);
        cursor: pointer; }

      /* ---------- ORB ---------- */
      #orb { width: 118px; height: 118px; margin: 6px auto; position: relative;
        display: flex; align-items: center; justify-content: center; cursor: pointer; -webkit-app-region: drag; }
      #orb .ring { position: absolute; inset: 0; border-radius: 50%; border: 2.5px solid #7fdcff;
        box-shadow: 0 0 26px rgba(127,220,255,.6), inset 0 0 22px rgba(127,220,255,.25); transition: .3s; }
      #orb.pending .ring { border-color: #ff5acf; box-shadow: 0 0 30px rgba(255,90,207,.7); }
      #orb .core { width: 88px; height: 88px; border-radius: 50%;
        background: radial-gradient(circle at 40% 33%, #16466a, #06121d 72%);
        display: flex; flex-direction: column; align-items: center; justify-content: center; }
      #orb .a { font-size: 16px; font-weight: 800; letter-spacing: 1px; color: #7fdcff; text-shadow: 0 0 12px rgba(127,220,255,.7); }
      #orb .l { font-size: 8px; letter-spacing: 2px; color: #7a8ea0; }
      #orb .dot { position: absolute; top: 14px; right: 20px; width: 12px; height: 12px; border-radius: 50%;
        background: #46506a; border: 2px solid #06121d; }
      #orb.connected .dot { background: #37d39b; box-shadow: 0 0 10px #37d39b; }
    </style>
  </head>
  <body>
    <!-- FULL PANEL -->
    <div id="panel">
      <div class="head">
        <div class="title"><b>AKIRA</b><small>// LOCAL COMPANION</small></div>
        <div class="min" id="minBtn" title="Minimize to orb">—</div>
        <div class="conn">
          <div class="live"><i></i><span id="connLabel">DISCONNECTED</span></div>
          <div class="spacer"></div>
          <div class="timer"><div class="k">Active session</div><div class="v" id="timer">00:00:00</div></div>
        </div>
      </div>

      <div class="sec">
        <div class="sec-h"><div class="t">System presence</div></div>
        <div class="presence">
          <div class="avatar" id="avatar">A</div>
          <div>
            <div class="who" id="operator">Operator</div>
            <div class="role">Operator</div>
            <div class="pstat"><i></i><span id="onlineLabel">Companion offline</span></div>
            <div class="loc" id="loc">—</div>
          </div>
        </div>
      </div>

      <div class="sec gate" id="apprSec">
        <div class="sec-h"><div class="t">Pending approvals</div><div class="n" id="apprCount">0</div></div>
        <div id="apprList"></div>
      </div>

      <div class="sec">
        <div class="sec-h"><div class="t">Connection &amp; security</div></div>
        <div class="kv"><span class="k">Token</span><span class="v ok">authenticated ✓</span></div>
        <div class="kv"><span class="k">Transport</span><span class="v" id="transport">outbound-only</span></div>
        <div class="kv"><span class="k">Browser profile</span><span class="v" id="profile">persistent · local</span></div>
        <div class="kv"><span class="k">Sensitive domains</span><span class="v" id="domains">0 guarded</span></div>
      </div>

      <div class="foot"><div class="stop" id="stopBtn">■ STOP — abort all activity</div></div>
    </div>

    <!-- ORB -->
    <div id="orb" class="hidden">
      <div class="ring"></div>
      <div class="dot"></div>
      <div class="core"><div class="a">AKIRA</div><div class="l">LOCAL</div></div>
    </div>

    <script src="./hud.js"></script>
  </body>
</html>
```

- [ ] **Step 2: Replace `hud.js` with full live rendering + interactions**

Replace the entire contents of `companion-hud/renderer/hud.js` with:

```js
const params = new URLSearchParams(location.search);
const PORT = params.get('port');
const TOKEN = params.get('token');

let ws = null;
let state = null;
let minimized = false;

const $ = (id) => document.getElementById(id);
const panel = $('panel');
const orb = $('orb');

const PANEL_SIZE = [360, 580];
const ORB_SIZE = [130, 130];

function fmtTimer(sec) {
  const s = Math.max(0, sec | 0);
  const h = String((s / 3600) | 0).padStart(2, '0');
  const m = String(((s % 3600) / 60) | 0).padStart(2, '0');
  const ss = String(s % 60).padStart(2, '0');
  return `${h}:${m}:${ss}`;
}

function fmtTime(ms) {
  return new Date(ms).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
}

function send(obj) {
  if (ws && ws.readyState === 1) ws.send(JSON.stringify(obj));
}

function renderApprovals(queue) {
  const list = $('apprList');
  $('apprCount').textContent = String(queue.length);
  if (queue.length === 0) {
    list.innerHTML = '<div class="empty">Nothing waiting.</div>';
    return;
  }
  list.innerHTML = '';
  for (const g of queue) {
    const item = document.createElement('div');
    item.className = 'appr-item';
    const host = g.host ? ` · ${g.host}` : '';
    item.innerHTML =
      `<div class="rsn">${escapeHtml(g.reason)}</div>` +
      `<div class="tgt">“<b>${escapeHtml(g.target || 'action')}</b>”${escapeHtml(host)}</div>` +
      `<div class="ts">requested ${fmtTime(g.requestedAt)} · waiting</div>` +
      `<div class="btns"><button class="deny">DENY</button><button class="ok">APPROVE</button></div>`;
    item.querySelector('.deny').onclick = () => send({ type: 'deny', id: g.id });
    item.querySelector('.ok').onclick = () => send({ type: 'approve', id: g.id });
    list.appendChild(item);
  }
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
}

function render() {
  const connected = !!state?.presence?.connected;
  const queue = state?.queue ?? [];
  const pending = queue.length > 0;

  panel.classList.toggle('connected', connected);
  orb.classList.toggle('connected', connected);
  orb.classList.toggle('pending', pending);

  if (state) {
    const p = state.presence;
    $('connLabel').textContent = connected ? 'CONNECTED' : 'DISCONNECTED';
    $('timer').textContent = fmtTimer(p.uptimeSec);
    $('operator').textContent = p.operator;
    $('avatar').textContent = (p.operator || 'A').trim().charAt(0).toUpperCase();
    $('onlineLabel').textContent = connected ? 'Companion online' : 'Companion offline';
    $('loc').textContent = `${p.host} · ${p.task}`;
    $('transport').textContent = state.security.transport;
    $('profile').textContent = state.security.profile;
    $('domains').textContent = `${state.security.sensitiveCount} guarded`;
    renderApprovals(queue);
    $('apprSec').classList.toggle('hidden', false);
  }
}

function setMinimized(m) {
  minimized = m;
  panel.classList.toggle('hidden', m);
  orb.classList.toggle('hidden', !m);
  const [w, h] = m ? ORB_SIZE : PANEL_SIZE;
  if (window.hud) window.hud.resize(w, h);
}

$('minBtn').onclick = () => setMinimized(true);
orb.onclick = () => setMinimized(false);
$('stopBtn').onclick = () => send({ type: 'stop' });

function connect() {
  if (!PORT) return;
  ws = new WebSocket(`ws://127.0.0.1:${PORT}`);
  ws.onopen = () => send({ type: 'hello', token: TOKEN });
  ws.onmessage = (ev) => {
    const msg = JSON.parse(ev.data);
    if (msg.type === 'state') { state = msg; render(); }
  };
  ws.onclose = () => { state = null; render(); setTimeout(connect, 1500); };
  ws.onerror = () => ws.close();
}

connect();
render();
```

- [ ] **Step 3: Manual verification — full gate approval end to end**

Prereqs: valid `companion/.env` with the Mini reachable, and a sensitive/danger target to trigger a gate (e.g. ask AKIRA to click a "Buy now" / "Place order" button, or add a test domain to `COMPANION_SENSITIVE`).

1. Terminal A: `cd companion && pnpm start`
2. Terminal B: `cd companion-hud && pnpm start`
3. Confirm the panel shows: **CONNECTED**, a ticking session timer, your operator name + host + current task, and Connection & Security values (domains count matches `COMPANION_SENSITIVE`).
4. Drive AKIRA to attempt a gated click. Expected: the **Pending Approvals** count rises, the card shows the reason/target, and the orb (if minimized) glows magenta.
5. Click **APPROVE** → the companion runs the click (see terminal A log) and the card clears. Repeat with **DENY** → card clears and terminal A logs `operator denied`.
6. Click **STOP** → terminal A logs `STOP — activity aborted, queue cleared` and the browser task closes.
7. Click **—** to minimize to the orb; click the orb to restore. Window resizes accordingly and stays always-on-top.

- [ ] **Step 4: Commit**

```bash
git add companion-hud/renderer/index.html companion-hud/renderer/hud.js
git commit -m "feat(hud): full panel — presence, live approvals, security, stop, minimize"
```

---

### Task 7: Documentation

**Files:**
- Modify: `companion/README.md`
- Create: `companion-hud/README.md`
- Modify: `docs/superpowers/specs/2026-06-29-akira-local-companion-design.md` (mark HUD slice status)

**Interfaces:** none (docs only).

- [ ] **Step 1: Document the HUD in the companion README**

Add this section to the end of `companion/README.md`:

```markdown
## The native HUD

The Companion exposes a **localhost-only** WebSocket bridge (bound to `127.0.0.1`,
random port) and writes `~/.akira-companion/bridge.json` (`{ port, token }`, mode
600). The native HUD (`../companion-hud/`) reads that file and connects to it.

When the HUD is connected, hard-gated actions (buy / pay / send / delete …) are
**held locally** and you approve or deny them in the HUD — the Mini does not need
to be reachable to resolve a gate. When the HUD is not running, the Companion
falls back to the Mini approval path as before. `STOP` in the HUD aborts all
activity and clears the queue.

Optional env: `COMPANION_OPERATOR` sets the name shown in the HUD (default
`Operator`).

Run the HUD alongside the Companion:
\`\`\`bash
cd ../companion-hud && pnpm install && pnpm start
\`\`\`
```

- [ ] **Step 2: Create the HUD README**

Create `companion-hud/README.md`:

```markdown
# AKIRA Local Companion — HUD

A native, always-on-top Electron HUD for the AKIRA Local Companion. Shows
connection, presence, the local hard-gate approval queue, and security posture;
collapses from a full glass panel to a draggable orb.

## How it works

The HUD reads `~/.akira-companion/bridge.json` (written by the Companion) to find
the localhost bridge port + token, connects over a `127.0.0.1` WebSocket, and:

- renders live **presence** (operator, host, current task, session timer),
- lists **pending approvals** with Approve / Deny,
- shows **connection & security** posture,
- sends **Stop** to abort all Companion activity.

No inbound network ports; nothing leaves the laptop.

## Setup

\`\`\`bash
pnpm install
# If Electron's binary didn't download (repo uses ignore-scripts):
node node_modules/electron/install.js
\`\`\`

## Run

Start the Companion first (`cd ../companion && pnpm start`), then:

\`\`\`bash
pnpm start
\`\`\`

The orb's dot turns green when the Companion's link to the Mini is up, and glows
magenta when an approval is waiting. Drag the header/orb to reposition; click
**—** to minimize, click the orb to restore.
```

- [ ] **Step 3: Mark the HUD slice in the Companion design spec**

In `docs/superpowers/specs/2026-06-29-akira-local-companion-design.md`, find the line noting the HUD surfaces approvals (near the "HUD (extend proposal card)" row / the HUD bullet around line 32) and append a cross-reference so the two specs stay in sync:

```markdown
> **Update (2026-07-02):** The native laptop HUD is specced separately in
> [2026-07-02-akira-companion-hud-design.md](2026-07-02-akira-companion-hud-design.md)
> and moves hard-gate approvals local (companion-held queue over a localhost bridge).
```

- [ ] **Step 4: Commit**

```bash
git add companion/README.md companion-hud/README.md docs/superpowers/specs/2026-06-29-akira-local-companion-design.md
git commit -m "docs: document the native Companion HUD and bridge"
```

---

## Final verification

Before merging to `dev`, confirm all of these:

- [ ] `cd companion && pnpm test` — `guard`, `page-snapshot`, `gate-queue`, `bridge-protocol` all pass.
- [ ] Root `pnpm test` — full suite green (it also runs `companion/src/*.test.ts`).
- [ ] Root `pnpm build` — clean; `companion/` and `companion-hud/` are NOT in the Mini build (no Electron/Playwright imports reach it).
- [ ] `cd companion && pnpm exec tsc --noEmit` — clean.
- [ ] Manual E2E (Task 6, Step 3): companion + HUD run; CONNECTED + timer + presence render; a gated click surfaces in the HUD; Approve runs it, Deny reports back, Stop aborts; minimize⇄orb works; window stays always-on-top.
- [ ] Merge `feat/akira-companion-hud` → `dev` with `git merge --no-ff`. **Do NOT** push to `main`, tag, or deploy.

## Deploy note (for the human, not the build)

No Mini change is required (approvals resolve locally; no DB migration, no new Mini
env var). The HUD is a laptop-side app run alongside the Companion. Packaging /
installer / autostart is a later slice.
