import { cookies } from 'next/headers';
import { eq } from 'drizzle-orm';
import { z } from 'zod';
import { randomBytes, bytesToHex } from '@noble/hashes/utils.js';
import { db } from '@/db/client';
import { tasks, projects } from '@/db/schema';
import { SESSION_COOKIE, verifySession } from '@/lib/auth';
import { getTaskBoard } from '@/lib/task-board-data';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const CreateBody = z.object({
  project_id: z.string().min(1),
  title: z.string().min(1).max(500),
  description: z.string().max(20_000).optional(),
});

async function authed(): Promise<boolean> {
  const jar = await cookies();
  const token = jar.get(SESSION_COOKIE)?.value;
  return !!token && !!(await verifySession(token));
}

export async function GET(req: Request) {
  if (!(await authed())) return Response.json({ error: 'Unauthorized' }, { status: 401 });
  const projectId = new URL(req.url).searchParams.get('project_id');
  if (!projectId) return Response.json({ error: 'project_id required' }, { status: 400 });
  return Response.json(await getTaskBoard(projectId));
}

export async function POST(req: Request) {
  if (!(await authed())) return Response.json({ error: 'Unauthorized' }, { status: 401 });

  const parsed = CreateBody.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return Response.json({ error: 'Invalid task body' }, { status: 400 });

  const project = await db
    .select({ id: projects.id })
    .from(projects)
    .where(eq(projects.id, parsed.data.project_id))
    .limit(1)
    .then((r) => r[0]);
  if (!project) return Response.json({ error: 'Project not found' }, { status: 400 });

  const now = new Date();
  const id = `task_${bytesToHex(randomBytes(8))}`;
  await db.insert(tasks).values({
    id,
    project_id: parsed.data.project_id,
    title: parsed.data.title.trim(),
    description: parsed.data.description?.trim() || null,
    status: 'todo',
    session_id: null,
    created_at: now,
    updated_at: now,
  });
  return Response.json({ ok: true, id });
}
