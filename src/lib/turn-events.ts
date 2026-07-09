/**
 * A turn's SSE event stream carries both mid-turn errors and end-of-turn markers.
 * `error` is NOT always terminal: `agent-runner-sdk` emits a non-fatal
 * `{ type: 'error', fatal: false }` mid-stream for recoverable conditions
 * (auth_failed / rate_limit / billing_error / model_not_found) WITHOUT ending
 * the turn. Only `persisted`, `skipped`, and a `fatal: true` error mean the turn
 * is over and a subscriber should close its stream.
 *
 * Pure + dependency-free so it can back both the server route (`closeOn`) and be
 * unit-tested under `tsx --test`.
 */
export interface TurnEvent {
  type: string;
  [k: string]: unknown;
}

export function isTerminalTurnEvent(e: TurnEvent): boolean {
  if (e.type === "persisted" || e.type === "skipped") return true;
  // An error only ends the turn when explicitly fatal. A missing flag is a legacy
  // event; treat it as non-terminal so a recoverable error can't detach the client.
  if (e.type === "error") return e.fatal === true;
  return false;
}
