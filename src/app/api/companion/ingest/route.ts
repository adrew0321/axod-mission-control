import { mkdir, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { randomBytes, bytesToHex } from '@noble/hashes/utils.js';
import { db } from '@/db/client';
import { projects } from '@/db/schema';
import { slugifyProjectId } from '@/lib/projects';
import { registerProject } from '@/lib/register-project';
import { streamToFileWithCap, cloneBundleIntoProject } from '@/lib/companion/ingest-repo';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const parsedMax = Number(process.env.COMPANION_INGEST_MAX_BYTES);
const MAX_BYTES = Number.isFinite(parsedMax) && parsedMax > 0 ? parsedMax : 1_000_000_000;

export async function POST(req: Request) {
  const token = req.headers.get('x-companion-token');
  if (!process.env.COMPANION_TOKEN || token !== process.env.COMPANION_TOKEN) {
    return new Response('Unauthorized', { status: 401 });
  }

  const url = new URL(req.url);
  const name = (url.searchParams.get('name') ?? '').trim();
  const branch = (url.searchParams.get('branch') ?? '').trim() || 'main';
  if (!name) return Response.json({ error: 'name is required' }, { status: 400 });
  if (!req.body) return Response.json({ error: 'no bundle body' }, { status: 400 });

  const slug = slugifyProjectId(name) || 'project';

  // Slice 1 is create-only: refuse if this project already exists.
  const existing = await db.select({ id: projects.id }).from(projects);
  if (existing.some((p) => p.id === slug)) {
    return Response.json({ error: `Project "${slug}" already exists.` }, { status: 409 });
  }

  const root = join(process.cwd(), 'data', 'ingested');
  const destDir = join(root, slug);
  if (existsSync(destDir)) {
    return Response.json({ error: `Folder for "${slug}" already exists.` }, { status: 409 });
  }
  const tmpDir = join(root, '.tmp');
  await mkdir(tmpDir, { recursive: true });
  const bundlePath = join(tmpDir, `${bytesToHex(randomBytes(6))}.bundle`);

  try {
    await streamToFileWithCap(req.body as ReadableStream<Uint8Array>, bundlePath, MAX_BYTES);
    await cloneBundleIntoProject(bundlePath, destDir);
    const { projectId } = await registerProject({ name, repoPath: destDir, defaultBranch: branch });
    return Response.json({ ok: true, projectId });
  } catch (e) {
    await rm(destDir, { recursive: true, force: true }).catch(() => {});
    if (e instanceof RangeError) {
      return Response.json({ error: 'bundle too large' }, { status: 413 });
    }
    return Response.json(
      { error: `ingest failed: ${e instanceof Error ? e.message : String(e)}` },
      { status: 400 },
    );
  } finally {
    await rm(bundlePath, { force: true }).catch(() => {});
  }
}
