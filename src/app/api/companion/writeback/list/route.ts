import { join } from 'node:path';
import { and, eq, isNull } from 'drizzle-orm';
import { db } from '@/db/client';
import { sessions, projects } from '@/db/schema';
import { diffWorktree } from '@/lib/worktree';
import { isIngestedRepo } from '@/lib/companion/writeback-list';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(req: Request) {
  const token = req.headers.get('x-companion-token');
  if (!process.env.COMPANION_TOKEN || token !== process.env.COMPANION_TOKEN) {
    return new Response('Unauthorized', { status: 401 });
  }

  const ingestedRoot = join(process.cwd(), 'data', 'ingested');
  const allProjects = await db.select().from(projects);
  const ingested = allProjects.filter((p) => isIngestedRepo(p.repo_path, ingestedRoot));

  const out = [];
  for (const p of ingested) {
    const rows = await db
      .select()
      .from(sessions)
      .where(and(eq(sessions.project_id, p.id), isNull(sessions.archived_at)));
    const sess = [];
    for (const s of rows) {
      const base = s.base_branch ?? p.default_branch ?? 'dev';
      const { files } = s.worktree_path
        ? await diffWorktree(s.worktree_path, base)
        : { files: [] as { status: string; path: string }[] };
      sess.push({
        sessionId: s.id,
        sessionName: s.title ?? s.id,
        changed: files.length > 0,
        fileCount: files.length,
      });
    }
    out.push({ projectId: p.id, projectName: p.name, sessions: sess });
  }

  return Response.json({ projects: out });
}
