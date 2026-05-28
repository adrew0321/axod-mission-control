import { cookies } from 'next/headers';
import { eq } from 'drizzle-orm';
import { db } from '@/db/client';
import { sessions } from '@/db/schema';
import { SESSION_COOKIE, verifySession } from '@/lib/auth';
import { buildWorktree, ensurePreviewServer, stopPreviewServer } from '@/lib/preview';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
// astro build runs ~15-20s; give the handler room.
export const maxDuration = 300;

// Build the session worktree's static site and serve it from an in-process
// static server, returning the preview URL for the iframe. action 'stop' tears
// the server down. v1: local-only (loopback); remote access is a week-5 item.
export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
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
    return Response.json({ ok: false, error: 'Session has no worktree yet.' }, { status: 400 });
  }

  const body = (await req.json().catch(() => ({}))) as { action?: 'build' | 'stop' };
  const action = body.action ?? 'build';

  if (action === 'stop') {
    await stopPreviewServer(sessionId);
    return Response.json({ ok: true, stopped: true });
  }

  const build = await buildWorktree(session.worktree_path);
  if (!build.ok) {
    return Response.json({ ok: false, log: build.log }, { status: 200 });
  }

  try {
    const { url } = await ensurePreviewServer(sessionId, session.worktree_path);
    return Response.json({ ok: true, url, log: build.log });
  } catch (err) {
    return Response.json(
      { ok: false, log: build.log, error: err instanceof Error ? err.message : String(err) },
      { status: 200 },
    );
  }
}
