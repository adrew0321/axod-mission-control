# AKIRA host reach — design

Sub-project C of the AKIRA agentic-OS program. Supersedes parts of
`2026-08-13-akiras-room-design.md`; see "What this reverses" below.

## Problem

AKIRA can do real work inside her container and nothing at all outside it. She
cannot read `/srv/mission-control`, so she cannot answer a question about her own
implementation without relaying it, cannot check whether a deploy failed, and
cannot read her own vault as files — which is why both skills shipped in
v1.23.0 (`vault-gardening`, `distil-research`) are inert: they are written
against `Read`/`Glob`/`Grep`, which she does not have.

The operator has decided, twice and unprompted, that AKIRA gets full
unrestricted access to the Mini as the host. This spec implements that decision.
It is not re-argued here.

## What this reverses

The room design's central invariant was:

> **Invariant:** prod is isolated from both other zones. […] The room cannot
> reach prod's database or the operator's home directory — the doorway is the
> only path.

That invariant is withdrawn. Three rows of its safety table go with it:

| Row | Status |
|---|---|
| "Reaching personal files → doorway is the only mount" | **Withdrawn.** `/home/akeem` is reachable. |
| "Reaching prod → no route from room to `/srv/mission-control`" | **Withdrawn.** Prod is reachable, including `.env` and the live SQLite DB. |
| "Shell does damage → container is the blast radius; `lxc restore`" | **Withdrawn for the host.** Still true of the container itself. |

What survives is Decision 8 and Decision 4 from the room design: **detection is
the primary control, and the log is load-bearing rather than diagnostic.** This
spec generalizes that from the room to every target.

## Decisions

Taken during brainstorming on 2026-08-22.

**D1 — Reach is total.** Prod's code, `.env`, and database; the operator's home
directory; systemd; the agent row holding her own prompt and `tools_allowlist`.
Asked explicitly whether the scope was narrower, the answer was "all of it,
that's what unrestricted means."

**D2 — Awareness, not veto.** No hard gate on any host action. Every consequential
action goes into a feed the operator can read. This was chosen over a veto gate
for two reasons, both structural: her unwatched turns (the 03:00 scheduler,
Dreaming, reflect, the doorway watcher) have no operator attached to answer a
gate — `AkiraToolContext.watched` is false for all of them — so a veto model
silently deletes her autonomous work; and once she can write the DB and `.env`,
she can edit any gate's configuration, so a gate implies a guarantee it cannot
make.

**D3 — The container stays; the tool surface merges.** `room_bash` and a host
shell would be two near-identical tools, and she would pick wrong. Instead one
tool per capability with a `target` parameter — the abstraction `registry.ts`
already uses for `laptop` vs `room`. No infrastructure is retired — the
container, the doorway, and the workshop repo all stay exactly as they are. The
`room_*` tool *names* do go away; see component 3.

**D4 — Host reach is a third companion target,** served by a new agent process,
not by in-process tools. Reinstating `Read`/`Glob`/`Grep`/`Bash` inside the MC
process (reverting `808e6f9`) was rejected: those execute in the server's own
event loop as `mc`, so a long-running command blocks the process she is thinking
inside, and "unrestricted" as `mc` requires a blanket NOPASSWD sudo grant —
a blunter thing to hand out than a root agent behind a real protocol. Escalating
the room to a privileged container was rejected as the worst of both: it is not a
container in any useful sense, and it fights `paths.ts` / `paths-real.ts`, code
shipped six days earlier.

**D5 — Self-affecting commands are fire-and-forget.** A command that restarts or
stops `mission-control` kills the turn issuing it. The host agent survives, the
turn does not. Such commands are classified, logged with intent *before*
dispatch, and dispatched without awaiting a result.

**D6 — Recovery is the backup chain and git, not a snapshot.** The host has no
`lxc restore`. This was put to the operator and did not change the decision.

**D7 — The Discord feed carries metadata, never command output.** Discord is a
third party. She can `cat .env`; posting stdout to Discord would exfiltrate
`SESSION_SECRET`, `CLAUDE_CODE_OAUTH_TOKEN`, `COMPANION_TOKEN`, and
`AKIRA_MEMORY_PIN` to an external service. The embed carries target, command,
cwd, exit code, and duration. Full output stays in the local log.

