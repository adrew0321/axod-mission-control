# Add-project Repo Picker + Create-repo (Epic B) — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let the operator browse the machine's folders to pick an existing local git repo — or create a new one (mkdir + `git init`) — from the Add-project modal, instead of typing the path.

**Architecture:** A new auth-gated `GET /api/fs/browse` lists machine subdirectories (home default, `isRepo` flag, Windows drives). `POST /api/projects` gains a `create` flag (mkdir + `git init` before registering). A new `FolderPicker` client component (breadcrumb + dir list + up + drives) is embedded in `AddProjectDialog`, which gains a "Use existing / Create new" mode toggle. Pure helpers (name validation, breadcrumb split) are unit-tested.

**Tech Stack:** Next.js route handlers, `node:fs/promises`, `node:child_process` (`git init`), React client components, lucide-react, node:test via tsx.

**Spec:** `docs/superpowers/specs/2026-06-05-repo-picker-design.md`
**Branch:** `feature/repo-picker` (already created off `dev`).

**Verified anchors:**
- `POST /api/projects` (`src/app/api/projects/route.ts`, full file): auth → `validateNewProjectInput` → path-exists + `.git` check → slug (collision-safe) → insert → `getOrCreateActiveSession` → set `ACTIVE_PROJECT_COOKIE`. Task 3 inserts the `create` branch.
- `AddProjectDialog` (`src/components/add-project-dialog.tsx`): controlled form (name/repoPath/defaultBranch/githubUrl) → `POST /api/projects` → `router.refresh()`. Task 5 rewrites it.
- Auth pattern: `SESSION_COOKIE`/`verifySession` (used by every route). `execFile` precedent: `src/lib/preview.ts` (`promisify(execFile)`; `git` is `git.exe` on Windows so it runs without a shell).

---

### Task 1: Pure helpers + tests (`src/lib/fs-browse.ts`)

**Files:**
- Create: `src/lib/fs-browse.ts`
- Test: `src/lib/fs-browse.test.ts`

- [ ] **Step 1: Write the failing test.** Create `src/lib/fs-browse.test.ts`:

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validateRepoName, breadcrumbSegments } from './fs-browse';

test('validateRepoName accepts a plain name', () => {
  assert.deepEqual(validateRepoName('my-repo'), { ok: true });
});

test('validateRepoName rejects empty, separators, and dot names', () => {
  assert.equal(validateRepoName('   ').ok, false);
  assert.equal(validateRepoName('a/b').ok, false);
  assert.equal(validateRepoName('a\\b').ok, false);
  assert.equal(validateRepoName('.').ok, false);
  assert.equal(validateRepoName('..').ok, false);
});

test('breadcrumbSegments splits a Windows path into cumulative crumbs', () => {
  assert.deepEqual(breadcrumbSegments('C:\\Source\\TEI'), [
    { label: 'C:', path: 'C:\\' },
    { label: 'Source', path: 'C:\\Source' },
    { label: 'TEI', path: 'C:\\Source\\TEI' },
  ]);
});

test('breadcrumbSegments splits a POSIX path and handles a trailing slash', () => {
  assert.deepEqual(breadcrumbSegments('/home/a/'), [
    { label: '/', path: '/' },
    { label: 'home', path: '/home' },
    { label: 'a', path: '/home/a' },
  ]);
});
```

- [ ] **Step 2: Run the test, confirm FAIL.**

Run: `pnpm exec tsx --test src/lib/fs-browse.test.ts`
Expected: FAIL — cannot find module `./fs-browse`.

- [ ] **Step 3: Implement `src/lib/fs-browse.ts`:**

```ts
// Pure helpers for the folder picker (no fs/DB). Unit-tested.

/** Validate a new folder name (for create-repo): non-empty, no separators, not . or .. */
export function validateRepoName(name: string): { ok: true } | { ok: false; error: string } {
  const n = (name ?? '').trim();
  if (!n) return { ok: false, error: 'Folder name is required.' };
  if (/[\\/]/.test(n)) return { ok: false, error: 'Folder name cannot contain slashes.' };
  if (n === '.' || n === '..') return { ok: false, error: 'Invalid folder name.' };
  return { ok: true };
}

