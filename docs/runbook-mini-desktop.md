# Runbook — Ubuntu desktop on the Mini (slice 0)

**Target:** `Macmini6,2` at 10.0.0.219, Ubuntu 24.04.4 LTS
**Spec:** `docs/superpowers/specs/2026-08-13-akiras-room-design.md`

> ## ✅ EXECUTED 2026-08-14 — remotely over SSH, successfully
>
> Run start to finish over SSH (not at the console, as originally written) with temporary
> passwordless root, granted via a `/etc/sudoers.d/` drop-in and revoked afterward. Prod never
> dropped. Final state: `ubuntu-desktop` (full, not minimal), GDM live on HDMI-A-3, `enp1s0f0`
> still `unmanaged` by NetworkManager after reboot, all sleep targets masked, zero failed units,
> `bridge.axodcreative.com/api/health` answering 1.19.0.
>
> **What made a remote run safe** — and what this document originally got wrong:
> 1. **Write NetworkManager's `unmanaged-devices` config BEFORE installing the desktop.** The
>    original text had this as a *recovery* step for after NM claims the interface. Remotely that is
>    too late — by then you have no SSH. As prevention it worked perfectly: NM installed and never
>    touched `enp1s0f0`.
> 2. **Arm a dead-man timer** during the risky window (`systemd-run --on-active=45min`) that restores
>    networking if you go silent. Make its action network-restore only — masking NM mid-install would
>    break `dpkg`.
> 3. **Run `apt` detached** via `systemd-run`, not in the SSH session. A dropped connection mid-install
>    leaves `dpkg` half-configured, which is far worse than a network blip.
>
> Neither the monitor nor the keyboard was needed. Both should still be attached before you begin.

## Why this was originally written as a console procedure

Slice 0 writes no code. It also carries the one failure mode in this whole project that takes
`bridge.axodcreative.com` offline: `ubuntu-desktop` pulls in NetworkManager, which can claim
`enp1s0f0` away from `systemd-networkd` and strand a headless box.

**Before you start:** have a monitor (HDMI or Thunderbolt) and a USB keyboard attached, and be able to
reach the machine physically. With the three mitigations above the console was never needed — but it
is the only recovery path if they fail.

## Preconditions

```bash
# From the laptop — confirm the box is where you think it is
ssh akeem@10.0.0.219 'systemctl is-active mission-control cloudflared; free -h | head -2; df -h / | tail -1'
```

Expect `active` twice, ~14 GiB available, ~79 GB free on `/`.

---

## Step 1 — Read the netplan config (the thing that can bite)

```bash
sudo cat /etc/netplan/90-ethernet.yaml /etc/netplan/99-iphone.yaml
```

Look at the `renderer:` line in each file.

- **`renderer: networkd`** — good. NetworkManager will leave these interfaces alone. Continue.
- **No `renderer:` line at all** — this is the risky case. The default renderer is `networkd` *today*,
  but once NetworkManager is installed the desktop's own netplan drop-in can change which renderer wins
  for unclaimed interfaces. Pin it explicitly before installing anything:

```bash
sudo sed -i '/^network:/a\  renderer: networkd' /etc/netplan/90-ethernet.yaml
sudo netplan generate && sudo netplan apply
ip -br addr show enp1s0f0   # must still show 10.0.0.219/24
```

- **`renderer: NetworkManager`** — stop and reassess; the current config does not match what this
  runbook assumes.

## Step 2 — Snapshot the network state so you can compare afterward

```bash
ip -br addr > ~/net-before.txt
ip route >> ~/net-before.txt
systemctl is-enabled systemd-networkd >> ~/net-before.txt
cat ~/net-before.txt
```

## Step 3 — Mask the sleep targets *before* the desktop exists

Do this first. GNOME ships with suspend-on-idle enabled, and a suspended Mini is a dead
`bridge.axodcreative.com`. Masking the targets is belt-and-braces with the `gsettings` change in
step 6 — the mask survives a GNOME settings reset, which is the point.

