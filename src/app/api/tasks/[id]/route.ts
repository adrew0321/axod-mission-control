import { cookies } from 'next/headers';
import { eq } from 'drizzle-orm';
import { z } from 'zod';
import { randomBytes, bytesToHex } from '@noble/hashes/utils.js';
import { db } from '@/db/client';
import { tasks, sessions, projects } from '@/db/schema';
import { SESSION_COOKIE, verifySession } from '@/lib/auth';
import { buildTaskPrompt, isSessionDone, type TaskColumn } from '@/lib/task-board';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const PatchBody = z.object({
  status: z.enum(['todo', 'in_progress', 'done']).optional(),
  title: z.string().min(1).max(500).optional(),
  description: z.string().max(20_000).optional(),
});

async function authed(): Promise<boolean> {
  const jar = await cookies();
  const token = jar.get(SESSION_COOKIE)?.value;
  return !!token && !!(await verifySession(token));
}

export async function PATCH(req: Request, ctx: { params: Promise<{ id: string }> }) {
  if (!(await authed())) return Response.json({ error: 'Unauthorized' }, { status: 401 });

  const { id } = await ctx.params;
  const parsed = PatchBody.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return Response.json({ error: 'Invalid body' }, { status: 400 });

  const task = await db.select().from(tasks).where(eq(tasks.id, id)).limit(1).then((r) => r[0]);
  if (!task) return Response.json({ error: 'Task not found' }, { status: 404 });

  const now = new Date();
  const nextStatus = (parsed.data.status ?? task.status) as TaskColumn;

  // Dispatch trigger: moving into In-Progress with no session yet → create a new
  // session and link it to the card. The seeded prompt is RETURNED (not inserted):
  // the client switches to this session and posts it through the normal send path,
  // which is what actually runs Sage (a turn only runs when the client streams it).
  const shouldDispatch = nextStatus === 'in_progress' && task.status !== 'in_progress' && !task.session_id;

  if (shouldDispatch) {
    try {
      const project = await db
        .select({ default_branch: projects.default_branch })
        .from(projects)
        .where(eq(projects.id, task.project_id))
        .limit(1)
        .then((r) => r[0]);

      const sessionId = `sess_${bytesToHex(randomBytes(4))}`;
      await db.insert(sessions).values({
        id: sessionId,
        project_id: task.project_id,
        title: task.title,
        branch: project?.default_branch ?? 'dev',
        worktree_path: null,
        status: 'active',
        cleared_at: null,
        created_at: now,
        updated_at: now,
      });
      await db
        .update(tasks)
        .set({ status: 'in_progress', session_id: sessionId, updated_at: now })
        .where(eq(tasks.id, id));
      return Response.json({ ok: true, sessionId, prompt: buildTaskPrompt(task) });
    } catch (e) {
      return Response.json(
        { error: `Could not dispatch task: ${e instanceof Error ? e.message : String(e)}` },
        { status: 500 },
      );
    }
  }

  // Plain update (drag between columns without a fresh dispatch, or edit fields).
  await db
    .update(tasks)
    .set({
      status: nextStatus,
      title: parsed.data.title?.trim() ?? task.title,
      description:
        parsed.data.description !== undefined ? parsed.data.description.trim() || null : task.description,
      updated_at: now,
    })
    .where(eq(tasks.id, id));

  // Acknowledge whether the linked session is finished (drives "ready for review").
  let sessionDone: boolean | undefined;
  if (task.session_id) {
    const s = await db
      .select({ status: sessions.status })
      .from(sessions)
      .where(eq(sessions.id, task.session_id))
      .limit(1)
      .then((r) => r[0]);
    sessionDone = s ? isSessionDone(s.status) : undefined;
  }
  return Response.json({ ok: true, sessionDone });
}

export async function DELETE(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  if (!(await authed())) return Response.json({ error: 'Unauthorized' }, { status: 401 });
  const { id } = await ctx.params;
  const task = await db.select({ id: tasks.id }).from(tasks).where(eq(tasks.id, id)).limit(1).then((r) => r[0]);
  if (!task) return Response.json({ error: 'Task not found' }, { status: 404 });
  await db.delete(tasks).where(eq(tasks.id, id)); // linked session is kept
  return Response.json({ ok: true });
}
