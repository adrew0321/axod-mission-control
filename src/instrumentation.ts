// Next.js startup hook (runs once per server process). Starts the in-process
// background tickers: the Scheduler and the Dreaming Curator. Guarded to the Node
// runtime (not Edge); each starter is itself idempotent so dev/HMR re-registration
// is safe.
export async function register() {
  if (process.env.NEXT_RUNTIME === 'nodejs') {
    const { startScheduler } = await import('@/lib/scheduler');
    startScheduler();
    const { startDreaming } = await import('@/lib/dream');
    startDreaming();
  }
}