```bash
sudo systemctl mask sleep.target suspend.target hibernate.target hybrid-sleep.target
systemctl is-enabled sleep.target suspend.target hibernate.target hybrid-sleep.target
```

Expected output: `masked` four times.

## Step 3b — Activate the graceful-shutdown work while you have sudo

Unrelated to the desktop, but this is the right moment: v1.19.0 shipped SIGTERM teardown and it had
never actually run. The unit calls `next start` directly rather than through `pnpm start`, so the
`cross-env NEXT_MANUAL_SIG_HANDLE=true` in `package.json` never reaches the process — Next.js installs
its own SIGTERM handler, which calls `process.exit(143)`, and the app's teardown never fires.

> ⚠️ **Corrected 2026-08-14.** This section originally claimed every restart "eats the full 30s
> `TimeoutStopSec`." That is wrong. Measured on the live box, the broken restart took **0 seconds** —
> Next's handler exits *immediately*. The symptom was never slowness; it was that teardown never ran
> at all: turns undrained, `sessions.running_since` leases unreleased, the Discord gateway socket
> never closed. Do not use restart duration as your test.

Use a drop-in rather than editing the unit — it survives unit changes and is trivially removable:

```bash
sudo mkdir -p /etc/systemd/system/mission-control.service.d
printf '[Service]\nEnvironment=NEXT_MANUAL_SIG_HANDLE=true\n' \
  | sudo tee /etc/systemd/system/mission-control.service.d/10-sighandle.conf
sudo systemctl daemon-reload
systemctl show mission-control -p Environment --value   # must print NEXT_MANUAL_SIG_HANDLE=true
```

**The correct test is the log, not the clock.** Restart twice — the first restart kills the old
process (which predates the variable), the second exercises the fix:

```bash
sudo systemctl restart mission-control && sleep 3 && sudo systemctl restart mission-control
journalctl -u mission-control -n 40 --no-pager | grep -i shutdown
```

Broken looks like `[shutdown] SIGTERM received` and then nothing. Working looks like the full
sequence — `turns aborted=0 drained=true`, five disposers `ok=true`, `[shutdown] complete in 98ms`.

## Step 4 — Install the desktop

**First, pre-empt NetworkManager — before it is installed.** This is the single most important step in
the document. NM reads this file on first start and never touches the interface:

```bash
sudo mkdir -p /etc/NetworkManager/conf.d
printf '[keyfile]\nunmanaged-devices=interface-name:enp1s0f0;interface-name:enx8688e1b4ca44\n' \
  | sudo tee /etc/NetworkManager/conf.d/10-unmanaged.conf
```

**Then arm a dead-man switch** for the risky window. Network-restore only — masking NM here would
break `dpkg` mid-install:

```bash
sudo systemd-run --on-active=45min --unit=deadman --collect \
  /bin/bash -c 'netplan apply; systemctl restart systemd-networkd; systemctl restart ssh'
```

**Then install, detached.** `systemd-run` decouples `apt` from the SSH session so a dropped connection
cannot leave `dpkg` half-configured:

```bash
sudo systemd-run --collect --unit=desktop-install \
  --setenv=DEBIAN_FRONTEND=noninteractive --setenv=NEEDRESTART_MODE=a \
  /bin/bash -c 'apt-get update -qq && apt-get install -y \
    -o Dpkg::Options::=--force-confdef -o Dpkg::Options::=--force-confold ubuntu-desktop'

# watch it
until ! systemctl is-active --quiet desktop-install; do sleep 5; done
systemctl show desktop-install -p ExecMainStatus --value   # 0 = success
```

`ubuntu-desktop` (full) was chosen over `ubuntu-desktop-minimal` — the operator daily-drives this box
and wants LibreOffice present. Cost was ~5 GB and about 18 minutes wall-clock on the 2012 Mini
(4m40s CPU, 3.6 GB peak memory). It pulls in NetworkManager and `gdm3` — expected.

**Do not reboot yet.**

## Step 5 — Verify networking survived the install

```bash
ip -br addr show enp1s0f0          # still 10.0.0.219/24?
nmcli device status 2>/dev/null    # enp1s0f0 should read "unmanaged"
systemctl is-active mission-control cloudflared
```

