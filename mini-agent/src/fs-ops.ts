// Executes fs_* commands inside the room. Every path goes through the gate first;
// a rejected path returns status 'blocked' (the same shape guard.ts produces for
// the browser), never an exception. The gate also resolves symlinks (paths-real.ts),
// so the `abs` it returns is the link-resolved path, not necessarily the literal one
// requested — every fs call below operates on that resolved path.
import { readFile, writeFile, readdir, mkdir, stat } from 'node:fs/promises';
import { dirname } from 'node:path';
import { type Roots } from './paths';
import { validatePathReal } from './paths-real';
import type { Command, Result } from './protocol';

export const MAX_READ_BYTES = 256 * 1024;

export async function execFs(roots: Roots, cmd: Command): Promise<Result> {
  if (cmd.action !== 'fs_list' && cmd.action !== 'fs_read' && cmd.action !== 'fs_write') {
    return { id: cmd.id, status: 'error', reason: `unsupported action: ${cmd.action}` };
  }

  const verdict = await validatePathReal(roots, cmd.path ?? '');
  if (!verdict.ok) return { id: cmd.id, status: 'blocked', reason: verdict.reason };
  const abs = verdict.abs;

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
