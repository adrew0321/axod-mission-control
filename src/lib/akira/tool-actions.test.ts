import { test } from 'node:test';
import assert from 'node:assert/strict';
import { navigateHandler, openHandler, relayHandler } from './tool-actions';

test('navigate emits a navigate event and confirms', async () => {
  const events: { type: string; [k: string]: unknown }[] = [];
  const res = await navigateHandler({ projectId: 'web', sessionId: 's1' }, { emit: (e) => events.push(e) });
  assert.equal(events[0].type, 'navigate');
  assert.equal(events[0].projectId, 'web');
  assert.equal(events[0].sessionId, 's1');
  assert.equal(res.isError ?? false, false);
});

test('open resolves a destination and emits open_url', async () => {
  const events: { type: string; [k: string]: unknown }[] = [];
  const res = await openHandler({ target: 'amazon', query: 'keyboard' }, { emit: (e) => events.push(e) });
  assert.equal(events[0].type, 'open_url');
  assert.match(String(events[0].url), /amazon\.com\/s\?k=keyboard/);
  assert.equal(res.isError ?? false, false);
});

test('open with an unknown target does not emit, returns error result', async () => {
  const events: { type: string; [k: string]: unknown }[] = [];
  const res = await openHandler({ target: 'nonsense place' }, { emit: (e) => events.push(e) });
  assert.equal(events.length, 0);
  assert.equal(res.isError, true);
});

test('relay PROPOSES only — emits relay_proposal and starts no work', async () => {
  const events: { type: string; [k: string]: unknown }[] = [];
  const res = await relayHandler(
    { projectId: 'web', sessionId: 's1', instruction: 'fix the signup bug' },
    { emit: (e) => events.push(e) },
  );
  assert.equal(events.length, 1);
  assert.equal(events[0].type, 'relay_proposal');
  assert.equal(events[0].sessionId, 's1');
  assert.equal(events[0].instruction, 'fix the signup bug');
  // No 'start'/'token'/'done' events — relay never runs a turn itself.
  assert.ok(!events.some((e) => ['start', 'token', 'done'].includes(e.type)));
  assert.equal(res.isError ?? false, false);
});
