# Week 1 — Walking Skeleton Plan

> **Goal:** Prove the core loop works end-to-end with the ugliest possible UI. By Friday evening, you should be able to type a prompt into a Next.js page, have it spawn Claude Code in a subprocess, and watch the agent's stdout stream onto the page in real-time.
>
> Five working days. Each day has a single deliverable. If a day slips, cut scope on the NEXT day to keep the rhythm.

## Pre-week setup (do this Sunday or before day 1)

- [ ] Confirm Anthropic API key is active and has billing (test with `curl https://api.anthropic.com/v1/messages` + a 1-token request)
- [ ] Make sure `pnpm` is installed (`corepack enable && corepack prepare pnpm@latest --activate`)
- [ ] Node 22+ (`node --version` — Claude Agent SDK requires this)
- [ ] Claude Code installed globally (`npm install -g @anthropic-ai/claude-code` — needed for Day 4 subprocess spawn)
- [ ] Spin up the Hetzner VPS now even though deploy isn't until week 5 — provisions in 60s, costs $5/mo to leave idle, removes a future surprise
- [ ] Create the Discord bot + save the token to a notes file — Discord is v1.1 but 5 min of setup now is cheap insurance
- [ ] Read the Claude Agent SDK quickstart at `https://docs.claude.com/en/api/agent-sdk/overview` (~30 min)

---

## Day 1 — Repo, Next.js skeleton, three-pane shell

**Goal:** Empty Next.js app deployed to localhost, showing the 3-pane layout from the hybrid mockup, with hardcoded mock data. **No real interactivity yet — just the skeleton.**

### Tasks

- [ ] **Init the Next.js project**
  ```bash
  cd c:/Users/A'KeemDrew/AXOD/axod-mission-control
  pnpm create next-app@latest . --typescript --tailwind --app --src-dir --eslint --turbopack --import-alias "@/*"
  # When prompted "Would you like to customize the default import alias?" → No (use default)
  # When prompted about existing files (README, docs) → keep them
  ```

- [ ] **Install foundational dependencies**
  ```bash
  pnpm add zod hono lucide-react clsx tailwind-merge
  pnpm add -D @types/node prettier prettier-plugin-tailwindcss
  ```

- [ ] **Install shadcn/ui CLI + initial components**
  ```bash
  pnpm dlx shadcn@latest init -d
  # Pick: Default style, Neutral base color, CSS variables yes
  pnpm dlx shadcn@latest add button card input scroll-area separator
  ```

- [ ] **Theme to AXOD palette**

  Edit `src/app/globals.css` — replace the default `:root` and `.dark` blocks with:
  ```css
  :root {
    --background: 220 30% 6%;       /* #0a0e14 */
    --foreground: 213 18% 92%;      /* #e6edf3 */
    --card: 215 22% 9%;             /* #11161d */
    --card-foreground: 213 18% 92%;
    --primary: 188 100% 50%;        /* #00e0ff cyan accent */
    --primary-foreground: 0 0% 0%;
    --secondary: 215 22% 13%;
    --muted: 215 18% 18%;
    --muted-foreground: 215 14% 55%;
    --border: 215 22% 16%;
    --accent: 217 91% 60%;          /* #3b82f6 blue */
    --radius: 0.5rem;
  }
  body { background: hsl(220 30% 4%); }
  ```

  Add to `<body>` className in `src/app/layout.tsx`: `font-sans antialiased`.

  Update `src/app/layout.tsx` to load Inter and JetBrains Mono via `next/font`.

- [ ] **Build the 3-pane shell as `src/app/page.tsx`**

  Three columns: 280px (team) · 1fr (chat) · 1fr (workspace). Use a top bar (48px) and bottom strip (36px). Pull the structure straight from the hybrid mockup — but with hardcoded mock data for now, no API calls.

  Make it a Server Component for the shell; client components only where you need interactivity (which is nowhere on day 1).

- [ ] **Mock data file** at `src/lib/mock-data.ts` — export TypeScript objects for: the team (Sage + Atlas), one mock session, mock messages, mock approval card. Use these to populate the UI on day 1.

- [ ] **Run + verify**
  ```bash
  pnpm dev --host 127.0.0.1
  # Open http://127.0.0.1:3000
  # Should see: 3-column shell, team on left with Sage and Atlas, mock chat in middle, empty workspace on right
  ```

