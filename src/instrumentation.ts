// Next.js startup hook (runs once per server process). Starts the in-process
// background tickers: the Scheduler, the Dreaming Curator, and the Discord Bot.
// Guarded to the Node runtime (not Edge); each starter is itself idempotent so
// dev/HMR re-registration is safe.
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
  }
}
