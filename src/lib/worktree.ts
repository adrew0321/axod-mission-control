// Server-side git worktree manager. Each work session gets its own checkout
// so parallel sessions on the same repo don't collide. Pure git — no secrets
// or DB — so it's safe to unit-test via tsx (no 'server-only' guard).
//
// Uses execFile with an argv array (never a shell string), so paths containing
// an apostrophe (e.g. C:/Users/A'KeemDrew/...) are passed literally and need no
// escaping — this is the de-risk for the plan's flagged Windows/apostrophe concern.
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import path from 'node:path';
import { existsSync } from 'node:fs';

const exec = promisify(execFile);

export interface WorktreeInfo {
  path: string;
  branch: string;
}

/** Root directory under which per-session worktrees are created. */
export function worktreeRoot(): string {
  return process.env.WORKTREE_ROOT ?? path.join(process.cwd(), 'data', 'worktrees');
}

function sessionBranch(sessionId: string): string {
  return `mc/${sessionId}`;
}

function sessionWorktreePath(sessionId: string): string {
  return path.join(worktreeRoot(), sessionId);
}

async function branchExists(repoPath: string, branch: string): Promise<boolean> {
  try {
    await exec('git', ['-C', repoPath, 'rev-parse', '--verify', '--quiet', `refs/heads/${branch}`]);
    return true;
  } catch {
    return false;
  }
}

/**
 * Ensure a worktree exists for this session, checked out to a session-scoped
 * branch (`mc/<sessionId>`) forked from `baseBranch`. Idempotent: returns the
 * existing worktree if already present.
 */
export async function ensureWorktree(
  sessionId: string,
  repoPath: string,
  baseBranch = 'dev',
): Promise<WorktreeInfo> {
  const wtPath = sessionWorktreePath(sessionId);
  const branch = sessionBranch(sessionId);

  if (existsSync(wtPath)) return { path: wtPath, branch };

  if (await branchExists(repoPath, branch)) {
    // Branch left over from a prior session — attach the worktree to it.
    await exec('git', ['-C', repoPath, 'worktree', 'add', wtPath, branch]);
  } else {
    await exec('git', ['-C', repoPath, 'worktree', 'add', '-b', branch, wtPath, baseBranch]);
  }
  return { path: wtPath, branch };
}

/**
 * Remove a session's worktree. Leaves the branch intact (it may hold unpushed
 * work). Idempotent: no-op if the worktree is already gone.
 */
export async function removeWorktree(sessionId: string, repoPath: string): Promise<void> {
  const wtPath = sessionWorktreePath(sessionId);
  if (!existsSync(wtPath)) {
    await exec('git', ['-C', repoPath, 'worktree', 'prune']).catch(() => {});
    return;
  }
  await exec('git', ['-C', repoPath, 'worktree', 'remove', '--force', wtPath]);
}

export interface WorktreeDiff {
  /** Unified diff of the worktree's working tree against the base branch tip. */
  diff: string;
  /** Per-file change summary (git name-status), e.g. { status: 'M', path: 'src/x.astro' }. */
  files: Array<{ status: string; path: string }>;
}

/**
 * Diff everything done in this worktree against the base branch — captures both
 * commits on the session branch AND uncommitted working-tree edits, which is
 * exactly "what the dispatched agent changed this session." `baseBranch` is the
 * project's default branch (the fork point); it's assumed static for the session.
 *
 * Returns an empty diff (not an error) when the worktree path is missing, so the
 * caller can render a clean "no changes yet" state.
 */
export async function diffWorktree(wtPath: string, baseBranch = 'dev'): Promise<WorktreeDiff> {
  if (!wtPath || !existsSync(wtPath)) return { diff: '', files: [] };

  const [{ stdout: diff }, { stdout: nameStatus }] = await Promise.all([
    exec('git', ['-C', wtPath, 'diff', baseBranch, '--'], { maxBuffer: 10 * 1024 * 1024 }),
    exec('git', ['-C', wtPath, 'diff', '--name-status', baseBranch, '--']),
  ]);

  const files = nameStatus
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean)
    .map((l) => {
      const [status, ...rest] = l.split(/\s+/);
      return { status, path: rest.join(' ') };
    });

  return { diff, files };
}

/** List worktree paths currently registered on the repo. */
export async function listWorktrees(repoPath: string): Promise<string[]> {
  const { stdout } = await exec('git', ['-C', repoPath, 'worktree', 'list', '--porcelain']);
  return stdout
    .split('\n')
    .filter((l) => l.startsWith('worktree '))
    .map((l) => l.slice('worktree '.length).trim());
}
