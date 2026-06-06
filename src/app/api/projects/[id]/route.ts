import { cookies } from 'next/headers';
import { eq, inArray } from 'drizzle-orm';
import { db } from '@/db/client';
import { projects, sessions, messages, approvals, artifacts, tool_permissions } from '@/db/schema';
import { SESSION_COOKIE, verifySession, cookieOptions } from '@/lib/auth';
import { ACTIVE_PROJECT_COOKIE } from '@/lib/projects';
import { nextActiveProjectId } from '@/lib/ui-helpers';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function DELETE(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  const jar = await cookies();
  const token = jar.get(SESSION_COOKIE)?.value;
  if (!token || !(await verifySession(token))) {
    return Response.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const { id } = await ctx.params;

  const all = await db.select({ id: projects.id }).from(projects);
  if (all.length <= 1) {
    return Response.json({ error: 'Cannot remove the only project.' }, { status: 400 });
  }
  if (!all.some((p) => p.id === id)) {
    return Response.json({ error: 'Project not found' }, { status: 404 });
  }

  try {
    // FK-safe manual cascade (no ON DELETE CASCADE in the schema).
    const sess = await db.select({ id: sessions.id }).from(sessions).where(eq(sessions.project_id, id));
    const sessionIds = sess.map((s) => s.id);
    if (sessionIds.length) {
      await db.delete(messages).where(inArray(messages.session_id, sessionIds));
      await db.delete(approvals).where(inArray(approvals.session_id, sessionIds));
      await db.delete(artifacts).where(inArray(artifacts.session_id, sessionIds));
      await db.delete(sessions).where(inArray(sessions.id, sessionIds));
    }
    await db.delete(tool_permissions).where(eq(tool_permissions.project_id, id));
    await db.delete(projects).where(eq(projects.id, id));
  } catch (e) {
    return Response.json(
      { error: `Could not remove project: ${e instanceof Error ? e.message : String(e)}` },
      { status: 500 },
    );
  }

  // Repoint the active-project cookie if it pointed at the removed project.
  const cookieId = jar.get(ACTIVE_PROJECT_COOKIE)?.value;
  const next = nextActiveProjectId(all, id, cookieId);
  if (cookieId === id && next) {
    jar.set(ACTIVE_PROJECT_COOKIE, next, cookieOptions());
  }

  return Response.json({ ok: true });
}
