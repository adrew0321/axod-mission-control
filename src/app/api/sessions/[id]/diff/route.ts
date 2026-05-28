import { cookies } from 'next/headers';
import { eq } from 'drizzle-orm';
import { db } from '@/db/client';
import { projects, sessions } from '@/db/schema';
import { SESSION_COOKIE, verifySession } from '@/lib/auth';
import { diffWorktree } from '@/lib/worktree';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

// Returns the live git diff of the session's worktree against the project's
// base branch — i.e. everything the dispatched agent changed this session. The
// operator reviews this before merge (v1 safety model: no inline approval gate).
export async function GET(_req: Request, ctx: { params: Promise<{ id: string }> }) {
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

  if (!session.worktree_path) {
    return Response.json({ base: null, files: [], diff: '' });
  }

  const project = session.project_id
    ? await db
        .select()
        .from(projects)
        .where(eq(projects.id, session.project_id))
        .limit(1)
        .then((r) => r[0])
    : undefined;
  const base = project?.default_branch ?? 'dev';

  try {
    const { diff, files } = await diffWorktree(session.worktree_path, base);
    return Response.json({ base, files, diff });
  } catch (err) {
    return Response.json(
      { error: err instanceof Error ? err.message : String(err) },
      { status: 500 },
    );
  }
}
