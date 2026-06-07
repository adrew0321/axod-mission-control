# Project File Explorer (Epic A) — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a "Files" tab that browses the active project's repo on disk — a themed lazy file tree + a read-only Monaco syntax-highlighted viewer.

**Architecture:** Two auth-gated read routes (`GET /api/files`, `GET /api/files/content`) resolve the active project's `repo_path` from a `projectId` query param and `safeJoin` requested paths against it (no traversal). A recursive lazy `FileTree` + a Monaco viewer live in a `FileExplorer` rendered by a new `activeTab === "files"` branch. Pure helpers (language/icon/excludes/path-guard) are unit-tested; routes + UI are build/manual.

**Tech Stack:** Next.js route handlers, `node:fs/promises`, Drizzle/SQLite, `@monaco-editor/react` (already a dep), lucide-react, node:test via tsx.

**Spec:** `docs/superpowers/specs/2026-06-04-file-explorer-design.md`
**Branch:** `feature/file-explorer` (already created off `dev`).

**Verified anchors:**
- Workspace tabs: `activeTab` is `useState<string>("plan")` (`mission-control.tsx:301`); tab buttons `:1325-1373`; content branches `:1395-1474` (e.g. `{activeTab === "code" && (...)}`). `MissionControl` already receives `activeProjectId` (multi-project switcher).
- Monaco pattern (`src/components/diff-viewer.tsx`): `const DiffEditor = dynamic(() => import("@monaco-editor/react").then((m) => m.DiffEditor), { ssr: false, loading: ... })`, with `options={{ readOnly: true, minimap: { enabled: false }, automaticLayout: true, fontSize: 12 }}`. The single-file editor is `m.Editor`.
- Path-traversal guard reference: `src/lib/preview.ts` `safeJoin` (resolve + `startsWith(root + sep)` check).
- Auth-gated route pattern: `src/app/api/sessions/[id]/clear/route.ts` (`SESSION_COOKIE`/`verifySession` 401 guard).

---

### Task 1: Pure helpers + tests

**Files:**
- Create: `src/lib/file-tree.ts`, `src/lib/safe-path.ts`
- Test: `src/lib/file-tree.test.ts`, `src/lib/safe-path.test.ts`

- [ ] **Step 1: Write the failing tests.** Create `src/lib/file-tree.test.ts`:

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fileLanguage, fileIcon, EXCLUDED_DIRS } from './file-tree';

test('fileLanguage maps known extensions and defaults to plaintext', () => {
  assert.equal(fileLanguage('a.tsx'), 'typescript');
  assert.equal(fileLanguage('a.ts'), 'typescript');
  assert.equal(fileLanguage('a.js'), 'javascript');
  assert.equal(fileLanguage('a.astro'), 'html');
  assert.equal(fileLanguage('a.json'), 'json');
  assert.equal(fileLanguage('a.md'), 'markdown');
  assert.equal(fileLanguage('Dockerfile'), 'plaintext');
});

test('fileIcon returns an icon + color, with a default fallback', () => {
  assert.deepEqual(fileIcon('a.tsx'), { icon: 'FileCode', color: 'text-[#36c5f0]' });
  assert.equal(fileIcon('a.json').icon, 'Braces');
  assert.deepEqual(fileIcon('noext'), { icon: 'File', color: 'text-[#8b949e]' });
});

test('EXCLUDED_DIRS contains the heavy/noise dirs', () => {
  for (const d of ['node_modules', '.git', '.next', 'dist', '.superpowers']) {
    assert.ok(EXCLUDED_DIRS.has(d), `${d} excluded`);
  }
  assert.equal(EXCLUDED_DIRS.has('src'), false);
});
```

Create `src/lib/safe-path.test.ts`:

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { resolveWithinRoot } from './safe-path';

const root = path.resolve('/tmp/repo');

test('resolveWithinRoot resolves paths inside the root', () => {
  assert.equal(resolveWithinRoot(root, ''), root);
  assert.equal(resolveWithinRoot(root, 'src'), path.join(root, 'src'));
  assert.equal(resolveWithinRoot(root, 'src/lib/a.ts'), path.join(root, 'src/lib/a.ts'));
  assert.equal(resolveWithinRoot(root, '/src'), path.join(root, 'src')); // leading slash stripped
});

test('resolveWithinRoot rejects traversal escapes', () => {
  assert.equal(resolveWithinRoot(root, '../etc'), null);
  assert.equal(resolveWithinRoot(root, 'src/../../etc'), null);
  assert.equal(resolveWithinRoot(root, '../../'), null);
});
```

