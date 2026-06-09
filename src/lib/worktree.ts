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
import { readFile } from 'node:fs/promises';

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

export interface WorktreeFileDiff {
  path: string;
  /** git name-status code: A(dded) / M(odified) / D(eleted) / R(enamed)… */
  status: string;
  /** File contents at the base branch tip ('' for added files). */
  original: string;
  /** File contents in the worktree now ('' for deleted files). */
  modified: string;
  /** True when skipped for being binary or too large; original/modified are then a placeholder. */
  skipped?: boolean;
}

const MAX_DIFF_FILE_BYTES = 256 * 1024;

async function gitShow(wtPath: string, ref: string, path: string): Promise<string> {
  try {
    const { stdout } = await exec('git', ['-C', wtPath, 'show', `${ref}:${path}`], {
      maxBuffer: 10 * 1024 * 1024,
    });
    return stdout;
  } catch {
    // Path doesn't exist at that ref (e.g. an added file at base) — treat as empty.
    return '';
  }
}

/**
 * Per-file original/modified contents for a side-by-side diff view (Monaco).
 * `original` is the file at the base branch tip; `modified` is the worktree copy.
 * Binary/oversized files are flagged `skipped` rather than streamed.
 */
export async function diffWorktreeFiles(
  wtPath: string,
  baseBranch = 'dev',
): Promise<WorktreeFileDiff[]> {
  if (!wtPath || !existsSync(wtPath)) return [];

  const { files } = await diffWorktree(wtPath, baseBranch);

  return Promise.all(
    files.map(async (f) => {
      const isDeleted = f.status.startsWith('D');
      const isAdded = f.status.startsWith('A');
      const original = isAdded ? '' : await gitShow(wtPath, baseBranch, f.path);
      let modified = '';
      if (!isDeleted) {
        const abs = path.join(wtPath, f.path);
        try {
          modified = existsSync(abs) ? await readFile(abs, 'utf8') : '';
        } catch {
          modified = '';
        }
      }
      const tooBig =
        Buffer.byteLength(original, 'utf8') > MAX_DIFF_FILE_BYTES ||
        Buffer.byteLength(modified, 'utf8') > MAX_DIFF_FILE_BYTES;
      // A NUL byte is the standard heuristic for binary content.
      const nul = String.fromCharCode(0);
      const looksBinary = original.includes(nul) || modified.includes(nul);
      if (tooBig || looksBinary) {
        const note = looksBinary ? '// binary file — not shown' : '// file too large to display';
        return { path: f.path, status: f.status, original: note, modified: note, skipped: true };
      }
      return { path: f.path, status: f.status, original, modified };
    }),
  );
}

/** List worktree paths currently registered on the repo. */
export async function listWorktrees(repoPath: string): Promise<string[]> {
  const { stdout } = await exec('git', ['-C', repoPath, 'worktree', 'list', '--porcelain']);
  return stdout
    .split('\n')
    .filter((l) => l.startsWith('worktree '))
    .map((l) => l.slice('worktree '.length).trim());
}

export type MergeResult = { ok: true } | { ok: false; conflict: true; message: string };

/**
 * Apply a session's work to the project's base branch. Commits any loose edits on
 * mc/<sessionId>, then merges that branch into baseBranch in the project repo.
 * On a merge conflict: aborts (no partial state) and returns { conflict }.
 * On success: removes the worktree + deletes the branch, returns { ok:true }.
 * A non-merge failure (e.g. dirty base) throws — the caller maps it to a 500.
 */
export async function mergeWorktree(
  sessionId: string,
  repoPath: string,
  baseBranch: string,
): Promise<MergeResult> {
  const wtPath = sessionWorktreePath(sessionId);
  const branch = sessionBranch(sessionId);

  // 1. Commit any uncommitted edits in the worktree so the branch carries them.
  const { stdout: status } = await exec('git', ['-C', wtPath, 'status', '--porcelain']);
  if (status.trim()) {
    await exec('git', ['-C', wtPath, 'add', '-A']);
    await exec('git', ['-C', wtPath, 'commit', '-m', `mission-control: ${branch}`]);
  }

  // 2. Merge the branch into the base in the project repo.
  await exec('git', ['-C', repoPath, 'checkout', baseBranch]);
  try {
    await exec('git', ['-C', repoPath, 'merge', '--no-ff', '-m', `Merge ${branch}`, branch]);
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    await exec('git', ['-C', repoPath, 'merge', '--abort']).catch(() => {});
    return { ok: false, conflict: true, message };
  }

  // 3. Cleanup: remove the worktree (detaches the branch) then delete the branch.
  await removeWorktree(sessionId, repoPath);
  await exec('git', ['-C', repoPath, 'branch', '-D', branch]).catch(() => {});
  return { ok: true };
}

/** Throw away a session's work: remove the worktree and delete the branch. */
export async function discardWorktree(sessionId: string, repoPath: string): Promise<void> {
  await removeWorktree(sessionId, repoPath);
  await exec('git', ['-C', repoPath, 'branch', '-D', sessionBranch(sessionId)]).catch(() => {});
}
