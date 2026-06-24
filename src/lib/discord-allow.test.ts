import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseAllowedIds, isAllowed } from './discord-allow';

test('parses a comma-separated list, trimming + dropping blanks', () => {
  const s = parseAllowedIds(' 111, 222 ,,333 ');
  assert.deepEqual([...s].sort(), ['111', '222', '333']);
});

test('undefined / empty → empty set', () => {
  assert.equal(parseAllowedIds(undefined).size, 0);
  assert.equal(parseAllowedIds('').size, 0);
  assert.equal(parseAllowedIds('  ').size, 0);
});

test('isAllowed matches exact ids only', () => {
  const s = parseAllowedIds('111,222');
  assert.equal(isAllowed('111', s), true);
  assert.equal(isAllowed('999', s), false);
});

test('empty allowlist denies everyone (fail closed)', () => {
  assert.equal(isAllowed('111', parseAllowedIds('')), false);
});
