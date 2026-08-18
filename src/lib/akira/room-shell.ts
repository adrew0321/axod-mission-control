// The room_bash dispatch/gate/log logic, kept pure and separate from
// room-tools.ts (which is 'server-only') so it can be exercised directly by
// node:test via tsx — 'server-only' throws on import outside the react-server
// resolve condition, and `pnpm test` doesn't set that condition. See
// shell-log.ts for why the audit log itself lives on the Mission Control side,
// and gates.ts for why a gated command awaits the operator inside the same turn.
import { sendCommand } from '@/lib/companion/registry';
import { openGate } from '@/lib/companion/gates';
import { appendShellLog } from './shell-log';
import { type AkiraToolContext, type ToolResult, ok, err } from './tool-actions';

// Longer than the room's own SHELL_TIMEOUT_MS (120s) so the room's kill-and-report
// wins the race and AKIRA gets output rather than a bare transport timeout.
export const SHELL_TIMEOUT_MS = 150_000;

function present(r: { status: string; text?: string; reason?: string }): ToolResult {
  if (r.status === 'error') return err(r.reason ?? 'the command failed to run');
  // A 'blocked' result that reaches here is NOT the operator gate (that path
  // never calls present() with the first, ungated result — see runShell
  // below). It is a plain refusal, e.g. a cwd outside the room and doorway.
  // Approval cannot clear it, so it must never read back as 'done'.
  if (r.status === 'blocked') {
    return ok(
      `That command was refused (${r.reason ?? 'blocked'}). Do not retry it — if it needs a cwd inside the room or doorway, adjust the path and try again.`,
    );
  }
  return ok(r.text ?? 'done');
}

export async function runShell(
  command: string,
  cwd: string | undefined,
  ctx: AkiraToolContext,
): Promise<ToolResult> {
  appendShellLog({ at: new Date(), event: 'dispatch', command, cwd });
  try {
    const first = await sendCommand({ action: 'shell', command, cwd }, SHELL_TIMEOUT_MS, 'room').result;
    // Key on the classifier's OWN flag, not on status === 'blocked' — a
    // refused cwd is also 'blocked' but approval cannot clear it, and it must
    // never be mistaken for an operator gate (see protocol.ts's `gated` doc).
    if (!first.gated) {
      appendShellLog({ at: new Date(), event: 'result', command, cwd, exitCode: first.exitCode, status: first.status });
      return present(first);
    }

    // Gated (Decision 7: a process that would outlive the command).
    const reason = first.reason ?? 'this would start something long-running';

    if (!ctx.watched) {
      // No operator-facing emit is attached to this turn — a doorway-triggered
      // turn (runRoomTurn in room-proposals-data.ts) runs headless, with
      // nobody at the HUD to see a gate card. Opening one anyway would park it
      // in the broker for the full GATE_TIMEOUT_MS (120s), stalling the single
      // serialized turn chain, and then auto-deny regardless. Fail fast
      // instead: deny now, and tell her to report back rather than retry.
      appendShellLog({
        at: new Date(),
        event: 'denied',
        command,
        cwd,
        reason: `${reason} (no operator watching this turn — gate skipped)`,
      });
      return ok(
        `That command would start something long-running (${reason}), and nobody is watching this turn right now to approve it. Do not retry it — report back what you were trying to do so the operator can approve it from the front door.`,
      );
    }

    // Park it, ask the operator through the HUD, and wait — do not retry, do
    // not work around it.
    appendShellLog({ at: new Date(), event: 'gated', command, cwd, reason });
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
    // sendCommand's promise REJECTS (rather than resolving to a status) when the
    // room companion is offline, disconnects mid-command, or our own transport
    // timeout elapses before the room's kill-and-report can fire. The room's
    // egress is open by design, so these are exactly the moments the audit log
    // is load-bearing — without a terminal line here, "still running", "silently
    // swallowed", and "the room went dark" are indistinguishable after the fact.
    const reason = e instanceof Error ? e.message : String(e);
    appendShellLog({ at: new Date(), event: 'result', command, cwd, status: 'error', reason });
    return err(reason);
  }
}
