import { loadConfig } from './config';
import { connect } from './connection';
import { execFs } from './fs-ops';
import { execShell } from './shell-ops';
import { watchDoorway } from './watcher';
import { isRoom } from './policy';
import type { Command, Result } from './protocol';

const cfg = loadConfig();
const tag = `[${cfg.mode}]`;

// One-at-a-time chain so writes never interleave — same discipline as the
// laptop companion's command chain.
let chain: Promise<void> = Promise.resolve();

const conn = connect(cfg, (cmd: Command) => {
  chain = chain
    .then(async () => {
      console.log(`${tag} exec`, cmd.action, cmd.command ?? cmd.path ?? '');
      let result: Result;
      try {
        result = cmd.action === 'shell'
          ? await execShell(cfg.policy, cmd)
          : await execFs(cfg.policy, cmd);
      } catch (e) {
        // An unexpected throw must still come back as a Result: never leave
        // Mission Control waiting on a promise that will not settle (spec D2).
        result = { id: cmd.id, status: 'error', reason: e instanceof Error ? e.message : String(e) };
      }
      if (result.status !== 'ok') console.warn(tag, result.status, result.reason);
      await conn.postResult(result);
    })
    .catch((err) => console.error(`${tag} result POST failed:`, err));
});

// Room only: there is no doorway on the host, and watchDoorway would throw on a
// path that isn't there.
const watcher = isRoom(cfg.policy)
  ? watchDoorway(cfg.policy.roots, (drop) => {
      console.log(`${tag} drop`, drop.zone, drop.name, `${drop.sizeBytes}b`);
      void conn.postDrop(drop);
    })
  : null;

console.log(
  `${tag} AKIRA mini agent started;`,
  isRoom(cfg.policy)
    ? `room: ${cfg.policy.roots.room} doorway: ${cfg.policy.roots.doorway}`
    : `host, default cwd: ${cfg.policy.defaultCwd}`,
);

function shutdown() {
  console.log(`\n${tag} shutting down…`);
  watcher?.stop();
  conn.stop();
  process.exit(0);
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
