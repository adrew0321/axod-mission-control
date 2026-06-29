# AKIRA Phase 1 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build AKIRA — a full-screen voice + HUD front door at `/` that briefs the operator on the whole fleet, talks back, navigates into projects, relays a human-confirmed request into a project's Sage, and opens web destinations.

**Architecture:** AKIRA is a new agent layer beside the per-project Sage world. A dedicated runner (`runAkiraTurn`) calls the SDK with **no git worktree** and a read-only + controlled-action toolset (`navigate` / `relay` / `open` + drill-down reads). Her persistent conversation is messages on one reserved `sessions` row (`id = 'akira'`, null project). A query-driven fleet snapshot (a registry of per-subsystem contributors) feeds both her prompt and the HUD's deterministic cards. The existing dashboard moves to `/dashboard` unchanged.

**Tech Stack:** Next.js 16 (App Router), Claude Agent SDK (`@anthropic-ai/claude-agent-sdk` ^0.3.153), Drizzle + better-sqlite3 (SQLite WAL), drizzle-kit migrations, browser Web Speech API (client-only), node:test via `tsx`.

## Global Constraints

- Spec: `docs/superpowers/specs/2026-06-28-akira-phase-1-design.md`. Visual reference: `docs/design/akira-hud.html`.
- The assistant is named **AKIRA** (female, she/her) in all copy, greetings, and persona. "Hermes" is retired.
- AKIRA agent id is `akira`, role `concierge`, model `claude-opus-4-8`.
- AKIRA's reserved conversation lives on a `sessions` row with **`id = 'akira'`** and **`project_id = null`**; her runner NEVER calls `ensureWorktree`.
- AKIRA NEVER receives a worktree, the `dispatch_agent` tool, or any file-edit tool (`Edit`/`Write`/`Bash`). She is NOT added to `DISPATCHABLE` in `src/lib/dispatch.ts`.
- **Safety invariant:** the `relay` tool in propose mode is side-effect free — it must NOT insert a message or start a turn. Work starts only via the human-confirmed `/api/akira/relay/confirm` route.
- Tests: `pnpm test` runs `tsx --test src/lib/*.test.ts`. Use **extensionless** relative imports in `src/lib` (a `.ts` extension breaks `tsc`/`next build`). Pure logic lives in non-`server-only` modules so the test runner can import it.
- Migrations: edit `src/db/schema.ts`, then `pnpm db:generate` (writes SQL to `./drizzle`), then `pnpm db:migrate`. The Mini has an existing DB — bootstrap rows must be idempotent (`onConflictDoNothing`), never assumed seeded.
- SSE event shape is `data: ${JSON.stringify(event)}\n\n`; events are `{ type, ... }`. Reuse the shape in `src/app/api/sessions/[id]/stream/route.ts`.
- Branch off `dev`; never push to `main`. Commit after each task.

## File Structure

**New files**
- `src/lib/akira/destinations.ts` — open-target registry (fixed links + search templates); pure. `resolveDestination()`.
- `src/lib/akira/destinations.test.ts`
- `src/lib/fleet-snapshot.ts` — `getFleetSnapshot()` + contributor registry (server-only).
- `src/lib/fleet-snapshot.test.ts`
- `src/lib/akira/prompt.ts` — `AKIRA_SYSTEM_PROMPT`, `renderSnapshot()`, `buildAkiraPrompt()`; pure.
- `src/lib/akira/prompt.test.ts`
- `src/lib/akira/bootstrap.ts` — `ensureAkiraThread()` idempotent agent + reserved-session insert (server-only).
- `src/lib/akira/tools.ts` — `createAkiraServer(ctx)` in-process MCP server (navigate/relay/open + reads).
- `src/lib/akira/tools.test.ts`
- `src/lib/akira-turn.ts` — `runAkiraTurn()` runner (server-only).
- `src/lib/akira-turn.test.ts`
- `src/lib/voice/chunk.ts` — sentence-chunking of streamed text + female-voice selection; pure.
- `src/lib/voice/chunk.test.ts`
- `src/lib/voice/speech.ts` — TTS/STT wrappers over Web Speech API (client-only).
- `src/app/api/akira/stream/route.ts` — AKIRA turn SSE (brief + replies).
- `src/app/api/akira/relay/confirm/route.ts` — human-confirmed relay SSE (runs target session turn).
- `src/app/dashboard/page.tsx` — the existing dashboard, relocated.
- `src/app/page.tsx` — REPLACED with the AKIRA HUD (server shell).
- `src/components/akira/hud.tsx` — HUD client component (orb + stream + voice + toggles).
- `src/components/akira/orb.tsx` — canvas orb (idle/listening/speaking) extracted from the mockup.

**Modified files**
- `src/db/schema.ts` — make `sessions.project_id` nullable.
- `scripts/seed.ts` — add the `akira` agent row + reserved session.
- `.claude/skills/ship-mc-feature/SKILL.md` — standing rule: new subsystem ⇒ add a snapshot contributor.

---

### Task 1: Make `sessions.project_id` nullable + generate migration

**Files:**
- Modify: `src/db/schema.ts:26`
- Create: `drizzle/<generated>.sql` (via `pnpm db:generate`)

**Interfaces:**
- Produces: a `sessions` table that accepts `project_id = null` (for the reserved AKIRA row).

- [ ] **Step 1: Drop `.notNull()` from `sessions.project_id`**

In `src/db/schema.ts`, change line 26 from:

```ts
  project_id: text('project_id').references(() => projects.id).notNull(),
```

to:

```ts
  // Nullable: the reserved AKIRA conversation row (id 'akira') has no project.
  project_id: text('project_id').references(() => projects.id),
```

- [ ] **Step 2: Generate the migration**

Run: `pnpm db:generate`
Expected: a new file under `drizzle/` is created (SQLite rebuilds `sessions` to relax the NOT NULL). No prompt for data loss.

- [ ] **Step 3: Apply the migration**

Run: `pnpm db:migrate`
Expected: "migrations applied" with no error; the existing local DB still opens.

- [ ] **Step 4: Verify build still typechecks**

Run: `pnpm build`
Expected: build succeeds (the nullable column doesn't break existing inserts, which all pass a `project_id`).

- [ ] **Step 5: Commit**

```bash
git add src/db/schema.ts drizzle
git commit -m "feat(db): make sessions.project_id nullable for the reserved AKIRA thread"
```

---

### Task 2: AKIRA bootstrap — idempotent agent + reserved session

**Files:**
- Create: `src/lib/akira/bootstrap.ts`
- Create: `src/lib/akira/bootstrap.test.ts`
- Modify: `scripts/seed.ts` (add the `akira` agent + reserved session)

**Interfaces:**
- Consumes: `AKIRA_SYSTEM_PROMPT` does not exist yet — Task 2 uses a short inline placeholder prompt constant `AKIRA_AGENT.system_prompt`; Task 5 replaces the agent's prompt via the seed upsert. To avoid a forward dependency, define the canonical agent metadata here:
- Produces:
  - `AKIRA_AGENT_ID = 'akira'`
  - `AKIRA_SESSION_ID = 'akira'`
  - `AKIRA_AGENT: { id; name; role; model; system_prompt; tools_allowlist; color }`
  - `ensureAkiraThread(): Promise<void>` — inserts the agent row and the reserved session row if missing (idempotent).

- [ ] **Step 1: Write the failing test**

`src/lib/akira/bootstrap.test.ts` — uses a temp DB. Follow the pattern in `src/lib/sessions.test.ts` if it sets up a DB; otherwise use better-sqlite3 directly against the schema. Minimal version asserting idempotency and shape:

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AKIRA_AGENT, AKIRA_AGENT_ID, AKIRA_SESSION_ID } from './bootstrap';

test('AKIRA agent metadata is correct and safe', () => {
  assert.equal(AKIRA_AGENT_ID, 'akira');
  assert.equal(AKIRA_SESSION_ID, 'akira');
  assert.equal(AKIRA_AGENT.id, 'akira');
  assert.equal(AKIRA_AGENT.role, 'concierge');
  assert.equal(AKIRA_AGENT.model, 'claude-opus-4-8');
  // never gets edit/exec tools
  for (const t of ['Edit', 'Write', 'Bash']) {
    assert.ok(!AKIRA_AGENT.tools_allowlist.includes(t), `${t} must not be allowed`);
  }
});
```

> Note: `ensureAkiraThread()` itself touches the real DB (`server-only`), so it is exercised by Task 9's runner test with a mocked DB, not unit-tested here. This task's test covers the pure metadata.

- [ ] **Step 2: Run it to verify it fails**

Run: `pnpm test`
Expected: FAIL — `Cannot find module './bootstrap'`.

- [ ] **Step 3: Implement `bootstrap.ts`**

```ts
import 'server-only';
import { eq } from 'drizzle-orm';
import { db } from '@/db/client';
import { agents, sessions } from '@/db/schema';

export const AKIRA_AGENT_ID = 'akira';
export const AKIRA_SESSION_ID = 'akira';

/**
 * AKIRA's canonical agent metadata. The full system prompt is set in
 * src/lib/akira/prompt.ts (Task 5) and applied via the seed upsert; this inline
 * prompt is a safety-net default for fresh/existing DBs that bootstrap before a
 * seed runs.
 */
export const AKIRA_AGENT = {
  id: AKIRA_AGENT_ID,
  name: 'AKIRA',
  role: 'concierge',
  model: 'claude-opus-4-8',
  system_prompt:
    'You are AKIRA, the operator’s personal concierge for AXOD Mission Control. You brief, navigate, relay (with confirmation), and open destinations. You never edit code.',
  tools_allowlist: ['Read', 'Glob', 'Grep', 'WebFetch', 'WebSearch', 'TodoWrite'] as string[],
  color: 'from-sky-300 to-cyan-400',
};

