import { cookies } from 'next/headers';
import { eq } from 'drizzle-orm';
import { db } from '@/db/client';
import { sessions } from '@/db/schema';
import { SESSION_COOKIE, verifySession } from '@/lib/auth';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

// Clear the session log: set `cleared_at = now`. The conversation view and Sage's
// memory transcript both filter to messages created after this — a fresh start.
// Messages stay in the DB (archived, not deleted); there is no un-clear.
export async function POST(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  const jar = await cookies();
  const token = jar.get(SESSION_COOKIE)?.value;
  if (!token || !(await verifySession(token))) {
    return Response.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const { id: sessionId } = await ctx.params;
  const session = await db
    .select()
    .from(sessions)
    .where(eq(sessions.id, sessionId))
    .limit(1)
    .then((r) => r[0]);
  if (!session) return Response.json({ error: 'Session not found' }, { status: 404 });

  await db.update(sessions).set({ cleared_at: new Date() }).where(eq(sessions.id, sessionId));
  return Response.json({ ok: true });
}
