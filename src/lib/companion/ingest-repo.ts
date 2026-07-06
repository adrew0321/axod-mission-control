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

  // The WriteStream emits 'error' on its own channel (failed open, EMFILE, disk
  // full, etc.) — separate from the write()-callback promises below. Without a
  // listener, that event crashes the process instead of rejecting this
  // function's promise. Turn it into a promise we can race against every await
  // point in the read/write loop.
  let streamErr: unknown;
  const errorPromise = new Promise<never>((_resolve, reject) => {
    out.on('error', (e) => {
      streamErr = e;
      reject(e);
    });
  });
  errorPromise.catch(() => {}); // avoid an unhandled-rejection warning if never raced

  let total = 0;
  try {
    for (;;) {
      const { value, done } = await Promise.race([reader.read(), errorPromise]);
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) {
        throw new RangeError('bundle exceeds size limit');
      }
      await Promise.race([
        new Promise<void>((res, rej) => out.write(value, (e) => (e ? rej(e) : res()))),
        errorPromise,
      ]);
    }
    await Promise.race([
      new Promise<void>((res, rej) => out.end((e?: Error) => (e ? rej(e) : res()))),
      errorPromise,
    ]);
    return total;
  } catch (e) {
    // Signal the source to stop (an oversized/failed upload shouldn't keep
    // streaming into the void), then clean up the partial destination file.
    await reader.cancel(e).catch(() => {});
    out.destroy();
    await rm(destPath, { force: true });
    throw e ?? streamErr;
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
