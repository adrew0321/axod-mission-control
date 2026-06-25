import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseHealthVerdict, healthStatus } from './health-verdict';

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

test('completed + FAIL verdict → fail', () => {
  assert.equal(healthStatus({ status: 'completed' }, 'oops\nHEALTH: FAIL'), 'fail');
});

test('completed + PASS verdict → ok', () => {
  assert.equal(healthStatus({ status: 'completed' }, 'HEALTH: PASS'), 'ok');
});

test('completed + no verdict → ok (non-health jobs unaffected)', () => {
  assert.equal(healthStatus({ status: 'completed' }, 'here is your digest'), 'ok');
  assert.equal(healthStatus({ status: 'completed' }, null), 'ok');
});

test('skipped → skipped, error → error (verdict ignored)', () => {
  assert.equal(healthStatus({ status: 'skipped' }, 'HEALTH: PASS'), 'skipped');
  assert.equal(healthStatus({ status: 'error' }, 'HEALTH: PASS'), 'error');
});
