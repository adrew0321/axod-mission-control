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
import { readFile, lstat, symlink, unlink, rm } from 'node:fs/promises';
import { parseGitBranches } from './sessions';

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
 * Link the worktree's node_modules to the project's main checkout so build/test jobs
 * have working dependencies (incl. already-compiled native modules). Best-effort:
 * never throws — a failure just leaves the worktree without deps (read-only jobs still
 * work). Idempotent. No-op when the project has no node_modules. The teardown in
 * removeWorktree removes this link before deleting the worktree.
 */
async function linkNodeModules(worktreePath: string, repoPath: string): Promise<void> {
  const target = path.resolve(repoPath, 'node_modules'); // absolute: required for junctions
  const link = path.join(worktreePath, 'node_modules');
  try {
    if (!existsSync(target)) return; // non-Node project / deps not installed
    if (existsSync(link)) return; // already linked or present — idempotent
    await symlink(target, link, 'junction');
  } catch (err) {
    console.warn('[worktree] node_modules link failed:', err instanceof Error ? err.message : err);
  }
}

/**
 * True only if wtPath is its own real git worktree — not a stray/hollow dir that
 * git would resolve UPWARD to a parent repo (which is how a leftover dir inside the
 * app repo silently "becomes" the Mission Control repo). The local `.git` check is
 * the guard: a real linked worktree has its own `.git` file, a hollow dir does not —
 * so a dir that only resolves to a parent has no `.git` here and is rejected. The
 * rev-parse then confirms that `.git` actually points at a live working tree (not a
 * pruned/broken one). We avoid string-comparing `--show-toplevel` to wtPath: git
 * normalizes separators/realpaths differently per-OS, which gives false negatives.
 */
export async function isWorktreeValid(wtPath: string): Promise<boolean> {
  try {
    if (!existsSync(path.join(wtPath, '.git'))) return false;
    const { stdout } = await exec('git', ['-C', wtPath, 'rev-parse', '--is-inside-work-tree']);
    return stdout.trim() === 'true';
  } catch {
    return false;
  }
}

/**
 * Remove a stale/corrupt scratch dir at wtPath so it can be recreated cleanly.
 * Unlinks the node_modules link first (never recurse into the live node_modules),
 * tries git's own removal (clears registration if it IS a registered worktree),
 * then hard-deletes any leftover dir and prunes stale registrations. Best-effort.
 */
async function removeStaleWorktreeDir(wtPath: string, repoPath: string): Promise<void> {
  await unlinkNodeModulesLink(wtPath);
  await exec('git', ['-C', repoPath, 'worktree', 'remove', '--force', wtPath]).catch(() => {});
  await rm(wtPath, { recursive: true, force: true }).catch(() => {});
  await exec('git', ['-C', repoPath, 'worktree', 'prune']).catch(() => {});
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
  // An agent must only ever run in a real isolated worktree. Validate the source
  // repo up front so a bad/stale repoPath fails loudly here instead of letting the
  // caller fall back to running in the wrong directory.
  if (!repoPath || !existsSync(repoPath)) {
    throw new Error(`repo path does not exist: ${repoPath}`);
  }
  try {
    await exec('git', ['-C', repoPath, 'rev-parse', '--is-inside-work-tree']);
  } catch {
    throw new Error(`not a git repository: ${repoPath}`);
  }

  const wtPath = sessionWorktreePath(sessionId);
  const branch = sessionBranch(sessionId);

  if (existsSync(wtPath)) {
    if (await isWorktreeValid(wtPath)) {
      await linkNodeModules(wtPath, repoPath);
      return { path: wtPath, branch };
    }
    // Stale/corrupt scratch dir (e.g. a hollow dir with no .git that would resolve
    // to the parent repo). Remove and recreate — real session work lives on the
    // branch, not the loose dir, so this is safe.
    await removeStaleWorktreeDir(wtPath, repoPath);
  }

  if (await branchExists(repoPath, branch)) {
    // Branch left over from a prior session — attach the worktree to it.
    await exec('git', ['-C', repoPath, 'worktree', 'add', wtPath, branch]);
  } else {
    await exec('git', ['-C', repoPath, 'worktree', 'add', '-b', branch, wtPath, baseBranch]);
  }
  await linkNodeModules(wtPath, repoPath);
  return { path: wtPath, branch };
}

/**
 * Remove the `node_modules` junction/symlink from a worktree, if present. MUST run
 * before `git worktree remove` so the recursive delete can never traverse the link
 * into the project's real (live) node_modules. Removes the LINK only, never the target.
 */
async function unlinkNodeModulesLink(worktreePath: string): Promise<void> {
  const link = path.join(worktreePath, 'node_modules');
  try {
    const st = await lstat(link); // does not follow the link
    // Node reports a Windows junction as a symbolic link here; unlink removes the link.
    if (st.isSymbolicLink()) await unlink(link);
  } catch {
    /* no link present — nothing to do */
  }
}

/**
 * Remove a session's worktree. Leaves the branch intact (it may hold unpushed
 * work). Idempotent: no-op if the worktree is already gone.
 */
