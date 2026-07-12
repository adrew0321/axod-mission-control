import { test } from 'node:test';
import assert from 'node:assert/strict';
import { tokenMatches } from './auth';

test('tokenMatches is true for an exact match', () => {
  assert.equal(tokenMatches('s3cret-abc', 's3cret-abc'), true);
});
test('tokenMatches is false for a mismatch', () => {
  assert.equal(tokenMatches('wrong', 's3cret-abc'), false);
});
test('tokenMatches is false when either side is empty/undefined/null', () => {
  assert.equal(tokenMatches('', 's3cret'), false);
  assert.equal(tokenMatches('s3cret', ''), false);
  assert.equal(tokenMatches(undefined, 's3cret'), false);
  assert.equal(tokenMatches('s3cret', null), false);
});
test('tokenMatches distinguishes tokens of different lengths without throwing', () => {
  // timingSafeEqual requires equal-length buffers; hashing both sides first keeps
  // it safe for arbitrary-length inputs.
  assert.equal(tokenMatches('short', 'a-much-longer-secret-value'), false);
});
