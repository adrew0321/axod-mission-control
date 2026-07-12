import { mkdir, rm, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { randomBytes, bytesToHex } from '@noble/hashes/utils.js';
import { eq } from 'drizzle-orm';
import { db } from '@/db/client';
import { sessions, projects } from '@/db/schema';
import { ensureWorktree, commitWorktreeEdits } from '@/lib/worktree';
import { countCommitsAhead, countChangedFiles, createSessionBundle } from '@/lib/companion/writeback-repo';
import { isIngestedRepo } from '@/lib/companion/writeback-list';
import { verifyCompanionToken } from '@/lib/companion/auth';
import { isLeaseHeld } from '@/lib/turn-lease';

// Mirror run-turn's DEFAULT_MAX_DURATION_MS so lease staleness matches the runner.
const TURN_MAX_DURATION_MS = 600_000;

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(req: Request) {
  const token = req.headers.get('x-companion-token');
  if (!verifyCompanionToken(token)) {
    return new Response('Unauthorized', { status: 401 });
  }

  const sessionId = new URL(req.url).searchParams.get('sessionId')?.trim();
  if (!sessionId) return Response.json({ error: 'sessionId is required' }, { status: 400 });

  const session = await db.select().from(sessions).where(eq(sessions.id, sessionId)).limit(1).then((r) => r[0]);
  if (!session?.project_id) return Response.json({ error: 'session not found' }, { status: 400 });

  const project = await db.select().from(projects).where(eq(projects.id, session.project_id)).limit(1).then((r) => r[0]);
  const ingestedRoot = join(process.cwd(), 'data', 'ingested');
  if (!project?.repo_path || !isIngestedRepo(project.repo_path, ingestedRoot)) {
    return Response.json({ error: 'not a companion-ingested project' }, { status: 400 });
  }

  // Don't bundle a worktree a live turn is actively editing — mirror run-turn's
  // running_since lease so writeback can't snapshot mid-edit state or collide on
  // git's index lock (which would spuriously 500 the in-flight turn).
  if (isLeaseHeld(session.running_since ?? null, Date.now(), TURN_MAX_DURATION_MS)) {
    return Response.json(
      { error: 'a turn is running for this session — try again once it finishes' },
      { status: 409 },
    );
  }

  const base = session.base_branch ?? project.default_branch ?? 'dev';
  const branch = `mc/${sessionId}`;
  const tmpDir = join(ingestedRoot, '.tmp');
  const bundlePath = join(tmpDir, `${bytesToHex(randomBytes(6))}.bundle`);

  try {
    await ensureWorktree(sessionId, project.repo_path, base);
    await commitWorktreeEdits(sessionId, project.repo_path);

    const commits = await countCommitsAhead(project.repo_path, base, branch);
    if (commits === 0) return Response.json({ error: 'nothing to write back' }, { status: 409 });
    const files = await countChangedFiles(project.repo_path, base, branch);

    await mkdir(tmpDir, { recursive: true });
    await createSessionBundle(project.repo_path, base, branch, bundlePath);
    const bytes = await readFile(bundlePath); // bundles are small (delta only)

    return new Response(bytes as unknown as BodyInit, {
      headers: {
        'Content-Type': 'application/octet-stream',
        'x-wb-branch': branch,
        'x-wb-commits': String(commits),
        'x-wb-files': String(files),
      },
    });
  } catch (e) {
    return Response.json({ error: `writeback failed: ${e instanceof Error ? e.message : String(e)}` }, { status: 500 });
  } finally {
    await rm(bundlePath, { force: true }).catch(() => {});
  }
}
