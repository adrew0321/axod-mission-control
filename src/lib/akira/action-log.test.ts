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

test('cwd, status, and reason each land in the JSON with their own value when given', () => {
  const row = JSON.parse(formatActionLogLine({
    at: new Date(),
    target: 'host',
    event: 'gated',
    command: 'systemctl restart mission-control',
    cwd: '/srv/mission-control',
    status: 'blocked',
    reason: 'this would restart the service that is running the turn',
  }));
  assert.equal(row.cwd, '/srv/mission-control');
  assert.equal(row.status, 'blocked');
  assert.equal(row.reason, 'this would restart the service that is running the turn');
});

test('a null exit code (killed) survives the round trip, distinguishable from "not recorded"', () => {
  const row = JSON.parse(formatActionLogLine({
    at: new Date(), target: 'host', event: 'result', command: 'sleep 9999', exitCode: null,
  }));
  assert.equal('exitCode' in row, true, 'a kill must be recorded, not silently dropped like an absent field');
  assert.equal(row.exitCode, null);
});

test('status and reason can both be present at once and stay distinct', () => {
  const row = JSON.parse(formatActionLogLine({
    at: new Date(),
    target: 'host',
    event: 'result',
    command: 'systemctl status mission-control',
    status: 'error',
    reason: 'companion command timeout',
  }));
  assert.equal(row.status, 'error');
  assert.equal(row.reason, 'companion command timeout');
  assert.notEqual(row.status, row.reason, 'status is reserved for outcomes, never overloaded with the reason text');
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
