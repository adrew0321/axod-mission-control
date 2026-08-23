import 'server-only';
import { asc, isNull, eq } from 'drizzle-orm';
import { randomBytes } from 'node:crypto';
import { db } from '@/db/client';
import { agent_actions } from '@/db/schema';
import { registerActionSink, type ActionLogEvent } from './action-log';

/**
 * The DB half of the action log. The file log (action-log.ts) is the durable,
 * synchronous record; this table exists so the Discord poller has something with
 * a cursor to diff, the same shape schedules/dreams/proposals already use.
 *
 * There is NO output column here and must never be one — spec D7.
 */

export interface ActionRow {
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

/** Events that end an action. `dispatch` is excluded: it precedes every command,
 *  so persisting it would post each action to the feed twice. `intent` is
 *  included because per D5 no result follows a Mission Control restart. */
const TERMINAL_EVENTS = new Set(['result', 'intent', 'denied']);

// Survive Next dev HMR / a distinct instrumentation module graph: keep the
// "have I registered my sink yet" bit on globalThis, matching preview.ts's
// idiom, so a second module instance of this file doesn't register a second
// sink (double-posted actions) — or, if action-log.ts's sinks array is ever
// backed the same way while this flag is not, silently register nowhere.
const state: { started: boolean } =
  (globalThis as { __mcActionFeedState?: { started: boolean } }).__mcActionFeedState ??
  ((globalThis as { __mcActionFeedState?: { started: boolean } }).__mcActionFeedState = { started: false });

/** Register the DB sink. Idempotent — safe to call more than once at boot. */
export function startActionFeed(): void {
  if (state.started) return;
  state.started = true;
  registerActionSink((e: ActionLogEvent) => {
    if (!TERMINAL_EVENTS.has(e.event)) return;
    // Fire-and-forget: a feed insert must never delay or break a turn. The file
    // log has already recorded this event synchronously.
    void db
      .insert(agent_actions)
      .values({
        id: `act_${randomBytes(6).toString('hex')}`,
        at: e.at,
        target: e.target,
        event: e.event,
        command: e.command,
        cwd: e.cwd ?? null,
        exit_code: e.exitCode ?? null,
        status: e.status ?? null,
        reason: e.reason ?? null,
      })
      .catch((err: unknown) => {
        console.warn('[action-feed] insert failed:', err instanceof Error ? err.message : err);
      });
  });
  console.log('[action-feed] started');
}

/** Actions not yet delivered to the feed, OLDEST first. Delivery state lives in
 *  the row, not in a module variable, so a restart resumes exactly where it
 *  stopped instead of skipping whatever was queued (spec D2). */
export async function readUnpostedActions(limit = 50): Promise<ActionRow[]> {
  const rows = await db.select().from(agent_actions)
    .where(isNull(agent_actions.posted_at))
    .orderBy(asc(agent_actions.at))
    .limit(limit);
  return rows.map((r) => ({
    id: r.id, atMs: r.at.getTime(), target: r.target, event: r.event, command: r.command,
    cwd: r.cwd, exitCode: r.exit_code, status: r.status, reason: r.reason,
  }));
}

/** Mark one action delivered. Best-effort: a failure here re-posts next tick,
 *  which is the right direction under D2 (a duplicate is visible, a drop is not). */
export async function markActionPosted(id: string): Promise<void> {
  await db.update(agent_actions).set({ posted_at: new Date() }).where(eq(agent_actions.id, id));
}
