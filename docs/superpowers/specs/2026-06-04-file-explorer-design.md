# Project File Explorer (Epic A) — Design

**Date:** 2026-06-04
**Branch:** `feature/file-explorer` (off `dev`)
**Scope:** A **"Files" tab** in the workspace pane that browses the **active project's repo on disk** — a themed, lazy-loaded file tree on the left and a read-only **Monaco** syntax-highlighted viewer on the right. Delivers the "look at the current project" ask and most of the "beautify" (file-type icons, color-coded names, real syntax highlighting). First of the three follow-ups from the multi-project switcher (B: repo-path picker, C: broader polish, come later).

---

## Current state (what exists)

- The workspace pane (right) is tabbed: **Preview / Plan / Code Diff / Terminal** via `activeTab` state in `src/components/mission-control.tsx` (~`:1306+`). Adding a tab = a new `activeTab` value + a button + a content branch.
- **Monaco is already wired**: `@monaco-editor/react` (`^4.7.0`) powers the Code Diff tab via `src/components/diff-viewer.tsx`. The Files viewer reuses this.
- **Path-traversal guarding exists**: `src/lib/preview.ts` has `safeJoin(root, urlPath)` — resolves a path and rejects anything escaping `root`. The file routes reuse the same guard pattern.
- The client knows the **active project** already: `MissionControl` receives `activeProjectId` (from the multi-project switcher). The Files tab passes it to the file APIs.

## Decided scope

**In:** read-only browse + view of the active project's repo files; lazy folder loading; the Vivid theme (icons, colors, syntax). **Out:** in-app editing, search, rendering images/binaries (placeholder only), browsing excluded dirs (`node_modules`, `.git`, `.next`, `dist`, `.superpowers`).

## 1. Server — two read routes (auth-gated, path-guarded)

Both resolve the active project's `repo_path` from a `projectId` query param (validated against the DB), then `safeJoin` the requested relative path against that root so nothing escapes the repo.

- **`GET /api/files?projectId=<id>&dir=<relative>`** → JSON `{ entries: { name: string; type: 'dir' | 'file' }[] }` for that directory (default `dir=""` = repo root). Directories listed first, then files, each alphabetical. **Excludes** `node_modules`, `.git`, `.next`, `dist`, `.superpowers` (a shared `EXCLUDED_DIRS` set). Lazy: the client calls this per folder on expand.
- **`GET /api/files/content?projectId=<id>&path=<relative>`** → JSON `{ content: string; language: string }` for a file, OR `{ binary: true }` when the file is > 1 MB or looks binary (a NUL byte in the first 8 KB). `language` comes from `fileLanguage(name)`.

Both return 401 (unauth, mirroring existing routes), 400 (missing/invalid `projectId` or out-of-root path), 404 (not found). `runtime = 'nodejs'`, `dynamic = 'force-dynamic'`.

## 2. Pure helpers (`src/lib/file-tree.ts` + test) — unit-tested

No fs/DB; shared by client (icons) and server (language):
- `fileLanguage(name: string): string` — extension → Monaco language id (`tsx`/`ts` → `typescript`, `js`/`jsx` → `javascript`, `astro` → `html` (closest), `json`, `css`, `md` → `markdown`, `html`, `sh` → `shell`, `yml`/`yaml` → `yaml`, default `plaintext`).
- `fileIcon(name: string): { icon: string; color: string }` — extension → a lucide icon name + a Tailwind text color class (the Vivid map: `.tsx` cyan, `.ts` blue, `.astro` orange, `.json`/config amber, `.css` purple, `.md` slate, folders amber). Directories use a folder icon (handled in the tree component, not here).
- `EXCLUDED_DIRS: ReadonlySet<string>` — the skip set, imported by the list route.

## 3. Client — the Files tab

- **Tab button + branch** in `mission-control.tsx`: add `"files"` to the `activeTab` union and a "Files" button in the tab row; render `<FileExplorer projectId={activeProjectId} />` when active.
- **`src/components/file-explorer.tsx`** (new): a split — `FileTree` (left, ~40%) + viewer (right). Holds the selected file path + its loaded content/language; shows an empty hint until a file is picked.
- **`src/components/file-tree.tsx`** (new): a recursive, lazy tree. Each folder fetches its children from `/api/files` on first expand (cached in state); rows use `fileIcon`/folder icon with the Vivid colors; the selected row gets the cyan marker. Clicking a file calls back up to load it.
- **Viewer:** the existing Monaco pattern from `diff-viewer.tsx`, as a **read-only single-file editor** (`options={{ readOnly: true, ... }}`), `language` from the content response, themed to the Vivid palette. `{ binary: true }` → a centered "Binary or oversized file — not shown" placeholder.
- **Project switch:** `FileExplorer` keys off / resets on `projectId` change, so switching projects reloads the tree from the new repo.

## 4. Theming consistency

Define the Vivid Monaco theme once (a small `defineTheme` config) and apply it to **both** the Files viewer and the existing Code Diff `diff-viewer.tsx`, so highlighting matches across the workspace.

## Data flow

Operator opens **Files** → `FileTree` fetches `/api/files?projectId=<active>&dir=` (root) → expand a folder → fetch its `dir` → click a file → `FileExplorer` fetches `/api/files/content` → Monaco renders it highlighted. Switch project → tree resets and refetches against the new repo.

## Error handling

- Invalid/unknown `projectId` or a path escaping the repo root → 400 (the guard never lets a traversal through). Missing file → 404. The tree shows a small inline "couldn't load" row on a failed fetch; the viewer shows the binary/oversize placeholder for non-text.

## Testing

- **Unit (node:test):** `fileLanguage` (the mapped extensions + default), `fileIcon` (a few known extensions + the default), `EXCLUDED_DIRS` membership.
- **Build + manual:** `pnpm build` clean; `pnpm test` green (existing + new). Manual: open **Files** → tree shows the repo (no `node_modules`/`.git`), expand folders lazily, click a `.tsx`/`.ts`/`.md` → highlighted read-only viewer; a large/binary file → placeholder; switch project (AXOD Creative ↔ Mission Control) → tree reflects the new repo.

## Out of scope (later epics)

Repo-path picker / create-repo (Epic B) · broader font/color polish beyond the tree + syntax (Epic C) · editing, search, image/binary rendering, diff/blame.
