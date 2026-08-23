import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isRoom, isHost, type ExecPolicy } from './policy';

const room: ExecPolicy = { mode: 'room', roots: { room: '/home/akira/workshop', doorway: '/mnt/doorway' } };
const host: ExecPolicy = { mode: 'host', defaultCwd: '/' };

test('the policy narrows by mode', () => {
  assert.equal(isRoom(room), true);
  assert.equal(isHost(room), false);
  assert.equal(isHost(host), true);
  assert.equal(isRoom(host), false);
});

test('narrowing gives access to the mode-specific fields', () => {
  if (isRoom(room)) assert.equal(room.roots.doorway, '/mnt/doorway');
  else assert.fail('room policy should narrow to room');
  if (isHost(host)) assert.equal(host.defaultCwd, '/');
  else assert.fail('host policy should narrow to host');
});
