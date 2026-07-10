// companion/src/writeback.ts
// Companion-side writeback: pull a session's commit bundle from the Mini and lay
// it into the local repo as a fast-forward-only review branch akira/<sessionId>.
// The Mini can never reach us; every call here is companion-initiated (outbound).
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { rm, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { WritebackProject } from './bridge-protocol';

const execFileAsync = promisify(execFile);

/**
 * Verify + fast-forward-only fetch a base..mc/<sessionId> bundle into
 * akira/<sessionId>. Never checks out; never forces. Throws a readable error on a
 * missing prerequisite (re-ingest) or a non-fast-forward (diverged branch).
 */
export async function applyBundleAsReviewBranch(
  localPath: string,
  sessionId: string,
  bundlePath: string,
): Promise<{ branch: string }> {
  const branch = `akira/${sessionId}`;

  try {
    await execFileAsync('git', ['-C', localPath, 'bundle', 'verify', bundlePath], { windowsHide: true });
  } catch {
    throw new Error('your local repo no longer has the base commit this work forked from — re-ingest to continue');
  }

  const refspec = `refs/heads/mc/${sessionId}:refs/heads/${branch}`; // no leading '+' => FF-only
  try {
    await execFileAsync('git', ['-C', localPath, 'fetch', bundlePath, refspec], { windowsHide: true });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (/non-fast-forward|rejected|fast[- ]forward/i.test(msg)) {
      throw new Error(`'${branch}' has diverged from Sage's work — rename or delete it, then pull again`);
    }
    throw new Error(`could not apply writeback: ${msg}`);
  }

  return { branch }; // commits/files come from the Mini's authoritative headers (downloadAndApply)
}

export async function downloadAndApply(
  cfg: { miniUrl: string; token: string },
  args: { sessionId: string; localPath: string },
  hooks: { onPhase: (p: 'downloading' | 'verifying' | 'applying') => void },
): Promise<{ branch: string; commits: number; files: number }> {
  hooks.onPhase('downloading');
  const qs = new URLSearchParams({ sessionId: args.sessionId });
  const res = await fetch(`${cfg.miniUrl}/api/companion/writeback?${qs.toString()}`, {
    method: 'POST',
    headers: { 'x-companion-token': cfg.token },
  });
  if (!res.ok) {
    const j = (await res.json().catch(() => null)) as { error?: string } | null;
    throw new Error(j?.error ?? `writeback failed (${res.status})`);
  }
  const commits = Number(res.headers.get('x-wb-commits')) || 0;
  const files = Number(res.headers.get('x-wb-files')) || 0;
  const buf = new Uint8Array(await res.arrayBuffer());

  const work = await mkdtemp(join(tmpdir(), 'akira-wb-'));
  const bundlePath = join(work, 'session.bundle');
  try {
    await writeFile(bundlePath, buf);
    hooks.onPhase('verifying');
    const r = await applyBundleAsReviewBranch(args.localPath, args.sessionId, bundlePath);
    hooks.onPhase('applying');
    return { branch: r.branch, commits, files }; // Mini's counts are authoritative
  } finally {
    await rm(work, { recursive: true, force: true }).catch(() => {});
  }
}

export async function fetchWritebackList(cfg: { miniUrl: string; token: string }): Promise<WritebackProject[]> {
  const res = await fetch(`${cfg.miniUrl}/api/companion/writeback/list`, {
    headers: { 'x-companion-token': cfg.token },
  });
  if (!res.ok) throw new Error(`writeback list failed (${res.status})`);
  const j = (await res.json()) as { projects?: WritebackProject[] };
  return j.projects ?? [];
}
