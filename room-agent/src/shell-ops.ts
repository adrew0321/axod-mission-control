// Executes `shell` commands inside the room. Two controls, both here:
//   1. classifyShell refuses anything that would outlive the command (Decision 7),
//      unless the operator already approved it.
//   2. Everything that runs gets a wall-clock timeout and its own process group,
//      so a timeout kills the whole tree rather than orphaning children on a box
//      that also hosts prod.
// A refused command returns status 'blocked' — the same shape guard.ts produces
// for the browser — never an exception.
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { StringDecoder } from 'node:string_decoder';
import { classifyShell } from './shell-gate';
import { validatePathReal } from './paths-real';
import type { Roots } from './paths';
import type { Command, Result } from './protocol';

export const SHELL_TIMEOUT_MS = 120_000;
export const MAX_OUTPUT_CHARS = 60_000;
/** POSIX 128 + SIGPIPE(13) — the exit code bash itself reports for a process
 * killed by a broken pipe. Used when WE close the output pipes to enforce
 * MAX_OUTPUT_CHARS and that closure is what kills an exec-optimised child. */
const SIGPIPE_EXIT_CODE = 141;

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
  if (command.includes('\0')) return { id: cmd.id, status: 'error', reason: 'null byte in command' };

  const gate = classifyShell(command);
  if (gate.gated && !cmd.approved) {
    // The ONLY 'blocked' cause an operator approval can clear. Every other
    // 'blocked' result below is a plain refusal — `gated` stays unset so
    // room-shell.ts never mistakes it for something the operator can approve.
    return { id: cmd.id, status: 'blocked', gated: true, reason: gate.reason ?? 'gated command' };
  }

  let cwd = roots.room;
  if (cmd.cwd) {
    const verdict = await validatePathReal(roots, cmd.cwd);
    if (!verdict.ok) return { id: cmd.id, status: 'blocked', reason: verdict.reason };
    cwd = verdict.abs;
  }

  return new Promise<Result>((resolve) => {
    let settled = false;
    let child: ChildProcessWithoutNullStreams;
    try {
      child = spawn('bash', ['-lc', command], { cwd, detached: true });
    } catch (e) {
      // A malformed input (this is defence in depth — 'command' is already
      // checked for null bytes above) or an environment failure must still
      // come back as a Result, never an exception: an uncaught throw here
      // would skip postResult entirely and leave the caller waiting forever.
      resolve({ id: cmd.id, status: 'error', exitCode: null, reason: e instanceof Error ? e.message : String(e) });
      return;
    }

    // Bounded collector: MAX_OUTPUT_CHARS is a memory bound, not just a display
    // bound. A naive "accumulate everything, cap it once at the end" tracks the
    // command's actual output in the agent's heap for the whole run — on a box
    // that also hosts prod, a `find /`, a runaway log dump, or `yes` grows that
    // heap for up to a full timeout window. Stop appending once the cap is hit.
    //
    // Two separate boundary risks live here, at two different layers, and each
    // needs its own guard: a StringDecoder per stream (stdout and stderr are
    // independent byte streams and must not share decode state) avoids
    // splitting a multi-byte UTF-8 sequence across chunk boundaries as bytes
    // arrive from the pipe — but it hands back a complete, valid JS string per
    // chunk, and slicing THAT string at an arbitrary code-unit offset (the cap
    // itself) can still cut a UTF-16 surrogate pair in half, leaving a lone
    // surrogate that re-encodes as U+FFFD. The decoder and the cap-slice guard
    // below cover different boundaries; neither substitutes for the other.
    const stdoutDecoder = new StringDecoder('utf8');
    const stderrDecoder = new StringDecoder('utf8');
    let out = '';
    let truncated = false;
    // Set the moment WE destroy the pipes for truncation (below), never for
    // any other reason. Fix round 3 (coordinator review, 2026-08-16): closing
    // the read ends can SIGPIPE the child — and when `bash -lc '<simple
    // command>'` exec-optimises (the child process IS the command, not bash
    // wrapping it), that SIGPIPE kills the leader itself, which `close`
    // reports as `code: null, signal: 'SIGPIPE'`. Without this flag that was
    // indistinguishable from an external kill and got reported as an error —
    // for a command that ran to completion and produced perfectly good
    // (truncated) output. This flag is what lets `close` tell "we did this on
    // purpose" apart from "something else killed it".
    let pipesClosedByUs = false;
    const append = (s: string) => {
      if (truncated || !s) return;
      if (out.length + s.length > MAX_OUTPUT_CHARS) {
        let cut = MAX_OUTPUT_CHARS - out.length;
        // Don't split a surrogate pair at the cut point: if the code unit just
        // before the cut is a high surrogate and the one at the cut is its low
        // surrogate, back off by one so the pair stays together on the same
        // side of the cut rather than leaving a lone, invalid surrogate.
        if (cut > 0 && cut < s.length) {
          const before = s.charCodeAt(cut - 1);
          const at = s.charCodeAt(cut);
          if (before >= 0xd800 && before <= 0xdbff && at >= 0xdc00 && at <= 0xdfff) {
            cut -= 1;
          }
        }
        out += s.slice(0, cut);
        truncated = true;
        pipesClosedByUs = true;
        // Stop the child from producing more output — and stop decoding what
        // it's already sent — the moment we've given up on capturing any more
        // of it. Destroying the read ends closes the pipe; most well-behaved
        // commands (head/tr/cat/etc.) die on the resulting broken pipe instead
        // of continuing to churn on data nobody's collecting.
        try { child.stdout.destroy(); } catch { /* already gone */ }
        try { child.stderr.destroy(); } catch { /* already gone */ }
      } else {
        out += s;
      }
    };
    // stdout and stderr are two separate pipes, concatenated as their chunks
    // arrive — the combined text does not preserve true chronological order
    // between the two streams (`echo one; echo two >&2; echo three` can read
    // back as one/three/two).
    const finalText = () => {
      if (!truncated) {
        append(stdoutDecoder.end());
        append(stderrDecoder.end());
      }
      return truncated ? `${out}\n\n… output truncated at ${MAX_OUTPUT_CHARS} characters.` : out;
    };

    const finish = (r: Result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      // Release every pipe and the process handle so a child we've given up on
      // can't keep the event loop alive or keep feeding `append` for a result
      // we've already returned. stdin is included even though we never write to
      // it — an untouched writable pipe is still an open handle that holds the
      // event loop open just as stdout/stderr would.
      try { child.stdin.destroy(); } catch { /* already gone */ }
      try { child.stdout.destroy(); } catch { /* already gone */ }
      try { child.stderr.destroy(); } catch { /* already gone */ }
      try { child.unref(); } catch { /* already gone */ }
      resolve(r);
    };

    const timer = setTimeout(() => {
      // Kill the whole process group: killing only the leader orphans its
      // children, e.g. what a compound `a && b` forks. Group kill is the
      // primary path. Track whether it actually worked — an unverified "it's
      // dead" claim to the operator is exactly the kind of silent failure this
      // whole mechanism exists to prevent.
      let killNote = '';
      try {
        if (child.pid) process.kill(-child.pid, 'SIGKILL');
      } catch {
        // Group kill failed (already gone, or this host doesn't support
        // negative-pid kill at all — e.g. Windows). Fall back to killing the
        // leader directly so it at least doesn't leak, even though any of its
        // own forked children may not be reachable this way. This is a
        // fallback, not a substitute: on the room's real target (Linux) the
        // group kill above is expected to succeed.
        try {
          child.kill('SIGKILL');
          killNote = ' (process group kill failed; only the leader was signalled)';
        } catch {
          killNote = ' (process group kill failed; leader signal also failed)';
        }
      }
      finish({
        id: cmd.id,
        status: 'error',
        exitCode: null,
        reason: `killed after ${timeoutMs}ms timeout${killNote}`,
        text: finalText(),
      });
    }, timeoutMs);

    child.stdout.on('data', (b: Buffer) => append(stdoutDecoder.write(b)));
    child.stderr.on('data', (b: Buffer) => append(stderrDecoder.write(b)));

    child.on('error', (e) => finish({
      id: cmd.id,
      status: 'error',
      exitCode: null,
      // Include cwd: a bare `spawn bash ENOENT` reads as "bash isn't
      // installed" even when the real cause is e.g. a cwd that vanished.
      reason: `${e.message} (cwd: ${cwd})`,
    }));

    child.on('close', (code, signal) => {
      if (code === null) {
        if (pipesClosedByUs && signal === 'SIGPIPE') {
          // We closed the read pipes ourselves once the output cap was hit
          // (see `append`), and the child died from the resulting broken
          // pipe. That is the direct, intended consequence of choosing to
          // stop reading — not a failure. It's the exact same event a
          // pipeline's downstream stage causes naturally when IT stops
          // reading; bash's own convention there is to report 128+signal
          // (141 for SIGPIPE) as the exit code, so mirror that convention
          // here for a consistent, truthful exit code between the pipeline
          // and non-pipeline (exec-optimised single-process) shapes of the
          // same truncation event, instead of a `null` that would misread as
          // "killed by our timeout" per this field's own doc comment.
          const body = finalText().trimEnd();
          finish({
            id: cmd.id,
            status: 'ok',
            exitCode: SIGPIPE_EXIT_CODE,
            text: `${body}${body ? '\n\n' : ''}(exit code ${SIGPIPE_EXIT_CODE})`,
          });
          return;
        }
        // Our own timeout kill already settled this promise before 'close' can
        // fire (the guard above makes this a no-op in that case), so a null
        // exit code reaching here means something else terminated the process
        // by signal — an external OOM-kill, a crash, or (if `pipesClosedByUs`
        // is set but the signal isn't SIGPIPE) an unrelated kill racing our
        // own pipe closure. That is not "ok".
        finish({
          id: cmd.id,
          status: 'error',
          exitCode: null,
          reason: `process terminated by signal ${signal ?? 'unknown'}`,
          text: finalText(),
        });
        return;
      }
      const body = finalText().trimEnd();
      finish({
        id: cmd.id,
        status: 'ok',
        exitCode: code,
        text: `${body}${body ? '\n\n' : ''}(exit code ${code})`,
      });
    });
  });
}