- [ ] **Step 2: Run the tests, confirm FAIL.**

Run: `pnpm exec tsx --test src/lib/file-tree.test.ts src/lib/safe-path.test.ts`
Expected: FAIL — cannot find modules `./file-tree`, `./safe-path`.

- [ ] **Step 3: Implement `src/lib/file-tree.ts`:**

```ts
// Pure file-presentation helpers (no fs/DB) — shared by the tree UI (icons),
// the content route (language), and the list route (excludes). Unit-tested.

export const EXCLUDED_DIRS: ReadonlySet<string> = new Set([
  'node_modules', '.git', '.next', 'dist', '.superpowers', '.turbo', 'coverage',
]);

/** Extension → Monaco language id. */
export function fileLanguage(name: string): string {
  const ext = name.split('.').pop()?.toLowerCase() ?? '';
  switch (ext) {
    case 'ts': case 'mts': case 'cts': case 'tsx': return 'typescript';
    case 'js': case 'mjs': case 'cjs': case 'jsx': return 'javascript';
    case 'astro': case 'html': case 'vue': case 'svelte': return 'html';
    case 'css': return 'css';
    case 'scss': return 'scss';
    case 'json': return 'json';
    case 'md': case 'mdx': return 'markdown';
    case 'yml': case 'yaml': return 'yaml';
    case 'py': return 'python';
    case 'sh': return 'shell';
    default: return 'plaintext';
  }
}

export interface FileIcon { icon: string; color: string; }

/** Extension → a lucide icon name + a Tailwind text-color class (the Vivid palette). */
export function fileIcon(name: string): FileIcon {
  const ext = name.split('.').pop()?.toLowerCase() ?? '';
  switch (ext) {
    case 'tsx': case 'jsx': return { icon: 'FileCode', color: 'text-[#36c5f0]' };
    case 'ts': case 'mts': case 'cts': case 'js': case 'mjs': case 'cjs':
      return { icon: 'FileCode', color: 'text-[#6cb6ff]' };
    case 'astro': case 'html': return { icon: 'FileCode', color: 'text-[#ff7b53]' };
    case 'css': case 'scss': return { icon: 'FileType', color: 'text-[#d2a8ff]' };
    case 'json': return { icon: 'Braces', color: 'text-[#e3b341]' };
    case 'md': case 'mdx': return { icon: 'FileText', color: 'text-[#9aa4af]' };
    case 'yml': case 'yaml': return { icon: 'FileCog', color: 'text-[#e3b341]' };
    case 'png': case 'jpg': case 'jpeg': case 'gif': case 'webp': case 'svg': case 'ico':
      return { icon: 'Image', color: 'text-[#a5d6ff]' };
    default: return { icon: 'File', color: 'text-[#8b949e]' };
  }
}
```

- [ ] **Step 4: Implement `src/lib/safe-path.ts`:**

```ts
import path from 'node:path';

/**
 * Resolve `rel` (a path relative to `root`) to an absolute path, or return null
 * if it escapes `root`. Mirrors the traversal guard in preview.ts. No fs access.
 */
export function resolveWithinRoot(root: string, rel: string): string | null {
  const clean = (rel ?? '').replace(/^[\\/]+/, '');
  const resolved = path.resolve(root, clean);
  if (resolved !== root && !resolved.startsWith(root + path.sep)) return null;
  return resolved;
}
```

- [ ] **Step 5: Run the tests, confirm PASS.**

Run: `pnpm exec tsx --test src/lib/file-tree.test.ts src/lib/safe-path.test.ts`
Expected: PASS (5 tests).

- [ ] **Step 6: Full suite.**

