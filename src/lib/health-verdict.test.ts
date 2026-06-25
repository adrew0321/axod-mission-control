import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseHealthVerdict } from './health-verdict';

test('PASS token → pass', () => {
  assert.equal(parseHealthVerdict('all checks green\nHEALTH: PASS'), 'pass');
});

test('FAIL token → fail', () => {
  assert.equal(parseHealthVerdict('build broke\nHEALTH: FAIL'), 'fail');
});

test('multiple tokens → last occurrence wins', () => {
  assert.equal(parseHealthVerdict('HEALTH: PASS\nwait, no\nHEALTH: FAIL'), 'fail');
});

test('case-insensitive', () => {
  assert.equal(parseHealthVerdict('health: pass'), 'pass');
});

test('tolerant of backticks / emphasis around the token', () => {
  assert.equal(parseHealthVerdict('`HEALTH: FAIL`'), 'fail');
  assert.equal(parseHealthVerdict('**HEALTH: PASS**'), 'pass');
  assert.equal(parseHealthVerdict('HEALTH: `PASS`'), 'pass');
});

test('no token → null', () => {
  assert.equal(parseHealthVerdict('everything looks fine to me'), null);
});

test('bare HEALTH: with no PASS/FAIL does not false-positive', () => {
  assert.equal(parseHealthVerdict('We will check HEALTH: of the system later'), null);
});

test('empty / undefined-ish input → null', () => {
  assert.equal(parseHealthVerdict(''), null);
});
