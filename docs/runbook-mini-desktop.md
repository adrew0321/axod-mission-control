# Runbook — Ubuntu desktop on the Mini (slice 0)

**Target:** `Macmini6,2` at 10.0.0.219, Ubuntu 24.04.4 LTS
**Spec:** `docs/superpowers/specs/2026-08-13-akiras-room-design.md`
**Who runs this:** the operator, **physically at the machine**, monitor and keyboard attached.

## Why this is a runbook and not a plan

Slice 0 writes no code. It also carries the one failure mode in this whole project that takes
`bridge.axodcreative.com` offline: `ubuntu-desktop` pulls in NetworkManager, which can claim
`enp1s0f0` away from `systemd-networkd` and strand a headless box. Do not run this over SSH alone.

**Before you start:** plug in a monitor (HDMI or Thunderbolt) and a USB keyboard. If networking dies,
that console is how you fix it. Everything below can be done from the console; SSH is a convenience.

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

Unrelated to the desktop, but this is the right moment: v1.19.0 shipped SIGTERM teardown and it has
never actually run. The unit calls `next start` directly rather than through `pnpm start`, so the
`cross-env NEXT_MANUAL_SIG_HANDLE=true` in `package.json` never reaches the process — Next.js installs
its own SIGTERM handler and the app's teardown never fires. Every restart eats the full 30s
`TimeoutStopSec` and is then SIGKILLed.

```bash
sudo systemctl edit --full mission-control
```

Add one line to the `[Service]` section, beside the existing `EnvironmentFile=`:

```ini
Environment=NEXT_MANUAL_SIG_HANDLE=true
```

Then:

```bash
sudo systemctl daemon-reload
```

No restart needed here — the step 7 reboot picks it up. **After that reboot**, confirm it worked:

```bash
sudo systemctl restart mission-control   # should now return in ~1-2s, not 30s
journalctl -u mission-control -n 30 | grep -iE "shutdown|sigterm|drain"
```

A restart that still takes exactly 30 seconds means the variable is not reaching the process — check
`sudo systemctl show mission-control -p Environment`.

## Step 4 — Install the desktop

`ubuntu-desktop-minimal` rather than `ubuntu-desktop`: it skips LibreOffice, Thunderbird, games, and
the rest, all of which install later in one command if you want them. Roughly 5 GB against 79 GB free.

```bash
sudo apt update
sudo apt install -y ubuntu-desktop-minimal
```

This takes a while on a 2012 Mini. It will pull in NetworkManager and `gdm3` — expected.

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

```bash
sudo -u gdm dbus-launch gsettings set org.gnome.settings-daemon.plugins.power sleep-inactive-ac-type 'nothing'
sudo -u gdm dbus-launch gsettings set org.gnome.settings-daemon.plugins.power sleep-inactive-battery-type 'nothing'
```

Repeat for your own user after first login (the `gdm` settings only cover the login screen):

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
- [ ] `sudo systemctl restart mission-control` returns in ~1-2s, not 30s (step 3b)
- [ ] `~/code/axod-mission-control` exists on branch `dev`
- [ ] `~/AKIRA/inbox` and `~/AKIRA/playground` exist