- [ ] **Commit + push**
  ```bash
  git add .
  git commit -m "chore: scaffold Next.js + 3-pane UI shell with mock data"
  ```

  (Push happens at end of week 1 when remote is created.)

### Day 1 success criteria

You open `http://127.0.0.1:3000` and see the hybrid mockup's layout, AXOD-themed, with Sage and Atlas in the team roster and a fake conversation. **Nothing works yet.** That's fine.

### Day 1 gotchas

- Tailwind 4 vs 3: Next.js 16 may default to Tailwind 4. Either works; shadcn supports both.
- If `pnpm create next-app` complains about existing files, it asks per-file. Keep README and docs, let it create everything else.
- Don't add a database, an API route, or any agent logic on day 1. **Resist this.**

---

## Day 2 — SQLite + Drizzle + seed data

**Goal:** Database is live. You can read `agents`, `projects`, `sessions` from SQLite into a Server Component and render them. Replaces the mock data file from day 1.

### Tasks

- [ ] **Install Drizzle + better-sqlite3**
  ```bash
  pnpm add drizzle-orm better-sqlite3
  pnpm add -D drizzle-kit @types/better-sqlite3
  ```

- [ ] **Create `src/db/schema.ts`** — copy the schema from the [v1 spec § Data model](../specs/v1-mvp-spec.md) section. All 9 tables: `projects`, `agents`, `sessions`, `messages`, `approvals`, `tool_permissions`, `artifacts`, `auth_users`, `auth_sessions`.

- [ ] **Create `src/db/client.ts`**
  ```ts
  import Database from 'better-sqlite3';
  import { drizzle } from 'drizzle-orm/better-sqlite3';
  import * as schema from './schema';

  const sqlite = new Database(process.env.DATABASE_PATH ?? './data/mission-control.db');
  sqlite.pragma('journal_mode = WAL');
  sqlite.pragma('foreign_keys = ON');
  export const db = drizzle(sqlite, { schema });
  ```

- [ ] **Drizzle config + migrations**
  ```bash
  # drizzle.config.ts at repo root
  ```
  ```ts
  import { defineConfig } from 'drizzle-kit';
  export default defineConfig({
    schema: './src/db/schema.ts',
    out: './drizzle',
    dialect: 'sqlite',
    dbCredentials: { url: './data/mission-control.db' },
  });
  ```

  ```bash
  mkdir -p data
  pnpm dlx drizzle-kit generate
  pnpm dlx drizzle-kit migrate
  ```

- [ ] **Seed script** at `scripts/seed.ts`. Inserts:
  - `projects`: one row for AXOD CREATIVE pointing at `c:/Users/A'KeemDrew/AXOD/landing`
  - `agents`: Sage (orchestrator, Opus 4.7) + Atlas (developer, Sonnet 4.6) with placeholder system prompts (full prompts get refined in week 3)
  - One demo `session` and a few demo `messages` so the UI has something to render

  Add to `package.json`:
  ```json
  "scripts": {
    "db:generate": "drizzle-kit generate",
    "db:migrate": "drizzle-kit migrate",
    "seed": "tsx scripts/seed.ts"
  }
  ```

- [ ] **Update `src/app/page.tsx`** to read from the DB instead of mock data
  ```ts
  import { db } from '@/db/client';
  import { agents, sessions, messages } from '@/db/schema';

  export default async function HomePage() {
    const team = await db.select().from(agents);
    const currentSession = await db.query.sessions.findFirst({
      orderBy: (s, { desc }) => [desc(s.updated_at)],
      with: { messages: { orderBy: (m, { asc }) => [asc(m.created_at)] } },
    });
    // ...render
  }
  ```

- [ ] **Add `.env.example` + `.env`**
  ```
  ANTHROPIC_API_KEY=
  DATABASE_PATH=./data/mission-control.db
  SESSION_SECRET=
  ```

  Add `data/` and `.env` to `.gitignore`.

- [ ] **Run + verify**
  ```bash
  pnpm db:migrate
  pnpm seed
  pnpm dev
  # Reload — should see real DB data instead of mocks. Identical visually.
  ```

- [ ] **Commit**
  ```bash
  git add . && git commit -m "feat(db): SQLite + Drizzle schema + seed script"
  ```

### Day 2 success criteria

The UI looks identical to day 1, but the data now comes from SQLite. You can `sqlite3 data/mission-control.db ".tables"` and see all 9 tables. Restarting the dev server preserves the data.

### Day 2 gotchas

