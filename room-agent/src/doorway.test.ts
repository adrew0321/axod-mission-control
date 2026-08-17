import { test } from 'node:test';
import assert from 'node:assert/strict';
import { zoneForPath, isNoiseName, buildDropReport, MAX_HEAD_CHARS } from './doorway';

const roots = { room: '/home/akira/workshop', doorway: '/mnt/doorway' };

test('a file in inbox routes to inbox', () => {
  assert.equal(zoneForPath(roots, '/mnt/doorway/inbox/resume.docx'), 'inbox');
});

test('a file in playground routes to playground', () => {
  assert.equal(zoneForPath(roots, '/mnt/doorway/playground/sketch.md'), 'playground');
});

test('nested files still carry their folder\'s permission', () => {
  // The folder carries the permission — that must not stop at depth 1.
  assert.equal(zoneForPath(roots, '/mnt/doorway/inbox/old/2024/resume.docx'), 'inbox');
});

test('the doorway root itself is neither zone', () => {
  assert.equal(zoneForPath(roots, '/mnt/doorway/loose.txt'), null);
});

test('a file in the room is not a doorway drop', () => {
  assert.equal(zoneForPath(roots, '/home/akira/workshop/notes.md'), null);
});

test('a sibling folder with a zone-like prefix is not a zone', () => {
  assert.equal(zoneForPath(roots, '/mnt/doorway/inbox-old/x.txt'), null);
});

test('noise names are ignored', () => {
  for (const n of ['.DS_Store', '~$resume.docx', 'resume.docx.crdownload', 'a.txt.part', '.goutputstream-X1', 'x.swp']) {
    assert.equal(isNoiseName(n), true, `${n} must be treated as noise`);
  }
});

test('real files are not noise', () => {
  for (const n of ['resume.docx', 'notes.md', 'photo.JPG', 'archive.tar.gz']) {
    assert.equal(isNoiseName(n), false, `${n} must not be treated as noise`);
  }
});

test('a drop report carries name, ext and size', () => {
  const r = buildDropReport({
    zone: 'inbox',
    path: '/mnt/doorway/inbox/resume.docx',
    sizeBytes: 42_000,
    raw: Buffer.from('PKbinary'),
  });
  assert.equal(r.name, 'resume.docx');
  assert.equal(r.ext, 'docx');
  assert.equal(r.sizeBytes, 42_000);
  assert.equal(r.zone, 'inbox');
});

test('a binary head is reported as binary, not as mojibake', () => {
  const r = buildDropReport({
    zone: 'inbox',
    path: '/mnt/doorway/inbox/resume.docx',
    sizeBytes: 42_000,
    raw: Buffer.from([0x50, 0x4b, 0x03, 0x04, 0x00, 0x01, 0x02]),
  });
  assert.match(r.head, /binary/i);
});

test('a text head is truncated, never unbounded', () => {
  const r = buildDropReport({
    zone: 'inbox',
    path: '/mnt/doorway/inbox/long.md',
    sizeBytes: 999_999,
    raw: Buffer.from('x'.repeat(5000)),
  });
  assert.ok(r.head.length <= MAX_HEAD_CHARS + 40, 'the head read is bounded');
  // A length-only assertion would still pass if the binary path fired instead
  // (that marker string is also short). Pin the actual truncated content so
  // this test can only pass via the non-binary branch.
  assert.equal(r.head, 'x'.repeat(MAX_HEAD_CHARS));
});

test('a file with no extension reports an empty ext', () => {
  const r = buildDropReport({ zone: 'inbox', path: '/mnt/doorway/inbox/README', sizeBytes: 10, raw: Buffer.from('hi') });
  assert.equal(r.ext, '');
});

// --- Self-review additions beyond the brief ---

test('the zone directory itself, with no file under it, is not a drop', () => {
  // Watchers fire on files, not bare directories, but the routing rule
  // ("under this folder") must not accidentally treat the folder's own
  // path as being "under" itself.
  assert.equal(zoneForPath(roots, '/mnt/doorway/inbox'), null);
  assert.equal(zoneForPath(roots, '/mnt/doorway/playground'), null);
});

test('a dotfile-only name reports an empty ext, same as no extension at all', () => {
  // '.gitignore' has no extension in the conventional sense — the leading
  // dot is the whole name, not a separator before a suffix. It should read
  // the same as an extensionless file like README, not as ext === 'gitignore'.
  const dotfile = buildDropReport({
    zone: 'playground',
    path: '/mnt/doorway/playground/.gitignore',
    sizeBytes: 12,
    raw: Buffer.from('node_modules'),
  });
  const noExt = buildDropReport({
    zone: 'playground',
    path: '/mnt/doorway/playground/README',
    sizeBytes: 2,
    raw: Buffer.from('hi'),
  });
  assert.equal(dotfile.ext, '');
  assert.equal(noExt.ext, '');
});

test('a zero-byte file produces an empty, non-binary head without throwing', () => {
  const r = buildDropReport({
    zone: 'inbox',
    path: '/mnt/doorway/inbox/empty.txt',
    sizeBytes: 0,
    raw: Buffer.alloc(0),
  });
  assert.equal(r.head, '');
  assert.equal(r.sizeBytes, 0);
});

test('a UTF-8 character truncated at the raw buffer boundary does not throw or read as binary', () => {
  // Simulates a bounded upstream read that cut a multi-byte character in
  // half: 10 ASCII bytes followed by only the lead byte of '日' (0xE6 of a
  // 3-byte sequence). The lead byte is not a control byte, so this must
  // still be treated as text — Buffer#toString('utf8') self-heals the
  // dangling sequence into a single U+FFFD rather than throwing or producing
  // a wall of mojibake.
  const full = Buffer.concat([Buffer.from('a'.repeat(10)), Buffer.from('日本語', 'utf8')]);
  const cutMidCharacter = full.subarray(0, 11);
  const r = buildDropReport({
    zone: 'inbox',
    path: '/mnt/doorway/inbox/note.txt',
    sizeBytes: full.length,
    raw: cutMidCharacter,
  });
  assert.doesNotMatch(r.head, /binary/i);
  assert.ok(r.head.length <= MAX_HEAD_CHARS + 40, 'the head read stays bounded even with a split character');
  assert.equal(r.head.slice(0, 10), 'a'.repeat(10));
});
