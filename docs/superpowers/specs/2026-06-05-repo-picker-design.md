# Add-project Repo Picker + Create-repo (Epic B) — Design

**Date:** 2026-06-05
**Branch:** `feature/repo-picker` (off `dev`)
**Scope:** Upgrade the Add-project modal so the operator can **browse the machine's folders** to pick an existing local git repo, or **create a new local repo** (mkdir + `git init`) — instead of typing the path. Epic B of the three File-Explorer follow-ups (A shipped: File Explorer; C: broader theme polish).

---

## Current state

- `AddProjectDialog` (`src/components/add-project-dialog.tsx`) is a form: **Name**, **Repo path** (typed), **Default branch**, **GitHub URL** → `POST /api/projects`.
- `POST /api/projects` (`src/app/api/projects/route.ts`): validates the path exists + is a directory + contains `.git`, slugifies an id (collision-safe), inserts the project, creates an initial session (`getOrCreateActiveSession`), sets the `mc_active_project` cookie.
- The Epic-A files API lists **within** a project's `repo_path`. There is **no** capability to browse arbitrary machine directories — Epic B adds one.

## MVP scope (decided)

**In:** a folder browser in the modal (pick an existing repo) + a "Create new" mode (mkdir + `git init` + register). **Out:** cloning remote repos, browsing/selecting files (that's the File Explorer), editing/removing projects.

## 1. Server — browse route (`GET /api/fs/browse`)

`GET /api/fs/browse?path=<absolute>` → lists the **sub-directories** of an absolute machine path. Auth-gated (`SESSION_COOKIE`/`verifySession`, 401). Returns:
```ts
{ path: string; parent: string | null; entries: { name: string; isRepo: boolean }[]; drives: string[] }
```
- `path` defaults to `os.homedir()` when the param is missing/empty.
- `entries`: immediate subdirectories only (files omitted — we pick folders), alphabetical; each `isRepo` = it contains a `.git` entry. Dirs that error on read (permission denied) are skipped, not fatal.
- `parent`: `path.dirname(path)`, or `null` when already at a filesystem/drive root.
- `drives`: on Windows, the available drive roots (e.g. `["C:\\", "D:\\"]`) for the drive switcher; `[]` on non-Windows. (Probe `A:`–`Z:` via `existsSync`.)

**Security note (in code):** this route reads the operator's own filesystem. It is acceptable only because Mission Control is a **single-user, auth-gated, local** tool. A comment marks it as must-stay-gated and **not for multi-user/hosted** deployment.

## 2. Server — extend `POST /api/projects` with a `create` flag

Body gains `create?: boolean`.
- **`create` falsy (today's behavior):** require `repoPath` to exist, be a directory, and contain `.git` (unchanged).
- **`create` true:** treat `repoPath` as the **new** repo's absolute path. Validate: its **parent** exists and is a directory; `repoPath` itself does **not** already exist. Then `mkdir` it and run `git init -b <defaultBranch||'dev'>` in it (via the project's existing command runner / `execFile('git', ['init', '-b', branch], { cwd })`). On git failure, return 400 with the message. Then continue with the existing slug → insert → session → cookie flow.

One endpoint serves both flows; the client sends the full target path (`<browsed dir>/<name>`) + `create: true` for new repos.

## 3. Client — `FolderPicker` + dialog modes

- **`src/components/folder-picker.tsx`** (new): a directory browser. Props `{ value: string | null; onChange: (absPath: string) => void }`. Shows a **breadcrumb** of the current path, an **↑ up** control, a **drives** dropdown (Windows), and the list of subdirectories (each row clickable to descend; a `✓ git repo` badge when `isRepo`). A "use this folder" affordance selects the current directory. Fetches `/api/fs/browse?path=` on mount and on each navigation.
- **`add-project-dialog.tsx`** gains a **mode toggle**: "Use existing repo" vs "Create new".
  - *Use existing:* the `FolderPicker` selects a folder → fills `repoPath`; submit posts `{ create: false }`.
  - *Create new:* the `FolderPicker` selects a **parent** folder + a **New folder name** field → submit posts `repoPath = join(parent, name)`, `{ create: true }`.
  - Name, Default branch, GitHub URL fields remain. Inline errors as today.

## 4. Pure helpers + tests (`src/lib/fs-browse.ts`)

No fs/DB; unit-tested:
- `validateRepoName(name)` → `{ ok: true } | { ok: false; error }` — rejects empty, names containing `/` `\` (path separators), and `.`/`..`.
- `breadcrumbSegments(path)` → `{ label: string; path: string }[]` — splits an absolute path into cumulative crumbs for the breadcrumb (handles Windows `C:\a\b` and POSIX `/a/b`).

## Data flow

Open modal → `FolderPicker` loads `os.homedir()` → operator navigates (each click → `GET /api/fs/browse?path=`) → selects a folder. **Existing:** `repoPath` = selected dir → `POST /api/projects { create:false }`. **Create:** `repoPath` = selected parent + name → `POST /api/projects { create:true }` → server mkdir + git init → register → cookie → `router.refresh()` (the multi-project switcher already makes the new project active).

## Error handling

- Browse: unreadable dir → skipped (listing still returns); bad/nonexistent `path` → 400. 
- Create: parent missing, target already exists, or `git init` fails → 400 with an inline message in the modal.
- Existing: unchanged (non-git folder → the current inline error).

## Testing

- **Unit (node:test):** `validateRepoName` (empty, separators, `.`/`..`, ok); `breadcrumbSegments` (Windows + POSIX absolute paths, root handling).
- **Build + manual:** `pnpm build` clean; `pnpm test` green (existing + new). Manual: open Add-project → browse to an existing repo (git badge shows) → add it → becomes active; switch to Create-new → browse to a parent, name it → it's created (`git init`) + added + active; try a bad new-folder name → inline error; confirm the browse route requires auth.

## Out of scope

Remote `git clone`, file (non-directory) browsing in the picker, editing/removing projects, recursive repo search.
