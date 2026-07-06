import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildState, parseClientMsg, type StateSnapshot } from './bridge-protocol';

const snap: StateSnapshot = {
  presence: { connected: true, operator: 'A\'Keem', host: 'LAPTOP', uptimeSec: 42, task: 'idle' },
  queue: [],
  security: { tokenAuthed: true, transport: 'outbound-only', profile: 'persistent · local', sensitiveCount: 2 },
  ingest: { phase: 'idle' },
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
