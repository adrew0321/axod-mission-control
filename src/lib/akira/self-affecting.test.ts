import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isSelfAffecting } from './self-affecting';

test('systemctl verbs that end the turn are caught', () => {
  for (const c of [
    'systemctl restart mission-control',
    'sudo systemctl restart mission-control',
    'systemctl stop mission-control.service',
    'sudo -n systemctl restart mission-control',
    'systemctl  restart   mission-control',
  ]) {
    assert.equal(isSelfAffecting(c), true, c);
  }
});

test('read-only systemctl verbs are NOT self-affecting', () => {
  for (const c of [
    'systemctl status mission-control',
    'systemctl is-active mission-control',
    'systemctl cat mission-control',
    'journalctl -u mission-control -n 50',
  ]) {
    assert.equal(isSelfAffecting(c), false, c);
  }
});

test('another unit is not self-affecting', () => {
  assert.equal(isSelfAffecting('systemctl restart cloudflared'), false);
  assert.equal(isSelfAffecting('systemctl restart akira-host-agent'), false);
});

test('a compound command containing a restart still counts', () => {
  assert.equal(isSelfAffecting('cd /srv/mission-control && systemctl restart mission-control'), true);
  assert.equal(isSelfAffecting('pnpm build; sudo systemctl restart mission-control'), true);
});

test('pkill / killall against the server process count', () => {
  assert.equal(isSelfAffecting('pkill -f "next start"'), true);
  assert.equal(isSelfAffecting('killall -9 node'), true);
});

test('ordinary commands do not', () => {
  for (const c of ['ls -la /srv/mission-control', 'cat .env', 'git -C /srv/mission-control status']) {
    assert.equal(isSelfAffecting(c), false, c);
  }
});

test('an empty or whitespace command is not self-affecting', () => {
  assert.equal(isSelfAffecting(''), false);
  assert.equal(isSelfAffecting('   '), false);
});
