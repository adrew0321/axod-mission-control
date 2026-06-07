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

test('Agent Team is the only live section', () => {
  const live = NAV_SECTIONS.filter((s) => s.status === 'live').map((s) => s.id);
  assert.deepEqual(live, ['agent-team']);
});
