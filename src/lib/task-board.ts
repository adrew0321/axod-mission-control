// Pure board logic — no db, no server-only, so the tsx test runner can import it.
// `ts` is emitted as an ISO string so initial server props and the GET-refresh
// payload share one shape.

export type TaskColumn = 'todo' | 'in_progress' | 'done';

/** A `tasks` row, as returned by drizzle (timestamps are Date). */
export interface TaskRow {
  id: string;
  project_id: string;
  title: string;
  description: string | null;
  status: TaskColumn;
  session_id: string | null;
  created_at: Date;
  updated_at: Date;
}

/** A session reduced to what the board needs, plus a precomputed activity flag. */
export interface BoardSessionRow {
  id: string;
  title: string | null;
  status: string;
  project_id: string;
  projectName: string;
  updated_at: Date;
  hasActivity: boolean; // has at least one agent message
}

export interface TaskCard {
  id: string;
  origin: 'manual' | 'auto';
  title: string;
  description?: string;
  column: TaskColumn;
  ready?: boolean; // manual + in_progress + linked session finished
  projectId: string;
  projectName: string;
  sessionId?: string;
  sessionTitle?: string;
  sessionStatus?: string;
  ts: string; // ISO
}

export interface BoardColumns {
  todo: TaskCard[];
  in_progress: TaskCard[];
  done: TaskCard[];
}

/** Session statuses that count as finished. */
export function isSessionDone(status: string): boolean {
  return status === 'done' || status === 'completed';
}

/** Build the Sage seed prompt for a dispatched card. */
export function buildTaskPrompt(task: { title: string; description?: string | null }): string {
  const title = task.title.trim();
  const desc = task.description?.trim();
  return desc ? `${title}\n\n${desc}` : title;
}

/**
 * Merge manual task rows and project sessions into three columns.
 * - Manual cards are placed by their `status`; `ready` is derived from the linked session.
 * - Auto cards are sessions NOT linked to a manual task that are either finished or active-with-activity.
 *   Active → in_progress, finished → done. Sessions have no todo state, so autos never land in todo.
 */
export function composeBoard(
  tasks: TaskRow[],
  sessions: BoardSessionRow[],
  projectName: string,
): BoardColumns {
  const board: BoardColumns = { todo: [], in_progress: [], done: [] };
  const sessionById = new Map(sessions.map((s) => [s.id, s]));
  const linkedSessionIds = new Set(tasks.map((t) => t.session_id).filter((id): id is string => !!id));

  for (const t of tasks) {
    const linked = t.session_id ? sessionById.get(t.session_id) : undefined;
    const ready = t.status === 'in_progress' && !!linked && isSessionDone(linked.status);
    board[t.status].push({
      id: t.id,
      origin: 'manual',
      title: t.title,
      description: t.description ?? undefined,
      column: t.status,
      ready: ready || undefined,
      projectId: t.project_id,
      projectName,
      sessionId: t.session_id ?? undefined,
      sessionTitle: linked?.title ?? undefined,
      sessionStatus: linked?.status,
      ts: t.created_at.toISOString(),
    });
  }

  for (const s of sessions) {
    if (linkedSessionIds.has(s.id)) continue;
    const done = isSessionDone(s.status);
    if (!done && !s.hasActivity) continue;
    const column: TaskColumn = done ? 'done' : 'in_progress';
    board[column].push({
      id: `session:${s.id}`,
      origin: 'auto',
      title: s.title || '(untitled session)',
      column,
      projectId: s.project_id,
      projectName: s.projectName,
      sessionId: s.id,
      sessionTitle: s.title ?? undefined,
      sessionStatus: s.status,
      ts: s.updated_at.toISOString(),
    });
  }

  // Newest first within each column.
  for (const key of ['todo', 'in_progress', 'done'] as const) {
    board[key].sort((a, b) => (a.ts < b.ts ? 1 : a.ts > b.ts ? -1 : 0));
  }
  return board;
}
