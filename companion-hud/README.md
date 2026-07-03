# AKIRA Local Companion — HUD

A native, always-on-top Electron HUD for the AKIRA Local Companion. Shows
connection, presence, the local hard-gate approval queue, and security posture;
collapses from a full glass panel to a draggable orb.

## How it works

The HUD watches `~/.akira-companion/bridge.json` (written by the Companion) for
the localhost bridge port + token, connects over a `127.0.0.1` WebSocket, and:

- renders live **presence** (operator, host, current task, session timer),
- lists **pending approvals** with Approve / Deny,
- shows **connection & security** posture,
- sends **Stop** to abort all Companion activity.

No inbound network ports; nothing leaves the laptop.

## Setup

```bash
pnpm install
# If Electron's binary didn't download (repo uses ignore-scripts):
node node_modules/electron/install.js
```

## Run

```bash
pnpm start
```

Start order doesn't matter — the HUD watches for `bridge.json` and connects as
soon as the Companion is up, and reconnects automatically if the Companion
restarts (it mints fresh creds each start). Typically you'll run the Companion
(`cd ../companion && pnpm start`) alongside it.

The orb's dot turns green when the Companion's link to the Mini is up, and glows
magenta when an approval is waiting. Drag the header/orb to reposition; click
**—** to minimize, click the orb to restore.
