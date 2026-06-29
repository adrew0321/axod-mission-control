# AKIRA Local Companion Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give AKIRA (on the Mini) hands on the user's laptop — a local Companion process that drives a persistent Playwright browser (navigate/read/type/click) on her behalf, with a human-confirmed safety model, logging into accounts via a saved profile.

**Architecture:** A new `companion/` package runs on the laptop and opens an **outbound SSE** channel to the Mini to receive commands, executing them against a persistent headful Chromium and POSTing results back. On the Mini, an in-memory **registry** bridges AKIRA's new `browser_*` MCP tools (request→await result) to the connected Companion. Irreversible actions are **hard-gated at the Companion**, and approvals surface smoothly in the AKIRA HUD.

**Tech Stack:** Node 22 (global `fetch`/`ReadableStream` for SSE), Playwright (laptop only), Next.js 16 route handlers (SSE + POST), Claude Agent SDK MCP tools, node:test via `tsx`.

## Global Constraints

- Spec: `docs/superpowers/specs/2026-06-29-akira-local-companion-design.md`.
- AKIRA is the brain (Mini); the Companion is the hands (laptop). The Mini stays the DB source of truth. The Companion only acts on the laptop browser.
- **Transport:** Companion dials **outbound** — SSE command channel (`GET /api/companion/stream`) + result `POST /api/companion/result`. No inbound ports on the laptop. No custom WebSocket server.
- **Auth:** a pre-shared token in the Mini `.env` as `COMPANION_TOKEN` and the Companion's local config; every connect/POST carries it; the Mini rejects mismatches.
- **Safety is enforced at the Companion, not trusted to AKIRA.** Before executing a click the Companion classifies it; gated actions (buy/pay/checkout/send/delete/transfer/confirm, payment fields, sensitive domains) are **not executed** until an explicit per-action approval arrives.
- **Login:** persistent Playwright profile; the user logs in once interactively; AKIRA never stores or types passwords.
- One active browser task at a time per Companion. Stuck-loop cap ~25 steps/task. Hard-gate with no response within a window = **declined** (fail-safe).
- Tests: `pnpm test` runs `tsx --test …`; add the companion + companion-lib globs. Pure logic only in tests; **extensionless** relative imports. Playwright/live-SSE are integration/manual.
- `companion/` is its own package (Playwright installed there only, NOT on the Mini) and is **excluded from the root tsconfig** so `next build`/`tsc` never sees Playwright.
- Branch off `dev`; never push to `main`. Commit after each task.

## File Structure

**Laptop — new `companion/` package (NOT installed on the Mini):**
- `companion/package.json` — deps: `playwright`, `dotenv`, `tsx` (dev). Scripts: `start`, `test`.
- `companion/tsconfig.json` — standalone, references the pure modules.
- `companion/src/config.ts` — Mini URL, token, profile dir, sensitive-domain list, timeouts.
- `companion/src/protocol.ts` — **pure** shared types: `Command`, `Result`, `Snapshot`, `RawEl`.
- `companion/src/guard.ts` — **pure** hard-gate classifier.
- `companion/src/guard.test.ts`
- `companion/src/page-snapshot.ts` — **pure** raw elements → trimmed snapshot with stable refs.
- `companion/src/page-snapshot.test.ts`
- `companion/src/browser.ts` — Playwright persistent browser; executes actions (impure).
- `companion/src/connection.ts` — outbound SSE read loop, token, heartbeat, result POST, reconnect (impure).
- `companion/src/index.ts` — entry: wire connection ↔ browser ↔ guard.

**Mini — Mission Control app:**
- `src/lib/companion/protocol.ts` — same `Command`/`Result`/`Snapshot` types (mirror; pure).
- `src/lib/companion/registry.ts` — in-memory presence + command/result bus + approvals (pure-ish, injected controller).
- `src/lib/companion/registry.test.ts`
- `src/app/api/companion/stream/route.ts` — SSE command channel (token-auth, presence).
- `src/app/api/companion/result/route.ts` — result intake (token-auth).
- `src/app/api/companion/approve/route.ts` — operator approves a gated action (session-cookie auth).
- `src/lib/akira/browser-tools.ts` — `browser_*` MCP tools (enqueue + await; task-approval + hard-gate hooks).
- `src/lib/akira/tools.ts` (modify) — register browser tools when a companion is online.
- `src/lib/akira-turn.ts` (modify) — add browser tool names to `extraAllowedTools`; add companion presence to the prompt.
- `src/components/akira/hud.tsx` (modify) — companion-online indicator + smooth browser-task / hard-gate / login-nudge cards.

**Config:**
- `.env.example` (modify) — add `COMPANION_TOKEN`.
- `tsconfig.json` (modify) — add `companion` to `exclude`.
- `package.json` (modify) — extend the `test` glob with the companion + companion-lib test dirs.

---

### Task 1: Shared protocol types (Mini + Companion)

Two identical pure modules (one per package) so each side imports its own without a cross-package build dependency.

**Files:**
- Create: `src/lib/companion/protocol.ts`
- Create: `companion/src/protocol.ts` (byte-identical content)

**Interfaces:**
- Produces:
  - `type CommandAction = 'navigate' | 'read' | 'type' | 'click' | 'wait'`
  - `interface Command { id: string; action: CommandAction; url?: string; ref?: string; text?: string; approved?: boolean }`
  - `interface RawEl { ref: string; tag: string; role?: string; name?: string; type?: string; href?: string }`
  - `interface Snapshot { url: string; title: string; text: string; elements: RawEl[] }`
  - `type ResultStatus = 'ok' | 'error' | 'blocked'`
  - `interface Result { id: string; status: ResultStatus; snapshot?: Snapshot; text?: string; reason?: string }`

