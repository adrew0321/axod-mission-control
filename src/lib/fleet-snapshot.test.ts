import { test } from 'node:test';
import assert from 'node:assert/strict';
import { getFleetSnapshot, emptySnapshot, type SnapshotContributor } from './fleet-snapshot';

test('merges slices from all contributors', async () => {
  const fakes: SnapshotContributor[] = [
    { key: 'health', collect: async () => ({ health: { verdict: 'pass', at: null } }) },
    { key: 'running', collect: async () => ({ running: [{ projectId: 'p', projectName: 'P', sessionId: 's' }] }) },
  ];
  const snap = await getFleetSnapshot(fakes);
  assert.equal(snap.health.verdict, 'pass');
  assert.equal(snap.running.length, 1);
  assert.deepEqual(snap.errors, []);
});

test('one throwing contributor degrades only its slice', async () => {
  const fakes: SnapshotContributor[] = [
    { key: 'proposals', collect: async () => { throw new Error('git blew up'); } },
    { key: 'health', collect: async () => ({ health: { verdict: 'fail', at: null } }) },
  ];
  const snap = await getFleetSnapshot(fakes);
  assert.deepEqual(snap.proposals, emptySnapshot().proposals); // unchanged default
  assert.equal(snap.health.verdict, 'fail'); // sibling still applied
  assert.ok(snap.errors.includes('proposals'));
});
