// Covers the property the shell log exists for: every dispatched command
// reaches a terminal log line, on every path out of runShell — including the
// paths where sendCommand's promise REJECTS rather than resolving to a status
// (room offline / disconnected mid-command / our own transport timeout). The
// room's egress is open by design, so those rejections are exactly the moments
// the audit trail has to hold up.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, rmSync, existsSync, mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

// Isolate this file's log from the real data/room-shell.log and from other
// test files. shellLogPath() reads this lazily on every call, so setting it
// before runShell is ever invoked is sufficient.
const logDir = mkdtempSync(join(tmpdir(), 'room-shell-test-'));
const logPath = join(logDir, 'room-shell.log');
process.env.ROOM_SHELL_LOG = logPath;

import { runShell } from './room-shell';
import { registerCompanion, resolveResult } from '@/lib/companion/registry';
import { decideGate } from '@/lib/companion/gates';
import type { Command } from '@/lib/companion/protocol';
import type { AkiraToolContext } from './tool-actions';

function readLogLines(): Record<string, unknown>[] {
  if (!existsSync(logPath)) return [];
  return readFileSync(logPath, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((l) => JSON.parse(l));
}

function freshCtx(): { ctx: AkiraToolContext; emitted: { type: string; [k: string]: unknown }[] } {
  const emitted: { type: string; [k: string]: unknown }[] = [];
  return { ctx: { emit: (e) => emitted.push(e) }, emitted };
}

test('a rejected dispatch (room companion offline) still ends in a terminal log line', async () => {
  rmSync(logPath, { force: true });
  const { ctx } = freshCtx();
  // No sink registered for 'room' — sendCommand rejects immediately (registry.ts).

  const result = await runShell('echo hi', undefined, ctx);

  assert.equal(result.isError, true, 'a transport failure must surface as an error to AKIRA');
  const lines = readLogLines();
  assert.equal(lines.length, 2, 'dispatch + exactly one terminal line — no silent drop after dispatch');
  assert.equal(lines[0].event, 'dispatch');
  const terminal = lines[1];
  assert.equal(terminal.event, 'result', 'the catch path is still a terminal outcome, not a new event type');
  assert.equal(terminal.status, 'error');
  assert.match(String(terminal.reason), /offline/i);
});

test("a normal completion logs dispatch then result with the room's real exit code", async () => {
  rmSync(logPath, { force: true });
  const { ctx } = freshCtx();
  const unreg = registerCompanion(
    { send: (cmd: Command) => resolveResult({ id: cmd.id, status: 'ok', text: 'hi', exitCode: 0 }) },
    'room',
  );
  try {
    const result = await runShell('echo hi', undefined, ctx);
    assert.equal(result.isError, undefined);
    const lines = readLogLines();
    assert.deepEqual(lines.map((l) => l.event), ['dispatch', 'result']);
    assert.equal(lines[1].status, 'ok');
    assert.equal(lines[1].exitCode, 0);
  } finally {
    unreg();
  }
});

test('a gated command the operator denies logs dispatch, gated (with its own reason field), denied — and the reply says stop, not retry', async () => {
  rmSync(logPath, { force: true });
  const { ctx, emitted } = freshCtx();
  const unreg = registerCompanion(
    { send: (cmd: Command) => resolveResult({ id: cmd.id, status: 'blocked', reason: 'looks like a dev server' }) },
    'room',
  );
  try {
    const promise = runShell('npm run dev', undefined, ctx);
    // Settle the gate the same way the operator's approve/deny route does,
    // instead of waiting out the real 120s auto-deny timeout.
    await new Promise((r) => setTimeout(r, 10));
    const gateId = String(emitted[0]?.gateId);
    assert.ok(gateId, 'runShell must emit a hard_gate carrying a gateId the operator can act on');
    assert.equal(decideGate(gateId, 'denied'), true);

    const result = await promise;
    assert.equal(result.isError, undefined, 'a denial is reported to AKIRA as content, not thrown as a tool error');
    assert.match(result.content[0].text, /do not retry/i);
    assert.match(result.content[0].text, /do not work around it/i);

    const lines = readLogLines();
    assert.deepEqual(lines.map((l) => l.event), ['dispatch', 'gated', 'denied']);
    assert.equal(lines[1].reason, 'looks like a dev server');
    assert.equal(lines[1].status, undefined, 'the gate reason must not overload status');
  } finally {
    unreg();
  }
});

test('a gated command the operator approves logs dispatch, gated, approved, result', async () => {
  rmSync(logPath, { force: true });
  const { ctx, emitted } = freshCtx();
  const unreg = registerCompanion(
    {
      send: (cmd: Command) => {
        if (cmd.approved) {
          resolveResult({ id: cmd.id, status: 'ok', text: 'started', exitCode: 0 });
        } else {
          resolveResult({ id: cmd.id, status: 'blocked', reason: 'looks like a dev server' });
        }
      },
    },
    'room',
  );
  try {
    const promise = runShell('npm run dev', undefined, ctx);
    await new Promise((r) => setTimeout(r, 10));
    const gateId = String(emitted[0]?.gateId);
    assert.equal(decideGate(gateId, 'approved'), true);

    const result = await promise;
    assert.equal(result.isError, undefined);

    const lines = readLogLines();
    assert.deepEqual(lines.map((l) => l.event), ['dispatch', 'gated', 'approved', 'result']);
    assert.equal(lines[3].status, 'ok');
  } finally {
    unreg();
  }
});

// A real auto-deny-at-120s path is not exercised here (waiting out
// GATE_TIMEOUT_MS in a unit test would make the suite take 2 minutes). Instead:
// runShell branches only on `decided === 'denied'` after `await decision`
// (room-shell.ts), and openGate's timeout callback resolves that same
// `decision` promise to 'denied' through the identical settle() path that
// decideGate(id, 'denied') calls explicitly (gates.ts:38-43 vs :64-70) — so the
// "gated command the operator denies" test above and the timeout case are the
// same code path in runShell, not two branches where only one could be tested.
