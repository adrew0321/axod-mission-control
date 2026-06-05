import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validateRepoName, breadcrumbSegments } from './fs-browse';

test('validateRepoName accepts a plain name', () => {
  assert.deepEqual(validateRepoName('my-repo'), { ok: true });
});

test('validateRepoName rejects empty, separators, and dot names', () => {
  assert.equal(validateRepoName('   ').ok, false);
  assert.equal(validateRepoName('a/b').ok, false);
  assert.equal(validateRepoName('a\\b').ok, false);
  assert.equal(validateRepoName('.').ok, false);
  assert.equal(validateRepoName('..').ok, false);
});

test('breadcrumbSegments splits a Windows path into cumulative crumbs', () => {
  assert.deepEqual(breadcrumbSegments('C:\\Source\\TEI'), [
    { label: 'C:', path: 'C:\\' },
    { label: 'Source', path: 'C:\\Source' },
    { label: 'TEI', path: 'C:\\Source\\TEI' },
  ]);
});

test('breadcrumbSegments splits a POSIX path and handles a trailing slash', () => {
  assert.deepEqual(breadcrumbSegments('/home/a/'), [
    { label: '/', path: '/' },
    { label: 'home', path: '/home' },
    { label: 'a', path: '/home/a' },
  ]);
});