- `better-sqlite3` is a native module — needs Node 22+ and may need build tools on first install (`npm config set msvs_version 2022` on Windows if it fails)
- Foreign keys must be explicitly enabled per connection (`PRAGMA foreign_keys = ON`)
- Drizzle's `text(..., { mode: 'json' })` is the right way to store JSON in SQLite

### Day 2 — what actually happened (2026-05-27)

- The project's `.npmrc` has `ignore-scripts=true` as a hardening default. This silently blocks `better-sqlite3`'s native build, and `pnpm rebuild` doesn't override it. Workaround: `cd node_modules/.pnpm/better-sqlite3@<ver>/node_modules/better-sqlite3 && npx --no prebuild-install` once, then it's cached for the lifetime of `node_modules`.
- pnpm 11 also runs a "deps status check" before any `pnpm <script>`, which throws `[ERR_PNPM_IGNORED_BUILDS]` and exits 1 even when the script doesn't need the build. Fix: add `verifyDepsBeforeRun: false` to `pnpm-workspace.yaml`. Also add the native package to `onlyBuiltDependencies:` in the same file (NOT in `package.json` — pnpm 11 reads the workspace file).
- Page refactor was bigger than the plan suggests: the Day 1 `page.tsx` was one giant client component. Split it into `src/app/page.tsx` (async Server Component fetching from SQLite) and `src/components/mission-control.tsx` (the existing interactive UI, now accepting `team / session / messages / artifacts` as props).
- Drizzle 0.45's `primaryKey({ columns: [...] })` is now passed as an **array** to the second arg of `sqliteTable`, not as `(t) => ({ pk: ... })`. Plan example was slightly out of date.
- Used `dotenv` in `drizzle.config.ts` so `pnpm db:*` picks up `DATABASE_PATH` from `.env` instead of relying on the literal default.
- Added `.claude/settings.local.json` to `.gitignore` (Claude Code's local-only settings file).

---

## Day 3 — Auth + basic API routes

**Goal:** You can log in (single user, scrypt password). The page is protected. You can `POST /api/sessions/:id/messages` and the message gets persisted. Still no agent yet.

### Tasks

- [ ] **Install auth deps**
  ```bash
  pnpm add jose @noble/hashes
  ```

  (Using `jose` for JWT-like session tokens, `@noble/hashes` for scrypt. `next-auth` is overkill for single-user.)

- [ ] **`src/lib/auth.ts`** — helpers: `hashPassword(plain)`, `verifyPassword(plain, hash)`, `createSession(userId)`, `verifySession(token)`. Uses `scryptAsync` from `@noble/hashes`. Session token is a signed JWT stored in an HTTP-only cookie.

- [ ] **`src/app/api/auth/login/route.ts`** — POST handler that:
  1. Reads `{ email, password }` from request
  2. Looks up `auth_users` row
  3. Verifies scrypt hash
  4. On success: creates `auth_sessions` row, sets `mc_session` cookie
  5. Rate-limited via simple in-memory Map (5 attempts per IP per 15 min)

- [ ] **`src/app/api/auth/logout/route.ts`** — POST handler that deletes the session row + clears the cookie.

- [ ] **`src/middleware.ts`** — Next.js middleware that protects all routes except `/login` and `/api/auth/*`. Redirects unauthenticated requests to `/login`.

- [ ] **Login page** at `src/app/login/page.tsx` — bare-bones form: email + password + submit. Posts to `/api/auth/login`, redirects to `/` on success.

- [ ] **Seed admin script** at `scripts/seed-admin.ts` — prompts via `readline` for email + password, hashes, inserts into `auth_users`. Add to `package.json`:
  ```json
  "seed:admin": "tsx scripts/seed-admin.ts"
  ```

- [ ] **API: send message route** at `src/app/api/sessions/[id]/messages/route.ts`
  - POST handler accepting `{ content }` from request
  - Inserts a new `messages` row with `role='user'`, `agent_id=null`
  - **Does not invoke any agent yet.** That's day 4-5.
  - Returns the inserted message

- [ ] **Wire up the composer in the UI** — make the chat composer at the bottom of the middle pane an actual `<form>` that POSTs to `/api/sessions/:id/messages` and re-fetches the message list after submit. Use `useTransition` or a simple form action.

- [ ] **Run + verify**
  ```bash
  pnpm seed:admin
  # Enter email: you@axodcreative.com
  # Enter password: <a real one>
  pnpm dev
  # Open http://127.0.0.1:3000 → redirected to /login
  # Log in → land on /
  # Type a message in composer → submit → see it appear in the message list
  ```

- [ ] **Commit**
  ```bash
  git add . && git commit -m "feat(auth): single-user scrypt auth + protected routes + message persistence"
  ```

### Day 3 success criteria

You're logged in. You type a message. It persists. You refresh and it's still there. The agent doesn't respond yet (that's day 4-5).