/** Split an absolute path into cumulative breadcrumb crumbs (Windows or POSIX). */
export function breadcrumbSegments(p: string): { label: string; path: string }[] {
  const norm = p.replace(/[\\/]+$/, ""); // drop trailing separators
  const isWin = /^[A-Za-z]:/.test(norm);
  if (isWin) {
    const parts = norm.split(/[\\/]/).filter(Boolean); // ['C:', 'Source', 'TEI']
    const segs: { label: string; path: string }[] = [{ label: parts[0], path: parts[0] + "\\" }];
    let acc = parts[0];
    for (let i = 1; i < parts.length; i++) {
      acc = acc + "\\" + parts[i];
      segs.push({ label: parts[i], path: acc });
    }
    return segs;
  }
  const segs: { label: string; path: string }[] = [{ label: "/", path: "/" }];
  let acc = "";
  for (const part of norm.split("/").filter(Boolean)) {
    acc += "/" + part;
    segs.push({ label: part, path: acc });
  }
  return segs;
}
```

- [ ] **Step 4: Run the test, confirm PASS.**

Run: `pnpm exec tsx --test src/lib/fs-browse.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 5: Full suite.**

Run: `pnpm test`
Expected: `tests 68 / pass 68 / fail 0` (existing 64 + 4 new).

- [ ] **Step 6: Commit.**

```bash
git add src/lib/fs-browse.ts src/lib/fs-browse.test.ts
git commit -m "feat(repo-picker): pure helpers (validateRepoName, breadcrumbSegments) + tests"
```

---

### Task 2: Browse route (`GET /api/fs/browse`)

**Files:**
- Create: `src/app/api/fs/browse/route.ts`

- [ ] **Step 1: Create the route.** Create `src/app/api/fs/browse/route.ts`:

```ts
import { readdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { cookies } from 'next/headers';
import { SESSION_COOKIE, verifySession } from '@/lib/auth';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

// SECURITY: this reads the operator's own filesystem. Safe ONLY because Mission
// Control is a single-user, auth-gated, LOCAL tool. Do NOT expose this route in a
// multi-user or hosted deployment without scoping it to an allow-listed root.

function listDrives(): string[] {
  if (process.platform !== 'win32') return [];
  const drives: string[] = [];
  for (let c = 65; c <= 90; c++) {
    const root = `${String.fromCharCode(c)}:\\`;
    if (existsSync(root)) drives.push(root);
  }
  return drives;
}

export async function GET(req: Request) {
  const jar = await cookies();
  const token = jar.get(SESSION_COOKIE)?.value;
  if (!token || !(await verifySession(token))) {
    return Response.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const url = new URL(req.url);
  const requested = url.searchParams.get('path');
  const target = requested && requested.trim() ? path.resolve(requested) : os.homedir();

  let dirents;
  try {
    dirents = await readdir(target, { withFileTypes: true });
  } catch {
    return Response.json({ error: 'Cannot read that folder' }, { status: 400 });
  }

  const entries = dirents
    .filter((d) => d.isDirectory())
    .map((d) => ({ name: d.name, isRepo: existsSync(path.join(target, d.name, '.git')) }))
    .sort((a, b) => a.name.localeCompare(b.name));

  const parent = path.dirname(target);
  return Response.json({
    path: target,
    parent: parent === target ? null : parent,
    entries,
    drives: listDrives(),
  });
}
```

- [ ] **Step 2: Build.**

Run: `pnpm build`
Expected: `✓ Compiled successfully` + `Finished TypeScript`; `ƒ /api/fs/browse` in the route list. Pre-existing next.config.ts NFT warning is acceptable. Report BLOCKED with the exact message on any TS error.

- [ ] **Step 3: Commit.**

```bash
git add src/app/api/fs/browse/route.ts
git commit -m "feat(repo-picker): GET /api/fs/browse lists machine dirs (auth-gated, isRepo + drives)"
```