If `enp1s0f0` shows as *managed* by NetworkManager, tell it not to be, then re-check:

```bash
printf '[keyfile]\nunmanaged-devices=interface-name:enp1s0f0\n' | sudo tee /etc/NetworkManager/conf.d/10-unmanaged.conf
sudo systemctl restart NetworkManager
nmcli device status
```

`diff <(ip -br addr) ~/net-before.txt` should show nothing meaningful.

## Step 6 — Turn off desktop power management

> ⚠️ **Corrected 2026-08-14.** The `sudo -u gdm dbus-launch gsettings …` form given here originally
> does **not** work on this box — `dbus-launch` is not installed (it lives in `dbus-x11`). This is
> harmless and was skipped: `sleep.target` is masked at the systemd level in step 3, so GNOME cannot
> suspend the machine regardless of what its own settings say. The mask is the real control; these
> `gsettings` are cosmetic. Install `dbus-x11` first only if you want the login screen's own settings
> to agree.

Set these for your own user after first login (the `gdm` settings only cover the login screen):

```bash
gsettings set org.gnome.settings-daemon.plugins.power sleep-inactive-ac-type 'nothing'
gsettings set org.gnome.desktop.session idle-delay 0
```

## Step 7 — Reboot, at the console

```bash
sudo reboot
```

Watch the physical screen. You want a GDM login prompt. Then, from the laptop:

```bash
ssh akeem@10.0.0.219 'systemctl is-active mission-control cloudflared'
curl -sSf https://bridge.axodcreative.com/api/health | head -5
```

Both services active, health endpoint answering. **Slice 0 is not done until that curl succeeds** —
the desktop is worthless if it cost you prod.

## Step 8 — Split the dev clone from the live app dir

This is the one step that is about the repo rather than the desktop, and it matters more now that you
will be sitting at this machine with an editor open.

`/srv/mission-control` **is the running application**. It is `mc`-owned and it is not a scratch space:
a `git checkout` there changes what production is serving. Give yourself a separate clone:

```bash
mkdir -p ~/code && cd ~/code
git clone https://github.com/adrew0321/axod-mission-control.git
cd axod-mission-control && git checkout dev
```

Rules for the rest of this machine's life:

- **Edit in `~/code/axod-mission-control`.** Never in `/srv/mission-control`.
- Deploys move code into `/srv` through the normal deploy path, not by editing in place.
- If you ever find yourself running `git` inside `/srv`, stop.

## Step 9 — Create the doorway

Slice 1 needs these to exist, and creating them now means the container work has somewhere to mount.

```bash
mkdir -p ~/AKIRA/inbox ~/AKIRA/playground
```

`inbox/` is where you drop things you want her to *notice and ask about*. `playground/` is where you
drop things she may act on unasked. The folder carries the permission.

---

## Rollback

If the desktop turns out to be a mistake:

```bash
sudo apt remove --purge -y ubuntu-desktop-minimal gdm3
sudo apt autoremove --purge -y
sudo systemctl set-default multi-user.target
sudo reboot
```

The sleep-target masks should **stay** masked regardless — they were never desktop-specific, and an
unmasked `suspend.target` on a production host was always a latent bug.

## Done when

- [ ] GDM login prompt on the physical screen
- [ ] `systemctl is-active mission-control cloudflared` → `active` twice
- [ ] `curl https://bridge.axodcreative.com/api/health` answers
- [ ] `systemctl is-enabled sleep.target` → `masked`
- [ ] `journalctl -u mission-control | grep shutdown` shows `[shutdown] complete in Nms` (step 3b)
- [ ] `nmcli device status` shows `enp1s0f0  ethernet  unmanaged` **after** the reboot
- [ ] `systemctl --failed` is empty
- [ ] the temporary `/etc/sudoers.d/` drop-in is removed, if you used one
- [ ] `~/code/axod-mission-control` exists on branch `dev`
- [ ] `~/AKIRA/inbox` and `~/AKIRA/playground` exist
