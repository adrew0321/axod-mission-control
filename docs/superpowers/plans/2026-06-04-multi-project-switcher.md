# Multi-Project Switcher (v1.4) — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let the operator switch the active project (repo) the agent team targets, and add new projects in-app — with Mission Control's own repo seeded as a 2nd project.

**Architecture:** An `mc_active_project` cookie holds the active project id; `HomePage` resolves it server-side (cookie → recent-session project → first) and loads/creates that project's session. A real header dropdown switches projects (`POST /api/projects/active`); an "Add project" modal registers a local git repo (`POST /api/projects`). Pure helpers (resolve/slug/validate) are unit-tested; routes + UI are build/manual.

**Tech Stack:** Next.js (App Router, server components + route handlers), Drizzle/SQLite, `next/headers` cookies, React client components, node:test via tsx.

**Spec:** `docs/superpowers/specs/2026-06-04-multi-project-switcher-design.md`
**Branch:** `feature/multi-project-switcher` (already created off `dev`).

**Verified anchors:**
- `MissionControlProps`: `src/components/mission-control.tsx:43-47`. Placeholder project dropdown: `:764-768`. `<MissionControl .../>` render: `src/app/page.tsx:175-181`. Session load: `page.tsx:43-64`.
- Cookie pattern: `src/lib/auth.ts:72-80` (`cookieOptions`), used via `const jar = await cookies(); jar.set(NAME, val, opts)` (`src/app/api/auth/login/route.ts:46-47`).
- API route pattern (auth-gated POST): `src/app/api/sessions/[id]/clear/route.ts` — `runtime='nodejs'`, `dynamic='force-dynamic'`, `SESSION_COOKIE`/`verifySession` 401 guard, `Response.json`.
- `Session`/`Agent`/`Message` UI types live in `src/lib/mock-data.ts`.

---

### Task 1: Pure helpers + tests (`src/lib/projects.ts`)

**Files:**
- Create: `src/lib/projects.ts`
- Test: `src/lib/projects.test.ts`

- [ ] **Step 1: Write the failing test.** Create `src/lib/projects.test.ts`:

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  resolveActiveProject,
  slugifyProjectId,
  validateNewProjectInput,
} from './projects';

const P = [{ id: 'axod-creative' }, { id: 'mission-control' }];

test('resolveActiveProject prefers the cookie project when it exists', () => {
  assert.equal(resolveActiveProject(P, 'mission-control', 'axod-creative')?.id, 'mission-control');
});

test('resolveActiveProject falls back to the recent-session project, then the first', () => {
  assert.equal(resolveActiveProject(P, undefined, 'mission-control')?.id, 'mission-control');
  assert.equal(resolveActiveProject(P, 'nope', undefined)?.id, 'axod-creative');
  assert.equal(resolveActiveProject(P, undefined, 'gone')?.id, 'axod-creative');
});

test('resolveActiveProject returns undefined when there are no projects', () => {
  assert.equal(resolveActiveProject([], 'x', 'y'), undefined);
});

test('slugifyProjectId lowercases and dashes non-alphanumerics', () => {
  assert.equal(slugifyProjectId('AXOD Creative'), 'axod-creative');
  assert.equal(slugifyProjectId('  My_Repo!! 2  '), 'my-repo-2');
});

test('validateNewProjectInput requires name and repoPath', () => {
  assert.deepEqual(validateNewProjectInput({ name: 'X', repoPath: '/p' }), { ok: true });
  assert.equal(validateNewProjectInput({ name: '', repoPath: '/p' }).ok, false);
  assert.equal(validateNewProjectInput({ name: 'X', repoPath: '  ' }).ok, false);
});
```

- [ ] **Step 2: Run the test to verify it fails.**

Run: `pnpm exec tsx --test src/lib/projects.test.ts`
Expected: FAIL — cannot find module `./projects`.

- [ ] **Step 3: Write the implementation.** Create `src/lib/projects.ts`:

```ts
// Pure project helpers (no DB/fs) — shared by the server (page.tsx, routes) and
// unit-tested under `tsx --test`. The cookie name lives here as the single source.

