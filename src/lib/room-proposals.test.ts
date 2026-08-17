import { test } from 'node:test';
import assert from 'node:assert/strict';
import { formatBytes, summarizeDrop, inboxTurnInstruction, playgroundTurnInstruction } from './room-proposals';

test('formatBytes is readable at every scale', () => {
  assert.equal(formatBytes(0), '0 B');
  assert.equal(formatBytes(512), '512 B');
  assert.equal(formatBytes(2048), '2.0 KB');
  // Brief literally said 5.2 MB, but 5_400_000 / 1024 / 1024 = 5.1498... which
  // rounds to 5.1, not 5.2 (verified independently). Corrected to match the
  // arithmetic — see task-12-report.md for the full note.
  assert.equal(formatBytes(5_400_000), '5.1 MB');
});

test('a summary names the file, its type and its size', () => {
  const s = summarizeDrop({ name: 'resume.docx', ext: 'docx', sizeBytes: 42_000, head: '(binary docx file)' });
  assert.match(s, /resume\.docx/);
  assert.match(s, /docx/i);
  assert.match(s, /41\.0 KB|41 KB/);
});

test('a text summary carries a first line of content, condensed', () => {
  const s = summarizeDrop({
    name: 'notes.md',
    ext: 'md',
    sizeBytes: 300,
    head: '# Q3 plan\n\n\nShip the room.\nThen the browser.\n',
  });
  assert.match(s, /Q3 plan/);
  assert.ok(!s.includes('\n\n\n'), 'blank runs are collapsed');
  assert.ok(s.length <= 280, `summary must stay short, got ${s.length}`);
});

test('a very long head is truncated with an ellipsis', () => {
  const s = summarizeDrop({ name: 'long.md', ext: 'md', sizeBytes: 99_999, head: 'x'.repeat(2000) });
  assert.ok(s.length <= 280);
  assert.match(s, /…$/);
});

test('the inbox instruction names the path and says the operator approved it', () => {
  const i = inboxTurnInstruction({ name: 'resume.docx', path: '/mnt/doorway/inbox/resume.docx', summary: 'resume.docx · docx · 41 KB' });
  assert.match(i, /\/mnt\/doorway\/inbox\/resume\.docx/);
  assert.match(i, /approved/i);
});

test('the playground instruction says she may act directly', () => {
  const i = playgroundTurnInstruction({ name: 'sketch.md', path: '/mnt/doorway/playground/sketch.md', head: '# idea' });
  assert.match(i, /\/mnt\/doorway\/playground\/sketch\.md/);
  assert.match(i, /playground/i);
  assert.ok(!/approv/i.test(i), 'playground work is ungated — do not ask for approval');
});
