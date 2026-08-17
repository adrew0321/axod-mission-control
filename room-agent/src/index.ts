import { loadConfig } from './config';
import { connect } from './connection';
import { execFs } from './fs-ops';
import { execShell } from './shell-ops';
import { watchDoorway } from './watcher';
import type { Command } from './protocol';

const cfg = loadConfig();

// One-at-a-time chain so writes never interleave — same discipline as the
// laptop companion's command chain.
let chain: Promise<void> = Promise.resolve();

const conn = connect(cfg, (cmd: Command) => {
  chain = chain
    .then(async () => {
      console.log('[room] exec', cmd.action, cmd.command ?? cmd.path ?? '');
      const result = cmd.action === 'shell'
        ? await execShell(cfg.roots, cmd)
        : await execFs(cfg.roots, cmd);
      if (result.status !== 'ok') console.warn('[room]', result.status, result.reason);
      await conn.postResult(result);
    })
    .catch((err) => console.error('[room] command chain error:', err));
});

const watcher = watchDoorway(cfg.roots, (drop) => {
  console.log('[room] drop', drop.zone, drop.name, `${drop.sizeBytes}b`);
  void conn.postDrop(drop);
});

console.log('[room] AKIRA room agent started; room:', cfg.roots.room, 'doorway:', cfg.roots.doorway);

function shutdown() {
  console.log('\n[room] shutting down…');
  watcher.stop();
  conn.stop();
  process.exit(0);
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
