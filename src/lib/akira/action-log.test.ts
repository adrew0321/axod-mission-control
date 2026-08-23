import { test } from 'node:test';
import assert from 'node:assert/strict';
import { formatActionLogLine, actionLogPath } from './action-log';

test('a log line carries the target and is one JSON object', () => {
  const line = formatActionLogLine({
    at: new Date('2026-08-22T12:00:00.000Z'),
    target: 'host',
    event: 'dispatch',
    command: 'systemctl status mission-control',
  });
  assert.ok(line.endsWith('\n'));
  const row = JSON.parse(line);
  assert.equal(row.target, 'host');
  assert.equal(row.event, 'dispatch');
  assert.equal(row.at, '2026-08-22T12:00:00.000Z');
});

test('a newline in a command cannot forge a second log entry', () => {
  const line = formatActionLogLine({
    at: new Date(),
    target: 'host',
    event: 'dispatch',
    command: 'echo one\n{"forged":true}',
  });
  assert.equal(line.split('\n').length, 2, 'exactly one newline: the terminator');
  assert.equal(JSON.parse(line).command, 'echo one\n{"forged":true}');
});

test('optional fields are omitted rather than emitted as undefined', () => {
  const row = JSON.parse(formatActionLogLine({
    at: new Date(), target: 'room', event: 'result', command: 'true', exitCode: 0,
  }));
  assert.equal(row.exitCode, 0);
  assert.equal('cwd' in row, false);
  assert.equal('reason' in row, false);
});

test('actionLogPath prefers AKIRA_ACTION_LOG, falls back to ROOM_SHELL_LOG', () => {
  const saved = { a: process.env.AKIRA_ACTION_LOG, r: process.env.ROOM_SHELL_LOG };
  try {
    delete process.env.AKIRA_ACTION_LOG;
    process.env.ROOM_SHELL_LOG = '/tmp/legacy.log';
    assert.equal(actionLogPath(), '/tmp/legacy.log', 'an existing Mini keeps writing where it did');
    process.env.AKIRA_ACTION_LOG = '/tmp/new.log';
    assert.equal(actionLogPath(), '/tmp/new.log', 'the new name wins when both are set');
  } finally {
    if (saved.a === undefined) delete process.env.AKIRA_ACTION_LOG; else process.env.AKIRA_ACTION_LOG = saved.a;
    if (saved.r === undefined) delete process.env.ROOM_SHELL_LOG; else process.env.ROOM_SHELL_LOG = saved.r;
  }
});
