import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { resolveWithinRoot } from './safe-path';

const root = path.resolve('/tmp/repo');

test('resolveWithinRoot resolves paths inside the root', () => {
  assert.equal(resolveWithinRoot(root, ''), root);
  assert.equal(resolveWithinRoot(root, 'src'), path.join(root, 'src'));
  assert.equal(resolveWithinRoot(root, 'src/lib/a.ts'), path.join(root, 'src/lib/a.ts'));
  assert.equal(resolveWithinRoot(root, '/src'), path.join(root, 'src'));
});

test('resolveWithinRoot rejects traversal escapes', () => {
  assert.equal(resolveWithinRoot(root, '../etc'), null);
  assert.equal(resolveWithinRoot(root, 'src/../../etc'), null);
  assert.equal(resolveWithinRoot(root, '../../'), null);
});
