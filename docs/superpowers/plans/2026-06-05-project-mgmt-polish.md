# Remove Project + Resizable Files Panel — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let the operator remove a project from the switcher (unregister only — never deletes disk files), and drag-resize the File Explorer's tree/viewer split.

**Architecture:** A `DELETE /api/projects/[id]` route cascades the project's children (messages/approvals/artifacts → sessions → tool_permissions → project) and repoints the active-project cookie if needed. `ProjectSwitcher` gains a per-row trash + inline confirm. `FileExplorer` gets a draggable splitter (clamped, localStorage-persisted tree width). Pure helpers (clamp + next-active) are unit-tested.

**Tech Stack:** Next.js route handlers, Drizzle/SQLite, React client components, lucide-react, node:test via tsx.

**Verified anchors:**
- `ProjectSwitcher` (`src/components/project-switcher.tsx`, full file): dropdown rows + "Add project". Task 3 rewrites it.
- `FileExplorer` (`src/components/file-explorer.tsx`, full file): tree `<div className="w-60 shrink-0 ...">` + `flex-1` viewer. Task 4 rewrites it.
- Dynamic route + cookie pattern: `src/app/api/sessions/[id]/clear/route.ts` (`ctx: { params: Promise<{ id: string }> }`, `SESSION_COOKIE`/`verifySession`). `cookieOptions` in `src/lib/auth.ts`; `ACTIVE_PROJECT_COOKIE` in `src/lib/projects.ts`.
- Schema tables (`src/db/schema.ts`): `projects, sessions, messages, approvals, artifacts, tool_permissions`.

---

### Task 1: Pure helpers + tests (`src/lib/ui-helpers.ts`)

**Files:**
- Create: `src/lib/ui-helpers.ts`
- Test: `src/lib/ui-helpers.test.ts`

- [ ] **Step 1: Write the failing test.** Create `src/lib/ui-helpers.test.ts`:

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { clampTreeWidth, nextActiveProjectId } from './ui-helpers';

test('clampTreeWidth clamps to [160, 560] and defaults NaN', () => {
  assert.equal(clampTreeWidth(300), 300);
  assert.equal(clampTreeWidth(50), 160);
  assert.equal(clampTreeWidth(9999), 560);
  assert.equal(clampTreeWidth(Number.NaN), 260);
});

test('nextActiveProjectId: removing the active picks the first other project', () => {
  const P = [{ id: 'a' }, { id: 'b' }, { id: 'c' }];
  assert.equal(nextActiveProjectId(P, 'a', 'a'), 'b');
  assert.equal(nextActiveProjectId(P, 'b', 'b'), 'a');
});

test('nextActiveProjectId: removing a non-active project leaves the active unchanged', () => {
  const P = [{ id: 'a' }, { id: 'b' }];
  assert.equal(nextActiveProjectId(P, 'b', 'a'), 'a');
});

test('nextActiveProjectId: removing the only project yields undefined', () => {
  assert.equal(nextActiveProjectId([{ id: 'a' }], 'a', 'a'), undefined);
});
```

- [ ] **Step 2: Run, confirm FAIL.**

Run: `pnpm exec tsx --test src/lib/ui-helpers.test.ts`
Expected: FAIL — cannot find module `./ui-helpers`.

- [ ] **Step 3: Implement `src/lib/ui-helpers.ts`:**

```ts
// Small pure UI helpers (no DOM/DB). Unit-tested.

const TREE_MIN = 160;
const TREE_MAX = 560;
export const TREE_DEFAULT = 260;

/** Clamp a desired file-tree width to the allowed range; NaN → the default. */
export function clampTreeWidth(px: number): number {
  if (Number.isNaN(px)) return TREE_DEFAULT;
  return Math.max(TREE_MIN, Math.min(TREE_MAX, px));
}

/**
 * The project that should become active after removing `removedId`. If the removed
 * project was the active one, pick the first remaining project (id ≠ removedId);
 * otherwise keep the current active id. Returns undefined if nothing remains.
 */
export function nextActiveProjectId(
  projects: { id: string }[],
  removedId: string,
  currentActiveId: string | undefined,
): string | undefined {
  if (currentActiveId !== removedId) return currentActiveId;
  return projects.find((p) => p.id !== removedId)?.id;
}
```

- [ ] **Step 4: Run, confirm PASS.**

Run: `pnpm exec tsx --test src/lib/ui-helpers.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 5: Full suite.**

Run: `pnpm test`
Expected: `tests 72 / pass 72 / fail 0` (existing 68 + 4 new).

- [ ] **Step 6: Commit.**

```bash
git add src/lib/ui-helpers.ts src/lib/ui-helpers.test.ts
git commit -m "feat(project-mgmt): clampTreeWidth + nextActiveProjectId helpers + tests"
```

