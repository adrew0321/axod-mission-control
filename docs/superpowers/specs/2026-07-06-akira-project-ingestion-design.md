# AKIRA Project Ingestion — Slice 1 (laptop → Mini)

**Status:** Approved design (2026-07-06). Slice 1 implemented on branch
`worktree-akira-project-ingestion` (2026-07-06), pending merge to `dev` — not yet released or
deployed.
**Feature:** Hand the AKIRA Local Companion a local git repo; it lands on the Mini as a
registered Mission Control project that Sage and the specialists can work on — without the
Mini ever touching the operator's employer DevOps.

This is **slice 1** of a two-slice feature. Slice 2 (separate spec) covers the Mini → laptop
writeback and the daily re-ingest/update loop.

---

## Goal

One sentence: *point the companion at one local git repo (e.g. `C:\...\TEI\Applications.Employer`),
and it becomes a working Mission Control project on the Mini, recognized by AKIRA, with zero
DevOps connectivity on the Mini side.*

## Why (operator's workflow)

The operator's work repos are cloned from Azure DevOps behind a corporate VPN, on the laptop.
The Mini cannot reach DevOps and must never try to. The intended loop:

1. On the laptop, `git pull` latest from DevOps (operator, over VPN, by hand).
2. **Ingest** a copy of a project to AKIRA on the Mini (this slice).
3. Work with AKIRA + Sage's team on the Mini against acceptance criteria.
4. (Slice 2) Send the changed work back to the laptop's copy as a review branch.
5. Operator reviews and pushes to DevOps from the laptop themselves.

The Mini is an **isolated work environment**. The laptop is the only bridge to DevOps.

## Hard constraints

- **DevOps isolation (non-negotiable).** The Mini never receives a DevOps URL or credentials.
  Transfer is via `git bundle`, which packs git objects only — no remotes. After the Mini
  clones the bundle, it removes `origin`. This is enforced by an explicit test: after ingest,
  `git -C <ingested repo> remote -v` returns empty.
- **Commit-based transfer.** A bundle carries committed history only. Uncommitted working-tree
  edits on the laptop do not cross. This is expected and matches the "pull latest, then send"
  loop.
- **Companion owns Mini communication.** The HUD is UI only; all filesystem-transfer and
  Mini-facing logic lives in the companion (single security boundary; consistent with the
  existing HUD-as-display / companion-as-privileged-worker split).
- **Never break the session proxy.** Any new token-authed companion route MUST be added to the
  `src/proxy.ts` matcher exclusion, or it 307-redirects to `/login` (the prior companion
  outage). See [[turns-require-client-sse]] history.

## Architecture

```
HUD folder picker  →  companion  →  git bundle  →  POST bytes  →  Mini
  (Electron)          (companion/)   (--all,        (streamed)     │ stream to temp file
                                      committed                    │ git clone <bundle>
                                      objects only)                │ git remote remove origin
                                                                   │ verify .git
                                                                   │ registerProject() → DB row
                                                                   ▼
                                        AKIRA sees it in her fleet snapshot → relay → Sage
```

### Component 1 — Companion (`companion/`)

Owns all Mini communication and the transfer logic.

- **New bridge message (HUD → companion):** `{ type: 'ingest', path: string }`.
- On receipt, the companion:
  1. Validates `path` is a directory containing `.git` (reject with a clear error otherwise).
  2. Runs `git bundle create <tmpBundle> --all` with `cwd = path`.
  3. Reads the project name from the folder's basename (e.g. `Applications.Employer`) and its
     current branch (`git rev-parse --abbrev-ref HEAD`) for the default branch.
  4. Streams `<tmpBundle>` to the Mini `POST /api/companion/ingest` (raw body or multipart),
     with metadata (name, defaultBranch) as query params or headers.
  5. Deletes `<tmpBundle>`.
- **Progress/result back to the HUD (companion → HUD):**
  `{ type: 'ingest:progress', pct }`, `{ type: 'ingest:done', projectId, name }`,
  `{ type: 'ingest:error', reason }`.
- Uses the existing companion token + Mini URL config (`companion/src/config.ts`); reuses the
  outbound HTTP pattern already used by `postResult` (`companion/src/connection.ts`).

### Component 2 — HUD (`companion-hud/`)

UI only.

- A "Send a project to AKIRA" affordance in the HUD.
- Clicking it triggers the Electron **native folder picker** in the main process
  (`dialog.showOpenDialog({ properties: ['openDirectory'] })`), yielding an absolute path.
- The HUD sends `{ type: 'ingest', path }` to the companion over the existing localhost WS
  bridge, and renders progress + the resulting project name (or the error).

### Component 3 — Mini (`src/`)

