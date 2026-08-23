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

/** Matches e.g. `systemctl restart mission-control`, with or without a sudo
 *  prefix, extra flags, or a `.service` suffix — anywhere in a compound line. */
function hasDisruptiveSystemctl(command: string): boolean {
  const verbs = DISRUPTIVE_VERBS.join('|');
  const re = new RegExp(
    `\\bsystemctl\\b[^;&|]*?\\b(?:${verbs})\\b[^;&|]*?\\b${UNIT}(?:\\.service)?\\b`,
    'i',
  );
  return re.test(command);
}

/** `pkill -f "next start"`, `killall node` — blunt instruments that reach the
 *  server process. Narrow on purpose: `pkill` against something else is fine. */
function killsTheServerProcess(command: string): boolean {
  return /\b(?:pkill|killall)\b[^;&|]*\b(?:node|next|next start)\b/i.test(command);
}

export function isSelfAffecting(command: string): boolean {
  const c = (command ?? '').trim();
  if (!c) return false;
  return hasDisruptiveSystemctl(c) || killsTheServerProcess(c);
}
