import { test } from 'node:test';
import assert from 'node:assert/strict';
import { classifyShell } from './shell-gate';

const ungated = [
  'ls -la',
  'pandoc resume.docx -o resume.md',
  'git add -A && git commit -m "draft"',
  'git push origin main',
  'rm -rf ./scratch',
  'pip install python-docx',
  'python convert.py',
  'grep -r TODO .',
  'sleep 5',
  'cat /mnt/doorway/inbox/resume.docx | head -c 200',
  // Fix-round-1 additions (coordinator review, 2026-08-15):
  // `next`/`vite` only count as servers when the subcommand itself is
  // long-running; a build is a one-shot compile.
  'next build',
  'vite build',
  'npm run build',
  // systemctl/service: read-only inspection must run free — the operator
  // routinely inspects prod state from the room.
  'systemctl status mission-control',
  'systemctl --failed',
  // screen/tmux: querying existing sessions is a one-shot read, not a start.
  'screen -ls',
  'tmux ls',
  'service --status-all',

  // Fix-round-2 additions (coordinator review, 2026-08-15): root-cause fix —
  // patterns must match a segment's *command word*, not a trigger word
  // appearing anywhere in the raw string (as an argument, filename, or
  // package name).
  'cat nohup.out',
  'rm nohup.out',
  'grep -r nohup .',
  'cat tmux.conf',
  'vim ~/.tmux.conf',
  'ls /var/log/screen.log',
  'npm install nodemon',
  'npm i -D nodemon webpack-dev-server',
  'pip install gunicorn',
  'grep uvicorn requirements.txt',
  'NOHUP=1 ./worker.sh',
  // Quoted spans must be stripped before matching.
  'git commit -m "add nohup wrapper"',
  'echo "while true" > loop.md',
  'grep -n "tail -f" scripts/*.sh',

  // Critical 1: BACKGROUNDED must not misfire on `&&`, `&>`, or `N>&M` (fd
  // duplication, e.g. `2>&1`) once it starts scanning for `&` anywhere.
  'node script.js > out.txt 2>&1',
  'a && b',
  'a &&',
  'echo "a & b"',
  // Ambiguous case — see fix report: `&>` is a redirect operator per the
  // explicit exclusion rule, and this string has no *other* `&`, so under
  // that rule it must run free. Flagged for coordinator confirmation.
  './worker.sh &> out.log',

  // Important 4: a bare `-w` must never be treated as `--watch` (it's
  // `grep -w`'s word-match flag).
  'grep -w foo file.txt',

  // Minor: the mutating verb must anchor to a token, not a substring of a
  // unit name.
  'systemctl status my-app-start',
  'systemctl status restart-helper',
  // Minor: tmux teardown/inspection is not "starting" a session.
  'tmux kill-server',
  'tmux kill-session -t work',

  // Fix-round-3 addition (coordinator review, 2026-08-15): concern 2 was
  // confirmed correct as originally implemented (see the round-2 `&>` case
  // above) — re-verified with the `&>>` append form too.
  './worker.sh &>> out.log',

  // Fix-round-3: the "false-positive neighbor" of each new recursion case —
  // the trigger text is present but only as an inert *argument* to `echo`,
  // never as an actual `bash -c`/substitution invocation. These must stay
  // ungated by the SAME quote-aware tokenizer that lets the real cases gate.
  'echo "bash -c nohup"',
  'echo "sh -c server"',
  'echo "bash -c npm run dev"',
  // A `$(...)` inside SINGLE quotes is inert (single quotes suppress shell
  // expansion entirely) — must not be treated as a live command.
  "echo '$(nohup ./worker.sh)'",
  // A backtick span inside SINGLE quotes is likewise inert.
  "echo '`nohup ./x`'",

  // Fix-round-3: `-c` with no argument does nothing — there is no command
  // string to run, so it is not treated as a nested command.
  'bash -c',
];

for (const cmd of ungated) {
  test(`ungated: ${cmd}`, () => {
    assert.equal(classifyShell(cmd).gated, false, `${cmd} must run free`);
  });
}

