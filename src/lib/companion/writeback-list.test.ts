import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { isIngestedRepo } from './writeback-list';

const root = join('/srv/app', 'data', 'ingested');

test('isIngestedRepo is true for a path under the ingested root', () => {
  assert.equal(isIngestedRepo(join(root, 'applications-employer'), root), true);
});
test('isIngestedRepo is false for a path outside the ingested root', () => {
  assert.equal(isIngestedRepo('/srv/app/some-other-repo', root), false);
});
test('isIngestedRepo is false for null/empty', () => {
  assert.equal(isIngestedRepo(null, root), false);
  assert.equal(isIngestedRepo('', root), false);
});
