### Task 16: Deploy slice 2 to the Mini

Ops. No unit tests — the verification steps are the test. Do not start any of this until every task above is merged to `dev`, `pnpm test` is green, `pnpm exec tsc --noEmit` is clean, and `pnpm build` exits 0.

Use the `ship-mc-feature` skill for the release itself. Target version **v1.22.0**.

**Files:**
- Modify: `deploy/room/provision.sh` (workshop remote)
- Modify: `docs/runbook-mini-desktop.md`

**Interfaces:**
- Consumes: everything above.
- Produces: a live room with a shell, a watcher, and its own credential.

- [ ] **Step 1: Add the workshop bare remote to the provisioner**

Decision 6: her work survives a container rebuild via a bare repo on the Mini, not a public host. Append to `deploy/room/provision.sh`, before the final `echo`:

```bash
# Decision 6: the workshop's remote is a bare repo on the Mini — outside the
# container, reachable over the bridge. Durability without a public push channel.
WORKSHOP_REMOTE="$HOME/akira-workshop.git"
if [ ! -d "$WORKSHOP_REMOTE" ]; then
  git init --bare "$WORKSHOP_REMOTE"
  echo "created workshop remote at $WORKSHOP_REMOTE"
fi

lxc config device remove "$CONTAINER" workshop-remote 2>/dev/null || true
lxc config device add "$CONTAINER" workshop-remote disk source="$WORKSHOP_REMOTE" path=/mnt/workshop-remote

lxc exec "$CONTAINER" -- sudo -u akira bash -lc '
  cd /home/akira/workshop
  git rev-parse --git-dir >/dev/null 2>&1 || git init
  git remote get-url origin >/dev/null 2>&1 || git remote add origin /mnt/workshop-remote
  git config user.email "akira@axodcreative.com"
  git config user.name "AKIRA"
'
```

- [ ] **Step 2: Cut the release**

Follow `ship-mc-feature`: merge `dev` → `main`, bump to `1.22.0`, tag `v1.22.0`, push.

- [ ] **Step 3: Deploy Mission Control to the Mini**

```bash
ssh akeem@10.0.0.219
sudo -n -u mc git -C /srv/mission-control pull
sudo -n -u mc pnpm -C /srv/mission-control db:migrate    # migration 0014: room_proposals
sudo -n -u mc pnpm -C /srv/mission-control build
```

**No `pnpm install`.** This release changes no dependency — `package.json` and `pnpm-lock.yaml` are untouched across the whole branch — and on the Mini `pnpm install` aborts wanting to purge `node_modules`, which would wipe the hand-compiled `better-sqlite3` binding. Only install when deps actually changed.

Set the new secret **before** restarting:

```bash
openssl rand -hex 32      # note this value; it is NOT the laptop's COMPANION_TOKEN
sudo -n -u mc tee -a /srv/mission-control/.env <<< "ROOM_COMPANION_TOKEN=<the value>"
sudo systemctl restart mission-control
```

Then reseed — the prompt changed in Task 15, and AKIRA's live prompt lives in the database:

```bash
sudo -n -u mc pnpm -C /srv/mission-control seed
```

- [ ] **Step 4: Verify prod came back**

```bash
curl -s localhost:3000/api/health          # expect 1.22.0
systemctl --failed                         # expect 0 failed units
```

`systemctl --failed` after every deploy is a standing rule in this repo, not a suggestion.

- [ ] **Step 5: Re-provision and update the room**

```bash
bash deploy/room/provision.sh                       # adds the workshop remote; idempotent
lxc file push -r room-agent/src akira-room/home/akira/room-agent/
```

`provision.sh` now reads `ROOM_COMPANION_TOKEN` from the live `.env`, refuses to run when it is unset or equal to `COMPANION_TOKEN`, and overwrites the container's `.env` with the single correct `ROOM_TOKEN` line — so there is nothing to hand-edit here. Step 3 must have set the secret first.

```bash
lxc exec akira-room -- systemctl restart akira-room
lxc exec akira-room -- journalctl -u akira-room -n 30 --no-pager
```

Expect `[room] connected to http://10.138.75.1:3000` and two `[room] watching …` lines. A repeating `stream 401` means the two token values do not match — or that you pasted `COMPANION_TOKEN` into both, which fails closed by design.