Run: `pnpm test`
Expected: `tests 64 / pass 64 / fail 0` (existing 59 + 5 new).

- [ ] **Step 7: Commit.**

```bash
git add src/lib/file-tree.ts src/lib/file-tree.test.ts src/lib/safe-path.ts src/lib/safe-path.test.ts
git commit -m "feat(file-explorer): pure helpers (language/icon/excludes/path-guard) + tests"
```

---

### Task 2: Directory-list route (`GET /api/files`)

**Files:**
- Create: `src/app/api/files/route.ts`

- [ ] **Step 1: Create the route.** Create `src/app/api/files/route.ts`:

```ts
import { readdir } from 'node:fs/promises';
import { cookies } from 'next/headers';
import { eq } from 'drizzle-orm';
import { db } from '@/db/client';
import { projects } from '@/db/schema';
import { SESSION_COOKIE, verifySession } from '@/lib/auth';
import { resolveWithinRoot } from '@/lib/safe-path';
import { EXCLUDED_DIRS } from '@/lib/file-tree';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(req: Request) {
  const jar = await cookies();
  const token = jar.get(SESSION_COOKIE)?.value;
  if (!token || !(await verifySession(token))) {
    return Response.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const url = new URL(req.url);
  const projectId = url.searchParams.get('projectId');
  const dir = url.searchParams.get('dir') ?? '';
  if (!projectId) return Response.json({ error: 'projectId is required' }, { status: 400 });

  const project = await db
    .select()
    .from(projects)
    .where(eq(projects.id, projectId))
    .limit(1)
    .then((r) => r[0]);
  if (!project) return Response.json({ error: 'Unknown project' }, { status: 400 });

  const abs = resolveWithinRoot(project.repo_path, dir);
  if (!abs) return Response.json({ error: 'Invalid path' }, { status: 400 });

  try {
    const dirents = await readdir(abs, { withFileTypes: true });
    const entries = dirents
      .filter((e) => !(e.isDirectory() && EXCLUDED_DIRS.has(e.name)))
      .map((e) => ({ name: e.name, type: e.isDirectory() ? ('dir' as const) : ('file' as const) }))
      .sort((a, b) =>
        a.type === b.type ? a.name.localeCompare(b.name) : a.type === 'dir' ? -1 : 1,
      );
    return Response.json({ entries });
  } catch {
    return Response.json({ error: 'Directory not found' }, { status: 404 });
  }
}
```

- [ ] **Step 2: Build.**

Run: `pnpm build`
Expected: `✓ Compiled successfully` + `Finished TypeScript` (the route appears as `ƒ /api/files`). Pre-existing next.config.ts NFT warning is acceptable.

- [ ] **Step 3: Commit.**

```bash
git add src/app/api/files/route.ts
git commit -m "feat(file-explorer): GET /api/files lists a project dir (path-guarded, excludes heavy dirs)"
```

---

### Task 3: File-content route (`GET /api/files/content`)

**Files:**
- Create: `src/app/api/files/content/route.ts`

- [ ] **Step 1: Create the route.** Create `src/app/api/files/content/route.ts`:

```ts
import { readFile, stat } from 'node:fs/promises';
import { cookies } from 'next/headers';
import { eq } from 'drizzle-orm';
import { db } from '@/db/client';
import { projects } from '@/db/schema';
import { SESSION_COOKIE, verifySession } from '@/lib/auth';
import { resolveWithinRoot } from '@/lib/safe-path';
import { fileLanguage } from '@/lib/file-tree';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const MAX_BYTES = 1_000_000;

export async function GET(req: Request) {
  const jar = await cookies();
  const token = jar.get(SESSION_COOKIE)?.value;
  if (!token || !(await verifySession(token))) {
    return Response.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const url = new URL(req.url);
  const projectId = url.searchParams.get('projectId');
  const rel = url.searchParams.get('path');
  if (!projectId || !rel) {
    return Response.json({ error: 'projectId and path are required' }, { status: 400 });
  }

  const project = await db
    .select()
    .from(projects)
    .where(eq(projects.id, projectId))
    .limit(1)
    .then((r) => r[0]);
  if (!project) return Response.json({ error: 'Unknown project' }, { status: 400 });

  const abs = resolveWithinRoot(project.repo_path, rel);
  if (!abs) return Response.json({ error: 'Invalid path' }, { status: 400 });

  try {
    const s = await stat(abs);
    if (!s.isFile()) return Response.json({ error: 'Not a file' }, { status: 400 });
    if (s.size > MAX_BYTES) return Response.json({ binary: true });

    const buf = await readFile(abs);
    if (buf.subarray(0, 8192).includes(0)) return Response.json({ binary: true });

    const name = rel.split(/[\\/]/).pop() ?? rel;
    return Response.json({ content: buf.toString('utf8'), language: fileLanguage(name) });
  } catch {
    return Response.json({ error: 'File not found' }, { status: 404 });
  }
}
```

