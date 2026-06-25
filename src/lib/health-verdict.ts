// Pure helpers for the Scheduler's health signal. No DB, no server-only —
// unit-testable under `tsx --test`.

import type { TurnResult } from './run-turn'; // type-only: erased at runtime, never loads the server-only module

/**
 * Read a machine-readable health verdict from an agent's report. Matches a
 * `HEALTH: PASS` / `HEALTH: FAIL` token (case-insensitive), tolerating backticks
 * or asterisks around it. When several appear, the LAST one wins — it is the
 * agent's final word. Returns null when no PASS/FAIL verdict is present.
 */
export function parseHealthVerdict(text: string): 'pass' | 'fail' | null {
  if (!text) return null;
  const re = /health:\s*[`*]*\s*(pass|fail)\b/gi;
  let last: 'pass' | 'fail' | null = null;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    last = m[1].toLowerCase() as 'pass' | 'fail';
  }
  return last;
}

/**
 * Map a turn's result + its final agent message to a Scheduler status.
 * A failed turn stays 'error' (infra) and a skipped turn 'skipped'; a completed
 * turn is 'fail' only when the agent emitted HEALTH: FAIL, otherwise 'ok'. So a
 * red build shows red while ordinary jobs (no verdict) stay 'ok'.
 */
export function healthStatus(
  result: TurnResult,
  finalMessage: string | null,
): 'ok' | 'fail' | 'skipped' | 'error' {
  if (result.status === 'skipped') return 'skipped';
  if (result.status === 'error') return 'error';
  return parseHealthVerdict(finalMessage ?? '') === 'fail' ? 'fail' : 'ok';
}
