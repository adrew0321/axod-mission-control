// Next.js startup hook (runs once per server process). Starts the in-process
// Scheduler ticker. Guarded to the Node runtime (not Edge); startScheduler is
// itself idempotent so dev/HMR re-registration is safe.
export async function register() {
  if (process.env.NEXT_RUNTIME === 'nodejs') {
    const { startScheduler } = await import('@/lib/scheduler');
    startScheduler();
  }
}
