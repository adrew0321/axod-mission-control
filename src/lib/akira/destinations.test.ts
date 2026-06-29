import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolveDestination } from './destinations';

test('resolves a fixed destination by key', () => {
  const r = resolveDestination('outlook');
  assert.equal(r?.url, 'https://outlook.office.com/mail/');
});

test('resolves a fuzzy/cased name', () => {
  assert.equal(resolveDestination('Outlook inbox')?.url, 'https://outlook.office.com/mail/');
});

test('builds a search URL from a template', () => {
  const r = resolveDestination('amazon', 'desktop keyboard');
  assert.equal(r?.url, 'https://www.amazon.com/s?k=desktop%20keyboard');
});

test('search target without a query falls back to the site root', () => {
  const r = resolveDestination('youtube');
  assert.equal(r?.url, 'https://www.youtube.com/');
});

test('prefers the longest matching key (youtube studio over youtube)', () => {
  assert.equal(resolveDestination('open youtube studio')?.url, 'https://studio.youtube.com/');
});

test('unknown target returns null', () => {
  assert.equal(resolveDestination('teleport me to mars'), null);
});
