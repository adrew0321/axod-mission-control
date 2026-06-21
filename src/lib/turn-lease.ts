// Pure helpers for the server turn runner: the concurrency-lease staleness rule
// and the turn-input decision. No DB, no server-only — unit-testable.

/** Extra grace beyond a turn's max duration before its lease is reclaimable. */
export const LEASE_GRACE_MS = 60_000;

/**
 * Is a live turn currently holding the session lease? A null lease is free; a
 * lease older than (maxDurationMs + grace) is stale (a crashed turn) and
 * reclaimable, so it is NOT considered held.
 */
export function isLeaseHeld(
  runningSince: Date | null,
  nowMs: number,
  maxDurationMs: number,
): boolean {
  if (!runningSince) return false;
  return runningSince.getTime() >= nowMs - (maxDurationMs + LEASE_GRACE_MS);
}

export type TurnInput =
  | { kind: "instruction"; content: string }
  | { kind: "reply" }
  | { kind: "none" };

/**
 * Decide what this turn responds to: a self-initiated instruction (wins), else
 * the session's pending last user message, else nothing.
 */
export function resolveTurnInput(
  instruction: string | undefined,
  hasPendingUserMessage: boolean,
): TurnInput {
  const trimmed = instruction?.trim();
  if (trimmed) return { kind: "instruction", content: trimmed };
  if (hasPendingUserMessage) return { kind: "reply" };
  return { kind: "none" };
}
