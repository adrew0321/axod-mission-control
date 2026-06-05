import { readdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { cookies } from 'next/headers';
import { SESSION_COOKIE, verifySession } from '@/lib/auth';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

// SECURITY: this reads the operator's own filesystem. Safe ONLY because Mission
// Control is a single-user, auth-gated, LOCAL tool. Do NOT expose this route in a
// multi-user or hosted deployment without scoping it to an allow-listed root.

function listDrives(): string[] {
  if (process.platform !== 'win32') return [];
  const drives: string[] = [];
  for (let c = 65; c <= 90; c++) {
    const root = `${String.fromCharCode(c)}:\\`;
    if (existsSync(root)) drives.push(root);
  }
  return drives;
}

export async function GET(req: Request) {
  const jar = await cookies();
  const token = jar.get(SESSION_COOKIE)?.value;
  if (!token || !(await verifySession(token))) {
    return Response.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const url = new URL(req.url);
  const requested = url.searchParams.get('path');
  const target = requested && requested.trim() ? path.resolve(requested) : os.homedir();

  let dirents;
  try {
    dirents = await readdir(target, { withFileTypes: true });
  } catch {
    return Response.json({ error: 'Cannot read that folder' }, { status: 400 });
  }

  const entries = dirents
    .filter((d) => d.isDirectory())
    .map((d) => ({ name: d.name, isRepo: existsSync(path.join(target, d.name, '.git')) }))
    .sort((a, b) => a.name.localeCompare(b.name));

  const parent = path.dirname(target);
  return Response.json({
    path: target,
    parent: parent === target ? null : parent,
    entries,
    drives: listDrives(),
  });
}
