# AKIRA Project Writeback — Slice 2 (Mini → laptop)

**Status:** Approved design (2026-07-09).
**Feature:** Bring Sage's finished work on the Mini back down to the laptop's original repo as a
review branch, so the operator can review it and push to Azure DevOps themselves — without the
Mini ever reaching the laptop or DevOps.

This is **slice 2** of the two-slice AKIRA project-transfer feature. Slice 1
(`2026-07-06-akira-project-ingestion-design.md`, shipped v1.13.0) covered the laptop → Mini
ingest. This slice closes the loop: step 4–5 of that spec's operator workflow.

---

## Goal

One sentence: *from the HUD, click "Bring to laptop" for a session, and the companion downloads a
bundle of Sage's commits and lays them into the original local repo as a fast-forward-only review
branch `akira/<session>` — not checked out — with zero Mini→laptop or DevOps connectivity.*

## Why (operator's workflow — completing slice 1)

1. On the laptop, `git pull` latest from DevOps (operator, over VPN, by hand). *(slice 1)*
2. **Ingest** a copy of a project to AKIRA on the Mini. *(slice 1)*
3. Work with AKIRA + Sage's team on the Mini against acceptance criteria.
4. **Bring the changed work back** to the laptop's copy as a review branch. *(this slice)*
5. Operator reviews `akira/<session>` locally and pushes to DevOps from the laptop themselves.

The companion is **outbound-only**: the Mini can never reach the laptop. So writeback is always
the **companion pulling** a bundle from the Mini (an HTTP request the companion initiates), never
the Mini pushing. This is the structural inverse of ingest and it shapes every component below.

## Locked decisions

- **Trigger:** HUD button, **per session** ("Bring to laptop").
- **Target folder:** the companion **remembers the ingest folder** via a local ledger keyed by
  `projectId`; writeback goes back to that same folder automatically.
- **Review branch:** `akira/<session>` — **created, never checked out** (the operator's working
  tree and current branch are untouched).
- **Re-pull:** **update the same branch, fast-forward-only.** A second pull fast-forwards
  `akira/<session>` to Sage's new tip; if it cannot fast-forward (operator committed on top, or
  history diverged) the companion **refuses and reports** rather than clobbering.