- [ ] **Step 1: Write `src/lib/companion/protocol.ts`**

```ts
// Shared wire types for the AKIRA Local Companion. Pure — no deps. The companion
// package has a byte-identical copy at companion/src/protocol.ts.

export type CommandAction = 'navigate' | 'read' | 'type' | 'click' | 'wait';

export interface Command {
  id: string;
  action: CommandAction;
  url?: string;
  ref?: string;
  text?: string;
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

- [ ] **Step 2: Copy it to `companion/src/protocol.ts`** (identical content).

- [ ] **Step 3: Verify it typechecks in the app build**

Run: `pnpm build`
Expected: success (the file is valid TS; not yet imported anywhere).

- [ ] **Step 4: Commit**

```bash
git add src/lib/companion/protocol.ts companion/src/protocol.ts
git commit -m "feat(companion): shared Command/Result/Snapshot protocol types"
```

---

### Task 2: Hard-gate classifier (`guard.ts`) — the safety core

**Files:**
- Create: `companion/src/guard.ts`
- Create: `companion/src/guard.test.ts`
- Modify: `package.json` (test glob), `tsconfig.json` (exclude companion)

**Interfaces:**
- Consumes: `RawEl` from `./protocol`.
- Produces: `classifyClick(el: RawEl, pageUrl: string, sensitiveDomains: string[]): { gated: boolean; reason?: string }`

- [ ] **Step 1: Exclude `companion` from the root tsconfig + extend the test glob**

In `tsconfig.json`, change the exclude line to:
```json
  "exclude": ["node_modules", "data", "companion"]
```
In `package.json`, change the `test` script to:
```json
    "test": "tsx --test src/lib/*.test.ts src/lib/akira/*.test.ts src/lib/voice/*.test.ts src/lib/companion/*.test.ts companion/src/*.test.ts",
```

- [ ] **Step 2: Write the failing test**

`companion/src/guard.test.ts`:

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { classifyClick } from './guard';
import type { RawEl } from './protocol';

const el = (p: Partial<RawEl>): RawEl => ({ ref: 'e1', tag: 'button', ...p });

test('gates a buy/checkout button', () => {
  assert.equal(classifyClick(el({ name: 'Place your order' }), 'https://amazon.com', []).gated, true);
  assert.equal(classifyClick(el({ name: 'Buy now' }), 'https://x.com', []).gated, true);
});

test('gates send / delete / transfer', () => {
  for (const name of ['Send', 'Delete account', 'Transfer funds', 'Confirm payment']) {
    assert.equal(classifyClick(el({ name }), 'https://x.com', []).gated, true, name);
  }
});

test('gates a submit on a sensitive domain regardless of label', () => {
  const r = classifyClick(el({ name: 'Continue', type: 'submit' }), 'https://mybank.com/transfer', ['mybank.com']);
  assert.equal(r.gated, true);
});

test('does NOT gate ordinary links/buttons', () => {
  assert.equal(classifyClick(el({ tag: 'a', name: 'Inbox', href: '/mail' }), 'https://outlook.com', []).gated, false);
  assert.equal(classifyClick(el({ name: 'Next page' }), 'https://x.com', []).gated, false);
});
```

- [ ] **Step 3: Run it to verify it fails**

Run: `pnpm test`
Expected: FAIL — `Cannot find module './guard'`.

- [ ] **Step 4: Implement `companion/src/guard.ts`**

```ts
// Pure hard-gate classifier — the Companion's brakes. Decides whether a click
// must wait for explicit operator approval. No Playwright, no deps.
import type { RawEl } from './protocol';

const DANGER = /\b(buy|buy now|place (your )?order|order now|pay|payment|checkout|purchase|subscribe|send|post|publish|tweet|delete|remove account|transfer|wire|confirm (payment|order|purchase)|place bid)\b/i;

function hostOf(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return '';
  }
}

/**
 * Returns { gated:true, reason } when this click must pause for explicit
 * approval: a dangerous label/intent, a payment field, or a submit on a
 * sensitive (e.g. banking) domain. Ordinary navigation/links are not gated.
 */
export function classifyClick(
  el: RawEl,
  pageUrl: string,
  sensitiveDomains: string[],
): { gated: boolean; reason?: string } {
  const host = hostOf(pageUrl);
  const onSensitive = sensitiveDomains.some((d) => host === d || host.endsWith('.' + d));
  const label = `${el.name ?? ''} ${el.role ?? ''}`.trim();

  if (el.type === 'submit' && onSensitive) {
    return { gated: true, reason: `submit on sensitive domain ${host}` };
  }
  if (DANGER.test(label)) {
    return { gated: true, reason: `action looks irreversible: "${el.name ?? label}"` };
  }
  if (onSensitive && DANGER.test(label)) {
    return { gated: true, reason: `sensitive action on ${host}` };
  }
  return { gated: false };
}
```

- [ ] **Step 5: Run tests**

Run: `pnpm test`
Expected: PASS (all guard tests).

- [ ] **Step 6: Commit**

```bash
git add companion/src/guard.ts companion/src/guard.test.ts tsconfig.json package.json
git commit -m "feat(companion): hard-gate click classifier (the safety core) + test wiring"
```

---

### Task 3: Page snapshot (`page-snapshot.ts`) — AKIRA's eyes

**Files:**
- Create: `companion/src/page-snapshot.ts`
- Create: `companion/src/page-snapshot.test.ts`