### Day 3 gotchas

- Don't use `bcrypt` on Node 22+ on Windows — native build is finicky. `@noble/hashes` is pure JS, works everywhere.
- Middleware runs in Edge runtime by default — make sure your auth verify is Edge-compatible. `jose` is.
- HTTP-only cookies + `Secure: true` will block on `http://127.0.0.1` in some browsers. Make `Secure` conditional on `process.env.NODE_ENV === 'production'`.

### Day 3 — what actually happened (2026-05-27)

- **Next 16 renamed middleware → proxy.** The file is `src/proxy.ts` (not `src/middleware.ts`) and the export is `proxy` (not `middleware`). Functionality identical. See `node_modules/next/dist/docs/01-app/01-getting-started/16-proxy.md`.
- Proxy runs in the Edge runtime, so it can't import `src/lib/auth.ts` (which pulls in `better-sqlite3`). Solution: tiny `src/lib/auth-edge.ts` that exports only the cookie-name constant. Proxy does an optimistic cookie-exists check; real session verification happens in pages + route handlers via `verifySession()` (Node runtime).
- `@noble/hashes` v2 requires the `.js` suffix on subpath imports — `@noble/hashes/scrypt.js` and `@noble/hashes/utils.js`. The plain `@noble/hashes/scrypt` style fails type resolution in TS 5.
- The composer was already a `<form>` (from Day 1) — wired its submit handler to `fetch('/api/sessions/:id/messages', POST)` with optimistic insert + rollback on failure, then `router.refresh()` to re-fetch the Server Component. Also wired the existing Lock icon in the header to logout via `/api/auth/logout`.
- `scripts/seed-admin.ts` uses a `readline` mute hack to hide the password input. This works interactively but breaks when stdin is piped — so for the Day 3 curl test I inserted the admin via a one-off `node -e` script instead. Real operator setup still uses `pnpm seed:admin` in a TTY.
- A test admin (`test@axodcreative.com` / `TestPassword123!`) was seeded during verification. Delete before deploy.
- Used `zod` for both `/api/auth/login` and `/api/sessions/[id]/messages` body validation. Returns generic "Invalid credentials" on login parse failure (don't leak which field was wrong).
- Login is rate-limited at **5 attempts per 15 min per IP** via an in-memory `Map` (`src/lib/rate-limit.ts`). In-memory is fine for single-process v1; will need Redis (or similar) if/when we scale beyond one node.
- Restarting the dev server (any time `proxy.ts` is added/changed) requires killing both the pnpm wrapper and the underlying `next dev` child process — `pnpm` doesn't propagate signals cleanly on Windows.

---

## Day 4 — Spawn Claude Code via subprocess, stream stdout via SSE

**Goal:** When you send a message, the server spawns the `claude` CLI as a subprocess, pipes the message in as a prompt, and streams its stdout token-by-token back to the web UI via Server-Sent Events.

This is the **proof of the core architecture**. It's ugly (real Claude Agent SDK integration is day 5 / week 2), but it shows the wire works.

### Tasks

- [ ] **Verify `claude` CLI works locally**
  ```bash
  echo "list files in src/" | claude --print --output-format text --add-dir c:/Users/A'KeemDrew/AXOD/landing
  # Should print Claude's response and exit
  ```

  If this fails, fix it before going further (auth issue, CLI not installed, etc).

- [ ] **`src/lib/agent-runner-stub.ts`** — a server-only module that:

  ```ts
  import { spawn } from 'node:child_process';

  export type AgentEvent =
    | { type: 'token'; content: string }
    | { type: 'done'; cost?: number; tokens?: number }
    | { type: 'error'; message: string };

  export async function* runClaudeCodeStub(
    prompt: string,
    workingDir: string,
  ): AsyncIterable<AgentEvent> {
    const proc = spawn('claude', [
      '--print',
      '--output-format', 'stream-json',
      '--add-dir', workingDir,
    ], { stdio: ['pipe', 'pipe', 'pipe'] });

    proc.stdin.write(prompt);
    proc.stdin.end();

    const decoder = new TextDecoder();
    for await (const chunk of proc.stdout) {
      const text = decoder.decode(chunk);
      for (const line of text.split('\n').filter(Boolean)) {
        try {
          const event = JSON.parse(line);
          if (event.type === 'content_block_delta') {
            yield { type: 'token', content: event.delta?.text ?? '' };
          }
        } catch {
          // not JSON, treat as raw token
          yield { type: 'token', content: line };
        }
      }
    }

    yield { type: 'done' };
  }
  ```

  > **Note:** This is intentionally a stub. Week 2 replaces it with the real Claude Agent SDK (`@anthropic-ai/claude-agent-sdk`) which handles tool use, multi-turn, and permission gates natively. We're using the CLI for day 4 to prove the wire is hot before adopting the SDK.

- [ ] **SSE endpoint** at `src/app/api/sessions/[id]/stream/route.ts`
  ```ts
  import { runClaudeCodeStub } from '@/lib/agent-runner-stub';

  export const runtime = 'nodejs'; // child_process needs Node runtime

  export async function GET(req: Request, { params }: { params: { id: string } }) {
    const session = await db.query.sessions.findFirst({ where: eq(sessions.id, params.id) });
    if (!session) return new Response('Not found', { status: 404 });

    const lastUserMessage = await db.query.messages.findFirst({
      where: and(eq(messages.session_id, session.id), eq(messages.role, 'user')),
      orderBy: (m, { desc }) => [desc(m.created_at)],
    });
    if (!lastUserMessage) return new Response('No prompt', { status: 400 });

    const project = await db.query.projects.findFirst({ where: eq(projects.id, session.project_id) });

    const stream = new ReadableStream({
      async start(controller) {
        const enc = new TextEncoder();
        let fullText = '';
        try {
          for await (const event of runClaudeCodeStub(lastUserMessage.content, project!.repo_path)) {
            if (event.type === 'token') fullText += event.content;
            controller.enqueue(enc.encode(`data: ${JSON.stringify(event)}\n\n`));
          }
          // Persist the agent message at end
          await db.insert(messages).values({
            id: crypto.randomUUID(),
            session_id: session.id,
            agent_id: 'sage',
            role: 'agent',
            content: fullText,
            created_at: new Date(),
          });
        } catch (err: any) {
          controller.enqueue(enc.encode(`data: ${JSON.stringify({ type: 'error', message: err.message })}\n\n`));
        } finally {
          controller.close();
        }
      },
    });

    return new Response(stream, {
      headers: {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache, no-transform',
        'Connection': 'keep-alive',
      },
    });
  }
  ```

- [ ] **Wire up the chat pane to consume the SSE stream**

  Make the chat pane a client component (`'use client'`). On submit:
  1. POST the message (from day 3)
  2. Open an `EventSource('/api/sessions/' + sessionId + '/stream')`
  3. Append tokens to a "currently streaming" message bubble
  4. On `done` event, close the EventSource and re-fetch messages

  Add a "Sage is thinking..." indicator while the stream is open.

- [ ] **Run + verify**
  ```bash
  pnpm dev
  # Log in. Type "list the files in src/components".
  # Watch tokens stream into the chat pane.
  # When done, the message is persisted in SQLite (check via sqlite3 CLI).
  ```

- [ ] **Commit**
  ```bash
  git add . && git commit -m "feat(agent): spawn Claude Code via subprocess, stream output via SSE"
  ```

### Day 4 success criteria

You type "list files in src/components" and Sage's response streams token-by-token into the chat pane. The full text persists in `messages` after the stream ends. **This is the walking skeleton's heart — if this works, the rest of v1 is mostly addition, not invention.**

### Day 4 gotchas

- Next.js streaming responses can be flaky in Edge runtime. Force Node runtime via `export const runtime = 'nodejs'`.
- The `claude` CLI's `--output-format stream-json` format may differ slightly from the spec above; adjust the parser if needed
- `EventSource` doesn't support custom headers — auth cookie must be on the same origin and auto-sent (it will be since you're hitting `/api/...` on `127.0.0.1`)
- On Windows, `spawn('claude', ...)` may need `shell: true` if PATH resolution is finicky

