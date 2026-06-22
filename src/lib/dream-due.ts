// Pure nightly gate for the Dreaming ticker. No DB, no server-only — unit-testable.

const TWELVE_HOURS_MS = 12 * 3_600_000;

/**
 * True when it's time for a nightly dream: the local hour is at/after `hour`
 * AND the last dream is either absent or older than 12h. The 12h floor stops
 * re-firing across the same night and absorbs a downtime catch-up to one run.
 */
export function isDreamDue(lastDreamAt: Date | null, now: Date, hour: number): boolean {
  if (now.getHours() < hour) return false;
  if (!lastDreamAt) return true;
  return now.getTime() - lastDreamAt.getTime() > TWELVE_HOURS_MS;
}
