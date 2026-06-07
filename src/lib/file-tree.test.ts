import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fileLanguage, fileIcon, EXCLUDED_DIRS } from './file-tree';

test('fileLanguage maps known extensions and defaults to plaintext', () => {
  assert.equal(fileLanguage('a.tsx'), 'typescript');
  assert.equal(fileLanguage('a.ts'), 'typescript');
  assert.equal(fileLanguage('a.js'), 'javascript');
  assert.equal(fileLanguage('a.astro'), 'html');
  assert.equal(fileLanguage('a.json'), 'json');
  assert.equal(fileLanguage('a.md'), 'markdown');
  assert.equal(fileLanguage('Dockerfile'), 'plaintext');
});

test('fileIcon returns an icon + color, with a default fallback', () => {
  assert.deepEqual(fileIcon('a.tsx'), { icon: 'FileCode', color: 'text-[#36c5f0]' });
  assert.equal(fileIcon('a.json').icon, 'Braces');
  assert.deepEqual(fileIcon('noext'), { icon: 'File', color: 'text-[#8b949e]' });
});

test('EXCLUDED_DIRS contains the heavy/noise dirs', () => {
  for (const d of ['node_modules', '.git', '.next', 'dist', '.superpowers']) {
    assert.ok(EXCLUDED_DIRS.has(d), `${d} excluded`);
  }
  assert.equal(EXCLUDED_DIRS.has('src'), false);
});
