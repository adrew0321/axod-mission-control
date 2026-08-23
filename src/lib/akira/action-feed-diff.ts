// This module is now type-only. `pickNewActions` and its cursor diff were removed
// when the feed moved to durable delivery state: action-feed.ts's
// readUnpostedActions / markActionPosted track what has been posted in the row's
// `posted_at` column, which survives a restart — a module-level cursor did not.
// `ActionLite` stays because discord-format.ts imports it for actionEmbed; its
// shape is exercised through that module's tests.

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
