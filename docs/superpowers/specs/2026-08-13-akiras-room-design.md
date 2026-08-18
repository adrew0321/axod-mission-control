# AKIRA's Room — design

**Date:** 2026-08-13
**Status:** Spec, awaiting review.

## Problem

Two separate needs land on the same machine.

**The operator's:** the Windows laptop at `C:\Users\A'KeemDrew\AXOD\` is employer property, returnable
on short notice. Personal project work, the Claude Code environment, Playwright, the companion, and any
uncommitted work all live on hardware he does not own. The Mac Mini (`Macmini6,2`, 10.0.0.219) is the
only durable machine, and he intends to make it his personal daily driver.

**AKIRA's:** she can read and search but cannot act. Her live allowlist, read from
`/srv/mission-control/data/mission-control.db` on 2026-08-13, is:

```
AKIRA|["Read","Glob","Grep","WebFetch","WebSearch","TodoWrite"]
```

Plus MCP tools from `src/lib/akira/tools.ts` (`navigate`, `open`, `relay`, `listSessions`,
`getSession`, `remember`, `forget`) and the four browser tools in `src/lib/akira/browser-tools.ts`
that proxy to the laptop companion.

She has **no `Write`, no `Edit`, no `Bash`**. The motivating example — *"grab my resume, review it,
give me a new copy"* — fails at four of five steps:

| Step | Today | Why |
|---|---|---|
| Find the file | **Blocked** | Runs as `mc`; cannot read `/home/akeem` |
| Read a `.docx` | **Blocked** | `Read` returns zipped XML as binary noise |
| Review it | Works | Given text, this is just reasoning |
| Write the new copy | **Blocked** | No `Write` tool |
| Return it as a document | **Blocked** | No converter, no `Bash` |

## Current machine state (measured 2026-08-13)

| | |
|---|---|
| Model | `Macmini6,2` — Late 2012, quad-core i7 |
| OS | Ubuntu 24.04.4 LTS, kernel 6.8.0-137 |
| GPU | Intel HD 4000 → open-source `i915`; no proprietary driver needed |
| RAM | 15 GiB total, 870 MiB used, **14 GiB available** |
| Disk | 98 GB root, 79 GB free |
| Desktop | **None installed** — no X, no display manager |
| Default target | `graphical.target` (already set; no DE present to satisfy it) |
| Network | `systemd-networkd`, netplan `90-ethernet.yaml` + `99-iphone.yaml`, wired `enp1s0f0` |
| Prod | `mission-control.service` (`User=mc`, `WorkingDirectory=/srv/mission-control`), `cloudflared.service` |
| Sleep targets | `sleep.target`, `suspend.target` — loaded, **not masked** |

## Architecture — three zones

```
┌─ MAC MINI ──────────────────────────────────────────────────────┐
│                                                                 │
│  ZONE 1: PROD                    ZONE 2: OPERATOR               │
│  /srv/mission-control            /home/akeem                    │
│  user: mc · systemd              GNOME desktop                  │
│  cloudflared →                   personal files, browser        │
│  bridge.axodcreative.com         dev clone of the MC repo       │
│                                                                 │
│         │                              │                        │
│         │ command/result wire          │  ~/AKIRA/              │
│         │ (companion protocol,         │   ├── inbox/           │
│         │  token-authed)               │   └── playground/      │
│         │                              │        THE DOORWAY     │
│         ▼                              ▼                        │
│  ┌─ ZONE 3: AKIRA'S ROOM (LXD container) ──────────┐            │
│  │  workshop repo · scratch · installed tools      │            │
│  │  Chrome + Xvfb · gated shell · git              │            │
│  └─────────────────────────────────────────────────┘            │
└─────────────────────────────────────────────────────────────────┘
```

**Invariant:** prod is isolated from both other zones. A desktop-session crash cannot take down
`bridge.axodcreative.com`. The room cannot reach prod's database or the operator's home directory —
the doorway is the only path, and it is two folders inside a home the operator controls.

### The doorway

Two spaces, deliberately distinct:

- **`~/AKIRA/`** — lives in the operator's home, visible in Files, bind-mounted into the room. The only
  part of `/home/akeem` the room can see.
- **The room's own filesystem** — her workshop repo, scratch, installed tools, experiments. Inspectable
  on request, but not in the operator's home, so her mess never clutters his desktop.

If everything lived in the shared folder the isolation would buy nothing. The doorway stays small.

## Component design

### 1. Room transport — reuse the companion protocol *(slice 1)*

The room runs an agent that dials out to Mission Control exactly as `companion/src/index.ts` does from
the laptop: `Command` in, `Result` out, `guard.ts` gating irreversible actions, token auth.

The one real refactor: `sendCommand` in `src/lib/companion/registry.ts` assumes a single connected
companion. It gains a target discriminator:

```ts
type CompanionTarget = 'laptop' | 'room';
```

`src/lib/akira/browser-tools.ts` grows a corresponding "which machine" dimension. After this change,
both machines are instances of one mechanism, and the operator's *next* work laptop connects as another
`laptop` target with no new code.

`companion/src/protocol.ts` and `src/lib/companion/protocol.ts` are byte-identical copies today; the
`CommandAction` union extends to cover file and shell actions. Both copies must stay in sync.

### 2. Doorway watcher — watch → propose → act *(slice 2)*

A watcher in the room observes the two doorway folders:

- **`inbox/`** — a bounded first pass (filename, type, size, and a truncated head read — not a full
  agent turn), then raise a **proposal** through existing machinery (proposals table, proposal
  summaries in the UI, Discord embeds from the ~30s poller). The full-cost turn runs only after
  approval.
- **`playground/`** — she acts directly, ungated.

The folder carries the permission. No global mode to remember; the operator chooses per item by where
he drops it. Token cost stays bounded: noticing is cheap and constant, working is gated and rare.

### 3. Scoped write *(slice 1)*

`Write` is enabled for the room agent, restricted to the room filesystem and the doorway. Enforcement
is in the room agent's path validation, not in the prompt — a rejected path returns `status: 'blocked'`
through the existing `Result` type, the same shape `guard.ts` already produces.

### 4. Gated shell *(slice 2)*

`Bash` inside the container only. Irreversible or unexpected commands route through the same hard-gate
path the browser tools already use (`ctx.emit({ type: 'hard_gate', ... })` in `browser-tools.ts:31`),
surfacing in the HUD for approval. AKIRA must stop and wait rather than retry — the prompt language for
this already exists and should be reused verbatim.

### 5. Her own browser *(slice 3)*

Chrome + Xvfb in the room, driven by the same four browser actions. Distinct from the laptop browser in
kind, not just location: the laptop browser carries the operator's logged-in sessions (hence the hard
gate on `browser_click`); the room browser is a clean server-side browser with no personal identity.
This is what makes the 03:00 scheduler, Dreaming, and reflect passes able to browse at all — the laptop
is closed at those hours and the companion is offline by definition.

## Safety model

| Risk | Control |
|---|---|
| Shell does damage | Container is the blast radius; `lxc restore` from snapshot |
| Reaching personal files | Doorway is the only mount; rest of `/home/akeem` invisible |
| Reaching prod | No route from room to `/srv/mission-control` or its database |
| Her output unopenable | uid mapping on the bind mount so LibreOffice can open her files |
| Desktop takes down prod | Prod is a separate systemd service under a separate user |
| **Box sleeps, prod vanishes** | **Mask `sleep.target suspend.target hibernate.target hybrid-sleep.target`** — GNOME defaults to suspend-on-idle and would take `bridge.axodcreative.com` offline |
| Desktop install drops SSH | `ubuntu-desktop` pulls NetworkManager; verify netplan renderer stays `networkd` before reboot |

## Decisions

Taken as defaults on 2026-08-13; each is cheap to revisit.

1. **LXD** over Docker or systemd-nspawn. Snapshots are first-class, it behaves like a machine rather
   than a process — correct for a long-lived workspace — and uid mapping is well-trodden.
2. **Unrestricted network egress** from the room initially. She needs it for `pandoc` and browsing.
   ~~Allowlisting is the obvious hardening step if it ever proves necessary.~~ **Superseded by
   Decision 4 (2026-08-15):** allowlisting was examined and rejected — it would delete slice 3's whole
   purpose, and it does not hold once a shell and a browser share a container. The hardening went into
   emptying the room instead.
3. **Slice 0 is done at the machine**, monitor and keyboard attached — not blind over SSH. It is the
   one step with a real chance of dropping the network on a headless box.

## Slice 2 — decisions (2026-08-15)

Taken before writing the slice 2 plan. Measured first: the room today reaches `github.com` and
`pypi.org` directly (HTTP 200 from inside the container), while `/srv` is empty and `/home` holds only
`akira` and `ubuntu`. Egress is wide open; the isolation invariant holds.

4. **Egress stays open — Decision 2 is reaffirmed, with its reasoning made explicit.** Closing it was
   considered and rejected. Slice 3 puts Chrome *in the room* precisely so she can browse at 03:00 when
   the laptop is closed and the companion is offline by definition; default-deny egress would delete
   that capability outright. Nor would a wall hold: once a shell and a browser are co-resident, any
   route the browser can take the shell can take too. Per-uid netfilter rules could separate them, but
   that is machinery well beyond this slice, and everything cheaper — parsing command strings, proxy
   environment variables — only *looks* like control, which is worse than none because it invites
   trust it cannot earn.

   **The control therefore moves from "can she reach the network" to "is there anything here worth
   sending."** The realistic threat is not an adversarial AKIRA; it is prompt injection carried in
   something she reads — a web page, or a file dropped in `inbox/` — and accidents. Both are answered
   by an empty room plus an audit trail, not by a firewall.

5. **Per-target companion tokens land BEFORE `Bash` does.** Previously carried as slice 2
   prerequisite #2 and treated as hardening; Decision 4 promotes it to a blocker. Slice 1 requires
   `ROOM_TOKEN === COMPANION_TOKEN`, so the room holds the shared secret that authenticates the
   *laptop* — the machine carrying the operator's logged-in browser sessions. Without a shell that
   secret is unreachable; with one it is a file she can read. The room must hold a credential that is
   useless anywhere but the room.

6. **The workshop remote is a bare repo on the Mini, not a public host.** Resolves the open question
   "private remote, or is a snapshot sufficient?" — a local bare repo (e.g. `/srv/akira-workshop.git`,
   outside the container, reachable over the bridge) delivers what the remote was for: her work
   survives a container rebuild and its history is inspectable. It adds no public push channel, so the
   durability story does not quietly become an exfiltration story. Mirroring it offsite stays an
   operator action, out of band.

   Consequently **commits and pushes are both ungated**: a push now travels to a repo on the same box
   the room already talks to, and gating it would spend the operator's attention on a non-event.

7. **`Bash` hard-gates exactly one thing: long-running or unbounded processes.** The Mini also hosts
   prod, so a runaway process is the one thing in the room that can reach out and hurt something the
   operator cares about. Everything else runs free — the room is hers to break, and `lxc restore`
   makes breaking it cheap. Gating by "irreversible-looking command" is explicitly rejected for the
   reasons in Decision 4.

   **Doorway writes are deliberately NOT gated**, in `Bash` or anywhere else. An earlier draft gated
   them and was wrong: slice 1 already ships ungated `fs_write` to the doorway — it is how she replies
   to the operator, and the shipped verification step is literally "write `reply.txt` in the inbox."
   Gating the same action in one tool and not the other would buy nothing (she would reach for
   `fs_write` without even trying to evade) while making the model incoherent. **The folder carries the
   permission**, and that rule survives the arrival of a shell intact.

8. **Every shell command is logged where the operator can read it.** Detection is the primary control
   under Decision 4, so the log is load-bearing rather than diagnostic.

9. **Workshop output is reviewed through the existing proposal surface** — proposals table, proposal
   summaries in the UI, Discord embeds from the ~30s poller. Resolves the open question. For non-code
   artifacts the proposal carries a short text summary and a path; opening it is an ordinary file read.
   No rendered preview and no new review surface in slice 2.

## Slices

| Slice | Builds | Unblocks |
|---|---|---|
| **0** | Desktop install; sleep targets masked; netplan renderer verified; dev clone split from `/srv` | Operator's daily driver; prerequisite for the rest |
| **1** | Room container; doorway + bind mount + uid mapping; room agent on the companion protocol; `registry.ts` target refactor; scoped `Write` | Workshop. Resume minus conversion. |
| **2** | Gated `Bash`; doorway watcher; proposal emission | Resume complete, end to end |
| **3** | Chrome + Xvfb in the room; browser tools targeting `room` | Library; browsing at 03:00 |

Slice 0 is ops with no code and no release. Slices 1–3 each end in a release and a deploy.

**Plan boundary:** the implementation plan drawn from this spec covers **slice 0 and slice 1 only**.
Slices 2 and 3 depend on decisions that are cheaper to make once the room exists and has been lived in
— in particular, how the proposal surface handles non-code artifacts, and whether the room browser
duplicates enough of `WebFetch` to be worth building at all. Each gets its own plan later.

## Testing

Following `pnpm test` convention — `node:test` via `tsx`, extensionless imports:

- **Pure and unit-testable:** doorway path validation (in-room vs. escape attempts), `inbox`
  vs. `playground` routing, proposal payload shaping, target resolution in `registry.ts`. These
  mirror the existing `registry.test.ts` / `stream-lifecycle.test.ts` / `writeback.test.ts` pattern.
- **Not unit-testable, verify on the Mini:** container lifecycle, bind-mount uid behavior, Chrome under
  Xvfb, and the full drop-file→proposal→approve→result loop.
- **Regression watch:** `registry.ts` gaining a target must not break the existing single-laptop path.
  `registry.test.ts` covers this today and should be extended rather than replaced.

## Open questions

- ~~Does the room agent reconnect cleanly across container restarts, or does it need the displacement
  handling that `stream-lifecycle.ts` added for the laptop companion?~~ **Answered by slice 1's build —
  it needs it, and the mechanism is now known.** See "Carried into slice 2" below.
- ~~Should the workshop repo have a git remote (private, like `akira-memory`) so her work survives a
  container rebuild, or is a snapshot sufficient?~~ **Resolved 2026-08-15 — Decision 6.** A remote,
  but a bare repo on the Mini rather than a public host.
- ~~How does the operator review her workshop output — the existing proposal/diff surface, or something
  new?~~ **Resolved 2026-08-15 — Decision 9.** Reuse the proposal surface; non-code artifacts carry a
  summary and a path rather than a rendered preview.

## Carried into slice 2

Three prerequisites surfaced during slice 1's implementation and review. Each was deliberately deferred
because nothing in slice 1 can reach it — AKIRA has exactly `fs_list`/`fs_read`/`fs_write` and no shell.
**Slice 2 lands gated `Bash`, which is precisely what makes all three reachable**, so they are that
slice's entry cost, not optional hardening.

1. **Resolve symlinks before acting on a path.** `room-agent/src/paths.ts` is pure path math and
   cannot see a symlink planted inside the room or doorway that points outside them. Today no protocol
   action can create one. Once `Bash` exists, `execFs` must resolve links — `fs.realpath` on the parent,
   or `O_NOFOLLOW` — before it reads or writes. Note the load-bearing control remains the LXD mount
   namespace (prod and `/home/akeem` are simply not in the container); the path gate is defence in depth
   *inside* the room, and should be described that way rather than as the boundary itself.

2. **Give the room its own token.** *(Promoted to a blocker by Decision 5 — this lands before `Bash`,
   not alongside it.)* `verifyCompanionToken` checks one shared secret, so slice 1 requires
   `ROOM_TOKEN === COMPANION_TOKEN` and the two zones authenticate as the same principal. A compromised
   room could therefore connect as `?target=laptop`, displace the operator's real companion (the registry
   closes the displaced sink), and receive browser commands intended for the machine that holds his
   logged-in sessions. Unreachable by AKIRA in slice 1 — she has no shell and no path to the token — but
   a shell changes that. Fix: a per-target secret, checked against the target the connection claims.

3. ~~**Guard the unregister closure's rejection loop.**~~ **FIXED 2026-08-15 (`aa4f400`), ahead of the
   slice.** In `src/lib/companion/registry.ts` the closure
   returned by `registerCompanion` guards sink *deletion* on `sinks.get(target) === s`, but the loop that
   rejects that target's in-flight commands has no such guard. A displaced stream's late teardown
   therefore rejects the *current* connection's in-flight command with "companion disconnected". This is
   the reconnect question above, with a concrete mechanism: the room reconnects on a 3s backoff loop, so
   it will hit this far more often than the single laptop ever did. One line —
   `if (sinks.get(target) !== s) return;` at the top of the closure.

## Prior art in this repo

Reused rather than rebuilt: `companion/src/protocol.ts` (wire types), `companion/src/guard.ts` (hard
gate), `src/lib/companion/registry.ts` (connection registry), `src/lib/companion/stream-lifecycle.ts`
(cleanup discipline), the proposals table and Discord poller (approval surface), and the vault
`remember`/`forget` tools (durable notes).