/**
 * Idempotently ensure AKIRA's agent row and reserved conversation session exist.
 * Safe to call on every turn; uses onConflictDoNothing so it never clobbers a
 * seeded prompt or an existing thread.
 */
export async function ensureAkiraThread(): Promise<void> {
  await db.insert(agents).values(AKIRA_AGENT).onConflictDoNothing();

  const now = new Date();
  await db
    .insert(sessions)
    .values({
      id: AKIRA_SESSION_ID,
      project_id: null,
      title: 'AKIRA',
      branch: null,
      base_branch: null,
      worktree_path: null,
      status: 'active',
      cleared_at: null,
      created_at: now,
      updated_at: now,
      running_since: null,
      archived_at: null,
    })
    .onConflictDoNothing();
}
```

- [ ] **Step 4: Add AKIRA to `scripts/seed.ts`**

In `scripts/seed.ts`, add a const near the other prompts (this will be superseded by Task 5's prompt — set it to the same inline string for now):

```ts
const AKIRA_SYSTEM_PROMPT = `You are AKIRA, the operator’s personal concierge for AXOD Mission Control. You brief, navigate, relay (with confirmation), and open destinations. You never edit code.`;
```

Add to the `agentRows` array (so the upsert keeps it fresh):

```ts
    {
      id: 'akira',
      name: 'AKIRA',
      role: 'concierge',
      model: 'claude-opus-4-8',
      system_prompt: AKIRA_SYSTEM_PROMPT,
      tools_allowlist: ['Read', 'Glob', 'Grep', 'WebFetch', 'WebSearch', 'TodoWrite'],
      color: 'from-sky-300 to-cyan-400',
    },
```

After the agents loop and before `sqlite.close()`, seed the reserved session:

```ts
  // AKIRA's reserved conversation (no project, no worktree).
  await db
    .insert(schema.sessions)
    .values({
      id: 'akira',
      project_id: null,
      title: 'AKIRA',
      status: 'active',
      created_at: now,
      updated_at: now,
    })
    .onConflictDoNothing();
```

- [ ] **Step 5: Run tests + seed**

Run: `pnpm test`
Expected: PASS.
Run: `pnpm seed`
Expected: "Seed complete" with `agents` count incremented; no error.

- [ ] **Step 6: Commit**

```bash
git add src/lib/akira/bootstrap.ts src/lib/akira/bootstrap.test.ts scripts/seed.ts
git commit -m "feat(akira): bootstrap AKIRA agent + reserved conversation thread"
```

---

### Task 3: Open-destinations registry (fixed links + search templates)

**Files:**
- Create: `src/lib/akira/destinations.ts`
- Create: `src/lib/akira/destinations.test.ts`

**Interfaces:**
- Produces:
  - `resolveDestination(target: string, query?: string): { url: string; label: string } | null`
  - `DESTINATIONS: Record<string, { label: string; url?: string; search?: string }>` (the allowlist; `search` is a template containing `{query}`).

- [ ] **Step 1: Write the failing test**

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolveDestination } from './destinations';

test('resolves a fixed destination by key', () => {
  const r = resolveDestination('outlook');
  assert.equal(r?.url, 'https://outlook.office.com/mail/');
});

test('resolves a fuzzy/cased name', () => {
  assert.equal(resolveDestination('Outlook inbox')?.url, 'https://outlook.office.com/mail/');
});

test('builds a search URL from a template', () => {
  const r = resolveDestination('amazon', 'desktop keyboard');
  assert.equal(r?.url, 'https://www.amazon.com/s?k=desktop%20keyboard');
});

test('search target without a query falls back to the site root', () => {
  const r = resolveDestination('youtube');
  assert.equal(r?.url, 'https://www.youtube.com/');
});

test('unknown target returns null', () => {
  assert.equal(resolveDestination('teleport me to mars'), null);
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `pnpm test`
Expected: FAIL — `Cannot find module './destinations'`.

- [ ] **Step 3: Implement `destinations.ts`**

```ts
// Pure registry of web destinations AKIRA may open. No DB, no server-only — the
// allowlist that prevents arbitrary URLs. Add an entry to teach AKIRA a new place.

export interface Destination {
  label: string;
  /** Fixed URL (used when there is no query, or for non-searchable sites). */
  url?: string;
  /** Search template containing the literal `{query}`. */
  search?: string;
  /** Site root, opened when a searchable site is asked for without a query. */
  root?: string;
}

export const DESTINATIONS: Record<string, Destination> = {
  outlook: { label: 'Outlook', url: 'https://outlook.office.com/mail/' },
  gmail: { label: 'Gmail', url: 'https://mail.google.com/' },
  github: { label: 'GitHub', url: 'https://github.com/', search: 'https://github.com/search?q={query}' },
  youtube: { label: 'YouTube', root: 'https://www.youtube.com/', search: 'https://www.youtube.com/results?search_query={query}' },
  'youtube studio': { label: 'YouTube Studio', url: 'https://studio.youtube.com/' },
  google: { label: 'Google', root: 'https://www.google.com/', search: 'https://www.google.com/search?q={query}' },
  amazon: { label: 'Amazon', root: 'https://www.amazon.com/', search: 'https://www.amazon.com/s?k={query}' },
};

/**
 * Resolve a free-text target (and optional query) to a single safe URL, or null
 * if no registry entry matches. Matching is case-insensitive and accepts a key
 * appearing anywhere in the phrase (e.g. "open my Outlook inbox" → outlook).
 */
export function resolveDestination(
  target: string,
  query?: string,
): { url: string; label: string } | null {
  if (!target) return null;
  const t = target.toLowerCase();
  // Prefer the longest matching key so "youtube studio" beats "youtube".
  const key = Object.keys(DESTINATIONS)
    .filter((k) => t.includes(k))
    .sort((a, b) => b.length - a.length)[0];
  if (!key) return null;
  const d = DESTINATIONS[key];
  const q = query?.trim();
  if (q && d.search) {
    return { url: d.search.replace('{query}', encodeURIComponent(q)), label: d.label };
  }
  const url = d.url ?? d.root;
  return url ? { url, label: d.label } : null;
}
```

- [ ] **Step 4: Run tests**

Run: `pnpm test`
Expected: PASS (all 5 destination tests).

- [ ] **Step 5: Commit**

```bash
git add src/lib/akira/destinations.ts src/lib/akira/destinations.test.ts
git commit -m "feat(akira): web-destinations registry with search templates"
```

---

### Task 4: Fleet snapshot + contributor registry

**Files:**
- Create: `src/lib/fleet-snapshot.ts`
- Create: `src/lib/fleet-snapshot.test.ts`

**Interfaces:**
- Consumes (existing): `getProposals()` → `Proposal[]` from `./proposals-data`; `getDreams()` → `DreamView[]` from `./dreams-data`; `getSchedules()` → `ScheduleRow[]` from `./schedules-data`; `db`, `sessions`, `projects`, `schedules`.
- Produces:
  - `interface FleetSnapshot { generatedAt: string; projects: {id;name;activeSessionId:string|null;lastTurnAt:string|null}[]; running: {projectId:string;projectName:string;sessionId:string}[]; proposals: {projectId:string;projectName:string;sessionId:string;summary:string;ageMinutes:number}[]; health: {verdict:'pass'|'fail'|'unknown';at:string|null}; insights: {title:string;detail:string;ageMinutes:number}[]; schedules: {projectId:string;title:string;nextRunAt:string|null}[]; errors: string[]; }`
  - `type SnapshotContributor = { key: string; collect: () => Promise<Partial<FleetSnapshot>> }`
  - `CONTRIBUTORS: SnapshotContributor[]`
  - `getFleetSnapshot(contributors?: SnapshotContributor[]): Promise<FleetSnapshot>` — runs each contributor in isolation; a throw degrades only that slice and adds its `key` to `errors`.
  - `emptySnapshot(): FleetSnapshot`

The contributor isolation logic is what's unit-tested; pass in fake contributors so the test needs no DB.

- [ ] **Step 1: Write the failing test**

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { getFleetSnapshot, emptySnapshot, type SnapshotContributor } from './fleet-snapshot';

test('merges slices from all contributors', async () => {
  const fakes: SnapshotContributor[] = [
    { key: 'health', collect: async () => ({ health: { verdict: 'pass', at: null } }) },
    { key: 'running', collect: async () => ({ running: [{ projectId: 'p', projectName: 'P', sessionId: 's' }] }) },
  ];
  const snap = await getFleetSnapshot(fakes);
  assert.equal(snap.health.verdict, 'pass');
  assert.equal(snap.running.length, 1);
  assert.deepEqual(snap.errors, []);
});

test('one throwing contributor degrades only its slice', async () => {
  const fakes: SnapshotContributor[] = [
    { key: 'proposals', collect: async () => { throw new Error('git blew up'); } },
    { key: 'health', collect: async () => ({ health: { verdict: 'fail', at: null } }) },
  ];
  const snap = await getFleetSnapshot(fakes);
  assert.deepEqual(snap.proposals, emptySnapshot().proposals); // unchanged default
  assert.equal(snap.health.verdict, 'fail');                    // sibling still applied
  assert.ok(snap.errors.includes('proposals'));
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `pnpm test`
Expected: FAIL — `Cannot find module './fleet-snapshot'`.

- [ ] **Step 3: Implement `fleet-snapshot.ts`**

```ts
import 'server-only';
import { eq, isNotNull, isNull, and, desc } from 'drizzle-orm';
import { db } from '@/db/client';
import { sessions, projects, schedules } from '@/db/schema';
import { getProposals } from './proposals-data';
import { getDreams } from './dreams-data';
import { getSchedules } from './schedules-data';

