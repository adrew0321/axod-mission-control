import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadConfig } from './config';

function withEnv(vars: Record<string, string | undefined>, fn: () => void): void {
  const saved: Record<string, string | undefined> = {};
  for (const k of Object.keys(vars)) {
    saved[k] = process.env[k];
    if (vars[k] === undefined) delete process.env[k];
    else process.env[k] = vars[k];
  }
  try {
    fn();
  } finally {
    for (const k of Object.keys(saved)) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  }
}

test('requires a token', () => {
  withEnv({ ROOM_TOKEN: undefined }, () => {
    assert.throws(() => loadConfig(), /ROOM_TOKEN/);
  });
});

test('defaults the roots to the container layout', () => {
  withEnv({ ROOM_TOKEN: 't', ROOM_ROOT: undefined, ROOM_DOORWAY: undefined }, () => {
    const cfg = loadConfig();
    assert.equal(cfg.roots.room, '/home/akira/workshop');
    assert.equal(cfg.roots.doorway, '/mnt/doorway');
  });
});

test('honours overrides', () => {
  withEnv({ ROOM_TOKEN: 't', ROOM_ROOT: '/tmp/r', ROOM_DOORWAY: '/tmp/d' }, () => {
    const cfg = loadConfig();
    assert.equal(cfg.roots.room, '/tmp/r');
    assert.equal(cfg.roots.doorway, '/tmp/d');
  });
});
