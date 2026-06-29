import 'server-only';
import { and, eq, desc, sql } from 'drizzle-orm';
import { db } from '@/db/client';
import { messages } from '@/db/schema';
import { AKIRA_SESSION_ID } from './agent';

/**
 * Return AKIRA's most recent persisted message if it's younger than `ttlMs`,
 * else null. Lets the HUD reuse a recent brief on refresh instead of burning a
 * fresh turn — the "flag" is simply the timestamp of her last message.
 */
export async function getRecentBrief(ttlMs: number): Promise<string | null> {
  const last = await db
    .select({ content: messages.content, at: messages.created_at })
    .from(messages)
    .where(and(eq(messages.session_id, AKIRA_SESSION_ID), eq(messages.role, 'agent')))
    .orderBy(desc(messages.created_at), desc(sql`rowid`))
    .limit(1)
    .then((r) => r[0]);
  if (!last) return null;
  if (Date.now() - last.at.getTime() > ttlMs) return null;
  return last.content;
}