export async function removeWorktree(sessionId: string, repoPath: string): Promise<void> {
  const wtPath = sessionWorktreePath(sessionId);
  await unlinkNodeModulesLink(wtPath); // safety: never let git recurse into live node_modules
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
 * Find the worktree path where `branch` is currently checked out, or null.
 * Parses `git worktree list --porcelain` (blocks of `worktree`/`HEAD`/`branch` lines).
 */
async function worktreeForBranch(repoPath: string, branch: string): Promise<string | null> {
  const { stdout } = await exec('git', ['-C', repoPath, 'worktree', 'list', '--porcelain']);
  let current: string | null = null;
  for (const line of stdout.split('\n')) {
    if (line.startsWith('worktree ')) current = line.slice('worktree '.length).trim();
    else if (line.startsWith('branch ') && current) {
      if (line.slice('branch '.length).trim() === `refs/heads/${branch}`) return current;
    }
  }
  return null;
}

/**
 * Commit any uncommitted edits in a session's worktree onto its branch
 * (mc/<sessionId>), excluding node_modules. Returns true if it committed, false
 * when the tree was already clean. Shared by mergeWorktree and the writeback route.
 */
export async function commitWorktreeEdits(sessionId: string, repoPath: string): Promise<boolean> {
  const wtPath = sessionWorktreePath(sessionId);
  const branch = sessionBranch(sessionId);
  const { stdout: status } = await exec('git', ['-C', wtPath, 'status', '--porcelain']);
  if (!status.trim()) return false;
  await exec('git', ['-C', wtPath, 'reset', '-q', '--', 'node_modules']).catch(() => {}); // drop any pre-staged node_modules
  await exec('git', ['-C', wtPath, 'add', '-A', '--', '.', ':!node_modules']); // stage everything except node_modules
  await exec('git', [
    '-c', 'user.email=mc@axodcreative.com',
    '-c', 'user.name=Mission Control',
    '-C', wtPath, 'commit', '-m', `mission-control: ${branch}`,
  ]);
  return true;
}

/**
 * Apply a session's work to the project's base branch. Commits any loose edits on
 * mc/<sessionId>, then merges that branch into baseBranch.
 *
 * Critically, this NEVER `git checkout`s in the project repo: for the self-hosted
 * case the project repo IS this app's own live working directory, and switching its
 * branch would yank the running app onto another branch. Instead it merges wherever
 * the base branch is already checked out, or in a throwaway worktree it cleans up.
 *
 * On a merge conflict: aborts (no partial state) and returns { conflict }.
 * On success: removes the session worktree + deletes the branch, returns { ok:true }.
 * A non-merge failure throws — the caller maps it to a 500.
 */
export async function mergeWorktree(
  sessionId: string,
  repoPath: string,
  baseBranch: string,
): Promise<MergeResult> {
  const branch = sessionBranch(sessionId);

  // 1. Commit any uncommitted edits in the worktree so the branch carries them.
  await commitWorktreeEdits(sessionId, repoPath);

  // 2. Merge into the base WITHOUT disturbing the operator's working tree. If the base
  //    is already checked out somewhere, merge there; otherwise spin up a temp worktree.
  const existingBaseDir = await worktreeForBranch(repoPath, baseBranch);
  let tmpDir: string | null = null;
  let mergeDir: string;
  if (existingBaseDir) {
    mergeDir = existingBaseDir;
  } else {
    tmpDir = path.join(worktreeRoot(), `_merge_${sessionId}`);
    await exec('git', ['-C', repoPath, 'worktree', 'remove', '--force', tmpDir]).catch(() => {});
    await exec('git', ['-C', repoPath, 'worktree', 'add', tmpDir, baseBranch]);
    mergeDir = tmpDir;
  }

  const cleanupTmp = async () => {
    if (tmpDir) await exec('git', ['-C', repoPath, 'worktree', 'remove', '--force', tmpDir]).catch(() => {});
  };

  try {
    await exec('git', [
      '-c', 'user.email=mc@axodcreative.com',
      '-c', 'user.name=Mission Control',
      '-C', mergeDir, 'merge', '--no-ff', '-m', `Merge ${branch}`, branch]);
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    await exec('git', ['-C', mergeDir, 'merge', '--abort']).catch(() => {});
    await cleanupTmp();
    return { ok: false, conflict: true, message };
  }

  await cleanupTmp();

  // 3. Cleanup: remove the session worktree (detaches the branch) then delete the branch.
  await removeWorktree(sessionId, repoPath);
  await exec('git', ['-C', repoPath, 'branch', '-D', branch]).catch(() => {});
  return { ok: true };
}

/** Throw away a session's work: remove the worktree and delete the branch. */
export async function discardWorktree(sessionId: string, repoPath: string): Promise<void> {
  await removeWorktree(sessionId, repoPath);
  await exec('git', ['-C', repoPath, 'branch', '-D', sessionBranch(sessionId)]).catch(() => {});
}

/**
 * List the repo's branches (local + remote-tracking, de-duped, default first) for
 * the session base-branch picker. Best-effort: returns just [defaultBranch] when the
 * repo is missing/not a git repo, so the UI always has at least the default.
 */
export async function listBranches(repoPath: string, defaultBranch: string): Promise<string[]> {
  try {
    if (!repoPath || !existsSync(repoPath)) return [defaultBranch];
    const { stdout } = await exec('git', ['-C', repoPath, 'branch', '-a', '--format=%(refname:short)']);
    return parseGitBranches(stdout, defaultBranch);
  } catch {
    return [defaultBranch];
  }
}
