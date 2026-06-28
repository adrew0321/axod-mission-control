import { cookies } from 'next/headers';
import { eq, desc } from 'drizzle-orm';
import { randomBytes, bytesToHex } from '@noble/hashes/utils.js';
import { db } from '@/db/client';
import { sessions, projects } from '@/db/schema';
import { SESSION_COOKIE, verifySession } from '@/lib/auth';
import { sessionTitleOrDefault, validateNewSessionInput } from '@/lib/sessions';
import { listBranches } from '@/lib/worktree';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(req: Request) {
  const jar = await cookies();
  const token = jar.get(SESSION_COOKIE)?.value;
  if (!token || !(await verifySession(token))) return Response.json({ error: 'Unauthorized' }, { status: 401 });

  const projectId = new URL(req.url).searchParams.get('projectId');
  if (!projectId) return Response.json({ error: 'projectId required' }, { status: 400 });

  const project = await db.select().from(projects).where(eq(projects.id, projectId)).limit(1).then((r) => r[0]);
  if (!project) return Response.json({ error: 'Project not found' }, { status: 404 });

  const rows = await db
    .select()
    .from(sessions)
    .where(eq(sessions.project_id, projectId))
    .orderBy(desc(sessions.updated_at));

  return Response.json({
    sessions: rows.map((s) => ({
      id: s.id,
      title: sessionTitleOrDefault(s.title),
      baseBranch: s.base_branch ?? project.default_branch ?? 'dev',
      hasChanges: s.worktree_path != null,
      isActive: project.active_session_id === s.id,
      updatedAt: (s.updated_at ?? new Date()).toISOString(),
    })),
  });
}

export async function POST(req: Request) {
  const jar = await cookies();
  const token = jar.get(SESSION_COOKIE)?.value;
  if (!token || !(await verifySession(token))) return Response.json({ error: 'Unauthorized' }, { status: 401 });

  const body = (await req.json().catch(() => ({}))) as { projectId?: string; title?: string; baseBranch?: string };
  if (!body.projectId) return Response.json({ error: 'projectId required' }, { status: 400 });

  const project = await db.select().from(projects).where(eq(projects.id, body.projectId)).limit(1).then((r) => r[0]);
  if (!project) return Response.json({ error: 'Project not found' }, { status: 404 });

  const def = project.default_branch ?? 'dev';
  const allowed = await listBranches(project.repo_path, def);
  const v = validateNewSessionInput({ title: body.title, baseBranch: body.baseBranch }, allowed);
  if (!v.ok) return Response.json({ error: v.error }, { status: 400 });

  const id = `sess_${bytesToHex(randomBytes(4))}`;
  const now = new Date();
  await db.insert(sessions).values({
    id,
    project_id: project.id,
    title: sessionTitleOrDefault(body.title),
    branch: `mc/${id}`,
    base_branch: body.baseBranch ?? def,
    worktree_path: null,
    status: 'active',
    cleared_at: null,
    created_at: now,
    updated_at: now,
  });
  await db.update(projects).set({ active_session_id: id }).where(eq(projects.id, project.id));
  return Response.json({ id });
}