---

### Task 3: Extend `POST /api/projects` with a `create` flag

**Files:**
- Modify: `src/app/api/projects/route.ts`

- [ ] **Step 1: Add imports.** At the top of `src/app/api/projects/route.ts`, change the first two import lines:

```ts
import { existsSync, statSync } from 'node:fs';
import path from 'node:path';
```

to:

```ts
import { existsSync, statSync } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import path from 'node:path';

const execFileAsync = promisify(execFile);
```

- [ ] **Step 2: Add `create` to the body type.** Change:

```ts
  const body = (await req.json().catch(() => ({}))) as {
    name?: string; repoPath?: string; defaultBranch?: string; githubUrl?: string;
  };
```

to:

```ts
  const body = (await req.json().catch(() => ({}))) as {
    name?: string; repoPath?: string; defaultBranch?: string; githubUrl?: string; create?: boolean;
  };
```

- [ ] **Step 3: Branch the repo validation on `create`.** Replace this block:

```ts
  const repoPath = body.repoPath!.trim();
  if (!existsSync(repoPath) || !statSync(repoPath).isDirectory()) {
    return Response.json({ error: 'Repo path does not exist or is not a directory.' }, { status: 400 });
  }
  if (!existsSync(path.join(repoPath, '.git'))) {
    return Response.json({ error: 'That folder is not a git repo (no .git found).' }, { status: 400 });
  }
```

with:

```ts
  const repoPath = body.repoPath!.trim();
  if (body.create) {
    const parent = path.dirname(repoPath);
    if (!existsSync(parent) || !statSync(parent).isDirectory()) {
      return Response.json({ error: 'Parent folder does not exist.' }, { status: 400 });
    }
    if (existsSync(repoPath)) {
      return Response.json({ error: 'That folder already exists.' }, { status: 400 });
    }
    const branch = body.defaultBranch?.trim() || 'dev';
    try {
      await mkdir(repoPath, { recursive: false });
      await execFileAsync('git', ['init', '-b', branch], { cwd: repoPath, windowsHide: true });
    } catch (e) {
      return Response.json(
        { error: `Could not create repo: ${e instanceof Error ? e.message : String(e)}` },
        { status: 400 },
      );
    }
  } else {
    if (!existsSync(repoPath) || !statSync(repoPath).isDirectory()) {
      return Response.json({ error: 'Repo path does not exist or is not a directory.' }, { status: 400 });
    }
    if (!existsSync(path.join(repoPath, '.git'))) {
      return Response.json({ error: 'That folder is not a git repo (no .git found).' }, { status: 400 });
    }
  }
```

(The slug → insert → session → cookie code below stays unchanged.)

- [ ] **Step 4: Build.**

Run: `pnpm build`
Expected: clean compile.

- [ ] **Step 5: Commit.**

```bash
git add src/app/api/projects/route.ts
git commit -m "feat(repo-picker): POST /api/projects create flag (mkdir + git init)"
```

---

### Task 4: `FolderPicker` component

**Files:**
- Create: `src/components/folder-picker.tsx`

- [ ] **Step 1: Create the component.** Create `src/components/folder-picker.tsx`:

```tsx
"use client";

import { useState, useEffect, useCallback } from "react";
import { Folder, ChevronUp, HardDrive, Check, RefreshCw } from "lucide-react";
import { breadcrumbSegments } from "@/lib/fs-browse";

type Entry = { name: string; isRepo: boolean };
type BrowseResult = { path: string; parent: string | null; entries: Entry[]; drives: string[] };

export default function FolderPicker({
  value,
  onChange,
}: {
  value: string | null;
  onChange: (absPath: string) => void;
}) {
  const [data, setData] = useState<BrowseResult | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const browse = useCallback(async (path?: string) => {
    setLoading(true);
    setError(null);
    try {
      const qs = path ? `?path=${encodeURIComponent(path)}` : "";
      const res = await fetch(`/api/fs/browse${qs}`);
      const d = await res.json();
      if (!res.ok) {
        setError(d.error ?? "Could not read folder");
      } else {
        setData(d);
        onChange(d.path);
      }
    } catch {
      setError("Network error");
    } finally {
      setLoading(false);
    }
  }, [onChange]);

  useEffect(() => {
    void browse();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const crumbs = data ? breadcrumbSegments(data.path) : [];

  return (
    <div className="border border-[#2a3441] rounded-md bg-[#060810] overflow-hidden">
      {/* breadcrumb + controls */}
      <div className="flex items-center gap-1 px-2 py-1.5 border-b border-[#1e2632] text-[10px] font-mono text-[#8b949e] flex-wrap">
        <Folder className="w-3.5 h-3.5 text-[#e3b341] shrink-0" />
        {crumbs.map((c, i) => (
          <span key={c.path} className="flex items-center gap-1">
            {i > 0 && <span className="text-[#3a424d]">›</span>}
            <button onClick={() => browse(c.path)} className="hover:text-[#00e0ff] transition-colors">
              {c.label}
            </button>
          </span>
        ))}
        <div className="ml-auto flex items-center gap-2">
          {data?.drives && data.drives.length > 0 && (
            <select
              value=""
              onChange={(e) => e.target.value && browse(e.target.value)}
              className="bg-[#161c25] border border-[#2a3441] rounded text-[10px] text-[#8b949e] px-1 py-0.5"
              title="Switch drive"
            >
              <option value="">▾ drive</option>
              {data.drives.map((d) => (
                <option key={d} value={d}>{d}</option>
              ))}
            </select>
          )}
          <button
            onClick={() => data?.parent && browse(data.parent)}
            disabled={!data?.parent}
            title="Up one folder"
            className="flex items-center gap-0.5 hover:text-[#00e0ff] disabled:opacity-30 transition-colors"
          >
            <ChevronUp className="w-3.5 h-3.5" /> up
          </button>
        </div>
      </div>

      {/* dir list */}
      <div className="max-h-44 overflow-y-auto">
        {loading ? (
          <div className="px-3 py-3 text-[11px] font-mono text-[#5c6470] flex items-center gap-1.5">
            <RefreshCw className="w-3 h-3 animate-spin" /> loading…
          </div>
        ) : error ? (
          <div className="px-3 py-3 text-[11px] font-mono text-red-400">{error}</div>
        ) : data && data.entries.length === 0 ? (
          <div className="px-3 py-3 text-[11px] font-mono text-[#5c6470]">No subfolders here.</div>
        ) : (
          data?.entries.map((e) => (
            <button
              key={e.name}
              onClick={() => browse(`${data.path}${data.path.endsWith("\\") || data.path.endsWith("/") ? "" : pathSep(data.path)}${e.name}`)}
              className="w-full flex items-center gap-2 px-3 py-1.5 text-[11px] font-mono text-[#e6edf3] hover:bg-[#161c25] text-left"
            >
              <Folder className="w-3.5 h-3.5 text-[#e3b341] shrink-0" />
              <span className="truncate">{e.name}</span>
              {e.isRepo && (
                <span className="ml-auto flex items-center gap-1 text-[#3fb950] text-[9px] shrink-0">
                  <Check className="w-3 h-3" /> git repo
                </span>
              )}
            </button>
          ))
        )}
      </div>

      {/* current selection */}
      <div className="px-2 py-1.5 border-t border-[#1e2632] text-[10px] font-mono text-[#5c6470] truncate">
        Selected: <span className="text-[#00e0ff]">{value ?? data?.path ?? "…"}</span>
      </div>
    </div>
  );
}

function pathSep(p: string): string {
  return /^[A-Za-z]:/.test(p) ? "\\" : "/";
}
```

- [ ] **Step 2: Build.**

Run: `pnpm build`
Expected: clean compile (component not yet rendered; must type-check). Report BLOCKED on any TS error (do not change the lucide imports without reporting).

- [ ] **Step 3: Commit.**