---

### Task 2: `DELETE /api/projects/[id]` (cascade + guards)

**Files:**
- Create: `src/app/api/projects/[id]/route.ts`

- [ ] **Step 1: Create the route.** Create `src/app/api/projects/[id]/route.ts`:

```ts
import { cookies } from 'next/headers';
import { eq, inArray } from 'drizzle-orm';
import { db } from '@/db/client';
import { projects, sessions, messages, approvals, artifacts, tool_permissions } from '@/db/schema';
import { SESSION_COOKIE, verifySession, cookieOptions } from '@/lib/auth';
import { ACTIVE_PROJECT_COOKIE } from '@/lib/projects';
import { nextActiveProjectId } from '@/lib/ui-helpers';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function DELETE(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  const jar = await cookies();
  const token = jar.get(SESSION_COOKIE)?.value;
  if (!token || !(await verifySession(token))) {
    return Response.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const { id } = await ctx.params;

  const all = await db.select({ id: projects.id }).from(projects);
  if (all.length <= 1) {
    return Response.json({ error: 'Cannot remove the only project.' }, { status: 400 });
  }
  if (!all.some((p) => p.id === id)) {
    return Response.json({ error: 'Project not found' }, { status: 404 });
  }

  try {
    // FK-safe manual cascade (no ON DELETE CASCADE in the schema).
    const sess = await db.select({ id: sessions.id }).from(sessions).where(eq(sessions.project_id, id));
    const sessionIds = sess.map((s) => s.id);
    if (sessionIds.length) {
      await db.delete(messages).where(inArray(messages.session_id, sessionIds));
      await db.delete(approvals).where(inArray(approvals.session_id, sessionIds));
      await db.delete(artifacts).where(inArray(artifacts.session_id, sessionIds));
      await db.delete(sessions).where(inArray(sessions.id, sessionIds));
    }
    await db.delete(tool_permissions).where(eq(tool_permissions.project_id, id));
    await db.delete(projects).where(eq(projects.id, id));
  } catch (e) {
    return Response.json(
      { error: `Could not remove project: ${e instanceof Error ? e.message : String(e)}` },
      { status: 500 },
    );
  }

  // Repoint the active-project cookie if it pointed at the removed project.
  const cookieId = jar.get(ACTIVE_PROJECT_COOKIE)?.value;
  const next = nextActiveProjectId(all, id, cookieId);
  if (cookieId === id && next) {
    jar.set(ACTIVE_PROJECT_COOKIE, next, cookieOptions());
  }

  return Response.json({ ok: true });
}
```

(This only unregisters — there are no `fs` calls, so the repo on disk is untouched.)

- [ ] **Step 2: Build.**