- [ ] **Step 2: Build.**

Run: `pnpm build`
Expected: clean compile; `ƒ /api/files/content` in the route list.

- [ ] **Step 3: Commit.**

```bash
git add src/app/api/files/content/route.ts
git commit -m "feat(file-explorer): GET /api/files/content (size/binary guard, language tag)"
```

---

### Task 4: `FileTree` component (recursive, lazy)

**Files:**
- Create: `src/components/file-tree.tsx`

- [ ] **Step 1: Create the component.** Create `src/components/file-tree.tsx`:

```tsx
"use client";

import { useState, useEffect, useCallback } from "react";
import * as Icons from "lucide-react";
import { ChevronRight, ChevronDown, Folder, FolderOpen } from "lucide-react";
import { fileIcon } from "@/lib/file-tree";

type Entry = { name: string; type: "dir" | "file" };

function FileLeaf({
  name,
  path,
  selectedPath,
  onSelect,
}: {
  name: string;
  path: string;
  selectedPath: string | null;
  onSelect: (path: string) => void;
}) {
  const { icon, color } = fileIcon(name);
  const Icon = (Icons as Record<string, React.ComponentType<{ className?: string }>>)[icon] ?? Icons.File;
  const active = selectedPath === path;
  return (
    <button
      onClick={() => onSelect(path)}
      className={`w-full flex items-center gap-1.5 pr-2 py-[3px] text-[11px] font-mono text-left transition-colors ${
        active ? "bg-[#11233a] text-[#e6edf3] shadow-[inset_2px_0_0_#00e0ff]" : "hover:bg-[#161c25]"
      }`}
    >
      <Icon className={`w-3.5 h-3.5 shrink-0 ${color}`} />
      <span className="truncate">{name}</span>
    </button>
  );
}

function FolderNode({
  name,
  path,
  projectId,
  depth,
  selectedPath,
  onSelect,
}: {
  name: string;
  path: string;
  projectId: string;
  depth: number;
  selectedPath: string | null;
  onSelect: (path: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const [entries, setEntries] = useState<Entry[] | null>(null);
  const [loading, setLoading] = useState(false);

  const toggle = useCallback(async () => {
    const next = !open;
    setOpen(next);
    if (next && entries === null) {
      setLoading(true);
      try {
        const res = await fetch(`/api/files?projectId=${encodeURIComponent(projectId)}&dir=${encodeURIComponent(path)}`);
        const data = await res.json();
        setEntries(res.ok ? (data.entries ?? []) : []);
      } catch {
        setEntries([]);
      } finally {
        setLoading(false);
      }
    }
  }, [open, entries, projectId, path]);

  return (
    <div>
      <button
        onClick={toggle}
        className="w-full flex items-center gap-1 pr-2 py-[3px] text-[11px] font-mono text-[#e3b341] hover:bg-[#161c25] text-left"
        style={{ paddingLeft: depth * 12 + 4 }}
      >
        {open ? <ChevronDown className="w-3 h-3 shrink-0 text-[#5c6470]" /> : <ChevronRight className="w-3 h-3 shrink-0 text-[#5c6470]" />}
        {open ? <FolderOpen className="w-3.5 h-3.5 shrink-0" /> : <Folder className="w-3.5 h-3.5 shrink-0" />}
        <span className="truncate">{name}</span>
      </button>
      {open && (
        <div>
          {loading && <div className="text-[10px] font-mono text-[#5c6470]" style={{ paddingLeft: (depth + 1) * 12 + 8 }}>loading…</div>}
          {entries?.map((e) =>
            e.type === "dir" ? (
              <FolderNode
                key={e.name}
                name={e.name}
                path={path ? `${path}/${e.name}` : e.name}
                projectId={projectId}
                depth={depth + 1}
                selectedPath={selectedPath}
                onSelect={onSelect}
              />
            ) : (
              <div key={e.name} style={{ paddingLeft: (depth + 1) * 12 + 4 }}>
                <FileLeaf name={e.name} path={path ? `${path}/${e.name}` : e.name} selectedPath={selectedPath} onSelect={onSelect} />
              </div>
            ),
          )}
        </div>
      )}
    </div>
  );
}

export default function FileTree({
  projectId,
  selectedPath,
  onSelect,
}: {
  projectId: string;
  selectedPath: string | null;
  onSelect: (path: string) => void;
}) {
  const [entries, setEntries] = useState<Entry[] | null>(null);

  // Load the repo root once per project (re-runs when the active project changes).
  useEffect(() => {
    let cancelled = false;
    setEntries(null);
    (async () => {
      try {
        const res = await fetch(`/api/files?projectId=${encodeURIComponent(projectId)}&dir=`);
        const data = await res.json();
        if (!cancelled) setEntries(res.ok ? (data.entries ?? []) : []);
      } catch {
        if (!cancelled) setEntries([]);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [projectId]);

  if (entries === null) {
    return <div className="p-3 text-[11px] font-mono text-[#5c6470]">Loading files…</div>;
  }

  return (
    <div className="py-1">
      {entries.map((e) =>
        e.type === "dir" ? (
          <FolderNode key={e.name} name={e.name} path={e.name} projectId={projectId} depth={0} selectedPath={selectedPath} onSelect={onSelect} />
        ) : (
          <div key={e.name} style={{ paddingLeft: 4 }}>
            <FileLeaf name={e.name} path={e.name} selectedPath={selectedPath} onSelect={onSelect} />
          </div>
        ),
      )}
    </div>
  );
}
```