export interface FleetSnapshot {
  generatedAt: string;
  projects: { id: string; name: string; activeSessionId: string | null; lastTurnAt: string | null }[];
  running: { projectId: string; projectName: string; sessionId: string }[];
  proposals: { projectId: string; projectName: string; sessionId: string; summary: string; ageMinutes: number }[];
  health: { verdict: 'pass' | 'fail' | 'unknown'; at: string | null };
  insights: { title: string; detail: string; ageMinutes: number }[];
  schedules: { projectId: string; title: string; nextRunAt: string | null }[];
  errors: string[];
}

export type SnapshotContributor = { key: string; collect: () => Promise<Partial<FleetSnapshot>> };

export function emptySnapshot(): FleetSnapshot {
  return {
    generatedAt: new Date().toISOString(),
    projects: [], running: [], proposals: [],
    health: { verdict: 'unknown', at: null },
    insights: [], schedules: [], errors: [],
  };
}

const ageMin = (d: Date | string | null): number =>
  d ? Math.max(0, Math.round((Date.now() - new Date(d).getTime()) / 60000)) : 0;

const projectsContributor: SnapshotContributor = {
  key: 'projects',
  collect: async () => {
    const rows = await db.select().from(projects);
    return {
      projects: rows.map((p) => ({
        id: p.id, name: p.name,
        activeSessionId: p.active_session_id ?? null,
        lastTurnAt: null,
      })),
    };
  },
};

const runningContributor: SnapshotContributor = {
  key: 'running',
  collect: async () => {
    const rows = await db
      .select({ sessionId: sessions.id, projectId: projects.id, projectName: projects.name })
      .from(sessions)
      .innerJoin(projects, eq(sessions.project_id, projects.id))
      .where(and(isNotNull(sessions.running_since), isNull(sessions.archived_at)));
    return { running: rows.map((r) => ({ projectId: r.projectId, projectName: r.projectName, sessionId: r.sessionId })) };
  },
};

const proposalsContributor: SnapshotContributor = {
  key: 'proposals',
  collect: async () => {
    const ps = await getProposals();
    return {
      proposals: ps.map((p) => ({
        projectId: p.projectId, projectName: p.projectName, sessionId: p.sessionId,
        summary: p.summary, ageMinutes: ageMin(p.ts),
      })),
    };
  },
};

const healthContributor: SnapshotContributor = {
  key: 'health',
  collect: async () => {
    // The named health-check job: most recently run schedule whose title mentions health.
    const rows = await db.select().from(schedules).orderBy(desc(schedules.last_run_at));
    const job = rows.find((s) => /health/i.test(s.title) && s.last_run_at);
    if (!job) return { health: { verdict: 'unknown', at: null } };
    const verdict = job.last_status === 'fail' ? 'fail' : job.last_status === 'ok' ? 'pass' : 'unknown';
    return { health: { verdict, at: job.last_run_at ? job.last_run_at.toISOString() : null } };
  },
};

const insightsContributor: SnapshotContributor = {
  key: 'insights',
  collect: async () => {
    const dreams = await getDreams();
    const newest = dreams[0];
    const items = (newest?.insights ?? []).filter((i) => i.status !== 'dismissed').slice(0, 3);
    const at = newest?.createdAt ?? null;
    return { insights: items.map((i) => ({ title: i.title, detail: i.detail, ageMinutes: ageMin(at) })) };
  },
};

const schedulesContributor: SnapshotContributor = {
  key: 'schedules',
  collect: async () => {
    const all = await getSchedules();
    const today = new Date(); today.setHours(23, 59, 59, 999);
    const due = all.filter((s) => s.enabled && s.nextRunAt && new Date(s.nextRunAt) <= today);
    return { schedules: due.map((s) => ({ projectId: s.projectId, title: s.title, nextRunAt: s.nextRunAt })) };
  },
};

export const CONTRIBUTORS: SnapshotContributor[] = [
  projectsContributor, runningContributor, proposalsContributor,
  healthContributor, insightsContributor, schedulesContributor,
];

/**
 * Build the fleet snapshot. Each contributor runs in its own try/catch: a
 * throwing subsystem degrades only its slice and records its key in `errors`,
 * never blanking the whole snapshot (cf. the v1.8.3 fault-isolation lesson).
 */
export async function getFleetSnapshot(contributors: SnapshotContributor[] = CONTRIBUTORS): Promise<FleetSnapshot> {
  const snap = emptySnapshot();
  for (const c of contributors) {
    try {
      Object.assign(snap, await c.collect());
    } catch (err) {
      snap.errors.push(c.key);
      console.warn(`[fleet-snapshot] contributor ${c.key} failed: ${err instanceof Error ? err.message : err}`);
    }
  }
  return snap;
}
```

- [ ] **Step 4: Run tests**

Run: `pnpm test`
Expected: PASS (both fleet-snapshot tests).

- [ ] **Step 5: Commit**

```bash
git add src/lib/fleet-snapshot.ts src/lib/fleet-snapshot.test.ts
git commit -m "feat(akira): query-driven fleet snapshot with isolated contributors"
```

---

### Task 5: AKIRA system prompt + prompt builder

**Files:**
- Create: `src/lib/akira/prompt.ts`
- Create: `src/lib/akira/prompt.test.ts`
- Modify: `scripts/seed.ts` (replace the placeholder `AKIRA_SYSTEM_PROMPT` with the real one) and `src/lib/akira/bootstrap.ts` (import the real prompt)

**Interfaces:**
- Consumes: `FleetSnapshot` from `../fleet-snapshot`; `TranscriptMessage` + `buildOrchestratorPrompt` from `../conversation`.
- Produces:
  - `AKIRA_SYSTEM_PROMPT: string`
  - `renderSnapshot(s: FleetSnapshot): string`
  - `buildAkiraPrompt(snapshot: FleetSnapshot, roster: {id:string;name:string;role:string}[], transcript: TranscriptMessage[], agentLabels: Record<string,string>): string`

- [ ] **Step 1: Write the failing test**

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { renderSnapshot, buildAkiraPrompt, AKIRA_SYSTEM_PROMPT } from './prompt';
import { emptySnapshot } from '../fleet-snapshot';

test('system prompt names AKIRA and her tools', () => {
  assert.match(AKIRA_SYSTEM_PROMPT, /AKIRA/);
  assert.match(AKIRA_SYSTEM_PROMPT, /navigate/);
  assert.match(AKIRA_SYSTEM_PROMPT, /relay/);
  assert.match(AKIRA_SYSTEM_PROMPT, /open/);
});

test('renderSnapshot summarizes counts and health', () => {
  const s = emptySnapshot();
  s.running = [{ projectId: 'p', projectName: 'Web', sessionId: 's1' }];
  s.health = { verdict: 'pass', at: null };
  const text = renderSnapshot(s);
  assert.match(text, /Web/);
  assert.match(text, /pass/i);
});

test('buildAkiraPrompt includes snapshot, roster, and transcript', () => {
  const s = emptySnapshot();
  const prompt = buildAkiraPrompt(
    s,
    [{ id: 'atlas', name: 'Atlas', role: 'developer' }],
    [{ role: 'user', content: 'hi' }],
    { atlas: 'Atlas (developer)' },
  );
  assert.match(prompt, /Atlas/);
  assert.match(prompt, /Operator: hi/);
  assert.match(prompt, /FLEET/);
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `pnpm test`
Expected: FAIL — `Cannot find module './prompt'`.

- [ ] **Step 3: Implement `prompt.ts`**

```ts
import { type FleetSnapshot } from '../fleet-snapshot';
import { buildOrchestratorPrompt, type TranscriptMessage } from '../conversation';

export const AKIRA_SYSTEM_PROMPT = `You are AKIRA, the operator A'Keem's personal concierge for AXOD Mission Control — his command center for directing AI agents across all of his projects. You are calm, warm, precise, and a little wry; you speak in the first person and address him directly.

Your job is to be the front door: brief him on what's happening across the whole fleet, answer questions about it, take him where he wants to go, relay a request into a project's team, and open things for him. You do NOT write or edit code, and you do not run project work yourself — the per-project orchestrator (Sage) and its specialists do that.

You are given, every turn, a FLEET snapshot (current state across all projects) and the live ROSTER of agents. Ground every statement in the snapshot — never invent a project, session, proposal, or status.

Your tools:
- navigate({ projectId, sessionId? }) — take the operator into a project/session in the dashboard. Use when he asks to "open"/"go to"/"show me" a project or session.
- relay({ projectId, sessionId, instruction }) — propose handing a concrete work request to a project's team. This ALWAYS proposes first: it does not start work. Phrase a clear instruction; the operator confirms before anything runs.
- open({ target, query? }) — open a web destination in his browser (e.g. Outlook, GitHub, a search). Use his words for the target; include a query when he wants a search.
- Read/Glob/Grep/WebSearch/WebFetch — for grounding and lookups.

Style: lead with the answer, keep it short and spoken-natural (your replies may be read aloud). Surface the one thing that needs him. When you propose a relay or a navigation, say what you're about to do in one line and let him confirm.`;

