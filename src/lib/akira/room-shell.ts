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
    if (first.status !== 'blocked') {
      appendShellLog({ at: new Date(), event: 'result', command, cwd, exitCode: first.exitCode, status: first.status });
      return present(first);
    }

    // Gated (Decision 7: a process that would outlive the command). Park it, ask
    // the operator through the HUD, and wait — do not retry, do not work around it.
    const reason = first.reason ?? 'this would start something long-running';
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
