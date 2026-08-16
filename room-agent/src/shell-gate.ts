// The room's ONLY brake on `shell`. Decision 7 in the spec: the one thing worth
// spending the operator's attention on is a process that outlives the command,
// because the Mini also hosts prod. Everything else runs free — the room is hers
// to break, and `lxc restore` makes breaking it cheap.
//
// Deliberately NOT gated: irreversible-looking commands (rm, git push, curl),
// and writes into the doorway. The spec rejects both by name.
// Pure — no fs, no deps, no process access.
//
// Fix round 2 (coordinator review, 2026-08-15): the round-1 patterns matched
// trigger words ANYWHERE in the raw command string, so `cat nohup.out` and
// `npm install nodemon` gated (false positives), and `sudo nohup ./worker.sh`
// stayed anchored-out (a false negative). Root cause fix: strip quoted spans,
// split into segments on control operators, and match tool patterns only
// against a segment's *command word* — the same shape a real shell resolves
// before it looks at anything else.

/** Strips every span wrapped in one of `quoteChars`, replacing it with a single
 * space. An unclosed quote absorbs the rest of the string (fails safe: the
 * remainder just disappears from matching, it never throws). */
function stripQuoted(s: string, quoteChars: string): string {
  let out = '';
  let i = 0;
  while (i < s.length) {
    const ch = s[i];
    if (quoteChars.includes(ch)) {
      const quote = ch;
      i++;
      while (i < s.length && s[i] !== quote) {
        if (s[i] === '\\' && i + 1 < s.length) i++;
        i++;
      }
      i++; // consume the closing quote (or, if unclosed, just falls off the end)
      out += ' ';
    } else {
      out += ch;
      i++;
    }
  }
  return out;
}

/**
 * A `&` used as a job-control operator, anywhere in the string — not only a
 * trailing one. Excludes `&&` (AND), `&>` (redirect stdout+stderr), and the
 * `&` in `N>&M` fd-duplication (e.g. `2>&1`).
 *
 * Fix round 2, Critical 1: the old regex only matched a *terminal* `&`, so
 * `./server & echo started` and `ls; ./server & echo ok` ran free — the gate
 * failing open on the one thing it exists to catch.
 */
function isBackgrounded(s: string): boolean {
  for (let i = 0; i < s.length; i++) {
    if (s[i] !== '&') continue;
    const prev = s[i - 1];
    const next = s[i + 1];
    if (next === '&') {
      i++; // skip the pair, neither half is job control
      continue;
    }
    if (next === '>') continue; // `&>` redirect
    if (prev === '>') continue; // `N>&M` fd duplication, e.g. `2>&1`
    return true;
  }
  return false;
}

/** Splits on `;`, `&&`, `||`, `|`, and a job-control `&` (the same exclusions
 * as {@link isBackgrounded} — a redirect `&` never starts a new segment). */
function splitSegments(s: string): string[] {
  const segments: string[] = [];
  let current = '';
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    const next = s[i + 1];
    if (ch === ';') {
      segments.push(current);
      current = '';
      continue;
    }
    if (ch === '|') {
      if (next === '|') i++;
      segments.push(current);
      current = '';
      continue;
    }
    if (ch === '&') {
      if (next === '&') {
        segments.push(current);
        current = '';
        i++;
        continue;
      }
      const prev = s[i - 1];
      if (next === '>' || prev === '>') {
        current += ch; // redirect-related `&`, not a segment boundary
        continue;
      }
      segments.push(current);
      current = '';
      continue;
    }
    current += ch;
  }
  segments.push(current);
  return segments;
}

const WRAPPER_PREFIXES = new Set(['sudo', 'env', 'time', 'nice', 'ionice']);

function isAssignment(token: string): boolean {
  return /^[A-Za-z_][A-Za-z0-9_]*=/.test(token);
}

/** Tokenizes a segment and drops any `VAR=value` assignments and known
 * wrapper prefixes (in any order/combination) so the real command word is
 * `tokens[0]`. Leading `(` / trailing `)` from subshell grouping are stripped
 * from each token so `(nohup` still resolves to `nohup`. */
function segmentTokens(segment: string): string[] {
  let tokens = segment
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .map((t) => t.replace(/^\(+/, '').replace(/\)+$/, ''))
    .filter(Boolean);

  let i = 0;
  while (i < tokens.length && (isAssignment(tokens[i]) || WRAPPER_PREFIXES.has(tokens[i]))) {
    i++;
  }
  return tokens.slice(i);
}

const ALWAYS_DETACHED_WORDS = new Set(['nohup', 'setsid', 'disown']);

/** screen/tmux: session managers. A subcommand that only inspects or tears
 * down an existing session is not "starting" one. */
const SESSION_NON_STARTING: Record<string, Set<string>> = {
  screen: new Set(['-ls', '-list']),
  tmux: new Set(['ls', 'list-sessions', 'kill-server', 'kill-session']),
};

function isSessionNonStarting(word: string, rest: string[]): boolean {
  const subcommands = SESSION_NON_STARTING[word];
  return subcommands !== undefined && rest.length > 0 && subcommands.has(rest[0]);
}

/** systemctl/service: only these verbs park a long-running unit. Matched as
 * a whole token (not a substring) so a unit named `my-app-start` cannot
 * masquerade as the verb `start`. */
const SERVICE_MUTATING_VERBS = new Set(['start', 'restart', 'reload', 'enable', 'daemon-reload']);

const NPM_LIKE = new Set(['npm', 'pnpm', 'yarn']);
const NPM_LONG_SUBCOMMANDS = new Set(['dev', 'start', 'serve', 'watch']);
const NEXT_VITE = new Set(['next', 'vite']);
const NEXT_VITE_LONG_SUBCOMMANDS = new Set(['dev', 'start', 'serve', 'preview']);
/** Long-running no matter what follows them. */
const BARE_LONG_RUNNING = new Set(['nodemon', 'webpack-dev-server', 'watch']);

