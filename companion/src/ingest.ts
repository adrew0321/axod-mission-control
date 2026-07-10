import { existsSync } from 'node:fs';
import { rm, mkdtemp } from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import { Readable } from 'node:stream';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { upsertLedger } from './ledger';

const execFileAsync = promisify(execFile);

export function deriveIngestMeta(repoPath: string, headBranch: string): { name: string; branch: string } {
  // basename() is POSIX-separator only; normalise Windows backslashes first.
  const name = basename(repoPath.replace(/\\/g, '/')) || 'project';
  return { name, branch: headBranch.trim() || 'main' };
}

export function isGitRepo(repoPath: string): boolean {
  return existsSync(join(repoPath, '.git'));
}

export async function createBundle(repoPath: string, outPath: string): Promise<void> {
  await execFileAsync('git', ['bundle', 'create', outPath, '--all'], { cwd: repoPath, windowsHide: true });
}

async function currentBranch(repoPath: string): Promise<string> {
  try {
    const { stdout } = await execFileAsync('git', ['-C', repoPath, 'rev-parse', '--abbrev-ref', 'HEAD'], {
      windowsHide: true,
    });
    return stdout.trim();
  } catch {
    return '';
  }
}

export async function ingestRepo(
  cfg: { miniUrl: string; token: string },
  repoPath: string,
  hooks: { onPhase: (p: 'bundling' | 'uploading') => void },
): Promise<{ projectId: string; name: string }> {
  if (!isGitRepo(repoPath)) throw new Error('not a git repo (no .git found)');

  const meta = deriveIngestMeta(repoPath, await currentBranch(repoPath));
  const work = await mkdtemp(join(tmpdir(), 'akira-ingest-'));
  const bundlePath = join(work, 'repo.bundle');

  try {
    hooks.onPhase('bundling');
    await createBundle(repoPath, bundlePath);

    hooks.onPhase('uploading');
    const qs = new URLSearchParams({ name: meta.name, branch: meta.branch });
    const body = Readable.toWeb(createReadStream(bundlePath)) as unknown as ReadableStream<Uint8Array>;
    const res = await fetch(`${cfg.miniUrl}/api/companion/ingest?${qs.toString()}`, {
      method: 'POST',
      headers: { 'x-companion-token': cfg.token, 'Content-Type': 'application/octet-stream' },
      body,
      // Node fetch requires this when streaming a request body.
      // @ts-expect-error duplex is valid at runtime (undici) but missing from the DOM types.
      duplex: 'half',
    });
    const json = (await res.json().catch(() => null)) as { projectId?: string; error?: string } | null;
    if (!res.ok || !json?.projectId) {
      throw new Error(json?.error ?? `ingest failed (${res.status})`);
    }
    // The Mini already has the project; a failure to record the LOCAL ledger must
    // not be reported as an ingest failure (Mini ingest is create-only, so a
    // "re-ingest" retry would 409 and leave the project unreachable from here).
    // Preserve success and log the projectId + localPath so the operator can
    // hand-repair ~/.akira-companion/ingest-ledger.json.
    try {
      await upsertLedger(json.projectId, {
        localPath: repoPath,
        name: meta.name,
        ingestedAt: new Date().toISOString(),
      });
    } catch (ledgerErr) {
      console.error(
        `[companion] ingest: project ${json.projectId} was saved on AKIRA, but writing the ` +
          `local ledger failed — writeback to this laptop needs a manual ledger entry ` +
          `(projectId=${json.projectId}, localPath=${repoPath}):`,
        ledgerErr,
      );
    }
    return { projectId: json.projectId, name: meta.name };
  } finally {
    await rm(work, { recursive: true, force: true }).catch(() => {});
  }
}