// Important 6: assert not just that a gated command carries a reason, but
// that it gated for the RIGHT reason. This is how the original `next build`
// bug survived round 1 — it matched a server pattern and nobody checked
// which. Each pair is [command, pattern the reason must match].
const gated: [string, RegExp][] = [
  ['npm run dev', /long-running|server/i],
  ['pnpm dev', /long-running|server/i],
  ['next start', /long-running|server/i],
  ['python -m http.server 8000', /long-running|server/i],
  ['nohup ./worker.sh', /detached/i],
  ['tail -f /var/log/syslog', /follows|stream/i],
  ['./server &', /backgrounds|&/i],
  ['while true; do echo hi; done', /loop/i],
  ['sleep 3600', /sleeps for/i],
  ['nodemon index.js', /long-running|server/i],
  // Fix-round-1 additions.
  ['sudo nohup ./worker.sh', /detached/i],
  ['env nohup ./worker.sh', /detached/i],
  ['time nohup ./worker.sh', /detached/i],
  ['nice nohup ./worker.sh', /detached/i],
  ['sudo systemctl start mission-control', /service|systemctl/i],
  ['systemctl restart akira-room', /service|systemctl/i],
  ['screen -dmS work ./run.sh', /screen|tmux|session/i],
  ['tmux new-session -d ./run.sh', /screen|tmux|session/i],

  // Fix-round-2 additions.
  // Critical 1: `&` anywhere is job control, not just a trailing one.
  ['./server & echo started', /backgrounds|&/i],
  ['ls; ./server & echo ok', /backgrounds|&/i],
  ['(./server &)', /backgrounds|&/i],
  // Important 4: flag-anywhere / generic --watch / bare `watch`.
  ['tail -n 100 -f /var/log/syslog', /follows|stream/i],
  ['tail --lines=50 -f app.log', /follows|stream/i],
  ['watch free -h', /long-running|server|watcher/i],
  ['npx tsc --watch', /long-running|server|watcher/i],
  ['npm test -- --watch', /long-running|server|watcher/i],
  // Important 5: matchAll — gate if ANY sleep exceeds the threshold.
  ['sleep 5 && sleep 3600', /sleeps for/i],
  ['sleep 1; sleep 86400', /sleeps for/i],
  ['echo warming; sleep 2; sleep 7200', /sleeps for/i],
  ['sleep 3600; sleep 1', /sleeps for/i],
  // Newly recognised long-runners (same category, cheap to add).
  ['php -S 8080', /long-running|server/i],
  ['nc -l 4444', /long-running|server/i],
  ['ssh -N -L 8080:localhost:80 example.com', /long-running|server/i],
  ['bun dev', /long-running|server/i],
  ['deno task dev', /long-running|server/i],

  // Fix-round-3 additions (coordinator review, 2026-08-15): round 2's
  // quote-stripping hid a gated payload wrapped in `bash -c "…"` or
  // `$(…)`/backticks. These must be extracted and recursively classified
  // BEFORE the outer quotes are stripped.
  ['bash -c "nohup ./worker.sh"', /detached/i],
  ["sh -c './server &'", /backgrounds|&/i],
  ['bash -c "npm run dev"', /long-running|server/i],
  ['echo $(nohup ./worker.sh)', /detached/i],
  ['`nohup ./x`', /detached/i],
  // Design decision: a combined short-flag cluster containing `-c` (e.g.
  // `-lc`, login shell + command) still consumes the next argument as the
  // command string, so it must gate the same as bare `-c`.
  ['bash -lc "nohup ./worker.sh"', /detached/i],
  // Depth cap: 4 levels of `$(...)` nesting exceeds MAX_RECURSION_DEPTH (3).
  // The innermost command ("echo nohup") would actually be ungated on its
  // own merits (nohup is an argument to echo, not the command word) — this
  // command only gates because the recursion limit fails safe, not because
  // any level's content was found risky. Confirms the cap is load-bearing,
  // not just decorative.
  ['echo $(echo $(echo $(echo $(echo nohup))))', /recursion|depth|limit/i],
];

for (const [cmd, reasonPattern] of gated) {
  test(`gated: ${cmd}`, () => {
    const v = classifyShell(cmd);
    assert.equal(v.gated, true, `${cmd} must be gated`);
    assert.ok(v.reason && v.reason.length > 0, 'a gated command must carry a reason');
    assert.match(v.reason ?? '', reasonPattern, `reason "${v.reason}" did not match the expected cause`);
  });
}

test('doorway writes are never gated by the shell', () => {
  // Decision 7: slice 1 already ships ungated fs_write to the doorway. Gating
  // the same action here would buy nothing and make the model incoherent.
  assert.equal(classifyShell('cp resume.md /mnt/doorway/inbox/resume.md').gated, false);
  assert.equal(classifyShell('echo done > /mnt/doorway/playground/reply.txt').gated, false);
});

test('doorway writes are never gated even when the path or payload contains a trigger word', () => {
  // Fix round 2: the existing doorway test passed only because its fixtures
  // used neutral filenames — it did not defend the invariant. These
  // deliberately plant "screen", "nohup", and "tmux" in the path AND payload.
  assert.equal(classifyShell('tee /mnt/doorway/inbox/nohup-notes.txt').gated, false);
  assert.equal(classifyShell('cp /mnt/doorway/inbox/screen.png ~/').gated, false);
  assert.equal(classifyShell('echo "the screen is blank" > /mnt/doorway/inbox/note.txt').gated, false);
  assert.equal(
    classifyShell('echo "kill the tmux session first" > /mnt/doorway/playground/tmux-reminder.txt').gated,
    false,
  );
});

test('an empty command is not gated (it is an ordinary error)', () => {
  assert.equal(classifyShell('').gated, false);
  assert.equal(classifyShell('   ').gated, false);
});

test('the reason names what was seen, not a generic warning', () => {
  assert.match(classifyShell('npm run dev').reason ?? '', /long-running|server/i);
});
