import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildSnapshot } from './page-snapshot';

test('assigns sequential refs and keeps named interactives', () => {
  const snap = buildSnapshot({
    url: 'https://x.com', title: 'X', pageText: 'hello world',
    raw: [
      { tag: 'a', name: 'Inbox', href: '/mail' },
      { tag: 'button', name: 'Compose' },
      { tag: 'button', name: '' }, // nameless → dropped
    ],
  });
  assert.equal(snap.elements.length, 2);
  assert.equal(snap.elements[0].ref, 'e1');
  assert.equal(snap.elements[1].ref, 'e2');
  assert.equal(snap.elements[1].name, 'Compose');
});

test('trims long page text', () => {
  const snap = buildSnapshot({ url: 'u', title: 't', pageText: 'x'.repeat(5000), raw: [] }, 200, 1000);
  assert.ok(snap.text.length <= 1001);
});

test('caps the element count', () => {
  const raw = Array.from({ length: 500 }, (_, i) => ({ tag: 'button', name: `b${i}` }));
  const snap = buildSnapshot({ url: 'u', title: 't', pageText: '', raw }, 200);
  assert.equal(snap.elements.length, 200);
});