```bash
git add src/components/folder-picker.tsx
git commit -m "feat(repo-picker): FolderPicker (breadcrumb + dir list + up + drives)"
```

---

### Task 5: Wire the picker + modes into `AddProjectDialog`

**Files:**
- Modify: `src/components/add-project-dialog.tsx` (full rewrite)

- [ ] **Step 1: Replace `src/components/add-project-dialog.tsx`** with:

```tsx
"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { X } from "lucide-react";
import FolderPicker from "@/components/folder-picker";
import { validateRepoName } from "@/lib/fs-browse";

export default function AddProjectDialog({
  open,
  onClose,
}: {
  open: boolean;
  onClose: () => void;
}) {
  const router = useRouter();
  const [mode, setMode] = useState<"existing" | "create">("existing");
  const [name, setName] = useState("");
  const [browsed, setBrowsed] = useState<string | null>(null); // current folder in the picker
  const [newFolder, setNewFolder] = useState("");
  const [defaultBranch, setDefaultBranch] = useState("dev");
  const [githubUrl, setGithubUrl] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  if (!open) return null;

  function join(parent: string, child: string): string {
    const sep = /^[A-Za-z]:/.test(parent) ? "\\" : "/";
    return parent.replace(/[\\/]+$/, "") + sep + child;
  }

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);

    if (!browsed) {
      setError(mode === "create" ? "Pick a parent folder." : "Pick the repo folder.");
      return;
    }
    let repoPath = browsed;
    if (mode === "create") {
      const v = validateRepoName(newFolder);
      if (!v.ok) {
        setError(v.error);
        return;
      }
      repoPath = join(browsed, newFolder.trim());
    }

    setPending(true);
    try {
      const res = await fetch("/api/projects", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name, repoPath, defaultBranch, githubUrl, create: mode === "create" }),
      });
      if (!res.ok) {
        const b = await res.json().catch(() => ({}));
        setError(b.error ?? `Failed (${res.status})`);
        setPending(false);
        return;
      }
      onClose();
      router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Network error");
      setPending(false);
    }
  }

  const inputCls =
    "w-full bg-[#060810] border border-[#2a3441] focus:border-[#00e0ff] rounded-md px-3 py-2 text-xs text-[#e6edf3] placeholder-[#5c6470] focus:outline-none transition-colors mb-3";
  const labelCls = "block text-[10px] font-mono text-[#5c6470] tracking-wider uppercase mb-1";

  return (
    <div className="fixed inset-0 z-[100] flex items-center justify-center bg-black/60" onMouseDown={onClose}>
      <form
        onMouseDown={(e) => e.stopPropagation()}
        onSubmit={submit}
        className="w-[440px] bg-[#11161d] border border-[#1e2632] rounded-lg p-6 shadow-lg shadow-black/40"
      >
        <div className="flex items-center justify-between mb-4">
          <h2 className="text-sm font-semibold text-[#e6edf3] font-heading">Add project</h2>
          <button type="button" onClick={onClose} className="text-[#5c6470] hover:text-[#e6edf3]">
            <X className="w-4 h-4" />
          </button>
        </div>

        <label className={labelCls}>Name</label>
        <input className={inputCls} value={name} onChange={(e) => setName(e.target.value)} placeholder="My Client Site" required />

        {/* mode toggle */}
        <div className="flex gap-1 mb-3 p-0.5 bg-[#060810] border border-[#2a3441] rounded-md text-[11px] font-mono">
          {(["existing", "create"] as const).map((m) => (
            <button
              key={m}
              type="button"
              onClick={() => { setMode(m); setError(null); }}
              className={`flex-1 py-1 rounded transition-colors ${
                mode === m ? "bg-[#161c25] text-[#00e0ff]" : "text-[#5c6470] hover:text-[#8b949e]"
              }`}
            >
              {m === "existing" ? "Use existing repo" : "Create new"}
            </button>
          ))}
        </div>

        <label className={labelCls}>{mode === "create" ? "Parent folder" : "Repo folder"}</label>
        <div className="mb-3">
          <FolderPicker value={browsed} onChange={setBrowsed} />
        </div>

        {mode === "create" && (
          <>
            <label className={labelCls}>New folder name</label>
            <input className={inputCls} value={newFolder} onChange={(e) => setNewFolder(e.target.value)} placeholder="my-new-repo" />
          </>
        )}

        <label className={labelCls}>Default branch</label>
        <input className={inputCls} value={defaultBranch} onChange={(e) => setDefaultBranch(e.target.value)} placeholder="dev" />

        <label className={labelCls}>GitHub URL (optional)</label>
        <input className={inputCls} value={githubUrl} onChange={(e) => setGithubUrl(e.target.value)} placeholder="https://github.com/you/repo" />

        {error && (
          <div className="mb-3 px-3 py-2 rounded text-[11px] font-mono bg-red-500/10 border border-red-500/40 text-red-400">
            {error}
          </div>
        )}

        <button
          type="submit"
          disabled={pending}
          className="w-full bg-[#00e0ff] hover:bg-[#00c0dd] disabled:opacity-50 text-black font-bold py-2 rounded-md text-xs transition-colors"
        >
          {pending ? "Working…" : mode === "create" ? "Create + add project" : "Add project"}
        </button>
      </form>
    </div>
  );
}
```