**Interfaces:**
- Consumes: `RawEl`, `Snapshot` from `./protocol`.
- Produces: `buildSnapshot(input: { url: string; title: string; pageText: string; raw: Omit<RawEl,'ref'>[] }, maxEls?: number, maxText?: number): Snapshot` — assigns stable refs `e1..eN`, drops invisible/nameless noise, trims text.

- [ ] **Step 1: Write the failing test**

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildSnapshot } from './page-snapshot';

test('assigns sequential refs and keeps named interactives', () => {
  const snap = buildSnapshot({
    url: 'https://x.com', title: 'X', pageText: 'hello world',
    raw: [
      { tag: 'a', name: 'Inbox', href: '/mail' },
      { tag: 'button', name: 'Compose' },
      { tag: 'button', name: '' }, // nameless → dropped
    ],
  });
  assert.equal(snap.elements.length, 2);
  assert.equal(snap.elements[0].ref, 'e1');
  assert.equal(snap.elements[1].ref, 'e2');
  assert.equal(snap.elements[1].name, 'Compose');
});

test('trims long page text', () => {
  const snap = buildSnapshot({ url: 'u', title: 't', pageText: 'x'.repeat(5000), raw: [] }, 200, 1000);
  assert.ok(snap.text.length <= 1001);
});

