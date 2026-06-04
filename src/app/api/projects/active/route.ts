import { cookies } from 'next/headers';
import { eq } from 'drizzle-orm';
import { db } from '@/db/client';
import { projects } from '@/db/schema';
import { SESSION_COOKIE, verifySession, cookieOptions } from '@/lib/auth';
import { ACTIVE_PROJECT_COOKIE } from '@/lib/projects';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(req: Request) {
  const jar = await cookies();
  const token = jar.get(SESSION_COOKIE)?.value;
  if (!token || !(await verifySession(token))) {
    return Response.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const body = (await req.json().catch(() => ({}))) as { projectId?: string };
  if (!body.projectId) return Response.json({ error: 'projectId is required' }, { status: 400 });

  const project = await db
    .select()
    .from(projects)
    .where(eq(projects.id, body.projectId))
    .limit(1)
    .then((r) => r[0]);
  if (!project) return Response.json({ error: 'Unknown project' }, { status: 400 });

  jar.set(ACTIVE_PROJECT_COOKIE, project.id, cookieOptions());
  return Response.json({ ok: true, projectId: project.id });
}
