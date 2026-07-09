// src/lib/companion/writeback-repo.ts
// Mini-side writeback primitives: count/bundle a session branch's commits over
// its base. Pure node (no DB/server-only) so it is unit-tested against temp
// repos with real git. A git bundle carries objects only — no remotes — which is
// exactly the DevOps-isolation guarantee, in reverse of ingest.
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

export async function countCommitsAhead(repoPath: string, base: string, branch: string): Promise<number> {
  const { stdout } = await execFileAsync('git', ['-C', repoPath, 'rev-list', '--count', `${base}..${branch}`], { windowsHide: true });
  return Number(stdout.trim()) || 0;
}

export async function countChangedFiles(repoPath: string, base: string, branch: string): Promise<number> {
  const { stdout } = await execFileAsync('git', ['-C', repoPath, 'diff', '--name-only', `${base}..${branch}`], { windowsHide: true });
  return stdout.split('\n').map((l) => l.trim()).filter(Boolean).length;
}

export async function createSessionBundle(repoPath: string, base: string, branch: string, outPath: string): Promise<void> {
  // base..branch: the bundle contains `branch`'s commits and records `base` as a
  // prerequisite the laptop must already have. Names the ref refs/heads/<branch>.
  await execFileAsync('git', ['-C', repoPath, 'bundle', 'create', outPath, `${base}..${branch}`], { windowsHide: true });
}
