import { test } from 'node:test';
import assert from 'node:assert/strict';
import { classifyClick } from './guard';
import type { RawEl } from './protocol';

const el = (p: Partial<RawEl>): RawEl => ({ ref: 'e1', tag: 'button', ...p });

test('gates a buy/checkout button', () => {
  assert.equal(classifyClick(el({ name: 'Place your order' }), 'https://amazon.com', []).gated, true);
  assert.equal(classifyClick(el({ name: 'Buy now' }), 'https://x.com', []).gated, true);
});

test('gates send / delete / transfer', () => {
  for (const name of ['Send', 'Delete account', 'Transfer funds', 'Confirm payment']) {
    assert.equal(classifyClick(el({ name }), 'https://x.com', []).gated, true, name);
  }
});

test('gates a submit on a sensitive domain regardless of label', () => {
  const r = classifyClick(el({ name: 'Continue', type: 'submit' }), 'https://mybank.com/transfer', ['mybank.com']);
  assert.equal(r.gated, true);
});

test('does NOT gate ordinary links/buttons', () => {
  assert.equal(classifyClick(el({ tag: 'a', name: 'Inbox', href: '/mail' }), 'https://outlook.com', []).gated, false);
  assert.equal(classifyClick(el({ name: 'Next page' }), 'https://x.com', []).gated, false);
});
