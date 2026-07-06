// Mini-side ingestion primitives: stream a bundle to disk (capped) and clone it
// into a project dir with NO remote. Pure node — no DB, no server-only — so it is
// unit-tested against temp dirs with real git.
import { createWriteStream } from 'node:fs';
import { rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

export async function streamToFileWithCap(
  stream: ReadableStream<Uint8Array>,
  destPath: string,
  maxBytes: number,
): Promise<number> {
  const out = createWriteStream(destPath);
  const reader = stream.getReader();
  let total = 0;
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) {
        throw new RangeError('bundle exceeds size limit');
      }
      await new Promise<void>((res, rej) => out.write(value, (e) => (e ? rej(e) : res())));
    }
    await new Promise<void>((res, rej) => out.end((e?: Error) => (e ? rej(e) : res())));
    return total;
  } catch (e) {
    out.destroy();
    await rm(destPath, { force: true });
    throw e;
  }
}

export async function cloneBundleIntoProject(bundlePath: string, destDir: string): Promise<void> {
  // A clone from a bundle sets origin = the bundle path; we remove it so the Mini
  // keeps no reference to where the repo came from (e.g. DevOps).
  await execFileAsync('git', ['clone', bundlePath, destDir], { windowsHide: true });
  if (!existsSync(join(destDir, '.git'))) {
    throw new Error('clone produced no .git');
  }
  await execFileAsync('git', ['-C', destDir, 'remote', 'remove', 'origin'], { windowsHide: true });
}