/** Render the snapshot into a compact text block for AKIRA's prompt. */
export function renderSnapshot(s: FleetSnapshot): string {
  const lines: string[] = ['## FLEET SNAPSHOT', `as of ${s.generatedAt}`];
  lines.push(`Projects (${s.projects.length}): ${s.projects.map((p) => `${p.name} [${p.id}]`).join(', ') || 'none'}`);
  lines.push(
    `Running turns (${s.running.length}): ` +
      (s.running.map((r) => `${r.projectName} (session ${r.sessionId})`).join('; ') || 'none'),
  );
  lines.push(
    `Proposals awaiting review (${s.proposals.length}): ` +
      (s.proposals.map((p) => `${p.projectName} — ${p.summary || 'changes'} (${p.ageMinutes}m, session ${p.sessionId})`).join('; ') || 'none'),
  );
  lines.push(`Health: ${s.health.verdict}${s.health.at ? ` (at ${s.health.at})` : ''}`);
  lines.push(
    `Insights (${s.insights.length}): ` +
      (s.insights.map((i) => `${i.title} — ${i.detail}`).join('; ') || 'none'),
  );
  lines.push(
    `Scheduled today (${s.schedules.length}): ` +
      (s.schedules.map((sc) => `${sc.title}${sc.nextRunAt ? ` @ ${sc.nextRunAt}` : ''}`).join('; ') || 'none'),
  );
  if (s.errors.length) lines.push(`(unavailable: ${s.errors.join(', ')})`);
  return lines.join('\n');
}

/** Assemble AKIRA's full turn prompt: snapshot + roster + conversation transcript. */
export function buildAkiraPrompt(
  snapshot: FleetSnapshot,
  roster: { id: string; name: string; role: string }[],
  transcript: TranscriptMessage[],
  agentLabels: Record<string, string>,
): string {
  const rosterText =
    '## ROSTER\n' + roster.map((a) => `- ${a.name} [${a.id}] — ${a.role}`).join('\n');
  const convo = buildOrchestratorPrompt(transcript, agentLabels);
  return `${renderSnapshot(snapshot)}\n\n${rosterText}\n\n## CONVERSATION\n${convo}`;
}
```

- [ ] **Step 4: Replace the seed + bootstrap placeholder prompts with the real one**

In `scripts/seed.ts`, replace the `AKIRA_SYSTEM_PROMPT` placeholder string with an import-free copy of the real prompt (the seed script can't easily import `server-only`-adjacent modules, so paste the same string literal you put in `prompt.ts`). In `src/lib/akira/bootstrap.ts`, import and use it:

```ts
import { AKIRA_SYSTEM_PROMPT } from './prompt';
// ...
export const AKIRA_AGENT = {
  // ...
  system_prompt: AKIRA_SYSTEM_PROMPT,
  // ...
};
```

(`prompt.ts` is pure — no `server-only` — so `bootstrap.ts` can import it safely.)

- [ ] **Step 5: Run tests + reseed**

Run: `pnpm test`
Expected: PASS.
Run: `pnpm seed`
Expected: AKIRA's prompt updated via upsert; no error.

- [ ] **Step 6: Commit**

```bash
git add src/lib/akira/prompt.ts src/lib/akira/prompt.test.ts src/lib/akira/bootstrap.ts scripts/seed.ts
git commit -m "feat(akira): system prompt + snapshot/roster/transcript prompt builder"
```

---

### Task 6: AKIRA action tools — `navigate` and `open`

**Files:**
- Create: `src/lib/akira/tools.ts`
- Create: `src/lib/akira/tools.test.ts`

**Interfaces:**
- Consumes: `tool`, `createSdkMcpServer` from `@anthropic-ai/claude-agent-sdk`; `resolveDestination` from `./destinations`; `z` from `zod`.
- Produces:
  - `interface AkiraToolContext { emit: (e: {type:string;[k:string]:unknown}) => void; }`
  - `createAkiraServer(ctx: AkiraToolContext)` — MCP server `akira` with tools `navigate`, `open`, `relay` (Task 7), `list_sessions` + `get_session_detail` (Task 8).
  - `AKIRA_SERVER_NAME = 'akira'`
  - Tool-name constants: `AKIRA_NAVIGATE = 'mcp__akira__navigate'`, `AKIRA_OPEN = 'mcp__akira__open'`, `AKIRA_RELAY = 'mcp__akira__relay'`, `AKIRA_LIST_SESSIONS = 'mcp__akira__list_sessions'`, `AKIRA_GET_SESSION = 'mcp__akira__get_session_detail'`.
- The handlers' pure effects (what they emit / return) are unit-tested by invoking the tool's handler function directly. To make that possible, **export the handler functions** (`navigateHandler`, `openHandler`) separately and have the `tool(...)` definitions call them.

This task adds only `navigate` + `open`; Tasks 7 and 8 add the rest to the same file/server.

- [ ] **Step 1: Write the failing test**

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { navigateHandler, openHandler } from './tools';

test('navigate emits a navigate event and confirms', async () => {
  const events: any[] = [];
  const res = await navigateHandler({ projectId: 'web', sessionId: 's1' }, { emit: (e) => events.push(e) });
  assert.equal(events[0].type, 'navigate');
  assert.equal(events[0].projectId, 'web');
  assert.equal(events[0].sessionId, 's1');
  assert.equal(res.isError ?? false, false);
});

test('open resolves a destination and emits open_url', async () => {
  const events: any[] = [];
  const res = await openHandler({ target: 'amazon', query: 'keyboard' }, { emit: (e) => events.push(e) });
  assert.equal(events[0].type, 'open_url');
  assert.match(events[0].url, /amazon\.com\/s\?k=keyboard/);
  assert.equal(res.isError ?? false, false);
});

test('open with an unknown target does not emit, returns error result', async () => {
  const events: any[] = [];
  const res = await openHandler({ target: 'nonsense place' }, { emit: (e) => events.push(e) });
  assert.equal(events.length, 0);
  assert.equal(res.isError, true);
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `pnpm test`
Expected: FAIL — `Cannot find module './tools'`.

- [ ] **Step 3: Implement `tools.ts` (navigate + open)**

```ts
import 'server-only';
import { z } from 'zod';
import { tool, createSdkMcpServer } from '@anthropic-ai/claude-agent-sdk';
import { resolveDestination } from './destinations';

export const AKIRA_SERVER_NAME = 'akira';
export const AKIRA_NAVIGATE = 'mcp__akira__navigate';
export const AKIRA_OPEN = 'mcp__akira__open';
export const AKIRA_RELAY = 'mcp__akira__relay';
export const AKIRA_LIST_SESSIONS = 'mcp__akira__list_sessions';
export const AKIRA_GET_SESSION = 'mcp__akira__get_session_detail';

export interface AkiraToolContext {
  emit: (e: { type: string; [k: string]: unknown }) => void;
}

type ToolResult = { content: { type: 'text'; text: string }[]; isError?: boolean };
const ok = (text: string): ToolResult => ({ content: [{ type: 'text', text }] });
const err = (text: string): ToolResult => ({ content: [{ type: 'text', text }], isError: true });

export async function navigateHandler(
  args: { projectId: string; sessionId?: string },
  ctx: AkiraToolContext,
): Promise<ToolResult> {
  ctx.emit({ type: 'navigate', projectId: args.projectId, sessionId: args.sessionId ?? null });
  return ok(`Navigating to ${args.projectId}${args.sessionId ? ` / ${args.sessionId}` : ''}.`);
}

export async function openHandler(
  args: { target: string; query?: string },
  ctx: AkiraToolContext,
): Promise<ToolResult> {
  const dest = resolveDestination(args.target, args.query);
  if (!dest) return err(`I don't have a destination for "${args.target}" yet.`);
  ctx.emit({ type: 'open_url', url: dest.url, label: dest.label });
  return ok(`Opening ${dest.label}.`);
}

export function createAkiraServer(ctx: AkiraToolContext) {
  const navigate = tool(
    'navigate',
    'Take the operator into a project (and optionally a specific session) in the dashboard. Use when he asks to open/go to/show a project or session.',
    { projectId: z.string().min(1).describe('The project id to open.'), sessionId: z.string().optional().describe('Optional session id within that project.') },
    (a) => navigateHandler(a, ctx),
  );

  const open = tool(
    'open',
    'Open a web destination in the operator\'s browser (e.g. Outlook, GitHub, Amazon search). Use his words as the target; include a query to perform a search.',
    { target: z.string().min(1).describe('What to open, in the operator\'s words (e.g. "outlook", "amazon").'), query: z.string().optional().describe('Optional search text for searchable sites.') },
    (a) => openHandler(a, ctx),
  );

  return createSdkMcpServer({
    name: AKIRA_SERVER_NAME,
    version: '1.0.0',
    alwaysLoad: true,
    tools: [navigate, open], // relay + read tools appended in Tasks 7 & 8
  });
}
```

- [ ] **Step 4: Run tests**

Run: `pnpm test`
Expected: PASS (3 tool tests).

- [ ] **Step 5: Commit**

```bash
git add src/lib/akira/tools.ts src/lib/akira/tools.test.ts
git commit -m "feat(akira): navigate + open action tools (MCP)"
```

---

### Task 7: `relay` tool (propose-only) + confirm SSE route

**Files:**
- Modify: `src/lib/akira/tools.ts` (add `relay` propose tool + handler)
- Modify: `src/lib/akira/tools.test.ts` (add the side-effect-free safety test)
- Create: `src/app/api/akira/relay/confirm/route.ts`

**Interfaces:**
- Consumes: `runSessionTurn` from `@/lib/run-turn` (signature: `runSessionTurn(sessionId, { emit, signal, instruction })`); `SESSION_COOKIE`, `verifySession` from `@/lib/auth`.
- Produces: `relayHandler(args, ctx)` that emits `relay_proposal` and starts NO work; the confirm route that actually runs the turn.

- [ ] **Step 1: Write the failing safety test (the critical invariant)**

Add to `src/lib/akira/tools.test.ts`:

```ts
import { relayHandler } from './tools';

