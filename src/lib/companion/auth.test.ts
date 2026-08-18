import { test } from 'node:test';
import assert from 'node:assert/strict';
import { tokenMatches, resolveTarget } from './auth';

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

const SECRETS = { laptop: 'laptop-secret', room: 'room-secret' };

test('resolveTarget identifies the laptop secret', () => {
  assert.equal(resolveTarget('laptop-secret', SECRETS), 'laptop');
});

test('resolveTarget identifies the room secret', () => {
  assert.equal(resolveTarget('room-secret', SECRETS), 'room');
});

test('the room secret does NOT authenticate as the laptop', () => {
  // This is the whole point of Decision 5: a compromised room must not be able
  // to connect as ?target=laptop and receive the operator's browser commands.
  assert.notEqual(resolveTarget('room-secret', SECRETS), 'laptop');
});

test('resolveTarget returns null for an unknown token', () => {
  assert.equal(resolveTarget('neither', SECRETS), null);
});

test('resolveTarget returns null when the token is empty', () => {
  assert.equal(resolveTarget('', SECRETS), null);
  assert.equal(resolveTarget(undefined, SECRETS), null);
});

test('an unset room secret authenticates nobody as the room', () => {
  // Fail closed. Falling back to COMPANION_TOKEN would silently re-create the
  // very hole this task closes.
  assert.equal(resolveTarget('laptop-secret', { laptop: 'laptop-secret', room: undefined }), 'laptop');
  assert.equal(resolveTarget('anything', { laptop: 'laptop-secret', room: '' }), null);
});

test('when both secrets are the same value, laptop wins and the room fails closed', () => {
  // A misconfiguration (operator copies COMPANION_TOKEN into ROOM_COMPANION_TOKEN)
  // must be loud, not silent: the room's connect attempts 401 in its retry loop.
  const same = { laptop: 'shared', room: 'shared' };
  assert.equal(resolveTarget('shared', same), 'laptop');
});
