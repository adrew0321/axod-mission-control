import 'server-only';
import { eq } from 'drizzle-orm';
import { db } from '@/db/client';
import { artifacts } from '@/db/schema';
import type { PlanSnapshot } from '@/lib/plan-events';

// One persisted plan per session, stored as a single artifacts row whose id is
// derived from the session id so writes are an upsert (latest writer wins).
function planRowId(sessionId: string): string {
  return `plan_${sessionId}`;
}

/**
 * Persist the latest plan snapshot for a session. Upserts a single
 * `type='plan'` artifacts row (id `plan_${sessionId}`) so each new snapshot
 * overwrites the previous one rather than appending history.
 */
export async function savePlanSnapshot(sessionId: string, snapshot: PlanSnapshot): Promise<void> {
  const id = planRowId(sessionId);
  const content = JSON.stringify(snapshot);
  const now = new Date();
  await db
    .insert(artifacts)
    .values({
      id,
      session_id: sessionId,
      agent_id: snapshot.agentId,
      type: 'plan',
      content,
      created_at: now,
    })
    .onConflictDoUpdate({
      // session_id is fixed by the PK-derived id; only the snapshot fields change.
      target: artifacts.id,
      set: { agent_id: snapshot.agentId, content, created_at: now },
    });
}

/** Return the persisted plan snapshot for a session, or null if none/unparseable. */
export async function getLatestPlanForSession(sessionId: string): Promise<PlanSnapshot | null> {
  const row = await db
    .select()
    .from(artifacts)
    .where(eq(artifacts.id, planRowId(sessionId)))
    .limit(1)
    .then((r) => r[0]);
  if (!row?.content) return null;
  try {
    return JSON.parse(row.content) as PlanSnapshot;
  } catch {
    return null;
  }
}