test('relay PROPOSES only — emits relay_proposal and starts no work', async () => {
  const events: any[] = [];
  const res = await relayHandler(
    { projectId: 'web', sessionId: 's1', instruction: 'fix the signup bug' },
    { emit: (e) => events.push(e) },
  );
  assert.equal(events.length, 1);
  assert.equal(events[0].type, 'relay_proposal');
  assert.equal(events[0].sessionId, 's1');
  assert.equal(events[0].instruction, 'fix the signup bug');
  // No 'start'/'token'/turn events — relay never runs a turn itself.
  assert.ok(!events.some((e) => ['start', 'token', 'done'].includes(e.type)));
  assert.equal(res.isError ?? false, false);
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `pnpm test`
Expected: FAIL — `relayHandler` is not exported.

- [ ] **Step 3: Add `relayHandler` + the relay tool to `tools.ts`**

Add the handler (above `createAkiraServer`):

```ts
export async function relayHandler(
  args: { projectId: string; sessionId: string; instruction: string },
  ctx: AkiraToolContext,
): Promise<ToolResult> {
  // Propose ONLY. Side-effect free: no DB write, no turn. The operator confirms,
  // then the /api/akira/relay/confirm route runs the turn.
  ctx.emit({
    type: 'relay_proposal',
    projectId: args.projectId,
    sessionId: args.sessionId,
    instruction: args.instruction,
  });
  return ok(`Proposed to the operator: run "${args.instruction}" in session ${args.sessionId}. Awaiting his confirmation.`);
}
```

Add the tool inside `createAkiraServer` and include it in the `tools` array:

```ts
  const relay = tool(
    'relay',
    'Propose handing a concrete work request to a project\'s team (Sage). This PROPOSES only and never starts work — the operator must confirm. Provide the target session and a clear, self-contained instruction.',
    {
      projectId: z.string().min(1).describe('The target project id.'),
      sessionId: z.string().min(1).describe('The target session id within that project.'),
      instruction: z.string().min(1).describe('A concrete, self-contained instruction for the project team.'),
    },
    (a) => relayHandler(a, ctx),
  );
```

Change the server's tools to `tools: [navigate, open, relay]`.

- [ ] **Step 4: Run tests**

Run: `pnpm test`
Expected: PASS (the safety test confirms relay starts no work).

- [ ] **Step 5: Implement the confirm SSE route**

`src/app/api/akira/relay/confirm/route.ts` — mirrors the session stream route but passes `instruction` (which `runSessionTurn` inserts as a user message in the target session, then runs the turn):

```ts
import { cookies } from 'next/headers';
import { SESSION_COOKIE, verifySession } from '@/lib/auth';
import { runSessionTurn } from '@/lib/run-turn';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

function sseEncode(event: { type: string; [k: string]: unknown }): Uint8Array {
  return new TextEncoder().encode(`data: ${JSON.stringify(event)}\n\n`);
}

export async function POST(req: Request) {
  const jar = await cookies();
  const token = jar.get(SESSION_COOKIE)?.value;
  if (!token || !(await verifySession(token))) return new Response('Unauthorized', { status: 401 });

  const body = (await req.json().catch(() => ({}))) as { sessionId?: string; instruction?: string };
  if (!body.sessionId || !body.instruction?.trim()) {
    return new Response('sessionId and instruction are required', { status: 400 });
  }
  const { sessionId, instruction } = body;

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const emit = (e: { type: string; [k: string]: unknown }) => controller.enqueue(sseEncode(e));
      try {
        await runSessionTurn(sessionId, { emit, signal: req.signal, instruction });
      } catch (err) {
        emit({ type: 'error', message: err instanceof Error ? err.message : String(err) });
      } finally {
        controller.close();
      }
    },
  });

  return new Response(stream, {
    headers: {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    },
  });
}
```

- [ ] **Step 6: Verify build**

Run: `pnpm build`
Expected: build succeeds; the new route compiles.

- [ ] **Step 7: Commit**

```bash
git add src/lib/akira/tools.ts src/lib/akira/tools.test.ts src/app/api/akira/relay/confirm/route.ts
git commit -m "feat(akira): propose-only relay tool + human-confirmed relay route"
```

---

### Task 8: Drill-down read tools — `list_sessions`, `get_session_detail`

**Files:**
- Modify: `src/lib/akira/tools.ts` (add two read tools + handlers)
- Modify: `src/lib/akira/tools.test.ts`

**Interfaces:**
- Consumes: `db`, `sessions`, `messages` from `@/db/schema`; drizzle `eq`, `and`, `isNull`, `desc`.
- Produces: `listSessionsHandler(args, ctx)`, `getSessionDetailHandler(args, ctx)` returning text results (read-only).

Because these hit the DB, the unit test asserts only the **shape/guard behavior** that's pure: an empty/missing arg returns an error result without touching the DB. (DB-backed happy paths are covered by the runner integration in Task 9.)

- [ ] **Step 1: Write the failing test**

```ts
import { listSessionsHandler, getSessionDetailHandler } from './tools';

test('list_sessions requires a projectId', async () => {
  const res = await listSessionsHandler({ projectId: '' } as any, { emit() {} });
  assert.equal(res.isError, true);
});

test('get_session_detail requires a sessionId', async () => {
  const res = await getSessionDetailHandler({ sessionId: '' } as any, { emit() {} });
  assert.equal(res.isError, true);
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `pnpm test`
Expected: FAIL — handlers not exported.

- [ ] **Step 3: Implement the read handlers + tools**

Add to `tools.ts`:

```ts
import { db } from '@/db/client';
import { sessions, messages } from '@/db/schema';
import { eq, and, isNull, desc, sql } from 'drizzle-orm';

export async function listSessionsHandler(
  args: { projectId: string },
  _ctx: AkiraToolContext,
): Promise<ToolResult> {
  if (!args.projectId) return err('projectId is required.');
  const rows = await db
    .select({ id: sessions.id, title: sessions.title, status: sessions.status, running: sessions.running_since })
    .from(sessions)
    .where(and(eq(sessions.project_id, args.projectId), isNull(sessions.archived_at)))
    .orderBy(desc(sessions.updated_at));
  if (rows.length === 0) return ok('No active sessions in that project.');
  return ok(rows.map((r) => `${r.id} — ${r.title ?? '(untitled)'} [${r.running ? 'running' : r.status}]`).join('\n'));
}

export async function getSessionDetailHandler(
  args: { sessionId: string },
  _ctx: AkiraToolContext,
): Promise<ToolResult> {
  if (!args.sessionId) return err('sessionId is required.');
  const s = await db.select().from(sessions).where(eq(sessions.id, args.sessionId)).limit(1).then((r) => r[0]);
  if (!s) return err(`No session ${args.sessionId}.`);
  const last = await db
    .select({ role: messages.role, content: messages.content })
    .from(messages)
    .where(eq(messages.session_id, args.sessionId))
    .orderBy(desc(messages.created_at), desc(sql`rowid`))
    .limit(1)
    .then((r) => r[0]);
  return ok(
    `Session ${s.id} — ${s.title ?? '(untitled)'}\nstatus: ${s.running_since ? 'running' : s.status}\nbase: ${s.base_branch ?? 'n/a'}\nlast message: ${last ? `${last.role}: ${last.content.slice(0, 200)}` : 'none'}`,
  );
}
```

Add the tools in `createAkiraServer` and include them:

```ts
  const listSessions = tool(
    'list_sessions',
    'List the active sessions in a project (id, title, status). Read-only.',
    { projectId: z.string().min(1).describe('The project id.') },
    (a) => listSessionsHandler(a, ctx),
  );
  const getSession = tool(
    'get_session_detail',
    'Get detail for one session (status, base branch, last message). Read-only.',
    { sessionId: z.string().min(1).describe('The session id.') },
    (a) => getSessionDetailHandler(a, ctx),
  );
```

Change the server tools to `tools: [navigate, open, relay, listSessions, getSession]`.

- [ ] **Step 4: Run tests**

Run: `pnpm test`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/lib/akira/tools.ts src/lib/akira/tools.test.ts
git commit -m "feat(akira): read-only drill-down tools (list_sessions, get_session_detail)"
```

---

### Task 9: AKIRA turn runner (no worktree)

**Files:**
- Create: `src/lib/akira-turn.ts`
- Create: `src/lib/akira-turn.test.ts`

**Interfaces:**
- Consumes: `runClaudeAgent` from `./agent-runner-sdk`; `getFleetSnapshot` from `./fleet-snapshot`; `buildAkiraPrompt`, `AKIRA_SYSTEM_PROMPT` from `./akira/prompt`; `createAkiraServer`, `AKIRA_SERVER_NAME`, and the 5 tool-name constants from `./akira/tools`; `ensureAkiraThread`, `AKIRA_AGENT_ID`, `AKIRA_SESSION_ID` from `./akira/bootstrap`; `db`, `messages`, `agents`; `trimTranscript` (defined here).
- Produces:
  - `trimTranscript(msgs: TranscriptMessage[], keep: number): TranscriptMessage[]` (pure, exported, unit-tested)
  - `runAkiraTurn(opts: { emit?: TurnEmit; signal?: AbortSignal; instruction?: string }): Promise<{ status: 'completed' | 'error'; reason?: string }>`

The runner mirrors `runSessionTurn` (`src/lib/run-turn.ts`) but: (a) calls `ensureAkiraThread()` first, (b) NEVER calls `ensureWorktree` — `workingDir = process.cwd()` (read-only tools only), (c) uses AKIRA's snapshot+roster prompt, (d) wires `createAkiraServer` with all five tool names in `extraAllowedTools`, (e) persists to the reserved session, (f) trims the thread.

- [ ] **Step 1: Write the failing test (pure trim logic)**

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { trimTranscript } from './akira-turn';
import type { TranscriptMessage } from './conversation';

test('trimTranscript keeps the last N messages', () => {
  const msgs: TranscriptMessage[] = Array.from({ length: 10 }, (_, i) => ({ role: 'user', content: `m${i}` }));
  const out = trimTranscript(msgs, 4);
  assert.equal(out.length, 4);
  assert.equal(out[0].content, 'm6');
  assert.equal(out[3].content, 'm9');
});

test('trimTranscript returns all when under the limit', () => {
  const msgs: TranscriptMessage[] = [{ role: 'user', content: 'a' }];
  assert.equal(trimTranscript(msgs, 20).length, 1);
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `pnpm test`
Expected: FAIL — `Cannot find module './akira-turn'`.

- [ ] **Step 3: Implement `akira-turn.ts`**

```ts
import 'server-only';
import { asc, eq, sql } from 'drizzle-orm';
import { randomBytes, bytesToHex } from '@noble/hashes/utils.js';
import { db } from '@/db/client';
import { agents, messages, sessions } from '@/db/schema';
import { runClaudeAgent } from './agent-runner-sdk';
import { getFleetSnapshot } from './fleet-snapshot';
import { buildAkiraPrompt, AKIRA_SYSTEM_PROMPT } from './akira/prompt';
import {
  createAkiraServer, AKIRA_SERVER_NAME,
  AKIRA_NAVIGATE, AKIRA_OPEN, AKIRA_RELAY, AKIRA_LIST_SESSIONS, AKIRA_GET_SESSION,
} from './akira/tools';
import { ensureAkiraThread, AKIRA_AGENT_ID, AKIRA_SESSION_ID } from './akira/bootstrap';
import { buildOrchestratorPrompt, type TranscriptMessage } from './conversation';

export type TurnEmit = (e: { type: string; [k: string]: unknown }) => void;
const KEEP_TURNS = 24; // last N messages kept verbatim in the persistent thread

/** Keep only the last `keep` transcript messages (bounds context growth). Pure. */
export function trimTranscript(msgs: TranscriptMessage[], keep: number): TranscriptMessage[] {
  return msgs.length <= keep ? msgs : msgs.slice(msgs.length - keep);
}

export async function runAkiraTurn(
  opts: { emit?: TurnEmit; signal?: AbortSignal; instruction?: string } = {},
): Promise<{ status: 'completed' | 'error'; reason?: string }> {
  const emit: TurnEmit = opts.emit ?? (() => {});
  await ensureAkiraThread();

  try {
    if (opts.instruction?.trim()) {
      await db.insert(messages).values({
        id: `msg_${bytesToHex(randomBytes(8))}`,
        session_id: AKIRA_SESSION_ID,
        role: 'user',
        content: opts.instruction.trim(),
        created_at: new Date(),
      });
    }

    const convo = await db
      .select()
      .from(messages)
      .where(eq(messages.session_id, AKIRA_SESSION_ID))
      .orderBy(asc(messages.created_at), asc(sql`rowid`));

    const allAgents = await db.select().from(agents);
    const roster = allAgents
      .filter((a) => a.id !== AKIRA_AGENT_ID)
      .map((a) => ({ id: a.id, name: a.name, role: a.role }));
    const agentLabels: Record<string, string> = Object.fromEntries(
      allAgents.map((a) => [a.id, a.id === 'sage' ? 'Sage' : `${a.name} (${a.role})`]),
    );

    const transcript = trimTranscript(
      convo.map((m): TranscriptMessage => ({
        role: m.role as TranscriptMessage['role'],
        agentId: m.agent_id,
        content: m.content,
      })),
      KEEP_TURNS,
    );

    const snapshot = await getFleetSnapshot();
    const prompt = buildAkiraPrompt(snapshot, roster, transcript, agentLabels);

    const akira = allAgents.find((a) => a.id === AKIRA_AGENT_ID);
    const server = createAkiraServer({ emit });

    emit({ type: 'start' });
    let buffer = '';
    let costUsd: number | undefined, tokensIn: number | undefined, tokensOut: number | undefined;

    for await (const event of runClaudeAgent({
      prompt,
      workingDir: process.cwd(), // AKIRA has only read tools; never a worktree
      model: akira?.model,
      systemPrompt: akira?.system_prompt ?? AKIRA_SYSTEM_PROMPT,
      allowedTools: akira?.tools_allowlist ?? undefined,
      mcpServers: { [AKIRA_SERVER_NAME]: server },
      extraAllowedTools: [AKIRA_NAVIGATE, AKIRA_OPEN, AKIRA_RELAY, AKIRA_LIST_SESSIONS, AKIRA_GET_SESSION],
      signal: opts.signal,
    })) {
      if (event.type === 'token') { buffer += event.content; }
      else if (event.type === 'done') {
        costUsd = event.costUsd; tokensIn = event.tokensIn; tokensOut = event.tokensOut;
        if (!buffer && event.fullText) buffer = event.fullText;
      }
      if (event.type !== 'tool_result') emit(event);
    }

    if (buffer.trim()) {
      await db.insert(messages).values({
        id: `msg_${bytesToHex(randomBytes(8))}`,
        session_id: AKIRA_SESSION_ID,
        agent_id: AKIRA_AGENT_ID,
        role: 'agent',
        content: buffer,
        token_count_in: tokensIn,
        token_count_out: tokensOut,
        cost_usd: costUsd,
        created_at: new Date(),
      });
      await db.update(sessions).set({ updated_at: new Date() }).where(eq(sessions.id, AKIRA_SESSION_ID));
    }
    emit({ type: 'persisted' });
    return { status: 'completed' };
  } catch (err) {
    emit({ type: 'error', message: err instanceof Error ? err.message : String(err) });
    return { status: 'error', reason: err instanceof Error ? err.message : String(err) };
  }
}
```

- [ ] **Step 4: Run tests**

Run: `pnpm test`
Expected: PASS (trim tests).

- [ ] **Step 5: Verify build**

Run: `pnpm build`
Expected: build succeeds.

- [ ] **Step 6: Commit**

```bash
git add src/lib/akira-turn.ts src/lib/akira-turn.test.ts
git commit -m "feat(akira): no-worktree AKIRA turn runner with thread trimming"
```

---

### Task 10: AKIRA stream route

**Files:**
- Create: `src/app/api/akira/stream/route.ts`

**Interfaces:**
- Consumes: `runAkiraTurn` from `@/lib/akira-turn`; `SESSION_COOKIE`, `verifySession` from `@/lib/auth`.
- Produces: `GET /api/akira/stream?instruction=...` — SSE stream of an AKIRA turn. The brief fires with `instruction = "Brief the operator on the current fleet state."`; a typed/spoken message passes the operator's text.

- [ ] **Step 1: Implement the route**

```ts
import { cookies } from 'next/headers';
import { SESSION_COOKIE, verifySession } from '@/lib/auth';
import { runAkiraTurn } from '@/lib/akira-turn';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

function sseEncode(event: { type: string; [k: string]: unknown }): Uint8Array {
  return new TextEncoder().encode(`data: ${JSON.stringify(event)}\n\n`);
}

export async function GET(req: Request) {
  const jar = await cookies();
  const token = jar.get(SESSION_COOKIE)?.value;
  if (!token || !(await verifySession(token))) return new Response('Unauthorized', { status: 401 });

  const url = new URL(req.url);
  const instruction = url.searchParams.get('instruction') ?? 'Brief the operator on the current fleet state.';

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const emit = (e: { type: string; [k: string]: unknown }) => controller.enqueue(sseEncode(e));
      try {
        await runAkiraTurn({ emit, signal: req.signal, instruction });
      } catch (err) {
        emit({ type: 'error', message: err instanceof Error ? err.message : String(err) });
      } finally {
        controller.close();
      }
    },
  });

  return new Response(stream, {
    headers: {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    },
  });
}
```

- [ ] **Step 2: Verify build**

Run: `pnpm build`
Expected: build succeeds; `/api/akira/stream` compiles.

- [ ] **Step 3: Commit**

```bash
git add src/app/api/akira/stream/route.ts
git commit -m "feat(akira): AKIRA turn SSE route (brief + replies)"
```

---

### Task 11: Relocate the dashboard to `/dashboard`

**Files:**
- Create: `src/app/dashboard/page.tsx` (the current home page content, verbatim)
- Modify: `src/app/page.tsx` (becomes a temporary redirect to `/dashboard`, replaced by the HUD in Task 12)

**Interfaces:**
- Produces: the existing Mission Control at `/dashboard`, byte-for-byte behavior preserved.

- [ ] **Step 1: Move the home page into `/dashboard`**

Copy the entire current contents of `src/app/page.tsx` into a new `src/app/dashboard/page.tsx`. Rename the exported component from `HomePage` to `DashboardPage` (keep `export default`). Do not change any imports or logic.

- [ ] **Step 2: Replace `src/app/page.tsx` with a temporary redirect**

```tsx
import { redirect } from 'next/navigation';

export const dynamic = 'force-dynamic';

export default function HomePage() {
  redirect('/dashboard');
}
```

- [ ] **Step 3: Verify build + routes**

Run: `pnpm build`
Expected: build succeeds; both `/` and `/dashboard` are listed as routes.

- [ ] **Step 4: Manual smoke**

Run: `pnpm dev`, log in, confirm `/` redirects to `/dashboard` and the dashboard renders exactly as before.

- [ ] **Step 5: Commit**

```bash
git add src/app/dashboard/page.tsx src/app/page.tsx
git commit -m "refactor(dashboard): relocate Mission Control to /dashboard"
```

---

### Task 12: HUD server shell at `/` + orb component

**Files:**
- Create: `src/components/akira/orb.tsx`
- Create: `src/components/akira/hud.tsx` (minimal shell here; wired in Task 14)
- Modify: `src/app/page.tsx` (render the HUD server shell with the snapshot)

**Interfaces:**
- Consumes: `getFleetSnapshot` from `@/lib/fleet-snapshot`.
- Produces: `<Orb mode="idle"|"listening"|"speaking" size={number} />` client component; `<Hud snapshot={FleetSnapshot} />` client component; `/` renders the snapshot cards + the HUD.

- [ ] **Step 1: Implement `orb.tsx`**

Port the locked orb engine from `docs/design/akira-hud.html` into a React client component. Wrap the canvas loop in a `useEffect` keyed on mount; expose `mode` via a prop and store it in a ref the animation loop reads (so prop changes don't restart the loop). The full canvas logic (particles, rim equalizer, ripples, idle/listening/speaking) is in `docs/design/akira-hud.html` lines ~187–249 — copy that `makeOrb` body into the effect, reading `modeRef.current` instead of the closed-over `mode`. Add `"use client";` at the top.

Key skeleton:

```tsx
"use client";
import { useEffect, useRef } from "react";

export type OrbMode = "idle" | "listening" | "speaking";

export function Orb({ mode, size = 300 }: { mode: OrbMode; size?: number }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const modeRef = useRef<OrbMode>(mode);
  modeRef.current = mode;

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    let raf = 0;
    // ... paste makeOrb body from docs/design/akira-hud.html, using modeRef.current
    //     for `mode`, R = size * 0.4, count = 850; assign raf = requestAnimationFrame(frame)
    return () => cancelAnimationFrame(raf);
  }, [size]);

  return <canvas ref={canvasRef} width={size} height={size} style={{ width: size, height: size }} />;
}
```

- [ ] **Step 2: Implement a minimal `hud.tsx` shell**

```tsx
"use client";
import { useState } from "react";
import { Orb, type OrbMode } from "./orb";
import type { FleetSnapshot } from "@/lib/fleet-snapshot";

export function Hud({ snapshot }: { snapshot: FleetSnapshot }) {
  const [mode] = useState<OrbMode>("idle");
  return (
    <div style={{ minHeight: "100vh", display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center" }}>
      <Orb mode={mode} size={320} />
      <div style={{ marginTop: 20, color: "#7fdcff", fontFamily: "ui-monospace, monospace" }}>
        {snapshot.running.length} running · {snapshot.proposals.length} proposal(s) · health: {snapshot.health.verdict}
      </div>
      <a href="/dashboard" style={{ marginTop: 16, color: "#6b7a8d" }}>Open full dashboard ↗</a>
    </div>
  );
}
```

- [ ] **Step 3: Replace `src/app/page.tsx` with the HUD shell**

```tsx
import { getFleetSnapshot } from "@/lib/fleet-snapshot";
import { Hud } from "@/components/akira/hud";

export const dynamic = "force-dynamic";

export default async function HomePage() {
  const snapshot = await getFleetSnapshot();
  return (
    <main style={{ background: "#04060b", color: "#e6edf3", minHeight: "100vh" }}>
      <Hud snapshot={snapshot} />
    </main>
  );
}
```

- [ ] **Step 4: Verify build + manual**

Run: `pnpm build` then `pnpm dev`.
Expected: `/` shows the animated orb + the deterministic counts; "Open full dashboard" navigates to `/dashboard`. The orb animates smoothly (idle).

- [ ] **Step 5: Commit**

```bash
git add src/components/akira/orb.tsx src/components/akira/hud.tsx src/app/page.tsx
git commit -m "feat(akira): HUD server shell at / with the animated orb + snapshot cards"
```

---

### Task 13: Voice layer — chunking + speech wrappers

**Files:**
- Create: `src/lib/voice/chunk.ts`
- Create: `src/lib/voice/chunk.test.ts`
- Create: `src/lib/voice/speech.ts`

**Interfaces:**
- Produces (pure, tested):
  - `splitSentences(buffer: string): { ready: string[]; rest: string }` — emit complete sentences as they form; keep the trailing partial.
  - `pickFemaleVoice(voices: { name: string; lang: string }[]): { name: string; lang: string } | null`
- Produces (client-only, not unit-tested): `speak(text, voiceName?)`, `createRecognizer({ onResult, onEnd })`, `voiceSupport()` in `speech.ts`.

- [ ] **Step 1: Write the failing test**

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { splitSentences, pickFemaleVoice } from './chunk';

test('splitSentences emits complete sentences and keeps the remainder', () => {
  const r = splitSentences('Hello there. How are you tod');
  assert.deepEqual(r.ready, ['Hello there.']);
  assert.equal(r.rest, ' How are you tod');
});

test('splitSentences with no terminator keeps everything as rest', () => {
  const r = splitSentences('still going');
  assert.deepEqual(r.ready, []);
  assert.equal(r.rest, 'still going');
});

test('pickFemaleVoice prefers a known female voice name', () => {
  const v = pickFemaleVoice([
    { name: 'Microsoft David - English (United States)', lang: 'en-US' },
    { name: 'Microsoft Zira - English (United States)', lang: 'en-US' },
  ]);
  assert.equal(v?.name, 'Microsoft Zira - English (United States)');
});

test('pickFemaleVoice falls back to the first en voice', () => {
  const v = pickFemaleVoice([{ name: 'SomeVoice', lang: 'en-GB' }]);
  assert.equal(v?.name, 'SomeVoice');
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `pnpm test`
Expected: FAIL — `Cannot find module './chunk'`.

- [ ] **Step 3: Implement `chunk.ts`**

```ts
// Pure helpers for the voice layer — no browser APIs, unit-testable.

/**
 * Given an accumulating text buffer, return the complete sentences ready to
 * speak (split on . ! ? followed by space/end) and the trailing partial to keep.
 */
export function splitSentences(buffer: string): { ready: string[]; rest: string } {
  const ready: string[] = [];
  let rest = buffer;
  const re = /(.+?[.!?])(\s+|$)/g;
  let m: RegExpExecArray | null;
  let lastIndex = 0;
  while ((m = re.exec(buffer)) !== null) {
    ready.push(m[1].trim());
    lastIndex = re.lastIndex;
  }
  if (ready.length) rest = buffer.slice(lastIndex);
  return { ready, rest };
}

const FEMALE_HINTS = ['zira', 'aria', 'jenny', 'samantha', 'female', 'eva', 'hazel', 'susan'];

/** Prefer a known female voice; else the first English voice; else null. */
export function pickFemaleVoice(
  voices: { name: string; lang: string }[],
): { name: string; lang: string } | null {
  const female = voices.find((v) => FEMALE_HINTS.some((h) => v.name.toLowerCase().includes(h)));
  if (female) return female;
  const en = voices.find((v) => v.lang.toLowerCase().startsWith('en'));
  return en ?? voices[0] ?? null;
}
```

- [ ] **Step 4: Run tests**

Run: `pnpm test`
Expected: PASS (4 chunk tests).

- [ ] **Step 5: Implement `speech.ts` (client-only wrapper)**

```ts
"use client";
import { pickFemaleVoice } from "./chunk";

export function voiceSupport(): { tts: boolean; stt: boolean } {
  if (typeof window === "undefined") return { tts: false, stt: false };
  const stt = "SpeechRecognition" in window || "webkitSpeechRecognition" in window;
  return { tts: "speechSynthesis" in window, stt };
}

let cachedVoice: SpeechSynthesisVoice | null = null;
export function speak(text: string): void {
  if (typeof window === "undefined" || !("speechSynthesis" in window) || !text.trim()) return;
  const u = new SpeechSynthesisUtterance(text);
  const voices = window.speechSynthesis.getVoices();
  if (!cachedVoice && voices.length) {
    const pick = pickFemaleVoice(voices.map((v) => ({ name: v.name, lang: v.lang })));
    cachedVoice = voices.find((v) => v.name === pick?.name) ?? null;
  }
  if (cachedVoice) u.voice = cachedVoice;
  window.speechSynthesis.speak(u);
}

export function createRecognizer(handlers: { onResult: (t: string) => void; onEnd: () => void }) {
  if (typeof window === "undefined") return null;
  const Ctor = (window as any).SpeechRecognition || (window as any).webkitSpeechRecognition;
  if (!Ctor) return null;
  const rec = new Ctor();
  rec.lang = "en-US";
  rec.interimResults = false;
  rec.maxAlternatives = 1;
  rec.onresult = (e: any) => handlers.onResult(e.results[0][0].transcript);
  rec.onend = handlers.onEnd;
  return rec as { start: () => void; stop: () => void };
}
```

- [ ] **Step 6: Verify build**

Run: `pnpm build`
Expected: build succeeds.

- [ ] **Step 7: Commit**

```bash
git add src/lib/voice/chunk.ts src/lib/voice/chunk.test.ts src/lib/voice/speech.ts
git commit -m "feat(akira): voice layer — sentence chunking, voice pick, TTS/STT wrappers"
```

---

### Task 14: Wire the HUD — stream, orb states, voice, toggles, actions

**Files:**
- Modify: `src/components/akira/hud.tsx` (full implementation)

**Interfaces:**
- Consumes: `Orb`/`OrbMode`; `FleetSnapshot`; `speak`, `createRecognizer`, `voiceSupport` from `@/lib/voice/speech`; `splitSentences` from `@/lib/voice/chunk`; the `/api/akira/stream`, `/api/akira/relay/confirm`, `/api/projects/active`, `/api/sessions/[id]/active` endpoints.
- Produces: the working HUD — fires the brief on mount, streams AKIRA's reply (orb `thinking`→`speaking`→`idle`), speaks it when Voice is on, captures mic input when Mic is on, renders Confirm/Cancel on `relay_proposal`, opens tabs on `open_url`, and routes on `navigate`.

- [ ] **Step 1: Implement the full HUD**

Build `hud.tsx` with this behavior (concrete code):

```tsx
"use client";
import { useEffect, useRef, useState, useCallback } from "react";
import { Orb, type OrbMode } from "./orb";
import type { FleetSnapshot } from "@/lib/fleet-snapshot";
import { speak, createRecognizer, voiceSupport } from "@/lib/voice/speech";
import { splitSentences } from "@/lib/voice/chunk";

type RelayProposal = { projectId: string; sessionId: string; instruction: string };

export function Hud({ snapshot }: { snapshot: FleetSnapshot }) {
  const [mode, setMode] = useState<OrbMode>("idle");
  const [reply, setReply] = useState("");
  const [micOn, setMicOn] = useState(false);
  const [voiceOn, setVoiceOn] = useState(true);
  const [proposal, setProposal] = useState<RelayProposal | null>(null);
  const support = useRef(voiceSupport());
  const spokenBuffer = useRef("");
  const voiceOnRef = useRef(voiceOn);
  voiceOnRef.current = voiceOn;

  // restore toggle prefs
  useEffect(() => {
    const m = localStorage.getItem("akira_mic"); if (m !== null) setMicOn(m === "1");
    const v = localStorage.getItem("akira_voice"); if (v !== null) setVoiceOn(v === "1");
  }, []);
  useEffect(() => { localStorage.setItem("akira_mic", micOn ? "1" : "0"); }, [micOn]);
  useEffect(() => { localStorage.setItem("akira_voice", voiceOn ? "1" : "0"); }, [voiceOn]);

  const runTurn = useCallback((instruction?: string) => {
    setReply(""); spokenBuffer.current = ""; setMode("speaking");
    const qs = instruction ? `?instruction=${encodeURIComponent(instruction)}` : "";
    const es = new EventSource(`/api/akira/stream${qs}`);
    es.onmessage = (ev) => {
      const e = JSON.parse(ev.data);
      if (e.type === "token") {
        setReply((r) => r + e.content);
        if (voiceOnRef.current) {
          spokenBuffer.current += e.content;
          const { ready, rest } = splitSentences(spokenBuffer.current);
          ready.forEach(speak); spokenBuffer.current = rest;
        }
      } else if (e.type === "navigate") {
        void goToProject(e.projectId, e.sessionId);
      } else if (e.type === "open_url") {
        window.open(e.url, "_blank", "noopener");
      } else if (e.type === "relay_proposal") {
        setProposal({ projectId: e.projectId, sessionId: e.sessionId, instruction: e.instruction });
      } else if (e.type === "persisted" || e.type === "error") {
        if (e.type === "error") {
          setReply((r) => r || "Good to see you, A'Keem. I couldn't compose a brief just now — tap to retry.");
        } else if (voiceOnRef.current && spokenBuffer.current.trim()) {
          speak(spokenBuffer.current);
        }
        setMode("idle"); es.close();
      }
    };
    es.onerror = () => {
      setReply((r) => r || "Good to see you, A'Keem. I couldn't reach the brief just now — tap to retry.");
      setMode("idle"); es.close();
    };
  }, []);

  // fire the brief once on mount
  useEffect(() => { runTurn("Brief the operator on the current fleet state."); }, [runTurn]);

  async function goToProject(projectId: string, sessionId?: string | null) {
    await fetch("/api/projects/active", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ projectId }) });
    if (sessionId) await fetch(`/api/sessions/${sessionId}/active`, { method: "POST" });
    window.location.href = `/dashboard`;
  }

  function startMic() {
    if (!micOn) return;
    setMode("listening");
    const rec = createRecognizer({
      onResult: (t) => runTurn(t),
      onEnd: () => setMode((m) => (m === "listening" ? "idle" : m)),
    });
    rec?.start();
  }

  async function confirmRelay() {
    if (!proposal) return;
    const p = proposal; setProposal(null); setMode("speaking"); setReply("");
    const res = await fetch("/api/akira/relay/confirm", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ sessionId: p.sessionId, instruction: p.instruction }),
    });
    // stream the confirmed turn's events (reuse the same handling shape)
    const reader = res.body?.getReader(); const dec = new TextDecoder();
    if (!reader) { setMode("idle"); return; }
    for (;;) {
      const { value, done } = await reader.read(); if (done) break;
      for (const line of dec.decode(value).split("\n\n")) {
        const m = line.match(/^data: (.*)$/m); if (!m) continue;
        const e = JSON.parse(m[1]);
        if (e.type === "token") setReply((r) => r + e.content);
      }
    }
    setMode("idle");
  }

  return (
    <div style={{ minHeight: "100vh", display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", position: "relative" }}>
      <div style={{ position: "fixed", top: 12, right: 16, display: "flex", gap: 10 }}>
        <button disabled={!support.current.stt} onClick={() => setMicOn((v) => !v)} title="Microphone">
          {micOn ? "🎙 Mic On" : "🎙 Mic Off"}
        </button>
        <button disabled={!support.current.tts} onClick={() => setVoiceOn((v) => !v)} title="Voice">
          {voiceOn ? "🔊 Voice On" : "🔇 Voice Off"}
        </button>
      </div>

      <Orb mode={mode} size={320} />
      <div style={{ marginTop: 18, maxWidth: 680, textAlign: "center", color: "#c4d3e3", lineHeight: 1.6 }}>{reply}</div>
      <div style={{ marginTop: 10, color: "#7fdcff", fontFamily: "ui-monospace, monospace", fontSize: 13 }}>
        {snapshot.running.length} running · {snapshot.proposals.length} proposal(s) · health: {snapshot.health.verdict}
      </div>

      {micOn && (
        <button onClick={startMic} style={{ marginTop: 16 }}>🎤 Tap to speak</button>
      )}

      {proposal && (
        <div style={{ marginTop: 16, padding: 14, border: "1px solid #1f3347", borderRadius: 10 }}>
          <div style={{ marginBottom: 8 }}>Run “{proposal.instruction}” in {proposal.projectId}?</div>
          <button onClick={confirmRelay}>Confirm</button>
          <button onClick={() => setProposal(null)} style={{ marginLeft: 8 }}>Cancel</button>
        </div>
      )}

      <a href="/dashboard" style={{ marginTop: 20, color: "#6b7a8d" }}>Open full dashboard ↗</a>
    </div>
  );
}
```

> Styling here is functional-minimal; the locked visual polish from `docs/design/akira-hud.html` (constellation background, top bar, layout) is applied as a follow-up styling pass — out of scope for behavior. Keep the orb + states + toggles + actions correct first.

- [ ] **Step 2: Verify build + manual**

Run: `pnpm build` then `pnpm dev`. Log in → `/` loads, orb goes to `speaking`, AKIRA's brief streams in. Toggle Voice and confirm TTS speaks (after a click, per autoplay rules). Toggle Mic on → "Tap to speak" appears. Ask her to "open Outlook" → a tab opens. Ask her to do work → a Confirm/Cancel card appears; Confirm runs the target session turn.

- [ ] **Step 3: Commit**

```bash
git add src/components/akira/hud.tsx
git commit -m "feat(akira): wire HUD — brief stream, orb states, voice, mic/voice toggles, navigate/open/relay"
```

---

### Task 15: Docs + standing rule

**Files:**
- Modify: `.claude/skills/ship-mc-feature/SKILL.md`
- Modify: `docs/superpowers/specs/2026-06-28-akira-phase-1-design.md` (mark Implemented)

**Interfaces:** none (documentation).

- [ ] **Step 1: Add the standing rule to the skill**

In `.claude/skills/ship-mc-feature/SKILL.md`, add a short note under the build guidance:

> **AKIRA awareness:** When a feature adds a new user-visible subsystem, add a snapshot contributor in `src/lib/fleet-snapshot.ts` (and extend `FleetSnapshot`) so AKIRA stays aware of it.

- [ ] **Step 2: Mark the spec implemented**

At the top of the spec, change the status line to: `**Status:** Implemented (Phase 1) — <date>`.

- [ ] **Step 3: Commit**

```bash
git add .claude/skills/ship-mc-feature/SKILL.md docs/superpowers/specs/2026-06-28-akira-phase-1-design.md
git commit -m "docs(akira): standing snapshot-contributor rule + mark Phase 1 implemented"
```

---

## Final verification (after all tasks)

- [ ] `pnpm test` — all `src/lib/*.test.ts` pass (destinations, fleet-snapshot, prompt, tools incl. the relay-propose safety test, akira-turn trim, voice chunk, bootstrap metadata).
- [ ] `pnpm build` — clean production build; routes `/`, `/dashboard`, `/api/akira/stream`, `/api/akira/relay/confirm` all present.
- [ ] `pnpm lint` — no new lint errors.
- [ ] Manual: log in → AKIRA briefs on landing; Voice/Mic toggles work and persist; "open Outlook/Amazon search" opens a tab; a work request yields Confirm/Cancel and the confirmed turn runs in the target session; "Open full dashboard" and `navigate` reach `/dashboard`.
- [ ] Then: REQUIRED SUB-SKILL superpowers:finishing-a-development-branch.