---

## Day 5 — Polish, decision review, week 2 prep

**Goal:** Tighten loose ends. Decide on the open questions from the spec. Create the remote GitHub repo. Push everything. Get the week 1 demo recorded so future-you can prove this milestone hit.

### Tasks

- [ ] **Pin Node and pnpm versions** in `package.json`
  ```json
  "engines": { "node": ">=22", "pnpm": ">=9" },
  "packageManager": "pnpm@9.x.x"
  ```

- [ ] **Add `.nvmrc`** with `22`

- [ ] **Refactor any throwaway code from days 1-4** that should obviously be a function or component. Don't refactor everything — just the things that already hurt.

- [ ] **Smoke test the full loop 3 times in a row** — different prompts, watch for race conditions
  - "what files are in src/components?"
  - "summarize the README"
  - "what does WhatIBuild.astro do?"

- [ ] **Health check endpoint** at `src/app/api/health/route.ts` returning `{ status: 'ok', db: 'ok', timestamp: ... }`. Will be used by Uptime Robot in week 5.

- [ ] **Decide the open questions from the v1 spec** and record decisions:
  - Repo visibility: **private** until v0.1 ✓ (this week's push)
  - License: **MIT** on first public release
  - Domain: `mc-dev.axodcreative.pages.dev` until issue #16 on AXOD CREATIVE ships, then `mc.axodcreative.com`
  - VPS provider: **Hetzner** (already provisioned in pre-week)
  - AI Gateway: **direct Anthropic API** for v1
  - CI: **GitHub Actions** with lint + typecheck on every PR

  Write a brief ADR for each decision in `docs/decisions/` if it took longer than 5 min to decide.

- [ ] **Create the GitHub remote + push**
  ```bash
  gh repo create adrew0321/axod-mission-control --private --source . --remote origin --description "Personal command center for orchestrating AI agent teams" --push
  ```

- [ ] **Update README** if anything changed during the week (it usually does)

- [ ] **Record a 60-second screen capture** showing: log in → type prompt → watch stream → message persists. Save it as `docs/demos/week-1.mp4` (gitignored if large; otherwise push it as proof).

- [ ] **Plan week 2** — read the [v1 spec § Architecture](../specs/v1-mvp-spec.md) section once more, then write `docs/plans/week-2-single-agent-sdk.md` with the same day-by-day structure. Specifically figure out:
  - Which exact `@anthropic-ai/claude-agent-sdk` version to pin
  - Where the agent process actually runs (in the Next.js node, or as a sidecar service?)
  - How approval gates intercept tool calls — Claude Agent SDK should expose hooks; verify in their docs

### Day 5 success criteria

- The code on `main` of `adrew0321/axod-mission-control` matches what's running locally
- A teammate (or future-you) can clone the repo, run `pnpm install && pnpm db:migrate && pnpm seed && pnpm seed:admin && pnpm dev` and see the same walking skeleton
- All Week 1 success criteria from each day still pass
- You know what Week 2 day 1 looks like

---

## What you've built by Friday evening

A bare-bones Next.js app with:
- 3-pane UI shell (team / chat / workspace) themed in AXOD's palette
- Single-user auth (scrypt + cookie)
- SQLite + Drizzle with 9 tables and seed data
- A POST endpoint to send a message (persists)
- An SSE endpoint that spawns `claude` CLI and streams its response back token-by-token
- The chat pane consumes the stream and renders in real-time
- Sage and Atlas exist as data in the agent table (their behavior comes in week 2-3)
- Pushed to GitHub as a private repo

What you have NOT built yet (week 2+):
- Real Claude Agent SDK integration with tool use
- Approval gates
- Git worktrees
- Sage as a real orchestrator (currently the subprocess just IS Sage with no team)
- Atlas as a separate agent
- Workspace tabs beyond a placeholder
- VPS deploy

## If you slip

The five-day plan assumes one focused workday per day. If life intervenes:
- **Slip day 1 (UI shell)?** That's the cheapest thing to delay — move it to evenings, start day 2 in parallel.
- **Slip day 2 (DB)?** Skip the seed script; hand-insert rows via sqlite3 CLI to keep going.
- **Slip day 3 (auth)?** Stub auth: hardcode a session in middleware until week 2. Don't ship to VPS without real auth, but local dev is fine.
- **Slip day 4 (SSE)?** This is the critical path. **Don't slip this.** Cut anything else first.
- **Slip day 5 (polish)?** Push without the demo video. Decision documents can be drafts.

## After week 1

Open the v1 spec. Start [week 2 plan](week-2-single-agent-sdk.md) (write it on day 5 if not already done). The pattern repeats: pick one slice of the architecture, build it, demo it, commit, push.