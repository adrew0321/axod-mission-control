import { existsSync, statSync } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import path from 'node:path';

const execFileAsync = promisify(execFile);
import { cookies } from 'next/headers';
import { SESSION_COOKIE, verifySession, cookieOptions } from '@/lib/auth';
import { ACTIVE_PROJECT_COOKIE, validateNewProjectInput } from '@/lib/projects';
import { registerProject } from '@/lib/register-project';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(req: Request) {
  const jar = await cookies();
  const token = jar.get(SESSION_COOKIE)?.value;
  if (!token || !(await verifySession(token))) {
    return Response.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const body = (await req.json().catch(() => ({}))) as {
    name?: string; repoPath?: string; defaultBranch?: string; githubUrl?: string; create?: boolean;
  };

  const shape = validateNewProjectInput(body);
  if (!shape.ok) return Response.json({ error: shape.error }, { status: 400 });

  const repoPath = body.repoPath!.trim();
  if (body.create) {
    const parent = path.dirname(repoPath);
    if (!existsSync(parent) || !statSync(parent).isDirectory()) {
      return Response.json({ error: 'Parent folder does not exist.' }, { status: 400 });
    }
    if (existsSync(repoPath)) {
      return Response.json({ error: 'That folder already exists.' }, { status: 400 });
    }
    const branch = body.defaultBranch?.trim() || 'dev';
    try {
      await mkdir(repoPath, { recursive: false });
      await execFileAsync('git', ['init', '-b', branch], { cwd: repoPath, windowsHide: true });
    } catch (e) {
      return Response.json(
        { error: `Could not create repo: ${e instanceof Error ? e.message : String(e)}` },
        { status: 400 },
      );
    }
  } else {
    if (!existsSync(repoPath) || !statSync(repoPath).isDirectory()) {
      return Response.json({ error: 'Repo path does not exist or is not a directory.' }, { status: 400 });
    }
    if (!existsSync(path.join(repoPath, '.git'))) {
      return Response.json({ error: 'That folder is not a git repo (no .git found).' }, { status: 400 });
    }
  }

  const { projectId: id } = await registerProject({
    name: body.name!,
    repoPath,
    defaultBranch: body.defaultBranch,
    githubUrl: body.githubUrl,
  });

  jar.set(ACTIVE_PROJECT_COOKIE, id, cookieOptions());
  return Response.json({ ok: true, projectId: id });
}
