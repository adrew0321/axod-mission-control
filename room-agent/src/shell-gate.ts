// The room's ONLY brake on `shell`. Decision 7 in the spec: the one thing worth
// spending the operator's attention on is a process that outlives the command,
// because the Mini also hosts prod. Everything else runs free — the room is hers
// to break, and `lxc restore` makes breaking it cheap.
//
// Deliberately NOT gated: irreversible-looking commands (rm, git push, curl),
// and writes into the doorway. The spec rejects both by name.
// Pure — no fs, no deps, no process access.

/** Backgrounded with a trailing `&` (but not `&&`). */
const BACKGROUNDED = /(^|[^&])&\s*$/;

/** Detachers: the process is explicitly meant to survive this command. */
const DETACHED = /(^|[;&|]\s*)(nohup|setsid|screen|tmux|disown|systemctl|service)\b/i;

/** Dev servers and watchers — they never return on their own. */
const SERVER = /\b(?:npm|pnpm|yarn)\s+(?:run\s+)?(?:dev|start|serve|watch)\b|\b(?:next|vite|nodemon|webpack-dev-server)\s+(?:dev|start|serve)?\b|\bhttp\.server\b|\bnpx\s+serve\b|\bflask\s+run\b|\buvicorn\b|\bgunicorn\b/i;

/** Follow-mode readers. */
const FOLLOW = /\btail\s+-\w*f\b|\btail\s+--follow\b|\bjournalctl\s+[^|;]*-f\b|\bwatch\s+-n\b/i;

/** Unbounded loops. */
const LOOP = /\bwhile\s+(?:true|:)\b|\buntil\s+false\b|\bfor\s*\(\(\s*;;\s*\)\)/i;

/** `sleep N` where N exceeds the room's own command timeout is a parked process. */
const MAX_SLEEP_SEC = 60;

function longSleep(command: string): number | null {
  const m = command.match(/\bsleep\s+(\d+(?:\.\d+)?)([smhd]?)\b/i);
  if (!m) return null;
  const n = Number(m[1]);
  const mult = { s: 1, m: 60, h: 3600, d: 86400, '': 1 }[m[2].toLowerCase() as 's' | 'm' | 'h' | 'd' | ''];
  const secs = n * mult;
  return secs > MAX_SLEEP_SEC ? secs : null;
}

/**
 * Returns { gated: true, reason } when a command must wait for explicit operator
 * approval because it starts something that will not finish on its own.
 */
export function classifyShell(command: string): { gated: boolean; reason?: string } {
  const c = (command ?? '').trim();
  if (!c) return { gated: false };

  if (DETACHED.test(c)) return { gated: true, reason: 'starts a detached process that outlives this command' };
  if (BACKGROUNDED.test(c)) return { gated: true, reason: 'backgrounds the process with `&`' };
  if (SERVER.test(c)) return { gated: true, reason: 'starts a long-running server or watcher' };
  if (FOLLOW.test(c)) return { gated: true, reason: 'follows a stream and never returns' };
  if (LOOP.test(c)) return { gated: true, reason: 'runs an unbounded loop' };

  const secs = longSleep(c);
  if (secs !== null) return { gated: true, reason: `sleeps for ${secs}s, longer than a command should run` };

  return { gated: false };
}