Run: `pnpm build`
Expected: `✓ Compiled successfully` + `Finished TypeScript`; `ƒ /api/projects/[id]` in the route list. Pre-existing next.config.ts NFT warning acceptable. Report BLOCKED with the exact message on any TS error (e.g. if `artifacts` isn't exported from schema — it is).

- [ ] **Step 3: Commit.**

```bash
git add src/app/api/projects/[id]/route.ts
git commit -m "feat(project-mgmt): DELETE /api/projects/[id] (cascade, last-project guard, cookie repoint)"
```

---

### Task 3: `ProjectSwitcher` remove control (full rewrite)

**Files:**
- Modify: `src/components/project-switcher.tsx` (full rewrite)

- [ ] **Step 1: Replace the file** with:

```tsx
"use client";

import { useState, useRef, useEffect } from "react";
import { useRouter } from "next/navigation";
import { ChevronDown, Check, Plus, Trash2 } from "lucide-react";
import type { ProjectOption } from "@/lib/mock-data";

export default function ProjectSwitcher({
  projects,
  activeProjectId,
  onAddProject,
}: {
  projects: ProjectOption[];
  activeProjectId: string;
  onAddProject: () => void;
}) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [confirmingId, setConfirmingId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const ref = useRef<HTMLDivElement>(null);
  const active = projects.find((p) => p.id === activeProjectId);

  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) {
        setOpen(false);
        setConfirmingId(null);
        setError(null);
      }
    };
    document.addEventListener("mousedown", onDoc);
    return () => document.removeEventListener("mousedown", onDoc);
  }, [open]);

  async function switchTo(id: string) {
    if (id === activeProjectId) { setOpen(false); return; }
    setBusy(id);
    try {
      await fetch("/api/projects/active", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ projectId: id }),
      });
      setOpen(false);
      router.refresh();
    } finally {
      setBusy(null);
    }
  }

  async function remove(id: string) {
    setBusy(id);
    setError(null);
    try {
      const res = await fetch(`/api/projects/${encodeURIComponent(id)}`, { method: "DELETE" });
      if (!res.ok) {
        const b = await res.json().catch(() => ({}));
        setError(b.error ?? `Failed (${res.status})`);
        setConfirmingId(null);
        return;
      }
      setConfirmingId(null);
      setOpen(false);
      router.refresh();
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="relative hidden sm:block" ref={ref}>
      <button
        onClick={() => setOpen((o) => !o)}
        className="flex items-center gap-2 px-2.5 py-1 bg-[#161c25] border border-[#1e2632] rounded-md cursor-pointer hover:bg-[#1c2330] transition-colors"
      >
        <span className="text-[9px] font-mono text-[#5c6470] uppercase tracking-wider">PROJECT</span>
        <span className="text-xs font-semibold text-[#e6edf3]">{active?.name ?? "—"}</span>
        <ChevronDown className="w-3.5 h-3.5 text-[#5c6470]" />
      </button>

      {open && (
        <div className="absolute left-0 top-full mt-1 z-50 min-w-[240px] bg-[#11161d] border border-[#2a3441] rounded-md shadow-lg shadow-black/40 py-1">
          {projects.map((p) =>
            confirmingId === p.id ? (
              <div key={p.id} className="flex items-center gap-2 px-3 py-1.5 text-xs text-[#e6edf3]">
                <span className="flex-1 min-w-0 truncate">
                  Remove <span className="font-semibold">{p.name}</span>?
                  <span className="block text-[9.5px] text-[#5c6470] font-mono">files on disk are kept</span>
                </span>
                <button
                  onClick={() => remove(p.id)}
                  disabled={busy !== null}
                  className="text-[10px] font-mono text-red-400 hover:text-red-300 px-1.5 py-0.5 rounded border border-red-500/40 disabled:opacity-50"
                >
                  remove
                </button>
                <button
                  onClick={() => setConfirmingId(null)}
                  className="text-[10px] font-mono text-[#8b949e] hover:text-[#e6edf3] px-1.5 py-0.5"
                >
                  cancel
                </button>
              </div>
            ) : (
              <div key={p.id} className="group flex items-center hover:bg-[#1c2330] transition-colors">
                <button
                  onClick={() => switchTo(p.id)}
                  disabled={busy !== null}
                  className="flex-1 min-w-0 flex items-center gap-2 px-3 py-1.5 text-xs text-[#e6edf3] text-left disabled:opacity-50"
                >
                  <span className="w-3.5 shrink-0">
                    {p.id === activeProjectId && <Check className="w-3.5 h-3.5 text-[#00e0ff]" />}
                  </span>
                  <span className="truncate">{p.name}</span>
                </button>
                <button
                  onClick={() => { setConfirmingId(p.id); setError(null); }}
                  title="Remove project"
                  className="shrink-0 px-2 text-[#5c6470] opacity-0 group-hover:opacity-100 hover:text-red-400 transition-all"
                >
                  <Trash2 className="w-3.5 h-3.5" />
                </button>
              </div>
            ),
          )}

          {error && (
            <div className="mx-2 my-1 px-2 py-1 rounded text-[10px] font-mono bg-red-500/10 border border-red-500/40 text-red-400">
              {error}
            </div>
          )}

          <div className="my-1 h-px bg-[#1e2632]" />
          <button
            onClick={() => { setOpen(false); onAddProject(); }}
            className="w-full flex items-center gap-2 px-3 py-1.5 text-xs text-[#00e0ff] hover:bg-[#1c2330] transition-colors text-left"
          >
            <Plus className="w-3.5 h-3.5" />
            Add project
          </button>
        </div>
      )}
    </div>
  );
}
```

- [ ] **Step 2: Build.**

Run: `pnpm build`
Expected: clean compile.

- [ ] **Step 3: Commit.**

```bash
git add src/components/project-switcher.tsx
git commit -m "feat(project-mgmt): remove-project control (trash + inline confirm) in the switcher"
```

---

### Task 4: Resizable Files panel (`FileExplorer` rewrite)

**Files:**
- Modify: `src/components/file-explorer.tsx` (full rewrite)

- [ ] **Step 1: Replace the file** with (adds the drag handle + persisted width; the viewer block is unchanged):

```tsx
"use client";

import { useState, useEffect, useCallback, useRef } from "react";
import dynamic from "next/dynamic";
import FileTree from "@/components/file-tree";
import { defineVividTheme, VIVID_THEME } from "@/lib/monaco-theme";
import { clampTreeWidth, TREE_DEFAULT } from "@/lib/ui-helpers";

const MonacoEditor = dynamic(() => import("@monaco-editor/react").then((m) => m.Editor), {
  ssr: false,
  loading: () => <div className="p-4 text-[11px] font-mono text-[#5c6470]">Loading editor…</div>,
});

const WIDTH_KEY = "mc_files_tree_width";

export default function FileExplorer({ projectId }: { projectId: string }) {
  const [selectedPath, setSelectedPath] = useState<string | null>(null);
  const [content, setContent] = useState<string>("");
  const [language, setLanguage] = useState<string>("plaintext");
  const [binary, setBinary] = useState(false);
  const [loading, setLoading] = useState(false);
  const [treeWidth, setTreeWidth] = useState(TREE_DEFAULT);
  const drag = useRef<{ startX: number; startW: number } | null>(null);

  // Restore the saved tree width on mount.
  useEffect(() => {
    const saved = window.localStorage.getItem(WIDTH_KEY);
    if (saved !== null) setTreeWidth(clampTreeWidth(parseInt(saved, 10)));
  }, []);

  // Reset the open file when the active project changes.
  useEffect(() => {
    setSelectedPath(null);
    setContent("");
    setBinary(false);
  }, [projectId]);

  const onDragMove = useCallback((e: MouseEvent) => {
    if (!drag.current) return;
    setTreeWidth(clampTreeWidth(drag.current.startW + (e.clientX - drag.current.startX)));
  }, []);

  const onDragEnd = useCallback(() => {
    drag.current = null;
    document.removeEventListener("mousemove", onDragMove);
    document.removeEventListener("mouseup", onDragEnd);
    setTreeWidth((w) => {
      window.localStorage.setItem(WIDTH_KEY, String(w));
      return w;
    });
  }, [onDragMove]);

  const onDragStart = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    drag.current = { startX: e.clientX, startW: treeWidth };
    document.addEventListener("mousemove", onDragMove);
    document.addEventListener("mouseup", onDragEnd);
  }, [treeWidth, onDragMove, onDragEnd]);

  const resetWidth = useCallback(() => {
    setTreeWidth(TREE_DEFAULT);
    window.localStorage.setItem(WIDTH_KEY, String(TREE_DEFAULT));
  }, []);

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
      <div style={{ width: treeWidth }} className="shrink-0 overflow-y-auto bg-[#0d1117]">
        <FileTree projectId={projectId} selectedPath={selectedPath} onSelect={open} />
      </div>

      {/* drag handle */}
      <div
        onMouseDown={onDragStart}
        onDoubleClick={resetWidth}
        title="Drag to resize · double-click to reset"
        className="w-1 shrink-0 cursor-col-resize bg-[#1e2632] hover:bg-[#00e0ff]/40 transition-colors"
      />

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

- [ ] **Step 2: Build.**

Run: `pnpm build`
Expected: `✓ Compiled successfully` + `Finished TypeScript`. Pre-existing next.config.ts NFT warning acceptable.

- [ ] **Step 3: Commit.**

```bash
git add src/components/file-explorer.tsx
git commit -m "feat(project-mgmt): resizable Files tree (drag handle, clamped, persisted width)"
```

---

### Task 5: Full verification + manual smoke

**Files:** none

- [ ] **Step 1: Build + full test suite.**

Run: `pnpm build && pnpm test`
Expected: build clean; `tests 72 / pass 72 / fail 0`.

- [ ] **Step 2: Manual smoke (operator-run).** With `pnpm dev` running and logged in:
  - **Remove (non-active):** open PROJECT ▾ → hover a non-active project → trash icon → **remove** → it disappears from the list; its repo folder on disk is **untouched**.
  - **Remove (active):** remove the currently-active project → the view repoints to another project (header reflects it).
  - **Last-project guard:** with one project left, the trash → remove → an inline error "Cannot remove the only project."
  - **Resize:** open the **Files** tab → drag the splitter between tree and viewer → the tree widens/narrows (long filenames fit); **reload** → the width persists; **double-click** the handle → resets to default.

---

## Wrap-up (after Task 5 passes)

- [ ] Add a "what actually happened" note to `docs/superpowers/specs/2026-06-05-project-mgmt-polish-design.md`.
- [ ] Update `README.md` if it tracks these (a brief line; optional).
- [ ] Integrate `feature/project-mgmt-polish` → `dev` (operator confirms).

## Self-review (done at authoring)

- **Spec coverage:** clampTreeWidth + nextActiveProjectId (+ tests) → Task 1; DELETE route (last-project guard, 404, cascade, cookie repoint, no fs) → Task 2; switcher trash + inline confirm + DELETE call → Task 3; resizable tree (drag handle, clamp, localStorage persist, double-click reset) → Task 4; verification → Task 5. No gaps.
- **Placeholder scan:** full code in every step; no TBD/TODO.
- **Type/name consistency:** `clampTreeWidth`/`TREE_DEFAULT`/`nextActiveProjectId`, the `DELETE /api/projects/[id]` shape, `mc_files_tree_width` key, and the schema table imports match across tasks. Test count 68 → 72 consistent (Tasks 1 and 5).
