import 'server-only';
import { asc, desc, gt } from 'drizzle-orm';
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

let started = false;

/** Register the DB sink. Idempotent — safe to call more than once at boot. */
export function startActionFeed(): void {
  if (started) return;
  started = true;
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

/** The newest action timestamp, for priming. null when the table is empty. */
export async function readLatestActionAt(): Promise<number | null> {
  const row = await db
    .select({ at: agent_actions.at })
    .from(agent_actions)
    .orderBy(desc(agent_actions.at))
    .limit(1)
    .then((r) => r[0]);
  return row ? row.at.getTime() : null;
}

/** Actions strictly newer than `sinceMs`, OLDEST first, capped at `limit`.
 *  Querying forward from the cursor (rather than backward from "now") means a
 *  burst larger than `limit` drains across successive ticks instead of being
 *  truncated away by a newest-first window — a newest-first read would let a
 *  large-enough burst push older, still-unposted rows permanently out of the
 *  window before they're ever fetched. `sinceMs === null` means "never primed"
 *  (see readLatestActionAt / the caller's prime step), so it reads from the
 *  oldest row on hand rather than filtering on a cursor that doesn't exist yet. */
export async function readActionsSince(sinceMs: number | null, limit = 50): Promise<ActionRow[]> {
  const rows = await (sinceMs === null
    ? db.select().from(agent_actions).orderBy(asc(agent_actions.at)).limit(limit)
    : db
        .select()
        .from(agent_actions)
        .where(gt(agent_actions.at, new Date(sinceMs)))
        .orderBy(asc(agent_actions.at))
        .limit(limit));
  return rows.map((r) => ({
    id: r.id,
    atMs: r.at.getTime(),
    target: r.target,
    event: r.event,
    command: r.command,
    cwd: r.cwd,
    exitCode: r.exit_code,
    status: r.status,
    reason: r.reason,
  }));
}
