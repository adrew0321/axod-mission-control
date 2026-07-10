import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildState, parseClientMsg, type StateSnapshot } from './bridge-protocol';

const snap: StateSnapshot = {
  presence: { connected: true, operator: 'A\'Keem', host: 'LAPTOP', uptimeSec: 42, task: 'idle' },
  queue: [],
  security: { tokenAuthed: true, transport: 'outbound-only', profile: 'persistent · local', sensitiveCount: 2 },
  ingest: { phase: 'idle' },
  writeback: { phase: 'idle' },
};

test('buildState tags the snapshot as a state message', () => {
  const m = buildState(snap);
  assert.equal(m.type, 'state');
  assert.equal(m.presence.uptimeSec, 42);
  assert.equal(m.security.sensitiveCount, 2);
});

test('parseClientMsg accepts valid hello/approve/deny/stop', () => {
  assert.deepEqual(parseClientMsg('{"type":"hello","token":"abc"}'), { type: 'hello', token: 'abc' });
  assert.deepEqual(parseClientMsg('{"type":"approve","id":"c1"}'), { type: 'approve', id: 'c1' });
  assert.deepEqual(parseClientMsg('{"type":"deny","id":"c1"}'), { type: 'deny', id: 'c1' });
  assert.deepEqual(parseClientMsg('{"type":"stop"}'), { type: 'stop' });
});

test('parseClientMsg rejects garbage, bad types, and missing fields', () => {
  assert.equal(parseClientMsg('not json'), null);
  assert.equal(parseClientMsg('123'), null);
  assert.equal(parseClientMsg('{"type":"approve"}'), null);   // missing id
  assert.equal(parseClientMsg('{"type":"hello"}'), null);     // missing token
  assert.equal(parseClientMsg('{"type":"launch_nukes"}'), null);
});

test('buildState carries the ingest state', () => {
  const m = buildState({ ...snap, ingest: { phase: 'done', projectName: 'Applications.Employer', projectId: 'applications-employer' } });
  assert.equal(m.ingest.phase, 'done');
  assert.equal(m.ingest.projectId, 'applications-employer');
});

test('parseClientMsg accepts an ingest message with a path', () => {
  assert.deepEqual(parseClientMsg('{"type":"ingest","path":"C:/TEI/App"}'), { type: 'ingest', path: 'C:/TEI/App' });
});

test('parseClientMsg rejects an ingest message with no path', () => {
  assert.equal(parseClientMsg('{"type":"ingest"}'), null);
});

test("parseClientMsg accepts writeback:list", () => {
  assert.deepEqual(parseClientMsg(JSON.stringify({ type: 'writeback:list' })), { type: 'writeback:list' });
});
test("parseClientMsg accepts a well-formed writeback", () => {
  assert.deepEqual(
    parseClientMsg(JSON.stringify({ type: 'writeback', projectId: 'app', sessionId: 'sess_1' })),
    { type: 'writeback', projectId: 'app', sessionId: 'sess_1' },
  );
});
test("parseClientMsg rejects a writeback missing ids", () => {
  assert.equal(parseClientMsg(JSON.stringify({ type: 'writeback', projectId: 'app' })), null);
  assert.equal(parseClientMsg(JSON.stringify({ type: 'writeback', sessionId: 's' })), null);
});
test("buildState carries the writeback block", () => {
  const s = buildState({
    presence: { connected: false, operator: 'A', host: 'h', uptimeSec: 0, task: 'idle' },
    queue: [], security: { tokenAuthed: true, transport: 'outbound-only', profile: 'p', sensitiveCount: 0 },
    ingest: { phase: 'idle' },
    writeback: { phase: 'idle' },
  });
  assert.equal(s.writeback.phase, 'idle');
});
