// Pure helpers for the Scheduler's health signal. No DB, no server-only —
// unit-testable under `tsx --test`.

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
