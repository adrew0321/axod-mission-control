// The shell dispatch/gate/log logic, kept pure and separate from agent-tools.ts
// (which is 'server-only') so it can be exercised directly by node:test via
// tsx — 'server-only' throws on import outside the react-server resolve
// condition, and `pnpm test` doesn't set that condition. See action-log.ts for
// why the audit log itself lives on the Mission Control side, and gates.ts for
// why a gated command awaits the operator inside the same turn.
//
// Target-parameterised for sub-project C (host reach): the room keeps its
// operator gate exactly as it always has; the host (the Mini itself, as root)
// never gates — the operator gets awareness via the audit log, not a veto
// (spec D2) — and a command that would restart Mission Control itself is
// dispatched fire-and-forget rather than awaited (spec D5), since the turn
// that issued it will not survive to see the result.
import { sendCommand, isOnline } from '@/lib/companion/registry';
import type { CompanionTarget } from '@/lib/companion/registry';
import { openGate } from '@/lib/companion/gates';
import { appendActionLog } from './action-log';
import { isSelfAffecting } from './self-affecting';
import { type AkiraToolContext, type ToolResult, ok, err } from './tool-actions';

// Longer than the companion's own SHELL_TIMEOUT_MS (120s) so its kill-and-report
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
  target: CompanionTarget,
  ctx: AkiraToolContext,
): Promise<ToolResult> {
  // Spec D5: a command that takes Mission Control down ends this turn — no
  // result will ever arrive to log or to report. The online check comes
  // BEFORE the log write: if the host agent is offline, sendCommand would
  // reject immediately and a swallowed rejection plus an 'intent' line already
  // in the log would tell the operator a restart happened when nothing ran.
  if (target === 'host' && isSelfAffecting(command)) {
    if (!isOnline(target)) {
      return err(`Your host agent is offline, so I did not run: ${command}`);
    }
    appendActionLog({ at: new Date(), target, event: 'intent', command, cwd });
    void sendCommand({ action: 'shell', command, cwd }, SHELL_TIMEOUT_MS, target).result.catch(
      () => { /* the server is going down; nobody is left to receive this */ },
    );
    return ok(
      `Started: ${command}\n\nThis restarts Mission Control, which ends this turn — I will not see the result. Check back in a moment.`,
    );
  }

  appendActionLog({ at: new Date(), target, event: 'dispatch', command, cwd });
  try {
    const first = await sendCommand({ action: 'shell', command, cwd }, SHELL_TIMEOUT_MS, target).result;
    // Key on the classifier's OWN flag, not on status === 'blocked' — a
    // refused cwd is also 'blocked' but approval cannot clear it, and it must
    // never be mistaken for an operator gate (see protocol.ts's `gated` doc).
    // The host never gates (spec D2): a `gated` flag arriving from a host
    // agent is ignored rather than honoured, so only 'room' ever falls
    // through to the gate branch below.
    if (!first.gated || target !== 'room') {
      appendActionLog({ at: new Date(), target, event: 'result', command, cwd, exitCode: first.exitCode, status: first.status });
      return present(first);
    }

    // Gated (Decision 7: a process that would outlive the command). Room only.
    const reason = first.reason ?? 'this would start something long-running';

    if (!ctx.watched) {
      // No operator-facing emit is attached to this turn — a doorway-triggered
      // turn (runRoomTurn in room-proposals-data.ts) runs headless, with
      // nobody at the HUD to see a gate card. Opening one anyway would park it
      // in the broker for the full GATE_TIMEOUT_MS (120s), stalling the single
      // serialized turn chain, and then auto-deny regardless. Fail fast
      // instead: deny now, and tell her to report back rather than retry.
      appendActionLog({
        at: new Date(),
        target,
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
    appendActionLog({ at: new Date(), target, event: 'gated', command, cwd, reason });
    const { id, decision } = openGate({ target, reason, command });
    ctx.emit({ type: 'hard_gate', gateId: id, ref: '', reason, command });

    const decided = await decision;
    appendActionLog({ at: new Date(), target, event: decided === 'approved' ? 'approved' : 'denied', command, cwd });
    if (decided === 'denied') {
      return ok(
        `The operator did not approve that command (${reason}). Do not retry it and do not work around it — tell him what you were trying to do and ask how he'd like to proceed.`,
      );
    }

    const second = await sendCommand(
      { action: 'shell', command, cwd, approved: true },
      SHELL_TIMEOUT_MS,
      target,
    ).result;
    appendActionLog({ at: new Date(), target, event: 'result', command, cwd, exitCode: second.exitCode, status: second.status });
    return present(second);
  } catch (e) {
    // sendCommand's promise REJECTS (rather than resolving to a status) when the
    // companion is offline, disconnects mid-command, or our own transport
    // timeout elapses before its kill-and-report can fire. The room's egress
    // is open by design, so these are exactly the moments the audit log is
    // load-bearing — without a terminal line here, "still running", "silently
    // swallowed", and "the room went dark" are indistinguishable after the fact.
    const reason = e instanceof Error ? e.message : String(e);
    appendActionLog({ at: new Date(), target, event: 'result', command, cwd, status: 'error', reason });
    return err(reason);
  }
}