- [ ] **Step 2: Build.**

Run: `pnpm build`
Expected: `✓ Compiled successfully` + `Finished TypeScript`. Pre-existing next.config.ts NFT warning acceptable.

- [ ] **Step 3: Commit.**

```bash
git add src/components/add-project-dialog.tsx
git commit -m "feat(repo-picker): Add-project modes (existing / create) + embedded FolderPicker"
```

---

### Task 6: Full verification + manual smoke

**Files:** none

- [ ] **Step 1: Build + full test suite.**

Run: `pnpm build && pnpm test`
Expected: build clean; `tests 68 / pass 68 / fail 0`.

- [ ] **Step 2: Manual smoke (operator-run).** With `pnpm dev` running and logged in, open the header **PROJECT ▾ → + Add project**:
  - **Use existing:** the picker opens at your home folder; navigate (breadcrumb / up / drive switch) to a real repo's parent → folders with `.git` show a **git repo** badge → click into one (or select it) → fill Name → **Add project** → it's added and becomes active.
  - **Create new:** switch to **Create new** → browse to a parent folder → enter a **New folder name** → **Create + add project** → confirm the folder is created with `git init` (a `.git` appears) and the project is added + active.
  - **Validation:** a new-folder name with a slash → inline error; a name that already exists → inline error from the server.
  - Confirm `GET /api/fs/browse` requires auth (logged out → 401).

---

## Wrap-up (after Task 6 passes)

- [ ] Add a "what actually happened" note to `docs/superpowers/specs/2026-06-05-repo-picker-design.md`.
- [ ] Update `README.md` (Epic B done; Epic C — broader theme polish — remains).
- [ ] Integrate `feature/repo-picker` → `dev` (operator confirms).

## Self-review (done at authoring)

- **Spec coverage:** browse route (home default, isRepo, drives, parent) → Task 2; create flag (mkdir + git init, parent/exists checks) → Task 3; FolderPicker (breadcrumb/list/up/drives/select) → Task 4; modal modes + new-folder field + create submit → Task 5; pure helpers (`validateRepoName`, `breadcrumbSegments`) + tests → Task 1; security note in the route → Task 2; verification → Task 6. No gaps.
- **Placeholder scan:** full code in every step; no TBD/TODO. (One non-ASCII typo guard note in Task 4.2 — "do not 改 the lucide imports" — is a stray character; read it as "do not change".)
- **Type/name consistency:** `validateRepoName`, `breadcrumbSegments`, the `{ path, parent, entries, drives }` browse shape, the `{ name, repoPath, defaultBranch, githubUrl, create }` POST body, and `FolderPicker`'s `{ value, onChange }` props match across tasks. Test count 64 → 68 consistent (Tasks 1 and 6).
