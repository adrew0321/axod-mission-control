import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chunkReply } from './discord-format';

test('short text → single chunk', () => {
  assert.deepEqual(chunkReply('hello'), ['hello']);
});

test('empty/whitespace text → single placeholder space (never empty)', () => {
  const out = chunkReply('');
  assert.equal(out.length, 1);
});

test('splits on newline boundaries under the max', () => {
  const text = 'a'.repeat(10) + '\n' + 'b'.repeat(10);
  const out = chunkReply(text, 12);
  assert.equal(out.length, 2);
  assert.ok(out.every((c) => c.length <= 12));
  assert.equal(out.join('\n').replace(/\n/g, ''), 'a'.repeat(10) + 'b'.repeat(10));
});

test('hard-splits a single token longer than max', () => {
  const out = chunkReply('x'.repeat(25), 10);
  assert.ok(out.every((c) => c.length <= 10));
  assert.equal(out.join(''), 'x'.repeat(25));
});

test('every chunk respects the max for realistic mixed text', () => {
  const text = Array.from({ length: 50 }, (_, i) => `line ${i} ${'z'.repeat(40)}`).join('\n');
  const out = chunkReply(text, 200);
  assert.ok(out.length > 1);
  assert.ok(out.every((c) => c.length <= 200));
});

import { scheduleEmbed, dreamEmbed, proposalEmbed } from './discord-format';

const run = (lastStatus: string | null) => ({
  id: 's', projectId: 'p', title: 'Nightly health check', lastRunAtMs: 1, lastStatus,
});

test('scheduleEmbed: color reflects status', () => {
  assert.equal(scheduleEmbed(run('ok')).color, 0x10b981);
  assert.equal(scheduleEmbed(run('fail')).color, 0xef4444);
  assert.equal(scheduleEmbed(run('error')).color, 0xef4444);
  assert.equal(scheduleEmbed(run(null)).color, 0xf59e0b);
  assert.match(String(scheduleEmbed(run('ok')).title), /Nightly health check/);
});

test('dreamEmbed: blue, shows status + insight count', () => {
  const e = dreamEmbed({ id: 'd', createdAtMs: 1, status: 'ok', insightCount: 3 });
  assert.equal(e.color, 0x3b82f6);
  assert.match(String(e.description), /3/);
});

test('proposalEmbed: blue, shows project + change counts + file count', () => {
  const e = proposalEmbed({
    sessionId: 's', sessionTitle: 'Add widget', projectId: 'p', projectName: 'AXOD MC',
    branch: 'mc/s', baseBranch: 'dev',
    files: [{ status: 'M', path: 'a.ts' }, { status: 'A', path: 'b.ts' }],
    additions: 10, deletions: 2, ts: '2026-06-25T00:00:00Z',
  });
  assert.equal(e.color, 0x3b82f6);
  const blob = JSON.stringify(e);
  assert.match(blob, /AXOD MC/);
  assert.match(blob, /\+10/);
  assert.match(blob, /-2/);
});
