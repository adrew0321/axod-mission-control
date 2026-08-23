import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadConfig } from './config';
import { isHost, isRoom } from './policy';

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
    if (!isRoom(cfg.policy)) return assert.fail('default mode should be room');
    assert.equal(cfg.policy.roots.room, '/home/akira/workshop');
    assert.equal(cfg.policy.roots.doorway, '/mnt/doorway');
  });
});

test('honours overrides', () => {
  withEnv({ ROOM_TOKEN: 't', ROOM_ROOT: '/tmp/r', ROOM_DOORWAY: '/tmp/d' }, () => {
    const cfg = loadConfig();
    if (!isRoom(cfg.policy)) return assert.fail('default mode should be room');
    assert.equal(cfg.policy.roots.room, '/tmp/r');
    assert.equal(cfg.policy.roots.doorway, '/tmp/d');
  });
});

test('treats an empty-string root/doorway as absent and falls back to defaults', () => {
  withEnv({ ROOM_TOKEN: 't', ROOM_ROOT: '', ROOM_DOORWAY: '' }, () => {
    const cfg = loadConfig();
    if (!isRoom(cfg.policy)) return assert.fail('default mode should be room');
    assert.equal(cfg.policy.roots.room, '/home/akira/workshop');
    assert.equal(cfg.policy.roots.doorway, '/mnt/doorway');
  });
});

test('still throws on an empty-string token', () => {
  withEnv({ ROOM_TOKEN: '' }, () => {
    assert.throws(() => loadConfig(), /ROOM_TOKEN/);
  });
});

test('an unset AGENT_MODE defaults to room (existing container .env keeps working)', () => {
  withEnv({ AGENT_MODE: undefined, ROOM_TOKEN: 't' }, () => {
    const cfg = loadConfig();
    assert.equal(cfg.mode, 'room');
  });
});

test('host mode requires HOST_TOKEN, independent of ROOM_TOKEN', () => {
  withEnv({ AGENT_MODE: 'host', HOST_TOKEN: undefined, ROOM_TOKEN: 't' }, () => {
    assert.throws(() => loadConfig(), /HOST_TOKEN/);
  });
});

test('host mode defaults defaultCwd to / and honours HOST_DEFAULT_CWD', () => {
  withEnv({ AGENT_MODE: 'host', HOST_TOKEN: 't', HOST_DEFAULT_CWD: undefined }, () => {
    const cfg = loadConfig();
    if (!isHost(cfg.policy)) return assert.fail('host mode should narrow to host');
    assert.equal(cfg.policy.defaultCwd, '/');
  });
  withEnv({ AGENT_MODE: 'host', HOST_TOKEN: 't', HOST_DEFAULT_CWD: '/root' }, () => {
    const cfg = loadConfig();
    if (!isHost(cfg.policy)) return assert.fail('host mode should narrow to host');
    assert.equal(cfg.policy.defaultCwd, '/root');
  });
});

test('host mode defaults miniUrl to loopback; room mode defaults to the bridge address', () => {
  withEnv({ AGENT_MODE: 'host', HOST_TOKEN: 't', MINI_URL: undefined }, () => {
    assert.equal(loadConfig().miniUrl, 'http://127.0.0.1:3000');
  });
  withEnv({ AGENT_MODE: undefined, ROOM_TOKEN: 't', MINI_URL: undefined }, () => {
    assert.equal(loadConfig().miniUrl, 'http://10.0.0.1:3000');
  });
});
