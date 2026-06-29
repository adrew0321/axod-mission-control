import 'server-only';
import { eq, sql } from 'drizzle-orm';
import { db } from '@/db/client';
import { tasks, sessions, projects, messages } from '@/db/schema';
import { composeBoard, type TaskRow, type BoardSessionRow, type BoardColumns } from './task-board';

/** Compose the board for one project (v1 scopes to the active project). */
export async function getTaskBoard(projectId: string): Promise<BoardColumns> {
  const project = await db
    .select({ name: projects.name })
    .from(projects)
    .where(eq(projects.id, projectId))
    .limit(1)
    .then((r) => r[0]);
  const projectName = project?.name ?? projectId;

  const taskRows = (await db.select().from(tasks).where(eq(tasks.project_id, projectId))) as TaskRow[];

  const sessRows = await db
    .select({
      id: sessions.id,
      title: sessions.title,
      status: sessions.status,
      project_id: sessions.project_id,
      updated_at: sessions.updated_at,
      agentMsgs: sql<number>`(SELECT COUNT(*) FROM ${messages} WHERE ${messages.session_id} = ${sessions.id} AND ${messages.role} = 'agent')`,
    })
    .from(sessions)
    .where(eq(sessions.project_id, projectId));

  const boardSessions: BoardSessionRow[] = sessRows.map((s) => ({
    id: s.id,
    title: s.title,
    status: s.status,
    project_id: s.project_id ?? projectId, // filtered by projectId above, never null here
    projectName,
    updated_at: s.updated_at,
    hasActivity: Number(s.agentMsgs) > 0,
  }));

  return composeBoard(taskRows, boardSessions, projectName);
}