## Architecture

Three targets behind one registry:

```
┌─ MAC MINI ──────────────────────────────────────────────────────────┐
│                                                                     │
│  /srv/mission-control (user mc)          /home/akeem                │
│    Mission Control + AKIRA                 desktop, dev clone       │
│         │                                                           │
│         │  registry.ts — one sink per target                        │
│         ├──────────────┬────────────────────┬──────────────────┐    │
│         ▼              ▼                    ▼                  │    │
│    target: host   target: room        target: laptop           │    │
│    host-agent     room-agent          companion (off-box)      │    │
│    user: root     LXD container       operator's laptop        │    │
│    whole machine  workshop+doorway    his browser session      │    │
└─────────────────────────────────────────────────────────────────────┘
```

`host-agent` is a sibling of `room-agent`, not a fork of the whole thing: the
protocol, the reconnect/displacement handling, and the result-POST path are the
same wire. What differs is that it runs as root, has no path scoping, and
classifies self-affecting commands.

## Components

### 1. `CompanionTarget` gains `'host'`

`src/lib/companion/registry.ts`. One line in the union type; the sink map,
`isOnline`, `sendCommand`, and the per-target failure isolation in
`registerCompanion` already key off the target and need no change. `registry.test.ts`
extends rather than changes — the existing single-laptop path must keep passing.

### 2. `host-agent/` — a new service

