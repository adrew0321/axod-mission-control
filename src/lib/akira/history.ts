import 'server-only';
import { eq, desc, sql } from 'drizzle-orm';
import { db } from '@/db/client';
import { messages } from '@/db/schema';
import { AKIRA_SESSION_ID } from './agent';
import { toTurns, type Turn } from './turns';

export type { Turn } from './turns';

/**
 * Load the last `limit` turns of AKIRA's thread for the front door. Returns the
 * turns (oldest-first) and whether the newest turn is a fresh (within `ttlMs`)
 * AKIRA reply — so the caller can reuse it instead of running a fresh brief.
 */
export async function getRecentTurns(
  limit: number,
  ttlMs: number,
): Promise<{ turns: Turn[]; freshBrief: boolean }> {
  const rows = await db
    .select({ role: messages.role, content: messages.content, created_at: messages.created_at })
    .from(messages)
    .where(eq(messages.session_id, AKIRA_SESSION_ID))
    .orderBy(desc(messages.created_at), desc(sql`rowid`))
    .limit(limit);
  const turns = toTurns(rows);
  const newest = turns[turns.length - 1];
  const freshBrief = !!newest && newest.role === 'akira' && Date.now() - newest.at <= ttlMs;
  return { turns, freshBrief };
}
