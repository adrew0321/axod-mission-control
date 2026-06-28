import { cookies } from 'next/headers';
import { eq } from 'drizzle-orm';
import { db } from '@/db/client';
import { projects } from '@/db/schema';
import { SESSION_COOKIE, verifySession } from '@/lib/auth';
import { listBranches } from '@/lib/worktree';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  const jar = await cookies();
  const token = jar.get(SESSION_COOKIE)?.value;
  if (!token || !(await verifySession(token))) {
    return Response.json({ error: 'Unauthorized' }, { status: 401 });
  }
  const { id } = await ctx.params;
  const project = await db.select().from(projects).where(eq(projects.id, id)).limit(1).then((r) => r[0]);
  if (!project) return Response.json({ error: 'Project not found' }, { status: 404 });
  const def = project.default_branch ?? 'dev';
  const branches = await listBranches(project.repo_path, def);
  return Response.json({ branches, default: def });
}
