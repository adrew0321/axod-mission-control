import { cookies } from 'next/headers';
import { eq } from 'drizzle-orm';
import { db } from '@/db/client';
import { sessions, projects } from '@/db/schema';
import { SESSION_COOKIE, verifySession } from '@/lib/auth';
import { mergeWorktree } from '@/lib/worktree';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(_req: Request, ctx: { params: Promise<{ sessionId: string }> }) {
  const jar = await cookies();
  const token = jar.get(SESSION_COOKIE)?.value;
  if (!token || !(await verifySession(token))) {
    return Response.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const { sessionId } = await ctx.params;
  const session = await db.select().from(sessions).where(eq(sessions.id, sessionId)).limit(1).then((r) => r[0]);
  if (!session || !session.worktree_path) {
    return Response.json({ error: 'No proposal for this session' }, { status: 404 });
  }
  const project = await db.select().from(projects).where(eq(projects.id, session.project_id)).limit(1).then((r) => r[0]);
  if (!project) return Response.json({ error: 'Project not found' }, { status: 404 });

  try {
    const result = await mergeWorktree(sessionId, project.repo_path, session.base_branch ?? project.default_branch ?? 'dev');
    if (!result.ok) return Response.json(result, { status: 200 }); // { ok:false, conflict, message }
    await db.update(sessions).set({ worktree_path: null }).where(eq(sessions.id, sessionId));
    return Response.json({ ok: true });
  } catch (e) {
    return Response.json(
      { error: `Merge failed: ${e instanceof Error ? e.message : String(e)}` },
      { status: 500 },
    );
  }
}