A sibling package to `room-agent/`, same shape: `config.ts` (its own `HOST_TOKEN`,
checked against `HOST_COMPANION_TOKEN` on the MC side — deliberately not the room's
or the laptop's credential), `connection.ts` (reused wire), `shell-ops.ts`,
`fs-ops.ts`. Runs as a systemd unit as root, reaching MC at `127.0.0.1:3000`.

No path scoping. `paths.ts`/`paths-real.ts` have no analogue here; that is the
point of the sub-project.

**Provisioning is an operator step.** Root on the Mini is NOPASSWD-allowlisted for
`restart` and `daemon-reload` only, so unit installation cannot be automated from
here. The unit file ships in the repo; installing it is a runbook step.

### 3. Tool surface: one tool per capability, with `target`

`room_list` / `room_read` / `room_write` / `room_bash` become `list` / `read` /
`write` / `bash`, each taking `target: 'host' | 'room'`. Her prompt explains what
each target *is*, since the choice is now hers. `laptop` is NOT a valid target for
these four tools — the laptop companion exposes browser actions, not a filesystem
or a shell, and extending it is explicitly out of scope (see Open questions).

The old `room_*` names are removed rather than aliased. Keeping both is the
failure mode D3 exists to avoid, and the tool list is injected into every turn,
so dead aliases cost tokens on every request forever.

`vault_write` and `remember`/`forget` are unaffected. They remain the correct
way to write the vault even though host `write` could reach it: they maintain
the note model and the index that `memory/INDEX.md` depends on.

### 4. `shell-log.ts` generalizes to `action-log.ts`

Today's log already does the hard part — it is written **before** dispatch and it
lives on the MC side, because "a log inside the container is a log the shell can
rewrite." Both properties are now more important, not less.

Changes: the event gains `target`, and the log covers file writes as well as
shell commands. `ROOM_SHELL_LOG` becomes `AKIRA_ACTION_LOG` with the old name
honored as a fallback so an existing Mini deployment keeps writing where it did.

The honest limit, stated because D2 makes this the whole safety story: **this log
is not tamper-proof against her.** It lives on a host she can write. It defends
against a command that dies, hangs, or kills MC — not against deliberate
rewriting. Under D1 no log on this machine could.

### 5. The feed — three tiers, different guarantees

| Tier | Written | Survives a command that kills MC | Reaches him when away |
|---|---|---|---|
| Action log (file) | Synchronously, pre-dispatch | **Yes** | No |
| `agent_actions` (DB row) | Synchronously, pre-dispatch | Yes | No |
| Discord embed | By the 30s poller | **No** | Yes |

The Discord poller is the existing `discord-notify.ts` tick: it diffs DB state on
a cursor, like schedules, dreams, and proposals. A new `agent_actions` table is
the cursor source — a file is the wrong shape for that loop, and the DB row is
what makes the post replayable after a restart.

Consequence worth stating plainly: **the one action guaranteed not to reach
Discord is the one that kills Mission Control.** The file log is the reason that
is recoverable at all. This is inherent to running the notifier inside the process
being acted on, and is accepted rather than solved.

### 6. Self-affecting commands (D5)

A pure classifier — `isSelfAffecting(command)` — matches commands targeting the
`mission-control` unit or its process. On a match:

1. Log `event: 'intent'` with the command, before anything is sent.
2. Dispatch without awaiting the result.
3. Return to her a description of what was started, not an outcome — the turn is
   likely to end mid-flight and a fabricated "done" would be a lie.

Her prompt gets one line: restarting Mission Control ends the current turn, so say
what she is about to do before doing it.

The classifier is a heuristic and will miss creative phrasings (`kill -9` by pid,
a script that restarts the unit). That is acceptable: a miss degrades to the
ordinary case — the turn dies, and the pre-dispatch log entry still explains why.
The classifier improves the message, not the safety.

## What this unblocks

Sub-project B shipped two skills that cannot run: `vault-gardening` ("Glob the
zone", "Read the INDEX.md") and `distil-research` ("Read the raw capture", "Grep
the vault"). They were left deliberately un-reworded pending "a follow-up slice
of scoped vault-read tools."

**That follow-up is cancelled — this supersedes it.** Host `read` and `list`
reach the vault directly. No scoped vault-read tools need to be designed, and the
two skills start working with no edit to either.

## Testing

Following the repo convention — `node:test` via `tsx`, extensionless imports:

- **Pure / unit-testable:** target routing in `registry.ts` (including that an
  offline host fails only host commands); `isSelfAffecting` classification, both
  directions; action-log line formatting with `target`; the `AKIRA_ACTION_LOG` /
  `ROOM_SHELL_LOG` fallback; Discord embed shaping asserting **no stdout field**
  (D7 is a security property and gets a test that fails loudly if someone adds
  output to the embed later).
- **Not unit-testable, verify on the Mini:** the root agent connecting at all;
  reading `/srv/mission-control/.env`; a real `systemctl restart mission-control`
  issued by her and the turn dying as designed; the reconnect after it.
- **Regression watch:** removing `room_*` touches every existing room test. They
  should be migrated to the `target` form, not deleted.

## Slices

| Slice | Builds | Ends in |
|---|---|---|
| **C1** | `'host'` target; `host-agent` package + unit file; `action-log.ts`; tools take `target`; `room_*` migrated | Release + deploy. She can reach the host; the file log is the only feed. |
| **C2** | `agent_actions` table + migration; `discord-notify` contributor; embed shaping with the no-output test | Release + deploy. The feed reaches him when away. |
| **C3** | Prompt + skills: teach her the targets, the self-restart rule, and that her own vault is now readable | Release + deploy. Reseed mandatory. |

C1 is the only slice with a hard operator prerequisite (installing the root unit).
C2 adds the first DB migration in this program — the drizzle table-rebuild hazard
does not apply, since it is a pure `CREATE TABLE`.

## Open questions

- **Does the host agent need the doorway watcher's displacement handling?** The
  room needed it (slice 1's finding). The host agent's connection is
  loopback rather than bridged, so it may reconnect differently. Measure in C1
  rather than assume.
- **Should `bash` on target `laptop` exist at all?** The companion protocol could
  carry it, and the laptop is employer property — a place where "unrestricted"
  was never the decision. Left out of this spec deliberately; raise it separately.
- **Does the nightly backup chain cover enough of the host to be a recovery
  path?** It currently backs up `/srv/backups`. Under D6 this is the only
  recovery story, so it should be verified against reality before C1 deploys —
  not assumed.

## Prior art in this repo

- `src/lib/akira/shell-log.ts` — pre-dispatch logging, and why the log lives on
  the MC side. The model for `action-log.ts`.
- `src/lib/companion/registry.ts` — the target abstraction, displacement
  handling, per-target failure isolation.
- `room-agent/` — the service shape, the token model, and the redirect-looks-like-
  success bug documented in `connection.ts` (it has bitten that file three times).
- `src/lib/discord-notify.ts` — the cursor-diff poller every feed contributor uses.
