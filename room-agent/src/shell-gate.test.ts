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
  // Fix-round additions (coordinator review, 2026-08-15):
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
];

for (const cmd of ungated) {
  test(`ungated: ${cmd}`, () => {
    assert.equal(classifyShell(cmd).gated, false, `${cmd} must run free`);
  });
}

const gated = [
  'npm run dev',
  'pnpm dev',
  'next start',
  'python -m http.server 8000',
  'nohup ./worker.sh',
  'tail -f /var/log/syslog',
  './server &',
  'while true; do echo hi; done',
  'sleep 3600',
  'nodemon index.js',
  // Fix-round additions (coordinator review, 2026-08-15):
  // A wrapper prefix (sudo, env, time, nice, ...) must not defeat the gate on
  // an always-detaching primitive.
  'sudo nohup ./worker.sh',
  'env nohup ./worker.sh',
  'time nohup ./worker.sh',
  'nice nohup ./worker.sh',
  // systemctl/service: mutating verbs park a long-running unit.
  'sudo systemctl start mission-control',
  'systemctl restart akira-room',
  // screen/tmux: starting a new session is exactly the outlives-the-command case.
  'screen -dmS work ./run.sh',
  'tmux new-session -d ./run.sh',
];

for (const cmd of gated) {
  test(`gated: ${cmd}`, () => {
    const v = classifyShell(cmd);
    assert.equal(v.gated, true, `${cmd} must be gated`);
    assert.ok(v.reason && v.reason.length > 0, 'a gated command must carry a reason');
  });
}

test('doorway writes are never gated by the shell', () => {
  // Decision 7: slice 1 already ships ungated fs_write to the doorway. Gating
  // the same action here would buy nothing and make the model incoherent.
  assert.equal(classifyShell('cp resume.md /mnt/doorway/inbox/resume.md').gated, false);
  assert.equal(classifyShell('echo done > /mnt/doorway/playground/reply.txt').gated, false);
});

test('an empty command is not gated (it is an ordinary error)', () => {
  assert.equal(classifyShell('').gated, false);
  assert.equal(classifyShell('   ').gated, false);
});

test('the reason names what was seen, not a generic warning', () => {
  assert.match(classifyShell('npm run dev').reason ?? '', /long-running|server/i);
});