test('caps the element count', () => {
  const raw = Array.from({ length: 500 }, (_, i) => ({ tag: 'button', name: `b${i}` }));
  const snap = buildSnapshot({ url: 'u', title: 't', pageText: '', raw }, 200);
  assert.equal(snap.elements.length, 200);
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `pnpm test`
Expected: FAIL — `Cannot find module './page-snapshot'`.

- [ ] **Step 3: Implement `companion/src/page-snapshot.ts`**

```ts
// Pure: turn raw extracted elements + page text into AKIRA's trimmed read model
// with stable refs. No Playwright — the impure extraction lives in browser.ts.
import type { RawEl, Snapshot } from './protocol';

export function buildSnapshot(
  input: { url: string; title: string; pageText: string; raw: Omit<RawEl, 'ref'>[] },
  maxEls = 120,
  maxText = 4000,
): Snapshot {
  const elements: RawEl[] = [];
  for (const r of input.raw) {
    const name = (r.name ?? '').trim();
    // keep only actionable, named elements (links/buttons/inputs); drop noise
    if (!name && !r.href && r.tag !== 'input') continue;
    elements.push({ ref: `e${elements.length + 1}`, ...r, name });
    if (elements.length >= maxEls) break;
  }
  const text = input.pageText.length > maxText ? input.pageText.slice(0, maxText) : input.pageText;
  return { url: input.url, title: input.title, text, elements };
}
```

- [ ] **Step 4: Run tests**

Run: `pnpm test`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add companion/src/page-snapshot.ts companion/src/page-snapshot.test.ts
git commit -m "feat(companion): pure page-snapshot builder (refs + trimming)"
```

---

### Task 4: Mini registry — presence + command/result bus

**Files:**
- Create: `src/lib/companion/registry.ts`
- Create: `src/lib/companion/registry.test.ts`

**Interfaces:**
- Consumes: `Command`, `Result` from `./protocol`.
- Produces (module singleton):
  - `interface CompanionSink { send: (cmd: Command) => void; close?: () => void }`
  - `registerCompanion(sink: CompanionSink): () => void` — returns an unregister fn; replaces any existing sink (single laptop).
  - `isOnline(): boolean`
  - `sendCommand(cmd: Omit<Command,'id'>): { id: string; result: Promise<Result> }` — pushes to the sink, returns a promise resolved by `resolveResult`; rejects if offline or on timeout (`COMMAND_TIMEOUT_MS`, default 60000).
  - `resolveResult(r: Result): void` — settles the pending promise for `r.id`.
  - `hasPending(): boolean` — true while a command is in flight (enforces one-task-at-a-time at the tool layer).
  - `newId(): string`

The promise/timeout/correlation logic is what's unit-tested (inject a fake sink; no server needed).

- [ ] **Step 1: Write the failing test**

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { registerCompanion, isOnline, sendCommand, resolveResult } from './registry';

test('offline send rejects', async () => {
  await assert.rejects(() => sendCommand({ action: 'read' }).result, /offline/i);
});

test('round-trips a command to a result by id', async () => {
  const seen: { id: string }[] = [];
  const unreg = registerCompanion({ send: (c) => seen.push(c) });
  assert.equal(isOnline(), true);
  const { id, result } = sendCommand({ action: 'read' });
  assert.equal(seen[0].id, id);
  resolveResult({ id, status: 'ok', text: 'done' });
  assert.equal((await result).text, 'done');
  unreg();
  assert.equal(isOnline(), false);
});

test('times out when no result arrives', async () => {
  const unreg = registerCompanion({ send: () => {} });
  const { result } = sendCommand({ action: 'read' }, 30); // 30ms timeout
  await assert.rejects(() => result, /timeout/i);
  unreg();
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `pnpm test`
Expected: FAIL — `Cannot find module './registry'`.

- [ ] **Step 3: Implement `src/lib/companion/registry.ts`**

```ts
// In-memory bridge between AKIRA's browser tools and the connected Companion.
// Single laptop: one sink at a time. Not server-only — pure promise/bus logic,
// unit-tested with a fake sink.
import { randomBytes, bytesToHex } from '@noble/hashes/utils.js';
import type { Command, Result } from './protocol';

export interface CompanionSink {
  send: (cmd: Command) => void;
  close?: () => void;
}

const DEFAULT_TIMEOUT_MS = 60_000;

let sink: CompanionSink | null = null;
const pending = new Map<string, { resolve: (r: Result) => void; reject: (e: Error) => void; timer: ReturnType<typeof setTimeout> }>();

export function newId(): string {
  return `cmd_${bytesToHex(randomBytes(6))}`;
}

export function registerCompanion(s: CompanionSink): () => void {
  sink?.close?.();
  sink = s;
  return () => {
    if (sink === s) sink = null;
    // fail any in-flight commands — never silently hang
    for (const [id, p] of pending) {
      clearTimeout(p.timer);
      p.reject(new Error('companion disconnected'));
      pending.delete(id);
    }
  };
}

export function isOnline(): boolean {
  return sink !== null;
}

export function hasPending(): boolean {
  return pending.size > 0;
}

export function sendCommand(
  cmd: Omit<Command, 'id'>,
  timeoutMs = DEFAULT_TIMEOUT_MS,
): { id: string; result: Promise<Result> } {
  const id = newId();
  if (!sink) {
    return { id, result: Promise.reject(new Error('companion offline')) };
  }
  const full: Command = { ...cmd, id };
  const result = new Promise<Result>((resolve, reject) => {
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(new Error('companion command timeout'));
    }, timeoutMs);
    pending.set(id, { resolve, reject, timer });
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

- [ ] **Step 4: Run tests**

Run: `pnpm test`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/lib/companion/registry.ts src/lib/companion/registry.test.ts
git commit -m "feat(companion): Mini-side presence + command/result bus"
```

---

### Task 5: Mini SSE stream + result routes

**Files:**
- Create: `src/app/api/companion/stream/route.ts`
- Create: `src/app/api/companion/result/route.ts`
- Modify: `.env.example` (add `COMPANION_TOKEN`)

**Interfaces:**
- Consumes: `registerCompanion`, `resolveResult` from `@/lib/companion/registry`; `Command`, `Result` from `@/lib/companion/protocol`.
- Produces: the authenticated outbound channel + result intake.

- [ ] **Step 1: Add the token to `.env.example`**

Append:
```
# Shared secret the laptop Companion uses to authenticate to the Mini.
COMPANION_TOKEN=
```

- [ ] **Step 2: Implement the SSE command channel**

`src/app/api/companion/stream/route.ts`:

```ts
import { registerCompanion } from '@/lib/companion/registry';
import type { Command } from '@/lib/companion/protocol';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

function sse(event: { type: string; [k: string]: unknown }): Uint8Array {
  return new TextEncoder().encode(`data: ${JSON.stringify(event)}\n\n`);
}

export async function GET(req: Request) {
  const token = new URL(req.url).searchParams.get('token');
  if (!process.env.COMPANION_TOKEN || token !== process.env.COMPANION_TOKEN) {
    return new Response('Unauthorized', { status: 401 });
  }

  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      const unregister = registerCompanion({
        send: (cmd: Command) => controller.enqueue(sse({ type: 'command', cmd })),
        close: () => {
          try { controller.close(); } catch { /* already closed */ }
        },
      });
      // heartbeat so the laptop (and any proxy) keeps the stream alive
      const hb = setInterval(() => controller.enqueue(sse({ type: 'ping' })), 15_000);
      req.signal.addEventListener('abort', () => {
        clearInterval(hb);
        unregister();
        try { controller.close(); } catch { /* noop */ }
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

- [ ] **Step 3: Implement the result intake**

`src/app/api/companion/result/route.ts`:

```ts
import { resolveResult } from '@/lib/companion/registry';
import type { Result } from '@/lib/companion/protocol';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(req: Request) {
  const token = req.headers.get('x-companion-token');
  if (!process.env.COMPANION_TOKEN || token !== process.env.COMPANION_TOKEN) {
    return new Response('Unauthorized', { status: 401 });
  }
  const body = (await req.json().catch(() => null)) as Result | null;
  if (!body || !body.id || !body.status) {
    return new Response('bad result', { status: 400 });
  }
  resolveResult(body);
  return Response.json({ ok: true });
}
```

- [ ] **Step 4: Verify build**

Run: `pnpm build`
Expected: success; routes `/api/companion/stream` and `/api/companion/result` present.

- [ ] **Step 5: Commit**

```bash
git add src/app/api/companion/stream/route.ts src/app/api/companion/result/route.ts .env.example
git commit -m "feat(companion): Mini SSE command channel + result intake (token auth)"
```

---

### Task 6: Mini approve route

**Files:**
- Create: `src/app/api/companion/approve/route.ts`

**Interfaces:**
- Consumes: `sendCommand` from `@/lib/companion/registry`; `SESSION_COOKIE`, `verifySession` from `@/lib/auth`.
- Produces: the operator-authenticated endpoint that re-issues a previously gated click with `approved: true`. Returns the result text.

The approve path re-sends the SAME action (`click` + `ref`) with `approved: true`; the Companion executes it because the flag is present. This keeps one mechanism (the command bus) for both normal and approved actions.

- [ ] **Step 1: Implement the route**

`src/app/api/companion/approve/route.ts`:

```ts
import { cookies } from 'next/headers';
import { SESSION_COOKIE, verifySession } from '@/lib/auth';
import { sendCommand, isOnline } from '@/lib/companion/registry';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(req: Request) {
  const jar = await cookies();
  const token = jar.get(SESSION_COOKIE)?.value;
  if (!token || !(await verifySession(token))) {
    return Response.json({ error: 'Unauthorized' }, { status: 401 });
  }
  if (!isOnline()) return Response.json({ error: 'companion offline' }, { status: 409 });

  const body = (await req.json().catch(() => ({}))) as { ref?: string };
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

- [ ] **Step 2: Verify build**

Run: `pnpm build`
Expected: success; `/api/companion/approve` present.

- [ ] **Step 3: Commit**

```bash
git add src/app/api/companion/approve/route.ts
git commit -m "feat(companion): operator approve route for hard-gated clicks"
```

---

### Task 7: AKIRA browser tools

**Files:**
- Create: `src/lib/akira/browser-tools.ts`
- Modify: `src/lib/akira/tools.ts` (register browser tools), `src/lib/akira-turn.ts` (allow + presence)

**Interfaces:**
- Consumes: `sendCommand`, `isOnline` from `@/lib/companion/registry`; `AkiraToolContext` from `./tool-actions`; SDK `tool`, `z`.
- Produces:
  - Tool-name constants `AKIRA_BROWSER_NAVIGATE/READ/TYPE/CLICK = 'mcp__akira__browser_*'`.
  - `browserToolDefs(ctx: AkiraToolContext)` — array of SDK tools to spread into the akira server.
  - Each tool calls `sendCommand` and awaits; on a `blocked` result it `ctx.emit({ type: 'hard_gate', ref, reason })` and returns text telling AKIRA it needs the operator's approval (she should stop and ask).

- [ ] **Step 1: Implement `src/lib/akira/browser-tools.ts`**

```ts
import 'server-only';
import { z } from 'zod';
import { tool } from '@anthropic-ai/claude-agent-sdk';
import { sendCommand } from '@/lib/companion/registry';
import { type AkiraToolContext, type ToolResult, ok, err } from './tool-actions';

export const AKIRA_BROWSER_NAVIGATE = 'mcp__akira__browser_navigate';
export const AKIRA_BROWSER_READ = 'mcp__akira__browser_read';
export const AKIRA_BROWSER_TYPE = 'mcp__akira__browser_type';
export const AKIRA_BROWSER_CLICK = 'mcp__akira__browser_click';

export const BROWSER_TOOL_NAMES = [
  AKIRA_BROWSER_NAVIGATE,
  AKIRA_BROWSER_READ,
  AKIRA_BROWSER_TYPE,
  AKIRA_BROWSER_CLICK,
];

function snapshotText(text: string, snap: { url: string; title: string; text: string; elements: { ref: string; tag: string; name?: string }[] } | undefined): string {
  if (!snap) return text;
  const els = snap.elements.map((e) => `${e.ref}: <${e.tag}> ${e.name ?? ''}`.trim()).join('\n');
  return `URL: ${snap.url}\nTITLE: ${snap.title}\n\nELEMENTS:\n${els}\n\nTEXT:\n${snap.text}`;
}

async function run(action: 'navigate' | 'read' | 'type' | 'click', args: Record<string, unknown>, ctx: AkiraToolContext): Promise<ToolResult> {
  try {
    const { result } = sendCommand({ action, ...args });
    const r = await result;
    if (r.status === 'blocked') {
      // hard gate — surface to the operator; AKIRA must stop and ask, not retry.
      ctx.emit({ type: 'hard_gate', ref: String(args.ref ?? ''), reason: r.reason ?? 'sensitive action' });
      return ok(`That action is gated for your safety (${r.reason ?? 'sensitive action'}). I've asked the operator to confirm — do not retry; wait for approval.`);
    }
    if (r.status === 'error') return err(r.reason ?? 'browser action failed');
    return ok(snapshotText(r.text ?? 'done', r.snapshot));
  } catch (e) {
    return err(e instanceof Error ? e.message : String(e));
  }
}

export function browserToolDefs(ctx: AkiraToolContext) {
  return [
    tool('browser_navigate', 'Open a URL in the operator\'s laptop browser. Returns a snapshot of the page.',
      { url: z.string().min(1).describe('The URL to open.') },
      (a) => run('navigate', { url: a.url }, ctx)),
    tool('browser_read', 'Re-read the current page; returns its elements (with refs) and text. Use before deciding the next action.',
      {}, () => run('read', {}, ctx)),
    tool('browser_type', 'Type text into an element by its ref (from the latest snapshot).',
      { ref: z.string().min(1), text: z.string() },
      (a) => run('type', { ref: a.ref, text: a.text }, ctx)),
    tool('browser_click', 'Click an element by its ref. Irreversible actions (buy/send/delete) will be gated and require the operator\'s approval.',
      { ref: z.string().min(1) },
      (a) => run('click', { ref: a.ref }, ctx)),
  ];
}
```

- [ ] **Step 2: Register the browser tools when a companion is online**

In `src/lib/akira/tools.ts`, import and conditionally include them. Add near the top:
```ts
import { browserToolDefs } from './browser-tools';
import { isOnline } from '@/lib/companion/registry';
```
In `createAkiraServer`, change the final tools array to append browser tools when online:
```ts
  const base = [navigate, open, relay, listSessions, getSession];
  const tools = isOnline() ? [...base, ...browserToolDefs(ctx)] : base;

  return createSdkMcpServer({
    name: AKIRA_SERVER_NAME,
    version: '1.0.0',
    alwaysLoad: true,
    tools,
  });
```

- [ ] **Step 3: Allow the browser tools + add presence to the prompt in `akira-turn.ts`**

In `src/lib/akira-turn.ts`, import:
```ts
import { BROWSER_TOOL_NAMES } from './akira/browser-tools';
import { isOnline as companionOnline } from '@/lib/companion/registry';
```
Add the names to `extraAllowedTools` (always safe to list; they only exist when registered):
```ts
      extraAllowedTools: [
        AKIRA_NAVIGATE, AKIRA_OPEN, AKIRA_RELAY, AKIRA_LIST_SESSIONS, AKIRA_GET_SESSION,
        ...BROWSER_TOOL_NAMES,
      ],
```
And append a line to the prompt so AKIRA knows whether she can drive the browser — after `buildAkiraPrompt(...)`:
```ts
    const prompt =
      buildAkiraPrompt(snapshot, roster, transcript, agentLabels) +
      `\n\n## LAPTOP COMPANION\n${companionOnline()
        ? 'The laptop companion is CONNECTED — you may use browser_navigate/read/type/click. Work read→act→read. State the task and let the operator approve before starting; never retry a gated (blocked) action — wait for approval.'
        : 'The laptop companion is OFFLINE — browser actions are unavailable; tell the operator their laptop companion isn\'t connected if they ask for browser work.'}`;
```

- [ ] **Step 4: Verify build**

Run: `pnpm build`
Expected: success.

- [ ] **Step 5: Commit**

```bash
git add src/lib/akira/browser-tools.ts src/lib/akira/tools.ts src/lib/akira-turn.ts
git commit -m "feat(akira): browser_* tools routed to the Companion + presence-aware prompt"
```

---

### Task 8: Companion config + connection (outbound SSE + results)

**Files:**
- Create: `companion/package.json`, `companion/tsconfig.json`, `companion/src/config.ts`, `companion/src/connection.ts`

**Interfaces:**
- Consumes: `Command`, `Result` from `./protocol`.
- Produces:
  - `loadConfig(): { miniUrl: string; token: string; profileDir: string; sensitiveDomains: string[] }`
  - `connect(cfg, onCommand: (cmd: Command) => void): { postResult: (r: Result) => Promise<void>; stop: () => void }` — opens the SSE stream, parses `data:` frames, calls `onCommand` for `command` events, auto-reconnects with backoff.

- [ ] **Step 1: Write `companion/package.json`**

```json
{
  "name": "akira-companion",
  "private": true,
  "type": "module",
  "scripts": {
    "start": "tsx src/index.ts",
    "test": "tsx --test src/*.test.ts"
  },
  "dependencies": {
    "playwright": "^1.49.0",
    "dotenv": "^17.4.2"
  },
  "devDependencies": {
    "tsx": "^4.22.3",
    "typescript": "^5"
  }
}
```

- [ ] **Step 2: Write `companion/tsconfig.json`**

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "esnext",
    "moduleResolution": "bundler",
    "strict": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "noEmit": true,
    "types": ["node"]
  },
  "include": ["src/**/*.ts"]
}
```

- [ ] **Step 3: Write `companion/src/config.ts`**

```ts
import 'dotenv/config';
import { homedir } from 'node:os';
import { join } from 'node:path';

export interface CompanionConfig {
  miniUrl: string;
  token: string;
  profileDir: string;
  sensitiveDomains: string[];
}

export function loadConfig(): CompanionConfig {
  const miniUrl = process.env.MINI_URL ?? 'https://bridge.axodcreative.com';
  const token = process.env.COMPANION_TOKEN ?? '';
  if (!token) throw new Error('COMPANION_TOKEN is required (set it in companion/.env)');
  const profileDir = process.env.COMPANION_PROFILE ?? join(homedir(), '.akira-companion', 'profile');
  const sensitiveDomains = (process.env.COMPANION_SENSITIVE ?? '')
    .split(',').map((s) => s.trim()).filter(Boolean);
  return { miniUrl, token, profileDir, sensitiveDomains };
}
```

- [ ] **Step 4: Write `companion/src/connection.ts`**

```ts
import type { Command, Result } from './protocol';
import type { CompanionConfig } from './config';

export function connect(cfg: CompanionConfig, onCommand: (cmd: Command) => void) {
  let stopped = false;
  let controller: AbortController | null = null;

  async function postResult(r: Result): Promise<void> {
    await fetch(`${cfg.miniUrl}/api/companion/result`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-companion-token': cfg.token },
      body: JSON.stringify(r),
    }).catch((e) => console.error('[companion] result POST failed:', e?.message ?? e));
  }

  async function loop() {
    while (!stopped) {
      controller = new AbortController();
      try {
        const res = await fetch(`${cfg.miniUrl}/api/companion/stream?token=${encodeURIComponent(cfg.token)}`, {
          headers: { Accept: 'text/event-stream' },
          signal: controller.signal,
        });
        if (!res.ok || !res.body) throw new Error(`stream ${res.status}`);
        console.log('[companion] connected to', cfg.miniUrl);
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
        if (!stopped) console.error('[companion] stream error, retrying:', (e as Error).message);
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

- [ ] **Step 5: Verify the companion package typechecks**

Run: `cd companion && pnpm install && pnpm exec tsc --noEmit && cd ..`
Expected: install succeeds (downloads Playwright); tsc clean. (Run on the laptop.)

- [ ] **Step 6: Commit**

```bash
git add companion/package.json companion/tsconfig.json companion/src/config.ts companion/src/connection.ts
git commit -m "feat(companion): package scaffold + config + outbound SSE connection"
```

---

### Task 9: Companion browser executor (Playwright)

**Files:**
- Create: `companion/src/browser.ts`

**Interfaces:**
- Consumes: `Command`, `Result`, `RawEl` from `./protocol`; `buildSnapshot` from `./page-snapshot`; `classifyClick` from `./guard`; `CompanionConfig`.
- Produces: `createBrowser(cfg): { execute: (cmd: Command) => Promise<Result>; close: () => Promise<void> }` — launches a persistent headful context, keeps a `ref → elementHandle` map per snapshot, executes actions, and enforces the hard gate before clicks.

- [ ] **Step 1: Implement `companion/src/browser.ts`**

```ts
import { chromium, type BrowserContext, type Page, type ElementHandle } from 'playwright';
import type { Command, Result, RawEl } from './protocol';
import { buildSnapshot } from './page-snapshot';
import { classifyClick } from './guard';
import type { CompanionConfig } from './config';

const SELECTOR = 'a, button, input, textarea, select, [role=button], [role=link], [role=textbox]';

export function createBrowser(cfg: CompanionConfig) {
  let ctx: BrowserContext | null = null;
  let page: Page | null = null;
  const refMap = new Map<string, ElementHandle>();
  const refMeta = new Map<string, RawEl>();

  async function ensure(): Promise<Page> {
    if (ctx && page && !page.isClosed()) return page;
    ctx = await chromium.launchPersistentContext(cfg.profileDir, { headless: false, viewport: null });
    page = ctx.pages()[0] ?? (await ctx.newPage());
    return page;
  }

  async function snapshot(p: Page): Promise<Result['snapshot']> {
    refMap.clear();
    refMeta.clear();
    const handles = await p.$$(SELECTOR);
    const raw: Omit<RawEl, 'ref'>[] = [];
    for (const h of handles) {
      const visible = await h.isVisible().catch(() => false);
      if (!visible) continue;
      const info = await h.evaluate((el) => ({
        tag: el.tagName.toLowerCase(),
        role: el.getAttribute('role') ?? undefined,
        name: (el.getAttribute('aria-label') || (el as HTMLElement).innerText || (el as HTMLInputElement).placeholder || el.getAttribute('value') || '').trim().slice(0, 80) || undefined,
        type: el.getAttribute('type') ?? undefined,
        href: el.getAttribute('href') ?? undefined,
      }));
      raw.push(info);
      // map the next ref (eN) to this handle, matching buildSnapshot's filter
      if (info.name || info.href || info.tag === 'input') {
        const ref = `e${refMap.size + 1}`;
        refMap.set(ref, h);
        refMeta.set(ref, { ref, ...info });
      }
    }
    const pageText = (await p.evaluate(() => document.body?.innerText ?? '')).slice(0, 8000);
    return buildSnapshot({ url: p.url(), title: await p.title(), pageText, raw });
  }

  async function execute(cmd: Command): Promise<Result> {
    try {
      const p = await ensure();
      switch (cmd.action) {
        case 'navigate':
          await p.goto(cmd.url!, { waitUntil: 'domcontentloaded', timeout: 30_000 });
          return { id: cmd.id, status: 'ok', snapshot: await snapshot(p) };
        case 'read':
          return { id: cmd.id, status: 'ok', snapshot: await snapshot(p) };
        case 'wait':
          await p.waitForLoadState('networkidle', { timeout: 15_000 }).catch(() => {});
          return { id: cmd.id, status: 'ok', snapshot: await snapshot(p) };
        case 'type': {
          const h = refMap.get(cmd.ref!);
          if (!h) return { id: cmd.id, status: 'error', reason: 'stale ref — re-read the page' };
          await h.fill(cmd.text ?? '');
          return { id: cmd.id, status: 'ok', text: 'typed' };
        }
        case 'click': {
          const meta = refMeta.get(cmd.ref!);
          const h = refMap.get(cmd.ref!);
          if (!h || !meta) return { id: cmd.id, status: 'error', reason: 'stale ref — re-read the page' };
          // HARD GATE: refuse unless explicitly approved.
          const gate = classifyClick(meta, p.url(), cfg.sensitiveDomains);
          if (gate.gated && !cmd.approved) {
            return { id: cmd.id, status: 'blocked', reason: gate.reason };
          }
          await h.click({ timeout: 15_000 });
          await p.waitForLoadState('domcontentloaded', { timeout: 15_000 }).catch(() => {});
          return { id: cmd.id, status: 'ok', snapshot: await snapshot(p) };
        }
        default:
          return { id: cmd.id, status: 'error', reason: `unknown action ${cmd.action}` };
      }
    } catch (e) {
      return { id: cmd.id, status: 'error', reason: e instanceof Error ? e.message : String(e) };
    }
  }

  async function close() {
    await ctx?.close().catch(() => {});
    ctx = null;
    page = null;
  }

  return { execute, close };
}
```

- [ ] **Step 2: Typecheck (laptop)**

Run: `cd companion && pnpm exec tsc --noEmit && cd ..`
Expected: clean.

- [ ] **Step 3: Commit**

```bash
git add companion/src/browser.ts
git commit -m "feat(companion): Playwright executor with hard-gate enforcement on click"
```

---

### Task 10: Companion entry — wire it together

**Files:**
- Create: `companion/src/index.ts`

**Interfaces:**
- Consumes: `loadConfig`, `connect`, `createBrowser`.
- Produces: the running agent — receives commands, executes one at a time, posts results.

- [ ] **Step 1: Implement `companion/src/index.ts`**

```ts
import { loadConfig } from './config';
import { connect } from './connection';
import { createBrowser } from './browser';
import type { Command } from './protocol';

const cfg = loadConfig();
const browser = createBrowser(cfg);

// One-at-a-time queue so page actions never interleave.
let chain: Promise<void> = Promise.resolve();

const conn = connect(cfg, (cmd: Command) => {
  chain = chain.then(async () => {
    console.log('[companion] exec', cmd.action, cmd.ref ?? cmd.url ?? '');
    const result = await browser.execute(cmd);
    await conn.postResult(result);
  });
});

console.log('[companion] AKIRA Local Companion started; profile:', cfg.profileDir);

async function shutdown() {
  console.log('\n[companion] shutting down…');
  conn.stop();
  await browser.close();
  process.exit(0);
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
```

- [ ] **Step 2: Manual smoke (laptop, with the Mini reachable)**

Set `companion/.env` (`COMPANION_TOKEN=…` matching the Mini, `MINI_URL=…`). Run `cd companion && pnpm start`. Expect "connected to …" and, when AKIRA issues a `browser_navigate`, a Chromium window opens and a snapshot returns.

- [ ] **Step 3: Commit**

```bash
git add companion/src/index.ts
git commit -m "feat(companion): entry wiring — one-at-a-time command execution"
```

---

### Task 11: HUD — presence + smooth browser approval / hard-gate / login cards

**Files:**
- Modify: `src/components/akira/hud.tsx`

**Interfaces:**
- Consumes: the akira stream's new events: `hard_gate` ({ ref, reason }), and reuses task-approval via the existing proposal flow.
- Produces: a companion-online dot in the top bar; a smooth confirm card for hard-gate approvals that POSTs to `/api/companion/approve`.

- [ ] **Step 1: Handle the `hard_gate` event in the stream handler**

In the `es.onmessage` switch in `hud.tsx`, add:
```ts
      } else if (e.type === "hard_gate") {
        setGate({ ref: e.ref, reason: e.reason });
```
Add state near the others: `const [gate, setGate] = useState<{ ref: string; reason: string } | null>(null);`

- [ ] **Step 2: Add the approve handler + card**

Add:
```tsx
  async function approveGate() {
    if (!gate) return;
    const g = gate;
    setGate(null);
    await fetch("/api/companion/approve", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ref: g.ref }),
    });
    runTurn("I approved the gated action — continue.");
  }
```
Render the card (reusing `proposalCard` styling, with the smooth transition the spec requires — opacity/translate transition like `fadeCard`):
```tsx
        {gate && (
          <div style={{ ...proposalCard, transition: "opacity .3s ease, transform .3s ease" }}>
            <div style={{ marginBottom: 10 }}>⚠ AKIRA wants to do something irreversible: {gate.reason}. Approve?</div>
            <button onClick={approveGate} style={pillStyle}>Approve</button>
            <button onClick={() => setGate(null)} style={{ ...pillStyle, marginLeft: 8 }}>Cancel</button>
          </div>
        )}
```

- [ ] **Step 3: Companion-online dot in the top bar**

The server shell already fetches the snapshot; pass companion presence too. In `src/app/page.tsx` import `isOnline` from `@/lib/companion/registry` and pass `companionOnline={isOnline()}` to `<Hud>`. Add the prop to `Hud({ snapshot, companionOnline })` and render a small indicator next to the clock:
```tsx
        <span style={{ ...meta, color: companionOnline ? "#37d39b" : "#56657a" }}>
          {companionOnline ? "laptop ●" : "laptop ○"}
        </span>
```

- [ ] **Step 4: Verify build + manual**

Run: `pnpm build`. Then with the Companion connected, ask AKIRA to do a browser task; confirm the task-approval card, the live browser, and that a buy/send/delete attempt raises the **smooth hard-gate card** and only proceeds on Approve.

- [ ] **Step 5: Commit**

```bash
git add src/components/akira/hud.tsx src/app/page.tsx
git commit -m "feat(akira): HUD companion presence + smooth hard-gate approval card"
```

---

### Task 12: Docs

**Files:**
- Create: `companion/README.md`
- Modify: `docs/superpowers/specs/2026-06-29-akira-local-companion-design.md` (mark Implemented)

- [ ] **Step 1: Write `companion/README.md`**

Include: what it is; install (`pnpm install` in `companion/`, `pnpm exec playwright install chromium`); `.env` keys (`MINI_URL`, `COMPANION_TOKEN` matching the Mini, optional `COMPANION_PROFILE`, `COMPANION_SENSITIVE` comma list); run (`pnpm start`); the one-time per-site interactive login; that it never stores passwords; the hard-gate behavior.

- [ ] **Step 2: Mark the spec implemented**

Change the spec status line to `**Status:** Implemented — <date>`.

- [ ] **Step 3: Commit**

```bash
git add companion/README.md docs/superpowers/specs/2026-06-29-akira-local-companion-design.md
git commit -m "docs(companion): README + mark Local Companion spec implemented"
```

---

## Final verification (after all tasks)

- [ ] `pnpm test` — guard, page-snapshot, registry suites pass alongside the existing tests.
- [ ] `pnpm build` — clean; routes `/api/companion/stream|result|approve` present; `companion/` excluded from the build.
- [ ] On the laptop: `cd companion && pnpm install && pnpm exec playwright install chromium && pnpm exec tsc --noEmit`.
- [ ] Manual E2E: start the Companion → HUD shows "laptop ●" → ask AKIRA "open my Outlook" → browser opens, she reads/navigates → first time she hits a login wall she pauses, you sign in once → a buy/send/delete attempt raises the smooth hard-gate card and only runs on Approve → "Stop" aborts.
- [ ] **Deploy note:** the Mini needs `COMPANION_TOKEN` set in `/srv/mission-control/.env` (no migration; new env only). Per the ship-mc-feature skill: set the env, restart. Playwright is NOT installed on the Mini.
- [ ] Then: REQUIRED SUB-SKILL superpowers:finishing-a-development-branch.
