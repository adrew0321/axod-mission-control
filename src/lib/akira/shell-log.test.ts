import { test } from 'node:test';
import assert from 'node:assert/strict';
import { formatShellLogLine } from './shell-log';

const at = new Date('2026-08-15T09:30:00.000Z');

test('a line is one newline-terminated JSON object', () => {
  const line = formatShellLogLine({ at, event: 'dispatch', command: 'ls -la' });
  assert.ok(line.endsWith('\n'), 'JSONL lines must be newline-terminated');
  const parsed = JSON.parse(line);
  assert.equal(parsed.event, 'dispatch');
  assert.equal(parsed.command, 'ls -la');
  assert.equal(parsed.at, '2026-08-15T09:30:00.000Z');
});

test('a newline inside the command cannot forge a second log line', () => {
  const line = formatShellLogLine({
    at,
    event: 'dispatch',
    command: 'echo a\n{"event":"result","command":"innocent"}',
  });
  assert.equal(line.split('\n').filter(Boolean).length, 1, 'one event, one line');
  assert.match(JSON.parse(line).command, /innocent/);
});

test('optional fields are omitted when absent, present when given', () => {
  assert.equal(JSON.parse(formatShellLogLine({ at, event: 'dispatch', command: 'ls' })).cwd, undefined);
  const withAll = JSON.parse(
    formatShellLogLine({ at, event: 'result', command: 'ls', cwd: '/home/akira/workshop', exitCode: 0, status: 'ok' }),
  );
  assert.equal(withAll.cwd, '/home/akira/workshop');
  assert.equal(withAll.exitCode, 0);
  assert.equal(withAll.status, 'ok');
});

test('a null exit code (killed) survives the round trip', () => {
  const parsed = JSON.parse(formatShellLogLine({ at, event: 'result', command: 'sleep 9999', exitCode: null }));
  assert.equal(parsed.exitCode, null);
  assert.ok('exitCode' in parsed, 'a kill must be distinguishable from "not recorded"');
});