- [ ] **Step 6: Verify the token split actually holds**

From inside the container, try to connect as the laptop. This must fail:

```bash
lxc exec akira-room -- bash -lc 'TOK=$(grep -m1 ^ROOM_TOKEN= /home/akira/room-agent/.env | cut -d= -f2-); curl -s -o /dev/null -w "%{http_code}\n" "http://10.138.75.1:3000/api/companion/stream?token=$TOK&target=laptop"'
```

Expected: `401`. If it returns 200, Decision 5 is not in force — stop and fix it before going further.

- [ ] **Step 7: Verify the shell end to end**

From the front door at `bridge.axodcreative.com`, ask AKIRA to run something ordinary:

> "Run `uname -a && df -h /` in your room."

Expect output in her reply. Then confirm the log exists and is on the **Mission Control** side, not in the room:

```bash
sudo -n -u mc tail -5 /srv/mission-control/data/room-shell.log
```

Expect JSONL lines with `"event":"dispatch"` and `"event":"result"`.

- [ ] **Step 8: Verify the gate**

Ask her:

> "Start a dev server in your room on port 8080."

Expect: the HUD shows the gate card naming the command, and she stops rather than retrying. Click **Deny** and confirm she reports back that it wasn't approved. Then repeat and click **Approve**, and confirm the command runs.

- [ ] **Step 9: Verify the doorway loop**

On the Mini's desktop, drop a file into `~/AKIRA/inbox`. Within seconds:

- `journalctl` in the container shows `[room] drop inbox <name>`
- the Proposals section in the dashboard shows it under "AKIRA's inbox"
- a Discord embed appears in the `mission-control` channel within ~30s

Click **Have her work on it** and confirm a turn runs and a result appears in the doorway.

Then drop a file into `~/AKIRA/playground` and confirm a turn starts **without** any proposal.

- [ ] **Step 10: Snapshot the working room**

```bash
lxc snapshot akira-room clean-slice2
lxc info akira-room | grep -A5 Snapshots
```

- [ ] **Step 11: Record the outcome**

Append a `## Slice 2 — EXECUTED <date>` section to `docs/runbook-mini-desktop.md` with: the release version, the migration applied, the two-secret setup, the snapshot name, and anything that differed from these steps. Update the slice table in `docs/superpowers/specs/2026-08-13-akiras-room-design.md` to mark slice 2 shipped, and strike the two prerequisites this slice resolved under "Carried into slice 2".

```bash
git add docs/
git commit -m "docs(runbook): record the slice 2 deploy"
```

---

## Verification checklist

Before calling this slice done, all of these must be true with output you have actually seen:

- [ ] `pnpm test` passes, including the new `gates`, `shell-gate`, `shell-ops`, `paths-real`, `doorway`, `watcher`, `shell-log`, and `room-proposals` suites.
- [ ] `pnpm exec tsc --noEmit` exits 0.
- [ ] `pnpm build` exits 0.
- [ ] `pnpm lint` reports no new errors.
- [ ] A room credential presented at `?target=laptop` returns 401 **on the Mini** (Task 16 step 6).
- [ ] `systemctl --failed` shows 0 failed units after the deploy.
- [ ] A shell command runs from the front door and appears in `data/room-shell.log`.
- [ ] A gated command shows the HUD card, and both Deny and Approve behave correctly.
- [ ] An inbox drop produces a proposal in the UI **and** a Discord embed; approving it runs a turn.
- [ ] A playground drop runs a turn with no proposal.
- [ ] `lxc snapshot` `clean-slice2` exists.

## Deliberate scope boundaries

Stated so a reviewer does not read them as omissions:

- **Egress stays open.** No allowlist, no proxy, no network filtering (Decision 4).
- **`Bash` gates only long-running processes.** Not `rm`, not `git push`, not "irreversible-looking" commands (Decision 7).
- **Doorway writes are ungated everywhere**, in `shell` as in `fs_write` (Decision 7).
- **Room proposals have no rendered preview** — a summary and a path, opened as an ordinary file read (Decision 9).
- **Chrome and Xvfb are slice 3.** The room browser is not built here.
- **Approving a room proposal is a dashboard action.** The Discord embed announces; it carries no action row, because approval starts a full agent turn.
