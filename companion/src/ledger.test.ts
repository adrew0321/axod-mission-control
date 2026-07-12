// companion/src/ledger.test.ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readLedger, upsertLedger, getLedgerEntry } from './ledger';

function tmpFile(): string {
  const dir = mkdtempSync(join(tmpdir(), 'akira-ledger-'));
  return join(dir, 'ingest-ledger.json');
}

test('readLedger returns {} when the file is missing', async () => {
  assert.deepEqual(await readLedger(join(tmpdir(), 'does-not-exist-xyz.json')), {});
});

test('upsert then get round-trips an entry', async () => {
  const f = tmpFile();
  await upsertLedger('applications-employer', { localPath: 'C:/TEI/App', name: 'App', ingestedAt: '2026-07-09T00:00:00Z' }, f);
  const e = await getLedgerEntry('applications-employer', f);
  assert.equal(e?.localPath, 'C:/TEI/App');
  assert.equal(e?.name, 'App');
});

test('upsert overwrites the same projectId and preserves others', async () => {
  const f = tmpFile();
  await upsertLedger('a', { localPath: '/one', name: 'A', ingestedAt: 't1' }, f);
  await upsertLedger('b', { localPath: '/two', name: 'B', ingestedAt: 't2' }, f);
  await upsertLedger('a', { localPath: '/one-new', name: 'A', ingestedAt: 't3' }, f);
  assert.equal((await getLedgerEntry('a', f))?.localPath, '/one-new');
  assert.equal((await getLedgerEntry('b', f))?.localPath, '/two');
});

test('readLedger tolerates a corrupt file (returns {})', async () => {
  const f = tmpFile();
  writeFileSync(f, '{ not json');
  assert.deepEqual(await readLedger(f), {});
});

test('getLedgerEntry returns undefined for an unknown projectId', async () => {
  const f = tmpFile();
  await upsertLedger('a', { localPath: '/one', name: 'A', ingestedAt: 't1' }, f);
  assert.equal(await getLedgerEntry('unknown', f), undefined);
});