- [ ] **Step 2: Build.**

Run: `pnpm build`
Expected: clean compile (the component isn't rendered yet but must type-check / bundle).

- [ ] **Step 3: Commit.**

```bash
git add src/components/file-tree.tsx
git commit -m "feat(file-explorer): recursive lazy FileTree with Vivid icons/colors"
```

---

### Task 5: `FileExplorer` + Monaco viewer + Vivid theme

**Files:**
- Create: `src/lib/monaco-theme.ts`, `src/components/file-explorer.tsx`

- [ ] **Step 1: Create the shared Monaco theme.** Create `src/lib/monaco-theme.ts`:

```ts
// A "vivid" dark theme for the Monaco viewers (Files tab + Code Diff), matching
// the app palette. `monaco` is the @monaco-editor/react `Monaco` instance passed
// to a beforeMount handler. Typed loosely to avoid importing monaco's types.
export const VIVID_THEME = "vivid-dark";

export function defineVividTheme(monaco: {
  editor: { defineTheme: (name: string, theme: unknown) => void };
}): void {
  monaco.editor.defineTheme(VIVID_THEME, {
    base: "vs-dark",
    inherit: true,
    rules: [
      { token: "keyword", foreground: "ff7b72" },
      { token: "string", foreground: "a5d6ff" },
      { token: "comment", foreground: "6e7681", fontStyle: "italic" },
      { token: "number", foreground: "79c0ff" },
      { token: "type", foreground: "d2a8ff" },
      { token: "function", foreground: "d2a8ff" },
      { token: "variable", foreground: "79c0ff" },
    ],
    colors: { "editor.background": "#060810" },
  });
}
```

- [ ] **Step 2: Create the FileExplorer.** Create `src/components/file-explorer.tsx`:

```tsx
"use client";

import { useState, useEffect, useCallback } from "react";
import dynamic from "next/dynamic";
import FileTree from "@/components/file-tree";
import { defineVividTheme, VIVID_THEME } from "@/lib/monaco-theme";

const MonacoEditor = dynamic(() => import("@monaco-editor/react").then((m) => m.Editor), {
  ssr: false,
  loading: () => <div className="p-4 text-[11px] font-mono text-[#5c6470]">Loading editor…</div>,
});

export default function FileExplorer({ projectId }: { projectId: string }) {
  const [selectedPath, setSelectedPath] = useState<string | null>(null);
  const [content, setContent] = useState<string>("");
  const [language, setLanguage] = useState<string>("plaintext");
  const [binary, setBinary] = useState(false);
  const [loading, setLoading] = useState(false);

  // Reset when the active project changes.
  useEffect(() => {
    setSelectedPath(null);
    setContent("");
    setBinary(false);
  }, [projectId]);

  const open = useCallback(async (path: string) => {
    setSelectedPath(path);
    setLoading(true);
    setBinary(false);
    try {
      const res = await fetch(`/api/files/content?projectId=${encodeURIComponent(projectId)}&path=${encodeURIComponent(path)}`);
      const data = await res.json();
      if (data.binary) {
        setBinary(true);
        setContent("");
      } else {
        setContent(data.content ?? "");
        setLanguage(data.language ?? "plaintext");
      }
    } catch {
      setBinary(true);
    } finally {
      setLoading(false);
    }
  }, [projectId]);

  return (
    <div className="h-full flex bg-[#11161d] border border-[#1e2632] rounded-lg overflow-hidden">
      <div className="w-60 shrink-0 border-r border-[#1e2632] overflow-y-auto bg-[#0d1117]">
        <FileTree projectId={projectId} selectedPath={selectedPath} onSelect={open} />
      </div>
      <div className="flex-1 min-w-0 bg-[#060810]">
        {!selectedPath ? (
          <div className="h-full flex items-center justify-center text-[#5c6470] text-xs font-mono">
            Select a file to view it.
          </div>
        ) : binary ? (
          <div className="h-full flex items-center justify-center text-[#5c6470] text-xs font-mono px-4 text-center">
            Binary or oversized file — not shown.
          </div>
        ) : loading ? (
          <div className="h-full flex items-center justify-center text-[#5c6470] text-xs font-mono">Loading…</div>
        ) : (
          <MonacoEditor
            height="100%"
            theme={VIVID_THEME}
            language={language}
            value={content}
            path={selectedPath}
            beforeMount={defineVividTheme}
            options={{
              readOnly: true,
              minimap: { enabled: false },
              scrollBeyondLastLine: false,
              fontSize: 12,
              automaticLayout: true,
            }}
          />
        )}
      </div>
    </div>
  );
}
```

- [ ] **Step 3: Apply the Vivid theme to the Code Diff tab (consistency).** In `src/components/diff-viewer.tsx`: add the import `import { defineVividTheme, VIVID_THEME } from "@/lib/monaco-theme";` near the top, then on the `<DiffEditor>` change `theme="vs-dark"` to `theme={VIVID_THEME}` and add the prop `beforeMount={defineVividTheme}`.

- [ ] **Step 4: Build.**

Run: `pnpm build`
Expected: clean compile.

- [ ] **Step 5: Commit.**

```bash
git add src/lib/monaco-theme.ts src/components/file-explorer.tsx src/components/diff-viewer.tsx
git commit -m "feat(file-explorer): FileExplorer + read-only Monaco viewer + shared Vivid theme"
```

---

### Task 6: Wire the "Files" tab into the workspace (`mission-control.tsx`)

**Files:**
- Modify: `src/components/mission-control.tsx`

- [ ] **Step 1: Import the component.** Add near the other `@/components` imports:

```ts
import FileExplorer from "@/components/file-explorer";
```

- [ ] **Step 2: Add the "Files" tab button.** The workspace tab row has buttons for preview/plan/code/terminal (`:1325-1373`). After the Terminal button's closing `</button>` (the one whose `onClick` is `() => setActiveTab("terminal")`), add a Files button mirroring the others' markup:

```tsx
              <button
                onClick={() => setActiveTab("files")}
                className={`flex items-center gap-1.5 px-3 py-1.5 text-[11px] font-mono rounded-t border-b-2 transition-colors ${
                  activeTab === "files"
                    ? "text-[#00e0ff] border-[#00e0ff]"
                    : "text-[#5c6470] border-transparent hover:text-[#8b949e]"
                }`}
              >
                <FolderTree className="w-3.5 h-3.5" />
                Files
              </button>
```

Confirm `FolderTree` is imported from `lucide-react` at the top of the file; if not, add it to the existing `lucide-react` import. (Match the exact className pattern of the adjacent Preview/Code buttons if it differs from the above — copy their wrapper classes and just swap the label/icon/`activeTab` value.)

- [ ] **Step 3: Add the content branch.** Alongside the other `{activeTab === "..." && (...)}` branches (`:1395-1474`), add:

```tsx
            {activeTab === "files" && <FileExplorer projectId={activeProjectId} />}
```

- [ ] **Step 4: Build.**

Run: `pnpm build`
Expected: `✓ Compiled successfully` + `Finished TypeScript`. Pre-existing next.config.ts NFT warning acceptable.

- [ ] **Step 5: Commit.**

```bash
git add src/components/mission-control.tsx
git commit -m "feat(file-explorer): add the Files tab to the workspace pane"
```

---

### Task 7: Full verification + manual smoke

**Files:** none

- [ ] **Step 1: Build + full test suite.**

Run: `pnpm build && pnpm test`
Expected: build clean; `tests 64 / pass 64 / fail 0`.

- [ ] **Step 2: Manual smoke (operator-run).** With `pnpm dev` running and logged in:
  - Open the **Files** tab → the active project's repo tree renders (top-level entries; **no** `node_modules` / `.git`).
  - Expand folders → children load lazily; file/folder **icons + colors** show (cyan `.tsx`, amber folders/`.json`, etc.).
  - Click a `.tsx`/`.ts`/`.md` → the **read-only Monaco** viewer shows it syntax-highlighted with the Vivid theme; the selected row has the cyan marker.
  - Click an image/binary or a huge file → "Binary or oversized file — not shown."
  - **Switch project** (AXOD Creative ↔ Mission Control via the header dropdown) → the Files tree resets and reflects the new repo.
  - Open the **Code Diff** tab (after a dispatch) → it now renders with the same Vivid syntax theme.

---

## Wrap-up (after Task 7 passes)

- [ ] Add a "what actually happened" note to `docs/superpowers/specs/2026-06-04-file-explorer-design.md`.
- [ ] Update `README.md` roadmap (note the File Explorer; Epics B/C remain).
- [ ] Integrate `feature/file-explorer` → `dev` (operator confirms).

## Self-review (done at authoring)

- **Spec coverage:** two routes → Tasks 2/3; path guard → `resolveWithinRoot` (Task 1) used in both routes; excludes/language/icons → Task 1 used by routes + tree; FileTree lazy + Vivid → Task 4; FileExplorer + Monaco read-only viewer + binary/size placeholder → Task 5; shared Vivid theme + Code-Diff consistency → Task 5; Files tab wiring + active-project prop + project-switch reset → Task 6 (+ FileExplorer `useEffect` on `projectId`); tests → Task 1; verification → Task 7. No gaps.
- **Placeholder scan:** every code step shows full code; no TBD/TODO. The one "match the adjacent button's exact classes" note (Task 6.2) is a deliberate guard against the tab markup having drifted — the engineer copies the real neighbor.
- **Type/name consistency:** `fileLanguage`, `fileIcon`, `EXCLUDED_DIRS`, `resolveWithinRoot`, `defineVividTheme`/`VIVID_THEME`, `FileTree`, `FileExplorer`, the `{ entries }` / `{ content, language } | { binary }` response shapes, and the `?projectId=&dir=` / `?projectId=&path=` query params match across tasks. Test count 59 → 64 consistent (Tasks 1 and 7).
