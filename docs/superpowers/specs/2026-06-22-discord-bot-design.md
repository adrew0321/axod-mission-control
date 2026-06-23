# Discord Bot — talk to your agent team from Discord (design)

**Date:** 2026-06-22
**Status:** Approved (brainstorm) — pending spec review
**Roadmap:** v1.8 ("Discord via OpenClaw gateway" — see note on naming below)

---

## Why (context)

The operator wants to **communicate with the Mission Control agent team from Discord** —
two-way chat, proactive notifications, and the ability to take actions (e.g. merge a
proposal) without opening the web UI.

"OpenClaw" appears throughout the docs only as a placeholder dependency for a future
multi-channel gateway; there is no such product/repo. Per the operator, the actual goal is
simply *"talk to my agents through Discord."* So this design **builds a direct Discord bot**
against Mission Control's existing internals — no separate gateway abstraction. The code is
structured so it could later be extracted into a standalone sidecar service if process
isolation ever becomes a concern, but that is explicitly out of scope for v1.

### What makes this feasible now

- **`runSessionTurn`** ([src/lib/run-turn.ts](../../../src/lib/run-turn.ts)) runs a full agent
  turn server-side, **sink-agnostic** (an `emit` callback) and **lease-guarded** on
  `sessions.running_since`. A non-browser caller can drive a turn with no client SSE
  connection. This is the enabler shipped in v1.7.0.
- Business logic is callable directly: `mergeWorktree(sessionId, repoPath, branch)`
  ([src/lib/worktree.ts](../../../src/lib/worktree.ts)) for the merge action, `getProposals()`
  for notifications, the `@mention` parser ([src/lib/mention.ts](../../../src/lib/mention.ts))
  for specialist addressing — all reused as in-process function calls.

## Decisions (from brainstorm)

| # | Decision | Choice |
|---|---|---|
| 1 | What is "OpenClaw" | Placeholder — build a **direct Discord bot**, no gateway layer |
| 2 | Scope (v1) | **Chat + notifications + actions** (built in that order) |
| 3 | Mapping | **One Discord channel per project**; messages run in that project's active session |
| 4 | Authorization | **Allowlist the operator's Discord user ID(s)** — the only ones the bot obeys |
| 5 | Architecture | **In-process gateway bot** (discord.js), started in `instrumentation.ts` |
| 6 | Ingress | Discord **Gateway** (outbound websocket) — no public inbound endpoint required |

### Why the in-process gateway bot

- The Gateway connection dials **out** (like `cloudflared`), so the bot is **not blocked on
  finishing the permanent deploy** and needs no inbound HTTPS endpoint or signature
  verification.
- Matches the existing in-process ticker pattern (`startScheduler` / `startDreaming` in
  [src/instrumentation.ts](../../../src/instrumentation.ts)).
- Reuses `runSessionTurn` and all business logic as direct calls — no internal HTTP API.
- HTTP-interactions-only (no gateway) was rejected: free-text chat requires reading channel
  messages, which requires the Gateway + Message Content intent. A separate sidecar process
  was rejected as more ops than a personal tool needs.

---

## Architecture

### File layout

```
src/lib/
  discord-bot.ts          # bot lifecycle: client connect, event wiring, startDiscordBot() (effectful)
  discord-sink.ts         # turn emit events → throttled Discord message edits (effectful; thin)
  discord-format.ts       # pure: reply chunking, notification embeds, action rows (unit-tested)
  discord-resolve.ts      # pure: allowlist check, channel→project, message→turn-input (unit-tested)
  discord-notify.ts       # subscribe to activity cursor → post embeds (effectful)
src/db/schema.ts          # + discord_bindings table
drizzle/0007_*.sql        # migration
src/instrumentation.ts    # + startDiscordBot() alongside startScheduler/startDreaming
.env.example              # + DISCORD_* vars
```

Pure modules (`discord-format`, `discord-resolve`) get `node:test` unit tests (run via tsx,
extensionless imports — see project testing convention). Effectful modules are proven by
runtime verification.

### Lifecycle

`startDiscordBot()` runs inside `register()` **only when `DISCORD_BOT_TOKEN` is set** — dev
machines without the token never start it. Idempotent via a `globalThis.__mcDiscordStarted`
guard (same pattern as `startDreaming`). The entire bot startup and every handler is wrapped
in try/catch: a Discord-side failure logs `[discord] …` and dies quietly without affecting the
web server or the Scheduler/Dreaming tickers. discord.js auto-reconnects the gateway socket;
`error`/`disconnect` events are logged.

### Data model

One new table:

```
discord_bindings:
  channel_id   text PK          -- Discord channel snowflake
  project_id   text FK→projects -- which project this channel drives
  created_at   integer (timestamp)
```

The channel→project map. Sessions are **not** stored here; the active session is resolved at
message time as the project's most-recently-updated session, creating one if none exists.
Notification dedupe uses an **in-memory** "last seen" cursor (YAGNI to persist across restarts
for v1; a restart may re-post at most the most recent items).

