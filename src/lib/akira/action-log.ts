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
