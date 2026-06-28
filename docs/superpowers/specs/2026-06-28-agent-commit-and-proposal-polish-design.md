# v1.9.1 — Agent commit hardening + proposal summaries + leaner orchestration (design)

**Date:** 2026-06-28
**Status:** Design approved, pending spec review
**Trigger:** Live-testing v1.9.0 on the Mini surfaced three things: a merge failed with "Author identity unknown"; Forge/Sage flagged that `git add -A` could stage `node_modules`; and Sage re-stated a dispatched agent's full report (a wasted, paid turn).

## Scope

Three independent, small improvements shipped together as a patch:

1. **Commit hardening** — agent merges never fail on git identity and never commit `node_modules`.
2. **Proposal summaries** — proposal embeds carry a 2-4 line "what changed" summary from the agent's own words.
3. **Leaner orchestration** — after dispatching an agent, Sage gives a one-line TL;DR instead of restating the report.

**Out of scope:** changing how proposals are detected, the merge algorithm, or the dispatch mechanism; per-session git identities; an extra LLM call to generate summaries (we reuse the agent's existing message).

## 1. Commit hardening — `src/lib/worktree.ts` (`mergeWorktree`)

The merge step (≈lines 324-329) currently stages with `git add -A` and commits with no identity:

```js
await exec('git', ['-C', wtPath, 'add', '-A']);
await exec('git', ['-C', wtPath, 'commit', '-m', `mission-control: ${branch}`]);
```

Change to:

```js
await exec('git', ['-C', wtPath, 'reset', '-q', '--', 'node_modules']).catch(() => {}); // drop any pre-staged node_modules
await exec('git', ['-C', wtPath, 'add', '-A', '--', '.', ':!node_modules']);            // stage everything except node_modules
await exec('git', [
  '-c', 'user.email=mc@axodcreative.com',
  '-c', 'user.name=Mission Control',
  '-C', wtPath, 'commit', '-m', `mission-control: ${branch}`,
]);
```

- The inline `-c user.email/user.name` makes the commit **box-independent** (works even with no `~/.gitconfig`) with consistent `Mission Control <mc@axodcreative.com>` authorship.
- `reset -- node_modules` + the `:!node_modules` exclude pathspec ensure `node_modules` is **never committed**, even if a project repo doesn't ignore it or an agent pre-staged the symlink.

**Tests (`worktree.test.ts`, real git temp dir):**
- After `mergeWorktree`, the merge commit's author is `Mission Control` (proves the inline identity applied and it doesn't depend on ambient config).
- A `node_modules/junk` present (and even `git add`-ed) in the worktree is **not** present in the merged base tree.

## 2. Proposal summary — agent's own words

- **Pure helper** in `src/lib/proposals.ts`: `summarizeForProposal(text: string | null): string` — trims, drops blank lines, joins the first ~4 non-empty lines, caps at ~280 chars with an ellipsis, returns `''` for empty/null. Unit-tested.
- **`ProposalRow`** gains `summaryRaw: string | null`; **`Proposal`** gains `summary: string`. In `collectProposals`, set `summary: summarizeForProposal(r.summaryRaw)`.
- **`src/lib/proposals-data.ts`**: after the sessions×projects select, for each row fetch the latest `role: 'agent'` message for that session (`messages` where `session_id = ?` and `role = 'agent'`, newest by `created_at`), attach as `summaryRaw`, then call `collectProposals(rowsWithSummary, diffWorktree)`. (Agent replies persist with `role: 'agent'`.)
- **`src/lib/discord-format.ts`** `proposalEmbed`: add `description: p.summary` when non-empty (keeps the existing Project/Changes/Files fields).
- The web Proposals UI already receives `Proposal`; it MAY render `summary` but that is optional and not required for this release.

**Tests:** `summarizeForProposal` — multi-line trim/cap/ellipsis, empty/null → `''`. `proposalEmbed` — description present when summary set, omitted when empty (extend `discord-format.test.ts`).

## 3. Leaner orchestration after dispatch — `src/lib/conversation.ts`

Extend `FRAMING_HEADER` (the always-prepended orchestrator guidance) with a brevity rule:

> After you dispatch an agent and receive its report, do NOT restate or re-summarize the report — the Operator can already read it. Reply with at most a one-line TL;DR of the outcome, or simply note the report is ready. Never duplicate information the Operator can already see.

**Tests:** `conversation.test.ts` — update any assertion on the header text; add a check that the rendered prompt contains the brevity guidance.

## Testing summary

- **Pure unit (tsx):** `summarizeForProposal`; `proposalEmbed` description behavior; `FRAMING_HEADER` content; `mergeWorktree` author + node_modules exclusion (real git in a temp dir — `worktree.ts` is pure-testable).
- **Effectful (tsc + suite + runtime):** the `proposals-data` summary fetch and embed wiring; verified after deploy by clicking Approve & Merge on a real proposal (commits as Mission Control, no node_modules) and seeing a summary in the embed + a terse Sage reply after a dispatch.

## Rollout

Patch release **v1.9.1**. No new deps, no migration → deploy is `git pull` → `pnpm build` → restart. The Mini already has the `mc` git identity set (2026-06-28), but this change makes commits box-independent regardless.
