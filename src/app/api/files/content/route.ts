import { readFile, stat } from 'node:fs/promises';
import { cookies } from 'next/headers';
import { eq } from 'drizzle-orm';
import { db } from '@/db/client';
import { projects } from '@/db/schema';
import { SESSION_COOKIE, verifySession } from '@/lib/auth';
import { resolveWithinRoot } from '@/lib/safe-path';
import { fileLanguage } from '@/lib/file-tree';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const MAX_BYTES = 1_000_000;

export async function GET(req: Request) {
  const jar = await cookies();
  const token = jar.get(SESSION_COOKIE)?.value;
  if (!token || !(await verifySession(token))) {
    return Response.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const url = new URL(req.url);
  const projectId = url.searchParams.get('projectId');
  const rel = url.searchParams.get('path');
  if (!projectId || !rel) {
    return Response.json({ error: 'projectId and path are required' }, { status: 400 });
  }

  const project = await db
    .select()
    .from(projects)
    .where(eq(projects.id, projectId))
    .limit(1)
    .then((r) => r[0]);
  if (!project) return Response.json({ error: 'Unknown project' }, { status: 400 });

  const abs = resolveWithinRoot(project.repo_path, rel);
  if (!abs) return Response.json({ error: 'Invalid path' }, { status: 400 });

  try {
    const s = await stat(abs);
    if (!s.isFile()) return Response.json({ error: 'Not a file' }, { status: 400 });
    if (s.size > MAX_BYTES) return Response.json({ binary: true });

    const buf = await readFile(abs);
    if (buf.subarray(0, 8192).includes(0)) return Response.json({ binary: true });

    const name = rel.split(/[\\/]/).pop() ?? rel;
    return Response.json({ content: buf.toString('utf8'), language: fileLanguage(name) });
  } catch {
    return Response.json({ error: 'File not found' }, { status: 404 });
  }
}
