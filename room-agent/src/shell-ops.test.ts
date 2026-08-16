import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
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

// The room is Linux; this test file is authored on a Windows laptop. Rather than
// assume from process.platform (which would blanket-skip everything here, even
// though `bash -lc` genuinely works on this host via Git Bash), probe the real
// capability: can we spawn bash and get an exit code back at all?
function canSpawnBash(): boolean {
  try {
    // Generous timeout: `bash -lc` (a login shell) reads profile/rc files, and
    // under load from the rest of the suite (the worktree tests just ahead of
    // this file spawn plenty of their own git/node processes) that startup has
    // been observed to take several seconds. A probe that times out too eagerly
    // would report "unavailable" for a shell that actually works, just slowly —
    // exactly the false-skip this capability probe exists to avoid.
    const r = spawnSync('bash', ['-lc', 'exit 0'], { timeout: 15_000 });
    return r.error === undefined && r.status === 0;
  } catch {
    return false;
  }
}

const skip = canSpawnBash() ? false : 'bash -lc is not available on this host';

// Separately: can this host actually kill a process GROUP via `process.kill(-pid,
// ...)`? On Linux (the room) it can. On this Windows dev laptop it cannot — Node's
// negative-pid kill throws ESRCH unconditionally, confirmed by direct probe (a
// live, freshly spawned process still reports ESRCH). Gate the "did the OS-level
// process actually die" test on this specific capability, separately from plain
// bash spawning, so a false-green never hides a broken kill.
function canKillProcessGroup(): boolean {
  let child;
  try {
    child = spawn('bash', ['-lc', 'sleep 2'], { detached: true, stdio: 'ignore' });
  } catch {
    return false;
  }
  const pid = child.pid;
  if (!pid) return false;
  let supported: boolean;
  try {
    process.kill(-pid, 0); // signal 0: existence probe only, does not actually kill
    supported = true;
  } catch {
    supported = false;
  }
  // Clean up the probe child either way so it doesn't outlive this module load.
  try { process.kill(-pid, 'SIGKILL'); } catch { /* group kill unsupported or already gone */ }
  try { child.kill('SIGKILL'); } catch { /* already gone */ }
  child.unref();
  return supported;
}

const groupKillSkip = skip
  || (canKillProcessGroup()
    ? false
    : 'process.kill(-pid) does not actually terminate a process group on this host — cannot verify the child was really killed, only that execShell reports a timeout');

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
  // Deviation from the brief: the brief's version ran `pwd` and asserted the
  // output contains `rts.room`. On this host, Git Bash's `pwd` reports the
  // MSYS-translated form of the cwd (e.g. `/tmp/...`), not the Windows path
  // string we pass — a translation-layer artifact, not evidence about whether
  // `cwd` actually propagated. A filesystem marker proves the same thing
  // (the command ran where we said) without depending on how a given shell
  // renders paths, and it holds identically on the room's real target (Linux).
  const rts = await roots();
  await writeFile(join(rts.room, 'marker.txt'), 'here');
  const r = await execShell(rts, cmd({ command: 'ls' }));
  assert.match(r.text ?? '', /marker\.txt/, 'the default cwd is the room root');
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
  // The gate is the operator's, not a permanent ban. Deliberately a SHORT sleep
  // (not the brief's `sleep 120`): on this host the timeout fallback can only
  // kill the immediate bash leader (see the kill-fallback note in shell-ops.ts),
  // not a forked grandchild, so a long sleep here would leak a real OS process
  // for the rest of its duration after the test file exits. A short one self-
  // reaps within seconds even in the worst case, while still proving the point:
  // approval lets a gated command reach the spawn at all.
  const r = await execShell(await roots(), cmd({ command: 'sleep 2 && echo never', approved: true }), 300);
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

// Split from the brief's single timeout test, which asserted `status: 'error'`
// AND that the process was actually killed in one breath. `execShell` wraps the
// group kill in try/catch and returns the timeout result regardless of whether
// the kill itself worked, so that single test would go green here even though
// the kill throws ESRCH on this host — a passing test that verifies nothing about
// the safety property it's named for. Two tests instead: the result shape (real,
// runs everywhere bash does), and the actual-death check (gated on whether this
// host can genuinely kill a process group).

test('a command that overruns the timeout is reported as a killed error, not a transport failure', { skip }, async () => {
  const r = await execShell(await roots(), cmd({ command: 'sleep 5', approved: true }), 200);
  assert.equal(r.status, 'error');
  assert.equal(r.exitCode, null);
  assert.match(r.reason ?? '', /timeout|killed/i);
});

test('a timed-out command is genuinely dead at the OS level, not merely reported dead', { skip: groupKillSkip }, async () => {
  const rts = await roots();
  // `echo $$` reports the spawned leader's own pid; it's captured in `out` well
  // before the 250ms timeout fires, so it survives into the killed result's text.
  const r = await execShell(rts, cmd({ command: 'echo $$; sleep 5' }), 250);
  assert.equal(r.status, 'error');
  const pid = Number((r.text ?? '').trim().split(/\s+/)[0]);
  assert.ok(Number.isInteger(pid) && pid > 0, `expected the leader's pid in captured output, got: ${r.text}`);
  // Give the OS a brief moment to finish reaping after the group kill.
  await new Promise((resolve) => setTimeout(resolve, 150));
  assert.throws(
    () => process.kill(pid, 0),
    /ESRCH/,
    'the process must actually be gone after a timeout kill, not just reported as gone',
  );
});

test('output is truncated rather than returned unbounded', { skip }, async () => {
  const r = await execShell(await roots(), cmd({ command: 'head -c 200000 /dev/zero | tr "\\0" "x"' }));
  assert.ok((r.text ?? '').length < 70_000, 'output must be capped');
  assert.match(r.text ?? '', /truncated/i);
});
