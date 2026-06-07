import { cookies } from 'next/headers';
import { eq } from 'drizzle-orm';
import { db } from '@/db/client';
import { sessions } from '@/db/schema';
import { SESSION_COOKIE, verifySession, cookieOptions } from '@/lib/auth';
import { ACTIVE_PROJECT_COOKIE } from '@/lib/projects';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

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

  const now = new Date();
  await db
    .update(sessions)
    .set({ updated_at: now })
    .where(eq(sessions.id, sessionId));

  jar.set(ACTIVE_PROJECT_COOKIE, session.project_id, cookieOptions());
  
  return Response.json({ ok: true, sessionId, projectId: session.project_id });
}