- **Uncommitted edits:** writeback **auto-commits** any loose worktree edits onto `mc/<sessionId>`
  first (reusing the merge path's commit step), so nothing Sage did is left behind.
- **HUD wording:** section "Bring work to my laptop"; per-session button "Bring to laptop".

## Hard constraints

- **DevOps isolation (non-negotiable).** The Mini never receives a DevOps URL or credentials and
  never pushes anywhere. Transfer is a `git bundle` (git objects only, no remotes). The companion
  applies it locally; only the operator pushes to DevOps.
- **Mini→laptop is impossible; companion pulls.** The Mini serves the bundle in an HTTP response;
  the companion initiates every request (outbound-only, same as ingest's `postResult`/upload).
- **Companion owns Mini communication.** The HUD is UI only; all filesystem + Mini-facing logic
  lives in the companion.
- **Never break the session proxy.** Both new token-authed routes
  (`api/companion/writeback` and `api/companion/writeback/list`) MUST be added to the
  `src/proxy.ts` matcher negative-lookahead, or they 307-redirect to `/login`. See slice 1's
  proxy note.
- **Never branch-switch the live repo.** Writeback only reads/commits within the **session**
  worktree (`data/worktrees/<sessionId>`) and its branch `mc/<sessionId>`, and bundles from there.
  It never merges into or checks out the ingested repo's default branch, so it cannot disturb a
  checked-out branch or the running app. (Consistent with `mergeWorktree`'s "never `git checkout`
  the project repo" rule.)
- Extensionless relative imports; `node:`-only (no `server-only`) in any unit-tested pure module
  so it runs under `tsx --test`.

## Architecture

```
HUD "Bring work to my laptop"
  │  {type:'writeback:list'}                     {type:'writeback', sessionId}
  ▼                                                        │
companion ── GET /api/companion/writeback/list ──> Mini    │
  │  (ledger ∩ Mini sessions → show only known projects)   │
  │                                                        ▼
  └────────── POST /api/companion/writeback {sessionId} ──> Mini
                                                             │ resolve session→ingested repo+base+worktree
                                                             │ commitWorktreeEdits(mc/<sessionId>)
                                                             │ git bundle create <tmp> base..mc/<sessionId>
             bundle bytes  <──────────────────────────────  │ stream bundle in the response body
  │                                                          │ delete <tmp>
  ▼
companion (local, cwd = ledger[projectId].localPath):
  git bundle verify <tmp>                    (prereq base commit present?)
  git fetch <tmp> mc/<sessionId>:refs/heads/akira/<session>   (NON-force → FF-only)
  → report {branch, commits, files} to HUD
```

### Component 1 — Ingest ledger (`companion/src/ledger.ts`, NEW; small add to slice 1's path)

A local JSON map so the companion knows where each ingested project came from.

- File: `~/.akira-companion/ingest-ledger.json` (same base dir as `profileDir`), shape:
  `{ [projectId: string]: { localPath: string; name: string; ingestedAt: string } }`.
- Pure module: `readLedger()`, `upsertLedger(projectId, entry)`, `getLedgerEntry(projectId)`.
  Read tolerates a missing/corrupt file (returns `{}`); write is atomic (write temp + rename).
- `ingestRepo` (`companion/src/ingest.ts`) calls `upsertLedger(projectId, { localPath: repoPath,
  name, ingestedAt })` after a successful ingest. This is the only change to the slice-1 path.

### Component 2 — Discovery route (`src/app/api/companion/writeback/list/route.ts`, NEW)

Lets the HUD list what can be brought back, with change indicators.

- `runtime='nodejs'`, `dynamic='force-dynamic'`. Auth: `x-companion-token === COMPANION_TOKEN`
  (same helper as the other companion routes); 401 otherwise.
- Returns every **companion-ingested** project (those whose `repo_path` is under `data/ingested/`)
  and, per project, its sessions:
  ```jsonc
  { "projects": [
    { "projectId": "...", "projectName": "...",
      "sessions": [ { "sessionId": "...", "sessionName": "...",
                      "changed": true, "fileCount": 3 } ] } ] }
  ```
- `changed`/`fileCount` come from `diffWorktree(worktreePath, baseBranch)` (existing) — cheap and
  already the "what the session changed" source of truth. A session with no worktree yet →
  `changed:false, fileCount:0`.
- The companion intersects this with its ledger and shows only projects it has a `localPath` for.

### Component 3 — Writeback route (`src/app/api/companion/writeback/route.ts`, NEW)

Produces and streams the bundle. `POST`, `runtime='nodejs'`, `dynamic='force-dynamic'`, token auth.

- Body/query: `{ sessionId }`.
- Resolve `session → project`. Guard: the project's `repo_path` MUST be under `data/ingested/`
  (only companion-ingested projects are writeback targets) → else 400.
- Ensure the worktree exists (`ensureWorktree`) and derive `base = session.base_branch ??
  project.default_branch`.
- **`commitWorktreeEdits(sessionId, repoPath)`** — extracted from `mergeWorktree` step 1 (commit
  loose edits as "Mission Control", excluding `node_modules`). No-op when the tree is clean.
- Compute the delta. If `mc/<sessionId>` has no commits ahead of `base` (nothing changed) →
  **409 "nothing to write back"**.
- `git bundle create <tmp> base..mc/<sessionId>` (a thin bundle: carries Sage's commits, records
  `base` as a prerequisite). Stream `<tmp>` as the response body
  (`application/octet-stream`); put the source ref (`mc/<sessionId>`) and a `session` slug in
  response headers. `finally`: delete `<tmp>`.

### Component 4 — Apply on the laptop (`companion/src/writeback.ts`, NEW)

The inverse of `ingest.ts`. Given `{ miniUrl, token }` and `sessionId`:

1. Resolve `projectId` for the session from the discovery list (the HUD passes `projectId` +
   `sessionId`), then `entry = getLedgerEntry(projectId)`; error "unknown project (re-ingest)" if
   missing.
2. Validate `entry.localPath` still `isGitRepo`.
3. `POST /api/companion/writeback` with the token; stream the response body to a temp bundle file.
   Non-2xx → surface the JSON `error` (e.g. "nothing to write back").
4. `git -C <localPath> bundle verify <tmp>` — if it reports a **missing prerequisite** commit
   (local repo no longer has `base`, e.g. the operator rebased) → clear error
   "your local repo no longer has the base commit this work forked from; re-ingest to continue".
5. `git -C <localPath> fetch <tmp> mc/<sessionId>:refs/heads/akira/<session>` **without a leading
   `+`** on the refspec, so git enforces fast-forward and rejects a non-FF update. On rejection →
   error "‘akira/<session>’ has diverged from Sage's work — rename/delete it or start a fresh
   branch". `<session>` is a slug of the session name (fallback `sessionId`), so the branch is
   `akira/<slug>`.
6. `finally`: delete the temp bundle. Return `{ branch, commits, files }` (parse from the fetch /
   a follow-up `git rev-list --count base..FETCH_HEAD` + `git diff --name-only`).

### Component 5 — HUD UI (`companion-hud/`)

UI only; mirrors the ingest affordance.

- A **"Bring work to my laptop"** panel listing ledger-known projects → their sessions with a
  "changed · N files" badge → a per-session **"Bring to laptop"** button (disabled when
  `changed:false`).
- Clicking sends `{ type:'writeback', projectId, sessionId }` to the companion over the localhost
  WS bridge; a refresh sends `{ type:'writeback:list' }`.
- Renders progress (verifying / downloading / applying) and the result — "updated
  `akira/applications-employer` (+3 commits)" — or a readable error. Reuses the pinned-header /
  scrollable-middle layout already in the HUD.

### Component 6 — Bridge protocol (`companion/src/bridge-protocol.ts`)

- `ClientMsg` gains `{ type:'writeback:list' }` and
  `{ type:'writeback'; projectId: string; sessionId: string }` (both validated in
  `parseClientMsg`).
- `StateSnapshot` gains a `writeback` block mirroring `IngestState`:
  `{ phase:'idle'|'listing'|'verifying'|'downloading'|'applying'|'done'|'error';
     projects?: […]; branch?: string; commits?: number; files?: number; error?: string }`.
- `buildState` includes it.

### Component 7 — Refactor: extract `commitWorktreeEdits`

`mergeWorktree` (`src/lib/worktree.ts`, step 1, lines ~324–334) already commits loose edits.
Extract it into an exported `commitWorktreeEdits(sessionId, repoPath): Promise<boolean>` (returns
whether it committed), have `mergeWorktree` call it, and the writeback route call it too. Keep
`mergeWorktree`'s existing tests green; add a focused test for the extracted function.

## Data flow

`mc/<sessionId>` worktree → `commitWorktreeEdits` → `git bundle create base..mc/<sessionId>` →
HTTP response bytes → companion temp file → `git bundle verify` → `git fetch … :akira/<session>`
(FF-only) → review branch in the operator's local repo → operator reviews & pushes to DevOps.

## Error handling

- **Companion:** unknown project (no ledger entry) → readable error; local path no longer a git
  repo → error; download non-2xx → surface Mini's `error`; `bundle verify` missing prerequisite →
  "re-ingest" error; non-fast-forward fetch → "diverged branch" error; temp bundle always deleted.
- **Mini:** bad token → 401; session/project not found or not under `data/ingested/` → 400;
  nothing changed → 409; `git bundle`/worktree failure → 500 with a message; temp bundle always
  deleted (success or failure).
- No partial state on the laptop: a failed `fetch` leaves the existing `akira/<session>` (if any)
  exactly as it was — git rejects the ref update atomically.

## Testing

- **Companion (`companion/src/*.test.ts`), TDD:**
  - `ledger.ts`: upsert then get round-trips; read tolerates missing/corrupt file; write is atomic.
  - `writeback.ts`: against temp git repos — a `base..tip` bundle fetches into
    `akira/<slug>` on a first pull (branch created at the right commit); a second pull
    fast-forwards it; a **non-FF** second pull is **refused** (branch unchanged, error returned);
    a bundle whose prerequisite is absent → the "re-ingest" error path.
- **Mini, TDD:**
  - `commitWorktreeEdits`: commits loose edits (excluding `node_modules`); no-op on a clean tree.
  - Writeback route: from a temp ingested repo with a session worktree that has edits → response
    is a valid bundle whose `base..tip` unbundles in a fresh clone of the base; empty diff → 409;
    non-ingested project → 400; bad token → 401.
  - Discovery route: returns ingested projects + per-session `changed`/`fileCount`; bad token→401.
  - Proxy matcher test: `/api/companion/writeback` and `/api/companion/writeback/list` are
    excluded (no redirect) — extend the existing slice-1 proxy test.
- Routes/UI/bridge wiring verified by manual E2E (ingest a temp repo, have Sage make a change,
  Bring to laptop, confirm `akira/<slug>` appears at the right commit and the working tree is
  untouched; pull again → fast-forward; hand-diverge the branch → refusal).

## Out of scope (→ later)

- Auto-merge / rebase / push on the laptop (operator does this).
- Conflict resolution beyond the fast-forward refusal.
- Daily re-ingest / update of an existing project on the Mini (merging fresh laptop pulls into
  in-flight Sage work).
- Whole-`TEI` multi-repo scan.
- AKIRA-initiated writeback ("AKIRA, send it back").
- Any browser-side (non-companion) download.

## Resolved decisions

- Direction: **companion pulls** the bundle (outbound-only) — the Mini cannot push.
- Trigger: **HUD button, per session**.
- Target resolution: **ledger (remember the ingest folder)**.
- Review branch: **`akira/<session>`, not checked out**.
- Re-pull: **same branch, fast-forward-only** (refuse, never clobber).
- Uncommitted edits: **auto-commit** onto `mc/<sessionId>` before bundling.
- HUD wording: **"Bring work to my laptop" / "Bring to laptop"**.