export const ACTIVE_PROJECT_COOKIE = 'mc_active_project';

/**
 * Pick the active project: the cookie's project if it still exists, else the
 * most-recent session's project, else the first project. Returns undefined only
 * when there are no projects at all.
 */
export function resolveActiveProject<T extends { id: string }>(
  projects: T[],
  cookieId: string | undefined,
  recentSessionProjectId: string | undefined,
): T | undefined {
  if (projects.length === 0) return undefined;
  return (
    (cookieId && projects.find((p) => p.id === cookieId)) ||
    (recentSessionProjectId && projects.find((p) => p.id === recentSessionProjectId)) ||
    projects[0]
  );
}

/** Turn a project name into a stable id: lowercase, non-alphanumerics → '-', trimmed/collapsed. */
export function slugifyProjectId(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

export type NewProjectInput = {
  name?: string;
  repoPath?: string;
  defaultBranch?: string;
  githubUrl?: string;
};

/** Shape-only validation (the filesystem repo check happens in the route). */
export function validateNewProjectInput(
  input: NewProjectInput,
): { ok: true } | { ok: false; error: string } {
  if (!input.name || !input.name.trim()) return { ok: false, error: 'Project name is required.' };
  if (!input.repoPath || !input.repoPath.trim()) return { ok: false, error: 'Repo path is required.' };
  return { ok: true };
}
```

- [ ] **Step 4: Run the test to verify it passes.**

Run: `pnpm exec tsx --test src/lib/projects.test.ts`
Expected: PASS (all 5 tests).

- [ ] **Step 5: Confirm the full suite passes.**

Run: `pnpm test`
Expected: `tests 59 / pass 59 / fail 0` (existing 54 + 5 new).

- [ ] **Step 6: Commit.**

```bash
git add src/lib/projects.ts src/lib/projects.test.ts
git commit -m "feat(multi-project): pure project helpers (resolve/slug/validate) + tests"
```

---

### Task 2: Seed Mission Control as a 2nd project (`scripts/seed.ts`)

**Files:**
- Modify: `scripts/seed.ts`

- [ ] **Step 1: Add the Mission Control project row.** In `scripts/seed.ts`, find the existing `db.insert(schema.projects).values({ ... id: 'axod-creative' ... }).onConflictDoNothing();` block. Change it to insert **both** projects by replacing the single `.values({...})` object with an array of two. The existing block is:

```ts
  await db
    .insert(schema.projects)
    .values({
      id: 'axod-creative',
      name: 'AXOD CREATIVE',
      repo_path: "c:/Users/A'KeemDrew/AXOD/landing",
      github_url: 'https://github.com/adrew0321/axod-creative',
      default_branch: 'dev',
      created_at: now,
    })
    .onConflictDoNothing();
```

Replace it with:

```ts
  await db
    .insert(schema.projects)
    .values([
      {
        id: 'axod-creative',
        name: 'AXOD CREATIVE',
        repo_path: "c:/Users/A'KeemDrew/AXOD/landing",
        github_url: 'https://github.com/adrew0321/axod-creative',
        default_branch: 'dev',
        created_at: now,
      },
      {
        id: 'mission-control',
        name: 'AXOD Mission Control',
        repo_path: process.cwd(),
        github_url: 'https://github.com/adrew0321/axod-mission-control',
        default_branch: 'dev',
        created_at: now,
      },
    ])
    .onConflictDoNothing();
```

(`process.cwd()` is the repo root when `pnpm seed` runs. No `tool_permissions` rows are seeded for it — the approval gate is dormant; `tools_allowlist` constrains agents at runtime.)

- [ ] **Step 2: Type-check the seed.**

Run: `pnpm exec tsc --noEmit -p tsconfig.json`
Expected: no errors.

- [ ] **Step 3: Re-seed and confirm both projects exist.**

Run: `pnpm seed`
Expected: `Seed complete: { projects: 2, ... }`.

Run: `node -e "const D=require('better-sqlite3');const db=new D(process.env.DATABASE_PATH||'./data/mission-control.db');console.log(db.prepare('select id,name,repo_path from projects').all())"`
Expected: two rows — `axod-creative` and `mission-control` (whose `repo_path` is this repo's absolute path).

- [ ] **Step 4: Commit.**

```bash
git add scripts/seed.ts
git commit -m "feat(multi-project): seed Mission Control's own repo as a 2nd project"
```

---

### Task 3: Server session helper (`src/lib/active-project.ts`)

**Files:**
- Create: `src/lib/active-project.ts`

- [ ] **Step 1: Create the helper.** Create `src/lib/active-project.ts`:

```ts
import 'server-only';
import { randomBytes, bytesToHex } from '@noble/hashes/utils.js';
import { desc, eq } from 'drizzle-orm';
import { db } from '@/db/client';
import { projects, sessions } from '@/db/schema';

/**
 * Return the project's most-recently-updated session, creating one if the project
 * has none yet (so a freshly added / freshly switched-to project always has a
 * workspace session). The session's branch defaults to the project's default_branch.
 */
export async function getOrCreateActiveSession(projectId: string) {
  const existing = await db
    .select()
    .from(sessions)
    .where(eq(sessions.project_id, projectId))
    .orderBy(desc(sessions.updated_at))
    .limit(1)
    .then((r) => r[0]);
  if (existing) return existing;

  const project = await db
    .select()
    .from(projects)
    .where(eq(projects.id, projectId))
    .limit(1)
    .then((r) => r[0]);

  const now = new Date();
  const row = {
    id: `sess_${bytesToHex(randomBytes(4))}`,
    project_id: projectId,
    title: '(new session)',
    branch: project?.default_branch ?? 'dev',
    worktree_path: null,
    status: 'active',
    cleared_at: null,
    created_at: now,
    updated_at: now,
  };
  await db.insert(sessions).values(row);
  return row;
}
```

- [ ] **Step 2: Verify the id-generation import resolves.** The stream route already imports `bytesToHex`/`randomBytes` for `msg_…` ids — confirm the import path matches what that file uses.

Run: `git grep -n "bytesToHex" -- src/app/api/sessions/[id]/stream/route.ts`
Expected: an import of `bytesToHex`/`randomBytes`. If its source differs from `@noble/hashes/utils`, change Task 3's import to match that exact source.

- [ ] **Step 3: Type-check.**

Run: `pnpm exec tsc --noEmit -p tsconfig.json`
Expected: no errors.

- [ ] **Step 4: Commit.**

```bash
git add src/lib/active-project.ts
git commit -m "feat(multi-project): getOrCreateActiveSession server helper"
```

---

### Task 4: Resolve the active project in `page.tsx`

**Files:**
- Modify: `src/app/page.tsx`

- [ ] **Step 1: Add imports.** At the top of `src/app/page.tsx`, alongside the existing imports, add:

```ts
import { cookies } from "next/headers";
import { resolveActiveProject, ACTIVE_PROJECT_COOKIE } from "@/lib/projects";
import { getOrCreateActiveSession } from "@/lib/active-project";
```

- [ ] **Step 2: Replace the "current session" load with active-project resolution.** The current block (around `page.tsx:43-64`) is:

```ts
  const currentSessionRow = await db
    .select()
    .from(sessions)
    .orderBy(desc(sessions.updated_at))
    .limit(1)
    .then((rows) => rows[0]);

  if (!currentSessionRow) {
    return (
      <div className="flex items-center justify-center h-screen bg-[#060810] text-[#8b949e] font-mono text-sm">
        No sessions yet — run <code className="text-[#00e0ff] ml-1">pnpm seed</code> to populate
        the database.
      </div>
    );
  }

  const project = await db
    .select()
    .from(projects)
    .where(eq(projects.id, currentSessionRow.project_id))
    .limit(1)
    .then((rows) => rows[0]);
```

Replace that entire block with:

```ts
  const projectRows = await db.select().from(projects);
  if (projectRows.length === 0) {
    return (
      <div className="flex items-center justify-center h-screen bg-[#060810] text-[#8b949e] font-mono text-sm">
        No projects yet — run <code className="text-[#00e0ff] ml-1">pnpm seed</code> to populate
        the database.
      </div>
    );
  }

  const recentSession = await db
    .select()
    .from(sessions)
    .orderBy(desc(sessions.updated_at))
    .limit(1)
    .then((rows) => rows[0]);

  const jar = await cookies();
  const project = resolveActiveProject(
    projectRows,
    jar.get(ACTIVE_PROJECT_COOKIE)?.value,
    recentSession?.project_id,
  )!; // non-null: projectRows is non-empty (guarded above)

  const currentSessionRow = await getOrCreateActiveSession(project.id);
```

(Everything downstream — `messageRows`, `approvalRows`, `totals`, `sessionForUi` — already keys off `currentSessionRow` / `project`, so it keeps working unchanged.)

- [ ] **Step 3: Pass the projects list + active id to `MissionControl`.** Replace the render (`page.tsx:175-181`):

```tsx
  return (
    <MissionControl
      team={team}
      session={sessionForUi}
      initialMessages={messagesForUi}
    />
  );
```

with:

```tsx
  return (
    <MissionControl
      team={team}
      session={sessionForUi}
      initialMessages={messagesForUi}
      projects={projectRows.map((p) => ({ id: p.id, name: p.name }))}
      activeProjectId={project.id}
    />
  );
```

- [ ] **Step 4: Build.**

Run: `pnpm build`
Expected: a TypeScript error that `MissionControl` doesn't accept `projects`/`activeProjectId` yet — that's expected; Task 6 adds the props. (If you prefer a green build at every task, do Task 6 before re-running.) Proceed to commit; the prop types land in Task 6.

- [ ] **Step 5: Commit.**

```bash
git add src/app/page.tsx
git commit -m "feat(multi-project): resolve active project from cookie in page.tsx"
```

---

### Task 5: Switch-project route (`POST /api/projects/active`)

**Files:**
- Create: `src/app/api/projects/active/route.ts`

- [ ] **Step 1: Create the route.** Create `src/app/api/projects/active/route.ts`:

```ts
import { cookies } from 'next/headers';
import { eq } from 'drizzle-orm';
import { db } from '@/db/client';
import { projects } from '@/db/schema';
import { SESSION_COOKIE, verifySession, cookieOptions } from '@/lib/auth';
import { ACTIVE_PROJECT_COOKIE } from '@/lib/projects';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(req: Request) {
  const jar = await cookies();
  const token = jar.get(SESSION_COOKIE)?.value;
  if (!token || !(await verifySession(token))) {
    return Response.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const body = (await req.json().catch(() => ({}))) as { projectId?: string };
  if (!body.projectId) return Response.json({ error: 'projectId is required' }, { status: 400 });

  const project = await db
    .select()
    .from(projects)
    .where(eq(projects.id, body.projectId))
    .limit(1)
    .then((r) => r[0]);
  if (!project) return Response.json({ error: 'Unknown project' }, { status: 400 });

  jar.set(ACTIVE_PROJECT_COOKIE, project.id, cookieOptions());
  return Response.json({ ok: true, projectId: project.id });
}
```

- [ ] **Step 2: Build.**

Run: `pnpm build`
Expected: compiles (the new route is self-contained). The `page.tsx` prop-type error from Task 4 may still show until Task 6 — that's fine.

- [ ] **Step 3: Commit.**

```bash
git add src/app/api/projects/active/route.ts
git commit -m "feat(multi-project): POST /api/projects/active sets the active-project cookie"
```

---

### Task 6: Client types + `MissionControl` props + project dropdown (`ProjectSwitcher`)

**Files:**
- Modify: `src/lib/mock-data.ts`
- Create: `src/components/project-switcher.tsx`
- Modify: `src/components/mission-control.tsx`

- [ ] **Step 1: Add the `ProjectOption` type.** In `src/lib/mock-data.ts`, after the `Session` interface (anywhere at top level), add:

```ts
export interface ProjectOption {
  id: string;
  name: string;
}
```

- [ ] **Step 2: Create the `ProjectSwitcher` component.** Create `src/components/project-switcher.tsx`:

```tsx
"use client";

import { useState, useRef, useEffect } from "react";
import { useRouter } from "next/navigation";
import { ChevronDown, Check, Plus } from "lucide-react";
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
  const [switching, setSwitching] = useState<string | null>(null);
  const ref = useRef<HTMLDivElement>(null);
  const active = projects.find((p) => p.id === activeProjectId);

  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", onDoc);
    return () => document.removeEventListener("mousedown", onDoc);
  }, [open]);

  async function switchTo(id: string) {
    if (id === activeProjectId) { setOpen(false); return; }
    setSwitching(id);
    try {
      await fetch("/api/projects/active", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ projectId: id }),
      });
      setOpen(false);
      router.refresh();
    } finally {
      setSwitching(null);
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
        <div className="absolute left-0 top-full mt-1 z-50 min-w-[220px] bg-[#11161d] border border-[#2a3441] rounded-md shadow-lg shadow-black/40 py-1">
          {projects.map((p) => (
            <button
              key={p.id}
              onClick={() => switchTo(p.id)}
              disabled={switching !== null}
              className="w-full flex items-center gap-2 px-3 py-1.5 text-xs text-[#e6edf3] hover:bg-[#1c2330] transition-colors text-left disabled:opacity-50"
            >
              <span className="w-3.5 shrink-0">
                {p.id === activeProjectId && <Check className="w-3.5 h-3.5 text-[#00e0ff]" />}
              </span>
              {p.name}
            </button>
          ))}
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

- [ ] **Step 3: Add the props to `MissionControlProps`.** In `src/components/mission-control.tsx`, replace the interface (`:43-47`):

```ts
export interface MissionControlProps {
  team: Agent[];
  session: Session;
  initialMessages: Message[];
}
```

with:

```ts
export interface MissionControlProps {
  team: Agent[];
  session: Session;
  initialMessages: Message[];
  projects: ProjectOption[];
  activeProjectId: string;
}
```

- [ ] **Step 4: Destructure the new props + add modal state.** Find the component signature `export default function MissionControl({ team: initialTeam, session: initialSession, ... })` and add `projects` and `activeProjectId` to the destructured params. Then, near the other `useState` hooks (e.g. right after `const [team] = useState<Agent[]>(initialTeam);`), add:

```ts
  const [addProjectOpen, setAddProjectOpen] = useState(false);
```

- [ ] **Step 5: Add imports.** At the top of `mission-control.tsx`, add to the `@/lib/mock-data` import the `ProjectOption` type, and add the two component imports:

```ts
import ProjectSwitcher from "@/components/project-switcher";
import AddProjectDialog from "@/components/add-project-dialog";
```

(`AddProjectDialog` is created in Task 7. If you build between tasks, create a temporary stub or do Task 7 first — Task 7 is small.)

Update the existing `import type { Agent, Message, Session } from "@/lib/mock-data";` to also import `ProjectOption`:

```ts
import type { Agent, Message, Session, ProjectOption } from "@/lib/mock-data";
```

- [ ] **Step 6: Replace the placeholder dropdown.** Replace the static PROJECT block (`mission-control.tsx:764-768`):

```tsx
          <div className="hidden sm:flex items-center gap-2 px-2.5 py-1 bg-[#161c25] border border-[#1e2632] rounded-md cursor-pointer hover:bg-[#1c2330] transition-colors">
            <span className="text-[9px] font-mono text-[#5c6470] uppercase tracking-wider">PROJECT</span>
            <span className="text-xs font-semibold text-[#e6edf3]">{session.project}</span>
            <ChevronDown className="w-3.5 h-3.5 text-[#5c6470]" />
          </div>
```

with:

```tsx
          <ProjectSwitcher
            projects={projects}
            activeProjectId={activeProjectId}
            onAddProject={() => setAddProjectOpen(true)}
          />
```

- [ ] **Step 7: Render the dialog.** Just before the component's final closing `</div>` (the root container that opens at `:742`, right after the `</footer>`), add:

```tsx
      <AddProjectDialog open={addProjectOpen} onClose={() => setAddProjectOpen(false)} />
```

- [ ] **Step 8: Build.**

Run: `pnpm build`
Expected: compiles cleanly once Task 7's `AddProjectDialog` exists (do Task 7 next, then re-run). No more `page.tsx` prop errors.

- [ ] **Step 9: Commit.**

```bash
git add src/lib/mock-data.ts src/components/project-switcher.tsx src/components/mission-control.tsx
git commit -m "feat(multi-project): functional project switcher dropdown"
```

---

### Task 7: Add-project modal (`AddProjectDialog`) + route (`POST /api/projects`)

**Files:**
- Create: `src/app/api/projects/route.ts`
- Create: `src/components/add-project-dialog.tsx`

- [ ] **Step 1: Create the add route.** Create `src/app/api/projects/route.ts`:

```ts
import { existsSync, statSync } from 'node:fs';
import path from 'node:path';
import { cookies } from 'next/headers';
import { eq } from 'drizzle-orm';
import { db } from '@/db/client';
import { projects } from '@/db/schema';
import { SESSION_COOKIE, verifySession, cookieOptions } from '@/lib/auth';
import {
  ACTIVE_PROJECT_COOKIE,
  slugifyProjectId,
  validateNewProjectInput,
} from '@/lib/projects';
import { getOrCreateActiveSession } from '@/lib/active-project';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(req: Request) {
  const jar = await cookies();
  const token = jar.get(SESSION_COOKIE)?.value;
  if (!token || !(await verifySession(token))) {
    return Response.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const body = (await req.json().catch(() => ({}))) as {
    name?: string; repoPath?: string; defaultBranch?: string; githubUrl?: string;
  };

  const shape = validateNewProjectInput(body);
  if (!shape.ok) return Response.json({ error: shape.error }, { status: 400 });

  const repoPath = body.repoPath!.trim();
  if (!existsSync(repoPath) || !statSync(repoPath).isDirectory()) {
    return Response.json({ error: 'Repo path does not exist or is not a directory.' }, { status: 400 });
  }
  if (!existsSync(path.join(repoPath, '.git'))) {
    return Response.json({ error: 'That folder is not a git repo (no .git found).' }, { status: 400 });
  }

  // Unique id from the name (append -2, -3, … on collision).
  const base = slugifyProjectId(body.name!) || 'project';
  const existing = await db.select({ id: projects.id }).from(projects);
  const taken = new Set(existing.map((p) => p.id));
  let id = base;
  for (let n = 2; taken.has(id); n++) id = `${base}-${n}`;

  const now = new Date();
  await db.insert(projects).values({
    id,
    name: body.name!.trim(),
    repo_path: repoPath,
    github_url: body.githubUrl?.trim() || null,
    default_branch: body.defaultBranch?.trim() || 'dev',
    created_at: now,
  });

  await getOrCreateActiveSession(id);
  jar.set(ACTIVE_PROJECT_COOKIE, id, cookieOptions());
  return Response.json({ ok: true, projectId: id });
}
```

- [ ] **Step 2: Create the dialog.** Create `src/components/add-project-dialog.tsx`:

```tsx
"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { X } from "lucide-react";

export default function AddProjectDialog({
  open,
  onClose,
}: {
  open: boolean;
  onClose: () => void;
}) {
  const router = useRouter();
  const [name, setName] = useState("");
  const [repoPath, setRepoPath] = useState("");
  const [defaultBranch, setDefaultBranch] = useState("dev");
  const [githubUrl, setGithubUrl] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  if (!open) return null;

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setPending(true);
    try {
      const res = await fetch("/api/projects", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name, repoPath, defaultBranch, githubUrl }),
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
        className="w-[400px] bg-[#11161d] border border-[#1e2632] rounded-lg p-6 shadow-lg shadow-black/40"
      >
        <div className="flex items-center justify-between mb-4">
          <h2 className="text-sm font-semibold text-[#e6edf3] font-heading">Add project</h2>
          <button type="button" onClick={onClose} className="text-[#5c6470] hover:text-[#e6edf3]">
            <X className="w-4 h-4" />
          </button>
        </div>

        <label className={labelCls}>Name</label>
        <input className={inputCls} value={name} onChange={(e) => setName(e.target.value)} placeholder="My Client Site" required />

        <label className={labelCls}>Repo path (local)</label>
        <input className={inputCls} value={repoPath} onChange={(e) => setRepoPath(e.target.value)} placeholder="c:/Users/.../my-repo" required />

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
          {pending ? "Adding…" : "Add project"}
        </button>
      </form>
    </div>
  );
}
```

- [ ] **Step 3: Build.**

Run: `pnpm build`
Expected: `✓ Compiled successfully` + `Finished TypeScript` — clean (all props/components now exist). Pre-existing next.config.ts NFT warning is acceptable.

- [ ] **Step 4: Commit.**

```bash
git add src/app/api/projects/route.ts src/components/add-project-dialog.tsx
git commit -m "feat(multi-project): add-project modal + POST /api/projects (validates local git repo)"
```

---

### Task 8: Full verification + manual smoke

**Files:** none

- [ ] **Step 1: Build + full test suite.**

Run: `pnpm build && pnpm test`
Expected: build clean; `tests 59 / pass 59 / fail 0`.

- [ ] **Step 2: Manual smoke (operator-run).** With `pnpm dev` running and logged in:
  - The header **PROJECT** dropdown opens and lists **AXOD CREATIVE** + **AXOD Mission Control**, the active one check-marked.
  - Switch to **AXOD Mission Control** → the view reloads on that project (Target Directory / branch reflect this repo); **reload the page** and confirm it *stays* on Mission Control (cookie persisted).
  - Open **+ Add project** → submit with a bad path → inline error ("does not exist" / "not a git repo"). Submit with a real local git repo → it's added and becomes active.
  - Dispatch a quick agent task and confirm it operates against the **switched project's** repo (Target Directory matches).

---

## Wrap-up (after Task 8 passes)

- [ ] Add a "what actually happened" note to `docs/superpowers/specs/2026-06-04-multi-project-switcher-design.md`.
- [ ] Update `README.md` — mark **v1.4 multi-project switcher** shipped in the roadmap.
- [ ] Integrate `feature/multi-project-switcher` → `dev` (operator confirms); release when appropriate.

## Self-review (done at authoring)

- **Spec coverage:** cookie persistence → `ACTIVE_PROJECT_COOKIE` (Task 1) + routes (5/7) + page.tsx (4); resolution/fallback → `resolveActiveProject` (1) used in page.tsx (4); session auto-create → `getOrCreateActiveSession` (3) used in page.tsx (4) + add route (7); switch route → Task 5; add route + fs git validation → Task 7; seed MC project → Task 2; dropdown UI → Task 6; modal → Task 7; helpers/tests → Task 1; verification → Task 8. No gaps.
- **Placeholder scan:** every code step shows full code; no TBD/TODO; the one cross-task ordering note (Task 4/6 prop types, Task 6/7 dialog import) is called out explicitly with how to keep builds green.
- **Type/name consistency:** `ACTIVE_PROJECT_COOKIE`, `resolveActiveProject`, `slugifyProjectId`, `validateNewProjectInput`, `getOrCreateActiveSession`, `ProjectOption`, `ProjectSwitcher`, `AddProjectDialog`, and the `{ projectId }` / `{ name, repoPath, defaultBranch, githubUrl }` request shapes match across tasks. Test count 54 → 59 consistent (Tasks 1 and 8).
