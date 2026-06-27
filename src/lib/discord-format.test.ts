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

import { buildActionId, parseActionId, proposalActionRow, proposalResultEmbed } from './discord-format';

test('buildActionId / parseActionId round-trip both actions', () => {
  assert.deepEqual(parseActionId(buildActionId('merge', 'sess_ab12')), { action: 'merge', sessionId: 'sess_ab12' });
  assert.deepEqual(parseActionId(buildActionId('discard', 'sess_ab12')), { action: 'discard', sessionId: 'sess_ab12' });
});

test('parseActionId returns null for foreign / malformed ids', () => {
  assert.equal(parseActionId('other:merge:x'), null);
  assert.equal(parseActionId('mc:bogus:x'), null);
  assert.equal(parseActionId('mc:merge'), null);
  assert.equal(parseActionId(''), null);
});

test('proposalActionRow has merge + discard buttons with correct ids/styles/labels', () => {
  const row = proposalActionRow('sess_ab12');
  assert.equal(row.type, 1);
  const btns = row.components as Array<{ type: number; style: number; label: string; custom_id: string }>;
  assert.equal(btns.length, 2);
  assert.deepEqual(
    { style: btns[0].style, label: btns[0].label, id: btns[0].custom_id },
    { style: 3, label: 'Approve & Merge', id: 'mc:merge:sess_ab12' },
  );
  assert.deepEqual(
    { style: btns[1].style, label: btns[1].label, id: btns[1].custom_id },
    { style: 4, label: 'Discard', id: 'mc:discard:sess_ab12' },
  );
});

test('proposalResultEmbed: color + text per kind', () => {
  const merged = proposalResultEmbed('merged', { baseBranch: 'dev', sessionTitle: 'Add widget' });
  assert.equal(merged.color, 0x10b981);
  assert.match(String(merged.title), /Merged into dev/);
  assert.match(String(merged.description), /Add widget/);
  assert.match(String(proposalResultEmbed('discarded').title), /Discarded/);
  assert.equal(proposalResultEmbed('discarded').color, 0x6e7681);
  assert.match(String(proposalResultEmbed('conflict').title), /conflict/i);
  assert.equal(proposalResultEmbed('conflict').color, 0xf59e0b);
  assert.match(String(proposalResultEmbed('stale').title), /already resolved/i);
});