/** Dev servers, watchers, and long-lived listeners — they never return on
 * their own. `next`/`vite`/`npm`-family require an explicit long-running
 * subcommand (a `build` is a one-shot compile); the rest are long-running
 * from the command word alone or from a specific flag. */
function isServerCommand(word: string, rest: string[]): boolean {
  if (BARE_LONG_RUNNING.has(word)) return true;

  if (NPM_LIKE.has(word)) {
    const sub = rest[0] === 'run' ? rest[1] : rest[0];
    return sub !== undefined && NPM_LONG_SUBCOMMANDS.has(sub);
  }
  if (NEXT_VITE.has(word)) {
    return rest[0] !== undefined && NEXT_VITE_LONG_SUBCOMMANDS.has(rest[0]);
  }
  if (word === 'python' || word === 'python3') {
    return rest[0] === '-m' && rest[1] === 'http.server';
  }
  if (word === 'npx') {
    return rest[0] === 'serve';
  }
  if (word === 'flask') {
    return rest[0] === 'run';
  }
  if (word === 'uvicorn' || word === 'gunicorn') return true;
  if (word === 'php') return rest.includes('-S');
  if (word === 'nc' || word === 'netcat') return rest.includes('-l');
  if (word === 'ssh') return rest.includes('-N');
  if (word === 'bun') return rest[0] === 'dev';
  if (word === 'deno') return rest[0] === 'task' && rest[1] === 'dev';

  return false;
}

/** `-f`/`--follow` anywhere among a `tail`/`journalctl` segment's arguments —
 * not just immediately after the command word (fix round 2, Important 4:
 * `tail -n 100 -f /var/log/syslog` was slipping through because the flag
 * wasn't in the position the old regex expected). */
function hasFollowFlag(rest: string[]): boolean {
  return rest.some((t) => t === '--follow' || /^-\w*f$/i.test(t));
}

/** Unbounded loops. Matched against the whole (quote-stripped) command since
 * the construct spans multiple control-operator segments (`while ...; do
 * ...; done`), not a single command word. */
const LOOP = /\bwhile\s+(?:true|:)\b|\buntil\s+false\b|\bfor\s*\(\(\s*;;\s*\)\)/i;

/** `sleep N` where N exceeds the room's own command timeout is a parked
 * process. Fix round 2, Important 5: uses `matchAll` and gates if ANY sleep
 * in the command exceeds the threshold — `sleep 5 && sleep 3600` used to
 * check only the first match and run free. */
const MAX_SLEEP_SEC = 60;

function longestSleepSeconds(command: string): number | null {
  const re = /\bsleep\s+(\d+(?:\.\d+)?)([smhd]?)\b/gi;
  let longest: number | null = null;
  for (const m of command.matchAll(re)) {
    const n = Number(m[1]);
    const mult = { s: 1, m: 60, h: 3600, d: 86400, '': 1 }[m[2].toLowerCase() as 's' | 'm' | 'h' | 'd' | ''];
    const secs = n * mult;
    if (secs > MAX_SLEEP_SEC && (longest === null || secs > longest)) longest = secs;
  }
  return longest;
}

function classifySegment(segment: string): { gated: boolean; reason?: string } | null {
  const tokens = segmentTokens(segment);
  if (tokens.length === 0) return null;
  const [word, ...rest] = tokens;

  if (ALWAYS_DETACHED_WORDS.has(word)) {
    return { gated: true, reason: 'starts a detached process that outlives this command' };
  }

  if (word === 'screen' || word === 'tmux') {
    if (isSessionNonStarting(word, rest)) return null;
    return { gated: true, reason: 'starts a screen/tmux session that outlives this command' };
  }

  if (word === 'systemctl' || word === 'service') {
    if (rest.some((t) => SERVICE_MUTATING_VERBS.has(t))) {
      return { gated: true, reason: 'starts, restarts, or enables a system service that outlives this command' };
    }
    return null;
  }

  if (isServerCommand(word, rest)) {
    return { gated: true, reason: 'starts a long-running server or watcher' };
  }

  // Generic `--watch` flag, independent of the command word (e.g. `npx tsc
  // --watch`, `npm test -- --watch`). Deliberately no bare `-w` alternative:
  // that collides with `grep -w` (word-match) and would be a false positive.
  if (tokens.includes('--watch')) {
    return { gated: true, reason: 'starts a long-running server or watcher' };
  }

  if ((word === 'tail' || word === 'journalctl') && hasFollowFlag(rest)) {
    return { gated: true, reason: 'follows a stream and never returns' };
  }

  return null;
}

/**
 * Returns { gated: true, reason } when a command must wait for explicit operator
 * approval because it starts something that will not finish on its own.
 */
export function classifyShell(command: string): { gated: boolean; reason?: string } {
  const c = (command ?? '').trim();
  if (!c) return { gated: false };

  const stripped = stripQuoted(c, `'"`);
  if (!stripped.trim()) return { gated: false };

  if (isBackgrounded(stripped)) return { gated: true, reason: 'backgrounds the process with `&`' };
  if (LOOP.test(stripped)) return { gated: true, reason: 'runs an unbounded loop' };

  const longest = longestSleepSeconds(stripped);
  if (longest !== null) return { gated: true, reason: `sleeps for ${longest}s, longer than a command should run` };

  for (const segment of splitSegments(stripped)) {
    const verdict = classifySegment(segment);
    if (verdict) return verdict;
  }

  return { gated: false };
}
