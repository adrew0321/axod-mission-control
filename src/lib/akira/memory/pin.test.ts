import { test } from 'node:test';
import assert from 'node:assert/strict';
import { verifyPin, createLimiter } from './pin';

test('verifyPin matches only the exact PIN and rejects an empty secret', () => {
  assert.equal(verifyPin('4821', '4821'), true);
  assert.equal(verifyPin('4821', '0000'), false);
  assert.equal(verifyPin('anything', ''), false);
});

test('createLimiter blocks after max failures in the window, then recovers', () => {
  const lim = createLimiter(3, 1000);
  assert.equal(lim.allowed(0), true);
  lim.recordFailure(0); lim.recordFailure(0); lim.recordFailure(0);
  assert.equal(lim.allowed(0), false);
  assert.equal(lim.allowed(1001), true);
});

test('recordSuccess clears the failure count', () => {
  const lim = createLimiter(2, 1000);
  lim.recordFailure(0); lim.recordFailure(0);
  assert.equal(lim.allowed(0), false);
  lim.recordSuccess();
  assert.equal(lim.allowed(0), true);
});
