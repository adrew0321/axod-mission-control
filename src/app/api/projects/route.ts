import { existsSync, statSync } from 'node:fs';
import path from 'node:path';
import { cookies } from 'next/headers';
import { db } from '@/db/client';
import { projects } from '@/db/schema';
import { SESSION_COOKIE, verifySession, cookieOptions } from '@/lib/auth';
import {
  ACTIVE_PROJECT_COOKIE,
  slugifyProjectId,
  validateNewProjectInput,
} from '@/lib/projects';
import { getOrCreateActiveSession } from '@/lib/active-project';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(req: Request) {
  const jar = await cookies();
  const token = jar.get(SESSION_COOKIE)?.value;
  if (!token || !(await verifySession(token))) {
    return Response.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const body = (await req.json().catch(() => ({}))) as {
    name?: string; repoPath?: string; defaultBranch?: string; githubUrl?: string;
  };

  const shape = validateNewProjectInput(body);
  if (!shape.ok) return Response.json({ error: shape.error }, { status: 400 });

  const repoPath = body.repoPath!.trim();
  if (!existsSync(repoPath) || !statSync(repoPath).isDirectory()) {
    return Response.json({ error: 'Repo path does not exist or is not a directory.' }, { status: 400 });
  }
  if (!existsSync(path.join(repoPath, '.git'))) {
    return Response.json({ error: 'That folder is not a git repo (no .git found).' }, { status: 400 });
  }

  const base = slugifyProjectId(body.name!) || 'project';
  const existing = await db.select({ id: projects.id }).from(projects);
  const taken = new Set(existing.map((p) => p.id));
  let id = base;
  for (let n = 2; taken.has(id); n++) id = `${base}-${n}`;

  const now = new Date();
  await db.insert(projects).values({
    id,
    name: body.name!.trim(),
    repo_path: repoPath,
    github_url: body.githubUrl?.trim() || null,
    default_branch: body.defaultBranch?.trim() || 'dev',
    created_at: now,
  });

  await getOrCreateActiveSession(id);
  jar.set(ACTIVE_PROJECT_COOKIE, id, cookieOptions());
  return Response.json({ ok: true, projectId: id });
}
