import { loadConfig } from './config';
import { connect } from './connection';
import { execFs } from './fs-ops';
import { execShell } from './shell-ops';
import { watchDoorway } from './watcher';
import { isRoom } from './policy';
import type { Command } from './protocol';

const cfg = loadConfig();
const tag = `[${cfg.mode}]`;

// One-at-a-time chain so writes never interleave — same discipline as the
// laptop companion's command chain.
let chain: Promise<void> = Promise.resolve();

const conn = connect(cfg, (cmd: Command) => {
  chain = chain
    .then(async () => {
      console.log(`${tag} exec`, cmd.action, cmd.command ?? cmd.path ?? '');
      // Task 5 teaches execShell/execFs to consume cfg.policy directly (room
      // roots vs. the host's unrestricted defaultCwd). Host-mode dispatch is
      // deliberately not wired here — that is out of scope for this task.
      if (!isRoom(cfg.policy)) {
        throw new Error(`${tag} command execution is not yet implemented for host mode`);
      }
      const result = cmd.action === 'shell'
        ? await execShell(cfg.policy.roots, cmd)
        : await execFs(cfg.policy.roots, cmd);
      if (result.status !== 'ok') console.warn(tag, result.status, result.reason);
      await conn.postResult(result);
    })
    .catch((err) => console.error(`${tag} command chain error:`, err));
});

const watcher = isRoom(cfg.policy)
  ? watchDoorway(cfg.policy.roots, (drop) => {
      console.log(`${tag} drop`, drop.zone, drop.name, `${drop.sizeBytes}b`);
      void conn.postDrop(drop);
    })
  : null;

console.log(
  `${tag} AKIRA agent started;`,
  isRoom(cfg.policy)
    ? `room: ${cfg.policy.roots.room} doorway: ${cfg.policy.roots.doorway}`
    : `defaultCwd: ${cfg.policy.defaultCwd}`,
);

function shutdown() {
  console.log(`\n${tag} shutting down…`);
  watcher?.stop();
  conn.stop();
  process.exit(0);
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
