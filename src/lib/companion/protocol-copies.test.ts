import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

// pnpm test runs from the repo root.
const COPIES = [
  'src/lib/companion/protocol.ts',
  'companion/src/protocol.ts',
  'room-agent/src/protocol.ts',
];

test('all protocol copies are byte-identical', () => {
  const contents = COPIES.map((p) => readFileSync(join(process.cwd(), p), 'utf8'));
  const [first, ...rest] = contents;
  rest.forEach((c, i) => {
    assert.equal(c, first, `${COPIES[i + 1]} has drifted from ${COPIES[0]}`);
  });
});

test('the protocol declares the fs actions', () => {
  const src = readFileSync(join(process.cwd(), COPIES[0]), 'utf8');
  for (const action of ['fs_list', 'fs_read', 'fs_write']) {
    assert.ok(src.includes(`'${action}'`), `CommandAction is missing ${action}`);
  }
});

test('the protocol declares the shell action and its fields', () => {
  const src = readFileSync(join(process.cwd(), COPIES[0]), 'utf8');
  assert.ok(src.includes(`'shell'`), 'CommandAction is missing shell');
  assert.ok(/command\?: string/.test(src), 'Command is missing the command field');
  assert.ok(/cwd\?: string/.test(src), 'Command is missing the cwd field');
  assert.ok(/exitCode\?: number \| null/.test(src), 'Result is missing exitCode');
});

test('the protocol declares the gated flag on Result', () => {
  const src = readFileSync(join(process.cwd(), COPIES[0]), 'utf8');
  assert.ok(/gated\?: boolean/.test(src), 'Result is missing gated');
});
