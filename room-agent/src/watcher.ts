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
// A late-mounting bind mount (container boot ordering) or a transient watch
// error should self-heal, not go quiet forever — retry indefinitely on a
// plain backoff rather than giving up after N tries.
const DEFAULT_RETRY_MS = 5000;

type Zone = 'inbox' | 'playground';

export function watchDoorway(
  roots: Roots,
  onDrop: (r: DropReport) => void,
  opts: { settleMs?: number; retryMs?: number } = {},
): { stop: () => void } {
  const settleMs = opts.settleMs ?? DEFAULT_SETTLE_MS;
  const retryMs = opts.retryMs ?? DEFAULT_RETRY_MS;
  const timers = new Map<string, ReturnType<typeof setTimeout>>();
  const reported = new Map<string, number>(); // abs path → last reported size
  const retryTimers = new Map<Zone, ReturnType<typeof setTimeout>>();
  const activeWatchers = new Map<Zone, FSWatcher>();
  let stopped = false;

  async function report(abs: string): Promise<void> {
    if (stopped) return;
    try {
      const s = await stat(abs);
      // Re-check after every await: stop() can land while this call is
      // suspended (a bind mount is far slower than local SSD), and a report
      // must never fire after stop() returned to its caller — the same
      // class of leak as the SSE-heartbeat cleanup that only covered some
      // teardown paths.
      if (stopped) return;
      if (!s.isFile()) return;
      if (reported.get(abs) === s.size) return; // already reported at this size
      const zone = zoneForPath(roots, abs);
      if (!zone) return;

      const fh = await open(abs, 'r');
      try {
        if (stopped) return;
        // Sized to match buildDropReport's own worst-case budget (MAX_HEAD_CHARS
        // * 4, for 4-byte UTF-8 sequences) so a full 800-char head is actually
        // achievable for CJK- or emoji-heavy content, not silently halved here.
        const buf = Buffer.alloc(Math.min(s.size, MAX_HEAD_CHARS * 4));
        if (buf.length) await fh.read(buf, 0, buf.length, 0);
        if (stopped) return;
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

  function scheduleRetry(zone: Zone, dir: string): void {
    if (stopped) return;
    clearTimeout(retryTimers.get(zone));
    retryTimers.set(
      zone,
      setTimeout(() => {
        retryTimers.delete(zone);
        startZoneWatcher(zone, dir);
      }, retryMs),
    );
  }

  // A zone whose watch() fails (or later errors) must not go quiet for the
  // rest of the process's life — that's the same shape as backups that were
  // silently dead for seven weeks. Retry on a plain backoff, indefinitely,
  // and log every attempt so journalctl shows the state instead of one lost
  // line at boot.
  function startZoneWatcher(zone: Zone, dir: string): void {
    if (stopped) return;
    try {
      const w = watch(dir, { recursive: true }, (_event, filename) => {
        if (stopped || !filename) return;
        const name = String(filename);
        const leaf = name.split(/[\\/]/).pop() ?? name;
        if (isNoiseName(leaf)) return;
        touch(join(dir, name));
      });
      w.on('error', (e) => {
        console.error(`[room] watcher error on ${dir}, retrying in ${retryMs}ms:`, e.message);
        activeWatchers.delete(zone);
        scheduleRetry(zone, dir);
      });
      activeWatchers.set(zone, w);
      console.log('[room] watching', dir);
    } catch (e) {
      console.error(
        `[room] cannot watch ${dir}, retrying in ${retryMs}ms:`,
        e instanceof Error ? e.message : e,
      );
      scheduleRetry(zone, dir);
    }
  }

  for (const zone of ['inbox', 'playground'] as const) {
    startZoneWatcher(zone, resolve(roots.doorway, zone));
  }

  return {
    stop() {
      stopped = true;
      for (const t of timers.values()) clearTimeout(t);
      timers.clear();
      for (const t of retryTimers.values()) clearTimeout(t);
      retryTimers.clear();
      for (const w of activeWatchers.values()) w.close();
      activeWatchers.clear();
    },
  };
}
