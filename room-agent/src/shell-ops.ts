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
      // Kill the whole process group: killing only the leader orphans its children,
      // e.g. what a compound `a && b` forks. Group kill is the primary path.
      try {
        if (child.pid) process.kill(-child.pid, 'SIGKILL');
      } catch {
        // Group kill failed (already gone, or this host doesn't support negative-pid
        // kill at all — e.g. Windows). Fall back to killing the leader directly so it
        // at least doesn't leak, even though any of its own forked children may not
        // be reachable this way. This is a fallback, not a substitute: on the room's
        // real target (Linux) the group kill above is expected to succeed.
        try {
          child.kill('SIGKILL');
        } catch {
          /* already gone */
        }
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