- **New route `POST /api/companion/ingest`** (`src/app/api/companion/ingest/route.ts`):
  - `runtime = 'nodejs'`, `dynamic = 'force-dynamic'`.
  - Auth: `x-companion-token` header equals `COMPANION_TOKEN` (same check as
    `src/app/api/companion/result/route.ts`). 401 otherwise.
  - **Stream** the request body to a temp file under `data/ingested/.tmp/` — never buffer the
    whole bundle in memory. Enforce a configurable size ceiling (default ~1 GB via
    `COMPANION_INGEST_MAX_BYTES`) and a low-disk guard; reject oversize with 413.
  - Derive a safe slug from the provided name (reuse `slugifyProjectId` from
    `src/lib/projects.ts`); if a project with that id already exists, **return 409 "already
    exists"** (slice 1 is create-only — re-ingest/update is slice 2).
  - `git clone <tmpBundle> data/ingested/<slug>` (a clone from a bundle sets `origin` = the
    bundle path).
  - `git -C data/ingested/<slug> remote remove origin` (isolation).
  - Verify `data/ingested/<slug>/.git` exists; else 400 and clean up.
  - `registerProject({ name, repoPath: <abs>, defaultBranch })` → DB row.
  - Delete the temp bundle. Return `{ ok: true, projectId }`.
- **Proxy exclusion:** add `api/companion/ingest` to the `src/proxy.ts` matcher negative
  lookahead alongside `stream|result`.
- **Ingested-repos root:** `data/ingested/` (the app repo already gitignores `data/`).

### Component 4 — Refactor: shared `registerProject()`

The project-registration core currently lives inline in
[src/app/api/projects/route.ts](src/app/api/projects/route.ts) (lines ~64–82: slug/dedupe,
`db.insert(projects)`, `getOrCreateActiveSession`, active-project cookie).

- Extract a pure-ish `registerProject(input: { name; repoPath; defaultBranch?; githubUrl? })`
  into `src/lib/projects.ts`, returning `{ projectId }`.
- The manual "Add Project" POST and the new ingest route both call it. The cookie-setting
  (`ACTIVE_PROJECT_COOKIE`) stays in the manual route only — the companion has no cookie jar;
  ingest does not change the operator's active project.

### Component 5 — AKIRA awareness

- No new tool. The fleet snapshot already enumerates the `projects` table, so an ingested
  project appears in AKIRA's context on her next turn and she can `relay` work to Sage.
- Add one line to the AKIRA system prompt (`src/lib/akira/prompt.ts`) noting that projects can
  arrive via companion ingestion, so she frames them naturally ("your `Applications.Employer`
  project is now on the Mini").
- No new fleet contributor needed — this is a new *instance* of an existing kind (a project),
  which the snapshot picks up automatically (per the ship-mc-feature skill's "Keep AKIRA
  aware" note).

## Data flow

laptop repo → `git bundle --all` (temp) → HTTP POST bytes → Mini temp file → `git clone` →
`data/ingested/<slug>/` (origin removed) → `projects` row → fleet snapshot → AKIRA → `relay`
→ Sage worktree.

## Error handling

- Companion: non-directory / no `.git` / `git bundle` failure → `ingest:error` with a readable
  reason; no partial upload.
- Mini: bad token → 401; oversize (cap exceeded) → 413; disk full (`ENOSPC`) → 507; slug
  collision → 409; clone or `.git` verification failure → 400 and remove the half-written
  `data/ingested/<slug>/` and temp file.
- `registerProject` is atomic: if session creation fails after the row insert, the row is
  rolled back so no orphan project remains.
- Temp bundle is always cleaned up (success or failure) on both sides.

## Testing

- **Companion (`companion/src/*.test.ts`):** bundle-and-upload builds a valid bundle from a
  temp git repo; rejects a non-repo path; posts with the right token header.
- **Mini:**
  - `registerProject()` unit test (slug dedupe, row shape).
  - Ingest integration: POST a real bundle (made from a temp git repo) → project row created,
    `data/ingested/<slug>/.git` exists, **`remote -v` empty** (the isolation test), 409 on
    re-ingest.
  - Proxy matcher test: `/api/companion/ingest` is excluded (no redirect).
- TDD throughout (companion has an existing test target in the `pnpm test` script).

## Out of scope (→ slice 2 / later)

- Mini → laptop writeback (changed work back to the `TEI` folder as a review branch).
- Re-ingest / daily-refresh update of an existing project (merging into in-flight Sage work).
- Whole-`TEI` multi-repo scan (register every repo in a container folder).
- AKIRA-initiated pulls ("AKIRA, pull TEI from my laptop").
- Any browser-side (non-companion) folder upload.

## Resolved decisions

- Transport: **git-bundle over the companion** (vs. raw zip / Mini-as-remote).
- Scope: **slice 1 = ingest + register only**; writeback is slice 2.
- Granularity: **one repo per gesture** (vs. whole-TEI scan).
- Re-ingest: **create-only** in slice 1 (409 on collision).
- Size ceiling: **~1 GB configurable**, low-disk guard.
