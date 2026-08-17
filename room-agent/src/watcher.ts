// Watches the two doorway folders and reports settled file drops. The routing and
// the first pass are pure (./doorway); this file is only fs plumbing.
//
// A copy in progress fires many events, so nothing is reported until the file's
// size has been stable for settleMs — otherwise a 40MB drop would raise a
// proposal about its first 4KB.
import { watch, type FSWatcher } from 'node:fs';
import { stat, open } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { zoneForPath, isNoiseName, buildDropReport, MAX_HEAD_CHARS, type DropReport } from './doorway';
import type { Roots } from './paths';

const DEFAULT_SETTLE_MS = 1500;

export function watchDoorway(
  roots: Roots,
  onDrop: (r: DropReport) => void,
  opts: { settleMs?: number } = {},
): { stop: () => void } {
  const settleMs = opts.settleMs ?? DEFAULT_SETTLE_MS;
  const timers = new Map<string, ReturnType<typeof setTimeout>>();
  const reported = new Map<string, number>(); // abs path → last reported size
  const watchers: FSWatcher[] = [];
  let stopped = false;

  async function report(abs: string): Promise<void> {
    if (stopped) return;
    try {
      const s = await stat(abs);
      if (!s.isFile()) return;
      if (reported.get(abs) === s.size) return; // already reported at this size
      const zone = zoneForPath(roots, abs);
      if (!zone) return;

      const fh = await open(abs, 'r');
      try {
        const buf = Buffer.alloc(Math.min(s.size, MAX_HEAD_CHARS * 2));
        if (buf.length) await fh.read(buf, 0, buf.length, 0);
        reported.set(abs, s.size);
        onDrop(buildDropReport({ zone, path: abs, sizeBytes: s.size, raw: buf }));
      } finally {
        await fh.close();
      }
    } catch {
      /* vanished mid-settle (a temp file, a cancelled copy) — nothing to report */
    }
  }

  function touch(abs: string): void {
    clearTimeout(timers.get(abs));
    timers.set(
      abs,
      setTimeout(() => {
        timers.delete(abs);
        void report(abs);
      }, settleMs),
    );
  }

  for (const zone of ['inbox', 'playground'] as const) {
    const dir = resolve(roots.doorway, zone);
    try {
      const w = watch(dir, { recursive: true }, (_event, filename) => {
        if (stopped || !filename) return;
        const name = String(filename);
        const leaf = name.split(/[\\/]/).pop() ?? name;
        if (isNoiseName(leaf)) return;
        touch(join(dir, name));
      });
      w.on('error', (e) => console.error(`[room] watcher error on ${dir}:`, e.message));
      watchers.push(w);
      console.log('[room] watching', dir);
    } catch (e) {
      console.error(`[room] cannot watch ${dir}:`, e instanceof Error ? e.message : e);
    }
  }

  return {
    stop() {
      stopped = true;
      for (const t of timers.values()) clearTimeout(t);
      timers.clear();
      for (const w of watchers) w.close();
    },
  };
}
