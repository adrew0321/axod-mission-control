import { cookies } from 'next/headers';
import { eq } from 'drizzle-orm';
import { db } from '@/db/client';
import { sessions, projects } from '@/db/schema';
import { SESSION_COOKIE, verifySession } from '@/lib/auth';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  const jar = await cookies();
  const token = jar.get(SESSION_COOKIE)?.value;
  if (!token || !(await verifySession(token))) return Response.json({ error: 'Unauthorized' }, { status: 401 });

  const { id } = await ctx.params;
  const session = await db.select().from(sessions).where(eq(sessions.id, id)).limit(1).then((r) => r[0]);
  if (!session) return Response.json({ error: 'Session not found' }, { status: 404 });
  if (session.worktree_path) {
    return Response.json({ error: 'Resolve its proposal (merge or discard) first' }, { status: 409 });
  }

  await db.update(sessions).set({ archived_at: new Date() }).where(eq(sessions.id, id));

  if (session.project_id) {
    const project = await db.select().from(projects).where(eq(projects.id, session.project_id)).limit(1).then((r) => r[0]);
    if (project?.active_session_id === id) {
      await db.update(projects).set({ active_session_id: null }).where(eq(projects.id, project.id));
    }
  }
  return Response.json({ ok: true });
}
