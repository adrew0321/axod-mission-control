import { loadConfig } from './config';
import { connect } from './connection';
import { createBrowser } from './browser';
import type { Command } from './protocol';

const cfg = loadConfig();
const browser = createBrowser(cfg);

// One-at-a-time queue so page actions never interleave.
let chain: Promise<void> = Promise.resolve();

const conn = connect(cfg, (cmd: Command) => {
  chain = chain.then(async () => {
    console.log('[companion] exec', cmd.action, cmd.ref ?? cmd.url ?? '');
    const result = await browser.execute(cmd);
    await conn.postResult(result);
  });
});

console.log('[companion] AKIRA Local Companion started; profile:', cfg.profileDir);

async function shutdown() {
  console.log('\n[companion] shutting down…');
  conn.stop();
  await browser.close();
  process.exit(0);
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
