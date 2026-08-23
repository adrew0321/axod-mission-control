// Pure cursor diff for the action feed, mirroring pickNewDreams in
// discord-notify-diff.ts. Kept separate from action-feed.ts because that module
// is 'server-only' and this one must be unit-testable.

/** The subset of an action row the feed needs. Structurally compatible with
 *  ActionRow from action-feed.ts, without importing that server-only module. */
export interface ActionLite {
  id: string;
  atMs: number;
  target: string;
  event: string;
  command: string;
  cwd: string | null;
  exitCode: number | null;
  status: string | null;
  reason: string | null;
}

/** Rows strictly newer than the cursor are new. next = the newest timestamp seen. */
export function pickNewActions(
  lastSeenMs: number | null,
  rows: ActionLite[],
): { newActions: ActionLite[]; next: number | null } {
  const newActions = rows.filter((a) => lastSeenMs == null || a.atMs > lastSeenMs);
  const maxMs = rows.reduce((m, a) => Math.max(m, a.atMs), lastSeenMs ?? -Infinity);
  const next = maxMs === -Infinity ? lastSeenMs : maxMs;
  return { newActions, next };
}
