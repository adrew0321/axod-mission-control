import { test } from 'node:test';
import assert from 'node:assert/strict';
import { NAV_SECTIONS } from './nav-sections';

test('NAV_SECTIONS has unique ids and required fields', () => {
  const ids = NAV_SECTIONS.map((s) => s.id);
  assert.equal(new Set(ids).size, ids.length, 'ids unique');
  for (const s of NAV_SECTIONS) {
    assert.ok(s.label && s.icon && s.group, `${s.id} has label/icon/group`);
    assert.ok(s.status === 'live' || s.status === 'soon');
    assert.ok(s.group === 'operational' || s.group === 'system');
  }
});

test('agent-team is live and every soon section stays soon', () => {
  const live = NAV_SECTIONS.filter((s) => s.status === 'live').map((s) => s.id);
  assert.ok(live.includes('agent-team'), 'agent-team is live');
  // Live sections are the ones with a real view wired up.
  assert.deepEqual(live, ['agent-team', 'live-feed', 'task-board', 'proposals']);
});
