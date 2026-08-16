import { test } from 'node:test';
import assert from 'node:assert/strict';
import { registerCompanion, isOnline, sendCommand, resolveResult } from './registry';

test('offline send rejects', async () => {
  await assert.rejects(() => sendCommand({ action: 'read' }).result, /offline/i);
});

test('round-trips a command to a result by id', async () => {
  const seen: { id: string }[] = [];
  const unreg = registerCompanion({ send: (c) => seen.push(c) });
  assert.equal(isOnline(), true);
  const { id, result } = sendCommand({ action: 'read' });
  assert.equal(seen[0].id, id);
  resolveResult({ id, status: 'ok', text: 'done' });
  assert.equal((await result).text, 'done');
  unreg();
  assert.equal(isOnline(), false);
});

test('times out when no result arrives', async () => {
  const unreg = registerCompanion({ send: () => {} });
  const { result } = sendCommand({ action: 'read' }, 30); // 30ms timeout
  await assert.rejects(() => result, /timeout/i);
  unreg();
});

test('laptop and room are independent sinks', () => {
  const laptop: { id: string }[] = [];
  const room: { id: string }[] = [];
  const unregL = registerCompanion({ send: (c) => laptop.push(c) }, 'laptop');
  const unregR = registerCompanion({ send: (c) => room.push(c) }, 'room');

  assert.equal(isOnline('laptop'), true);
  assert.equal(isOnline('room'), true);

  sendCommand({ action: 'fs_list', path: '.' }, 1000, 'room').result.catch(() => {});
  assert.equal(room.length, 1);
  assert.equal(laptop.length, 0, 'a room command must not reach the laptop sink');

  unregL();
  unregR();
});

test('disconnecting the room does not fail laptop commands', async () => {
  const unregL = registerCompanion({ send: () => {} }, 'laptop');
  const unregR = registerCompanion({ send: () => {} }, 'room');

  const laptopCmd = sendCommand({ action: 'read' }, 1000, 'laptop');
  const roomCmd = sendCommand({ action: 'fs_list', path: '.' }, 1000, 'room');

  unregR(); // room drops

  await assert.rejects(() => roomCmd.result, /disconnected/i);
  resolveResult({ id: laptopCmd.id, status: 'ok', text: 'still here' });
  assert.equal((await laptopCmd.result).text, 'still here');

  unregL();
});

test('a displaced stream tearing down late leaves the live connection alone', async () => {
  // The room agent reconnects on a 3s backoff loop, so a new stream regularly
  // displaces an old one. The old stream's cleanup then runs *after* the new
  // one is live, and must not touch commands that belong to the new connection.
  const displaced = registerCompanion({ send: () => {} }, 'room');
  const seen: { id: string }[] = [];
  const live = registerCompanion({ send: (c) => seen.push(c) }, 'room');

  const cmd = sendCommand({ action: 'fs_list', path: '.' }, 1000, 'room');
  assert.equal(seen.length, 1, 'the command must go to the live sink');

  displaced(); // late teardown of the stream that was replaced

  assert.equal(isOnline('room'), true, 'the live sink must stay registered');
  resolveResult({ id: cmd.id, status: 'ok', text: 'survived' });
  assert.equal((await cmd.result).text, 'survived');

  live();
});

test('target defaults to laptop', () => {
  const seen: { id: string }[] = [];
  const unreg = registerCompanion({ send: (c) => seen.push(c) }); // no target
  assert.equal(isOnline(), true);
  assert.equal(isOnline('room'), false);
  sendCommand({ action: 'read' }).result.catch(() => {}); // no target
  assert.equal(seen.length, 1);
  unreg();
});
