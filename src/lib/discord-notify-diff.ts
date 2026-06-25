// Pure diff helpers for Discord notifications. No DB, no server-only, no live
// discord.js client — unit-testable under `tsx --test`. Each takes the prior
// cursor + current rows and returns BOTH the new items and the next cursor.
// Priming (ignoring the first tick's "new" items) is the loop's job, not these.

export type ScheduleRunRow = {
  id: string;
  projectId: string;
  title: string;
  lastRunAtMs: number | null;
  lastStatus: string | null;
};

export type DreamRowLite = {
  id: string;
  createdAtMs: number;
  status: string;
  insightCount: number;
};

/** A schedule whose last_run_at advanced past the cursor (or first-seen) is "new". */
export function diffScheduleRuns(
  prev: Map<string, number>,
  rows: ScheduleRunRow[],
): { newRuns: ScheduleRunRow[]; next: Map<string, number> } {
  const next = new Map<string, number>();
  const newRuns: ScheduleRunRow[] = [];
  for (const r of rows) {
    if (r.lastRunAtMs == null) continue; // never ran → ignore, keep out of cursor
    next.set(r.id, r.lastRunAtMs);
    const before = prev.get(r.id);
    if (before === undefined || before < r.lastRunAtMs) newRuns.push(r);
  }
  return { newRuns, next };
}

/** Dreams created strictly after the cursor are new. next = newest createdAtMs seen. */
export function pickNewDreams(
  lastSeenMs: number | null,
  rows: DreamRowLite[],
): { newDreams: DreamRowLite[]; next: number | null } {
  const newDreams = rows.filter((d) => lastSeenMs == null || d.createdAtMs > lastSeenMs);
  const maxMs = rows.reduce((m, d) => Math.max(m, d.createdAtMs), lastSeenMs ?? -Infinity);
  const next = maxMs === -Infinity ? lastSeenMs : maxMs;
  return { newDreams, next };
}

/** Proposals (by sessionId) present now but not before are new. next = current set. */
export function diffProposals(
  prev: Set<string>,
  curr: Set<string>,
): { newIds: string[]; next: Set<string> } {
  const newIds = [...curr].filter((id) => !prev.has(id));
  return { newIds, next: new Set(curr) };
}
