// Next.js startup hook (runs once per server process). Starts the in-process
// background tickers: the Scheduler, the Dreaming Curator, and the Discord Bot.
// Guarded to the Node runtime (not Edge); each starter is itself idempotent so
// dev/HMR re-registration is safe.
//
// Each starter registers a disposer with src/lib/shutdown.ts. We bind SIGTERM
// here and run those disposers under a bounded budget, then exit explicitly:
// without this the four background intervals and the Discord gateway socket keep
// the event loop alive forever and systemd SIGKILLs us at TimeoutStopSec.
export async function register() {
  if (process.env.NEXT_RUNTIME === 'nodejs') {
    const { startScheduler } = await import('@/lib/scheduler');
    startScheduler();
    const { startDreaming } = await import('@/lib/dream');
    startDreaming();
    const { startReflecting } = await import('@/lib/akira/reflect');
    startReflecting();
    const { startDiscordBot } = await import('@/lib/discord-bot');
    startDiscordBot();
    const { startDiscordNotify } = await import('@/lib/discord-notify');
    startDiscordNotify();

    const { onShutdown, runShutdown } = await import('@/lib/shutdown');
    const { drainTurns } = await import('@/lib/turn-broker');

    // Registered last so the tickers above are already stopped: no new turn can
    // start while we drain. Each aborted turn releases its own lease via the
    // finally block in run-turn.ts.
    onShutdown(
      'turns',
      async () => {
        const { aborted, drained } = await drainTurns({ timeoutMs: 5000 });
        console.log(`[shutdown] turns aborted=${aborted} drained=${drained}`);
      },
      6000,
    );

    const g = globalThis as unknown as { __mcSignalsBound?: boolean };
    if (!g.__mcSignalsBound) {
      g.__mcSignalsBound = true;
      for (const signal of ['SIGTERM', 'SIGINT'] as const) {
        process.once(signal, () => {
          console.log(`[shutdown] ${signal} received`);
          void runShutdown({ timeoutMs: 8000, defaultBudgetMs: 1000 })
            .then((report) => {
              for (const r of report.results) {
                const flags = `${r.timedOut ? ' timeout' : ''}${r.error ? ` error=${r.error}` : ''}`;
                console.log(`[shutdown] ${r.name} ok=${r.ok} ${r.ms}ms${flags}`);
              }
              console.log(`[shutdown] complete in ${report.totalMs}ms`);
              // Explicit: open SSE sockets would otherwise keep the HTTP server
              // from closing, and the work they were streaming is already aborted.
              process.exit(0);
            })
            .catch((err) => {
              console.error('[shutdown] failed:', err);
              process.exit(1);
            });
        });
      }
    }
  }
}