### Config / env

```
DISCORD_BOT_TOKEN        # bot token (presence gates startup)
DISCORD_APP_ID           # application id, for slash-command registration
DISCORD_ALLOWED_USER_IDS # comma-separated operator id(s) — the auth boundary
DISCORD_GUILD_ID         # optional; scopes slash commands to one guild (instant vs ~1h global)
```

---

## Flows

### Chat

1. `messageCreate` → ignore bots/self; **author id must be in `DISCORD_ALLOWED_USER_IDS`**
   (else silently ignore); look up `discord_bindings` for the channel — no binding → ignore.
2. Resolve the project's active session (most-recently-updated, or create). Persist the Discord
   message text as a `user` message, exactly like the web send path. `@Atlas`/`@Echo` parsing
   applies unchanged.
3. Call `runSessionTurn(sessionId, { emit: discordSink, instruction: text })`. The
   `running_since` lease means a concurrent web turn yields a clean "busy" reply rather than a
   collision.
4. **`discordSink`** posts a placeholder ("Sage is thinking…"), buffers `token` events, and
   **edits the message on a throttle** (~1.2s or ~1500 chars), rolling into a new message at
   Discord's 2000-char limit. Finalizes on `done`/`persisted`. After the turn it posts any
   **dispatched-specialist** messages (new agent rows created during the turn) so Atlas/Echo
   replies appear too.
5. `type:'error'` → placeholder becomes "⚠️ turn failed: …".

### Notifications

- `discord-notify` holds an in-memory cursor and polls (~10s, in-process) the same data the
  **Live Feed** view aggregates (dispatches · replies · approvals · artifacts · session
  lifecycle). On a new *interesting* event it posts an embed to that project's bound channel.
- **v1 triggers:** proposal ready to merge · scheduled task finished · new dream/insight.
- Proposal embeds carry action buttons (see below).

### Actions

- **Slash commands** (registered to `DISCORD_GUILD_ID` for instant availability):
  `/mc bind project:<name>`, `/mc unbind`, `/mc status`, `/mc new-session`.
- **Buttons on proposal notifications:** **Approve & Merge** / **Discard**. Handler re-checks
  the allowlist, then calls `mergeWorktree(...)` / discard logic directly and edits the embed
  with the result — including the `{ ok:false, conflict }` path → "merge conflict, resolve in
  MC".

---

## Authorization & safety

- Single allowlist gate enforced in **three** places: `messageCreate`, slash commands, and
  button interactions (buttons are clickable by anyone who can see them — re-check every time).
  Non-allowlisted: messages ignored silently; interactions get an ephemeral "not authorized".
- Minimal Discord intents/permissions: **Message Content** (privileged, free for a private
  bot) + read/send/embed/manage-messages in its channels. No admin.
- Actions call lib functions with the server's own privileges, so **the allowlist is the
  boundary** — consistent with MC's "the tool allowlist is the v1 safety model" stance.
- Outbound-only connection: no new inbound attack surface on the web server.

## Testing

- **Unit (node:test/tsx):** `discord-resolve` — allowlist parse/match, channel→project,
  message→turn-input (incl. `@mention` passthrough); `discord-format` — reply chunking at the
  2000-char boundary, embed/action-row construction, conflict-result rendering.
- **Runtime verification** (`verify` skill) against the operator's private test guild: send a
  message → streamed reply; trigger a proposal → notification + working **Approve & Merge**;
  confirm a non-allowlisted account is ignored.
- discord.js itself is not unit-tested; the effectful bot is proven at runtime.

## Build order

1. Bot skeleton + allowlist + `/mc bind` + **chat** (the 80% win).
2. **Notifications** (proposal / scheduled / dream embeds).
3. **Actions** (merge/discard buttons).

## Out of scope (v1)

Multi-user / role-based access · DM-based chat (channel-per-project only) · extracting the bot
into a standalone sidecar · persisting the notification cursor across restarts · voice ·
arbitrary "run any action" commands beyond bind/status/new-session/merge/discard.

## Operator setup (prerequisites)

1. Create a Discord application + bot in the Discord Developer Portal; copy the **bot token**
   and **application id**.
2. Enable the **Message Content** privileged intent on the bot.
3. Invite the bot to your private MC guild with read/send/embed/manage-messages permissions.
4. Put `DISCORD_BOT_TOKEN`, `DISCORD_APP_ID`, `DISCORD_ALLOWED_USER_IDS`, `DISCORD_GUILD_ID`
   in `.env`. Create one channel per project and `/mc bind` each.

## Naming note

The roadmap row reads "v1.8 — Discord via OpenClaw gateway." Since there is no OpenClaw
component, after this ships the README row should be retitled to **"v1.8 — Discord bot
(direct)"** to keep docs honest ([keep-docs-in-sync] convention).
