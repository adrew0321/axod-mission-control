// Spec D5. A command that restarts or stops Mission Control kills the turn that
// issued it: the host agent survives, the turn does not. Such commands are
// dispatched fire-and-forget, and AKIRA is told what she STARTED rather than
// handed a result that will never arrive.
//
// This is a heuristic and it will miss creative phrasings (a script that
// restarts the unit, `kill` by pid). A miss degrades to the ordinary case: the
// turn dies mid-flight and the pre-dispatch log entry still explains why. The
// classifier improves the message, not the safety.

/** The systemd unit Mission Control runs as. */
const UNIT = 'mission-control';

/** systemctl verbs that would take the process down. Read-only verbs (status,
 *  cat, is-active, show) are deliberately absent — she should use those freely. */
const DISRUPTIVE_VERBS = ['restart', 'stop', 'kill', 'try-restart', 'reload-or-restart'];

/** Same-statement run: stops at a command separator OR a line break. A bare
 *  newline separates statements just as surely as `;` does. */
const SEP = '[^;&|\\n\\r]*?';

/** Matches e.g. `systemctl restart mission-control`, with or without a sudo
 *  prefix, extra flags, or a `.service` suffix — within a single statement. */
function hasDisruptiveSystemctl(command: string): boolean {
  const verbs = DISRUPTIVE_VERBS.join('|');
  // The unit name is anchored, not merely prefixed: \b would let
  // `mission-control-canary` match, which is a DIFFERENT unit. Require that no
  // word char, dot, or hyphen sits on either side.
  const re = new RegExp(
    `\\bsystemctl\\b${SEP}\\b(?:${verbs})\\b${SEP}(?<![\\w.-])${UNIT}(?:\\.service)?(?![\\w.-])`,
    'i',
  );
  return re.test(command);
}

/** `pkill -f "next start"`, `killall node` — blunt instruments that reach the
 *  server process. Narrow on purpose: `pkill` against something else is fine.
 *  The process name is anchored the same way the unit name is above: a bare
 *  `\b` is satisfied by a hyphen, so `pkill -f my-node-script`, `killall
 *  node-red`, and `pkill -f node-exporter` would all otherwise match. */
function killsTheServerProcess(command: string): boolean {
  return /\b(?:pkill|killall)\b[^;&|\n\r]*(?<![\w.-])(?:node|next)(?![\w.-])/i.test(command);
}

export function isSelfAffecting(command: string): boolean {
  const c = (command ?? '').trim();
  if (!c) return false;
  return hasDisruptiveSystemctl(c) || killsTheServerProcess(c);
}
