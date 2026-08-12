// Process-wide shutdown registry. Background services register a disposer here;
// the SIGTERM handler in src/instrumentation.ts runs them all under a bounded
// budget and then exits. Pure (injectable clock/timers, no server-only or DB
// imports) so it is unit-tested with node:test.

export type Disposer = () => void | Promise<void>;

export interface DisposerResult {
  name: string;
  ok: boolean;
  ms: number;
  error?: string;
  timedOut?: boolean;
}

export interface ShutdownReport {
  ran: boolean;
  results: DisposerResult[];
  totalMs: number;
}

export interface RunShutdownOpts {
  /** Total budget across every disposer. */
  timeoutMs?: number;
  /** Per-disposer default when one is not given at registration. */
  defaultBudgetMs?: number;
  now?: () => number;
  setTimeout?: (cb: () => void, ms: number) => unknown;
  clearTimeout?: (handle: unknown) => void;
}

interface Entry {
  name: string;
  fn: Disposer;
  budgetMs?: number;
}

const entries: Entry[] = [];
let inFlight: Promise<ShutdownReport> | null = null;

export function onShutdown(name: string, fn: Disposer, budgetMs?: number): void {
  entries.push({ name, fn, budgetMs });
}

/** Tests only: clear the registry and allow runShutdown to run again. */
export function resetShutdown(): void {
  entries.length = 0;
  inFlight = null;
}

/**
 * Run every registered disposer once, in registration order. Idempotent: a
 * second SIGTERM while shutting down returns the in-flight promise rather than
 * re-running teardown.
 */
export function runShutdown(opts: RunShutdownOpts = {}): Promise<ShutdownReport> {
  if (inFlight) return inFlight;
  inFlight = execute(opts);
  return inFlight;
}

async function execute(opts: RunShutdownOpts): Promise<ShutdownReport> {
  const now = opts.now ?? (() => Date.now());
  const setT = opts.setTimeout ?? ((cb: () => void, ms: number) => setTimeout(cb, ms));
  const clearT =
    opts.clearTimeout ?? ((h: unknown) => clearTimeout(h as ReturnType<typeof setTimeout>));

  const totalMs = opts.timeoutMs ?? 8000;
  const perDefault = opts.defaultBudgetMs ?? totalMs;
  const start = now();
  const deadline = start + totalMs;
  const results: DisposerResult[] = [];

  for (const entry of entries) {
    const t0 = now();
    const remaining = deadline - t0;
    if (remaining <= 0) {
      results.push({ name: entry.name, ok: false, ms: 0, timedOut: true });
      continue;
    }

    const budget = Math.min(entry.budgetMs ?? perDefault, remaining);
    let timedOut = false;
    let error: string | undefined;

    try {
      await new Promise<void>((resolve, reject) => {
        let handle: unknown;
        let settled = false;
        // If the disposer rejects after the timeout already settled this promise,
        // that rejection is intentionally dropped here (settled guards it) — the
        // entry is already recorded as timedOut and the loop has moved on.
        const settle = (act: () => void) => {
          if (settled) return;
          settled = true;
          if (handle !== undefined) clearT(handle);
          act();
        };
        handle = setT(() => {
          timedOut = true;
          settle(resolve);
        }, budget);
        Promise.resolve()
          .then(() => entry.fn())
          .then(
            () => settle(resolve),
            (err) => settle(() => reject(err)),
          );
      });
    } catch (err) {
      error = err instanceof Error ? err.message : String(err);
    }

    results.push({
      name: entry.name,
      ok: !timedOut && error === undefined,
      ms: now() - t0,
      ...(error !== undefined ? { error } : {}),
      ...(timedOut ? { timedOut: true } : {}),
    });
  }

  return { ran: true, results, totalMs: now() - start };
}
