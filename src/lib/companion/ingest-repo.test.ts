import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, existsSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { streamToFileWithCap, cloneBundleIntoProject } from './ingest-repo';

function tmp(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

function streamOf(bytes: number[]): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start(c) { c.enqueue(new Uint8Array(bytes)); c.close(); },
  });
}

test('streamToFileWithCap writes bytes and returns the count', async () => {
  const dir = tmp('mc-cap-');
  const dest = join(dir, 'out.bin');
  const n = await streamToFileWithCap(streamOf([1, 2, 3, 4]), dest, 100);
  assert.equal(n, 4);
  assert.deepEqual([...readFileSync(dest)], [1, 2, 3, 4]);
  rmSync(dir, { recursive: true, force: true });
});

test('streamToFileWithCap throws and cleans up when over the cap', async () => {
  const dir = tmp('mc-cap-');
  const dest = join(dir, 'out.bin');
  await assert.rejects(() => streamToFileWithCap(streamOf([1, 2, 3, 4, 5]), dest, 3), RangeError);
  assert.equal(existsSync(dest), false);
  rmSync(dir, { recursive: true, force: true });
});

test('cloneBundleIntoProject clones the bundle and removes origin (DevOps isolation)', async () => {
  const work = tmp('mc-src-');
  // Build a source repo with a fake DevOps origin, then bundle it.
  execFileSync('git', ['init', '-b', 'main'], { cwd: work });
  execFileSync('git', ['config', 'user.email', 't@t'], { cwd: work });
  execFileSync('git', ['config', 'user.name', 'T'], { cwd: work });
  execFileSync('git', ['remote', 'add', 'origin', 'https://devops.example/secret.git'], { cwd: work });
  writeFileSync(join(work, 'hello.txt'), 'hi');
  execFileSync('git', ['add', '-A'], { cwd: work });
  execFileSync('git', ['commit', '-m', 'init'], { cwd: work });
  const bundle = join(work, 'repo.bundle');
  execFileSync('git', ['bundle', 'create', bundle, '--all'], { cwd: work });

  const destParent = tmp('mc-dest-');
  const dest = join(destParent, 'applications-employer');
  await cloneBundleIntoProject(bundle, dest);

  assert.equal(existsSync(join(dest, '.git')), true);
  assert.equal(existsSync(join(dest, 'hello.txt')), true);
  const remotes = execFileSync('git', ['-C', dest, 'remote', '-v']).toString().trim();
  assert.equal(remotes, ''); // origin removed — the Mini has NO path back to DevOps

  rmSync(work, { recursive: true, force: true });
  rmSync(destParent, { recursive: true, force: true });
});
