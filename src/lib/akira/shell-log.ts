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
  /** The process outcome ('ok' / 'error') on a 'result' event. Never repurposed
   *  to carry the gate's reason text — see `reason` for that. */
  status?: string;
  /** Human-readable "why": the gate's reason on a 'gated' event, or the failure
   *  detail on an error 'result' (including a transport rejection). Kept separate
   *  from `status` so a field means the same thing on every line, not just within
   *  one event type. */
  reason?: string;
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
  if (e.reason !== undefined) row.reason = e.reason;
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
