import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openGate, decideGate, getGate, pendingGateCount, resolveDecision } from './gates';

test('an approved gate settles with approved', async () => {
  const { id, decision } = openGate({ target: 'room', reason: 'server', command: 'npm run dev' });
  assert.equal(decideGate(id, 'approved'), true);
  assert.equal(await decision, 'approved');
});

test('a denied gate settles with denied', async () => {
  const { id, decision } = openGate({ target: 'room', reason: 'server', command: 'npm run dev' });
  assert.equal(decideGate(id, 'denied'), true);
  assert.equal(await decision, 'denied');
});

test('an un-actioned gate auto-denies after its timeout', async () => {
  const { decision } = openGate({ target: 'room', reason: 'server', command: 'sleep 9999' }, 30);
  assert.equal(await decision, 'denied', 'silence is not consent');
});

test('deciding an unknown or already-decided gate returns false', async () => {
  const { id, decision } = openGate({ target: 'room', reason: 'r', command: 'c' });
  assert.equal(decideGate('gate_nope', 'approved'), false);
  decideGate(id, 'approved');
  await decision;
  assert.equal(decideGate(id, 'denied'), false, 'a gate settles exactly once');
});

test('the gate carries what the operator needs to see, and is cleared once decided', async () => {
  const before = pendingGateCount();
  const { id, decision } = openGate({ target: 'room', reason: 'starts a server', command: 'next dev' });
  const g = getGate(id);
  assert.equal(g?.command, 'next dev');
  assert.equal(g?.reason, 'starts a server');
  assert.equal(g?.target, 'room');
  assert.equal(pendingGateCount(), before + 1);
  decideGate(id, 'approved');
  await decision;
  assert.equal(getGate(id), undefined);
  assert.equal(pendingGateCount(), before);
});

test('gate ids are unique', () => {
  const a = openGate({ target: 'room', reason: 'r', command: 'c' }, 20);
  const b = openGate({ target: 'room', reason: 'r', command: 'c' }, 20);
  assert.notEqual(a.id, b.id);
  a.decision.catch(() => {});
  b.decision.catch(() => {});
});

test('resolveDecision requires an explicit "approved"; ambiguous input denies', () => {
  assert.equal(resolveDecision(undefined), 'denied', 'missing decision denies');
  assert.equal(resolveDecision(null), 'denied', 'null decision denies');
  assert.equal(resolveDecision('aproved'), 'denied', 'a misspelling denies');
  assert.equal(resolveDecision('approved'), 'approved', 'an explicit approval approves');
});

test('an ambiguous decision (missing, null, misspelled) settles the gate as denied', async () => {
  for (const bad of [undefined, null, 'aproved']) {
    const { id, decision } = openGate({ target: 'room', reason: 'r', command: 'c' });
    assert.equal(decideGate(id, resolveDecision(bad)), true);
    assert.equal(await decision, 'denied', `resolveDecision(${JSON.stringify(bad)}) must deny`);
  }
});

test('an explicit "approved" decision still approves the gate', async () => {
  const { id, decision } = openGate({ target: 'room', reason: 'r', command: 'c' });
  assert.equal(decideGate(id, resolveDecision('approved')), true);
  assert.equal(await decision, 'approved');
});

test('deciding a gate after its timeout already denied it returns false and does not re-settle', async () => {
  const { id, decision } = openGate({ target: 'room', reason: 'r', command: 'c' }, 30);
  assert.equal(await decision, 'denied', 'the timeout settles it first');
  assert.equal(decideGate(id, 'approved'), false, 'the timeout already settled this gate');
  assert.equal(getGate(id), undefined);
});
