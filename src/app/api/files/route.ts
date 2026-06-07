import { readdir } from 'node:fs/promises';
import { cookies } from 'next/headers';
import { eq } from 'drizzle-orm';
import { db } from '@/db/client';
import { projects } from '@/db/schema';
import { SESSION_COOKIE, verifySession } from '@/lib/auth';
import { resolveWithinRoot } from '@/lib/safe-path';
import { EXCLUDED_DIRS } from '@/lib/file-tree';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(req: Request) {
  const jar = await cookies();
  const token = jar.get(SESSION_COOKIE)?.value;
  if (!token || !(await verifySession(token))) {
    return Response.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const url = new URL(req.url);
  const projectId = url.searchParams.get('projectId');
  const dir = url.searchParams.get('dir') ?? '';
  if (!projectId) return Response.json({ error: 'projectId is required' }, { status: 400 });

  const project = await db
    .select()
    .from(projects)
    .where(eq(projects.id, projectId))
    .limit(1)
    .then((r) => r[0]);
  if (!project) return Response.json({ error: 'Unknown project' }, { status: 400 });

  const abs = resolveWithinRoot(project.repo_path, dir);
  if (!abs) return Response.json({ error: 'Invalid path' }, { status: 400 });

  try {
    const dirents = await readdir(abs, { withFileTypes: true });
    const entries = dirents
      .filter((e) => !(e.isDirectory() && EXCLUDED_DIRS.has(e.name)))
      .map((e) => ({ name: e.name, type: e.isDirectory() ? ('dir' as const) : ('file' as const) }))
      .sort((a, b) =>
        a.type === b.type ? a.name.localeCompare(b.name) : a.type === 'dir' ? -1 : 1,
      );
    return Response.json({ entries });
  } catch {
    return Response.json({ error: 'Directory not found' }, { status: 404 });
  }
}
