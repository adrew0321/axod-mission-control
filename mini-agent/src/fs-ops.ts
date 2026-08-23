// Executes fs_* commands for both the room and the host. In the room, every
// path goes through the gate first; a rejected path returns status 'blocked'
// (the same shape guard.ts produces for the browser), never an exception. The
// gate also resolves symlinks (paths-real.ts), so the `abs` it returns is the
// link-resolved path, not necessarily the literal one requested — every fs
// call below operates on that resolved path. The host has no gate (D1/D2);
// see the isRoom/else branch below.
import { readFile, writeFile, readdir, mkdir, stat } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { validatePathReal } from './paths-real';
import { isRoom, type ExecPolicy } from './policy';
import type { Command, Result } from './protocol';

export const MAX_READ_BYTES = 256 * 1024;

export async function execFs(policy: ExecPolicy, cmd: Command): Promise<Result> {
  if (cmd.action !== 'fs_list' && cmd.action !== 'fs_read' && cmd.action !== 'fs_write') {
    return { id: cmd.id, status: 'error', reason: `unsupported action: ${cmd.action}` };
  }

  let abs: string;
  if (isRoom(policy)) {
    const verdict = await validatePathReal(policy.roots, cmd.path ?? '');
    if (!verdict.ok) return { id: cmd.id, status: 'blocked', reason: verdict.reason };
    abs = verdict.abs;
  } else {
    // Host: no scope. A relative path resolves against the configured default
    // cwd so a bare "data/x.md" still means something predictable.
    const p = cmd.path ?? '';
    if (!p) return { id: cmd.id, status: 'error', reason: 'empty path' };
    abs = resolve(policy.defaultCwd, p);
  }

  try {
    switch (cmd.action) {
      case 'fs_list': {
        const names = await readdir(abs);
        return { id: cmd.id, status: 'ok', text: names.join('\n') };
      }
      case 'fs_read': {
        const s = await stat(abs);
        if (s.size > MAX_READ_BYTES) {
          return {
            id: cmd.id,
            status: 'error',
            reason: `file too large (${s.size} bytes, limit ${MAX_READ_BYTES})`,
          };
        }
        return { id: cmd.id, status: 'ok', text: await readFile(abs, 'utf8') };
      }
      case 'fs_write': {
        await mkdir(dirname(abs), { recursive: true });
        await writeFile(abs, cmd.content ?? '', 'utf8');
        return { id: cmd.id, status: 'ok', text: `wrote ${abs}` };
      }
      default:
        return { id: cmd.id, status: 'error', reason: `unsupported action: ${cmd.action}` };
    }
  } catch (e) {
    return { id: cmd.id, status: 'error', reason: e instanceof Error ? e.message : String(e) };
  }
}
