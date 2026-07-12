// Pure fleet-snapshot core — types, the empty default, the contributor contract,
// and the isolation-merging runner. No db, no server-only, so the tsx test runner
// can import it. The live DB-backed contributors live in ./fleet-contributors.

export interface FleetSnapshot {
  generatedAt: string;
  projects: { id: string; name: string; activeSessionId: string | null; lastTurnAt: string | null }[];
  running: { projectId: string; projectName: string; sessionId: string }[];
  proposals: { projectId: string; projectName: string; sessionId: string; summary: string; ageMinutes: number }[];
  health: { verdict: 'pass' | 'fail' | 'unknown'; at: string | null };
  insights: { title: string; detail: string; ageMinutes: number }[];
  schedules: { projectId: string; title: string; nextRunAt: string | null }[];
  soulProposal: { reason: string } | null;
  errors: string[];
}

export type SnapshotContributor = { key: string; collect: () => Promise<Partial<FleetSnapshot>> };

export function emptySnapshot(): FleetSnapshot {
  return {
    generatedAt: new Date().toISOString(),
    projects: [],
    running: [],
    proposals: [],
    health: { verdict: 'unknown', at: null },
    insights: [],
    schedules: [],
    soulProposal: null,
    errors: [],
  };
}

/**
 * Build the fleet snapshot from a set of contributors. Each runs in its own
 * try/catch: a throwing subsystem degrades only its slice and records its key in
 * `errors`, never blanking the whole snapshot (cf. the v1.8.3 fault-isolation
 * lesson). Pass real contributors in production; fakes in tests.
 */
export async function getFleetSnapshot(contributors: SnapshotContributor[]): Promise<FleetSnapshot> {
  const snap = emptySnapshot();
  for (const c of contributors) {
    try {
      Object.assign(snap, await c.collect());
    } catch (err) {
      snap.errors.push(c.key);
      console.warn(`[fleet-snapshot] contributor ${c.key} failed: ${err instanceof Error ? err.message : err}`);
    }
  }
  return snap;
}
