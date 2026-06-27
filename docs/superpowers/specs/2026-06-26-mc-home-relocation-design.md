# Move the `mc` service user's HOME off the repo dir

**Date:** 2026-06-26
**Status:** Approved; execution gated on a root step (see below)
**Type:** Mini operational change (not a code change)

## Problem

On the Mini, the `mc` service user's HOME **is** the app repo: `/srv/mission-control`. So `mc`'s
home dotfiles — Claude credentials (`.claude`), corepack/pnpm + npm caches (`.cache`, `.npm`),
`.config`, `.local`, `.ssh` — live **inside the git working tree** as untracked files. That's
what let the 2026-06-26 incident's `git clean -fd` delete the Claude auth and break pnpm. The
worktree-abort safeguard (v1.8.1) removed the acute trigger; this removes the underlying
fragility.

## Goal

Relocate `mc`'s HOME to `/srv/mc` (outside the repo), so credentials/caches can never be touched
by git operations in the repo, and `git status` in the repo is clean.

## What moves vs. stays (verified on the Mini)

**Move to `/srv/mc`** (these are `mc`'s home dotfiles, untracked/ignored, not repo files):
`.cache`, `.claude`, `.claude.json`, `.config`, `.local`, `.ssh`, `.npm`.

**Stays in `/srv/mission-control`** (repo + app runtime; the app keeps running here):
`.env`, `.env.example`, `.git`, `.gitattributes`, `.gitignore`, `.npmrc`, `.nvmrc`, `.next`,
`node_modules`, `data/` (the DB), and all source.

The systemd unit has `User=mc`, `WorkingDirectory=/srv/mission-control`,
`EnvironmentFile=/srv/mission-control/.env`, and **no explicit `HOME`** — so HOME is derived from
`mc`'s passwd entry. After `usermod -d /srv/mc mc` + a restart, the service runs with
`HOME=/srv/mc` while its working directory and `.env`/DB stay in `/srv/mission-control`.

The landing-repo deploy key (`/srv/projects/.mc_deploy_ed25519`) and its `core.sshCommand` use an
absolute path → unaffected. `.ssh/known_hosts` moves with HOME.

## Procedure (single root script)

```bash
sudo bash -c '
  set -e
  mkdir -p /srv/mc
  for d in .cache .claude .claude.json .config .local .ssh .npm; do
    [ -e "/srv/mission-control/$d" ] && mv "/srv/mission-control/$d" /srv/mc/ || true
  done
  chown -R mc:mc /srv/mc
  usermod -d /srv/mc mc
  systemctl restart mission-control
'
```

`mkdir` in `/srv` and `usermod` require **root**. Because of the sudo scope-down
(`akeem` has passwordless sudo only for `-u mc …` + specific `systemctl`), this needs `akeem`'s
**password** — run interactively, or the operator runs the script.

## Verification (no root needed)

- `getent passwd mc` → home is `/srv/mc`.
- Service env: `cat /proc/$(pgrep -f 'next start' | head -1)/environ | tr '\0' '\n' | grep ^HOME=` → `HOME=/srv/mc`.
- `sudo -u mc bash -lc 'claude auth status'` → `loggedIn: true` (creds now at `/srv/mc/.claude`).
- `sudo -u mc bash -lc 'cd /srv/mission-control && pnpm --version'` → `11.1.2`.
- `curl -s 127.0.0.1:3000/api/health` → `version 1.8.1`, `db: ok`.
- `journalctl -u mission-control` (no sudo, via `adm`) shows `[discord] logged in` + tickers.
- `sudo -u mc git -C /srv/mission-control status --porcelain` → no more `?? .claude/` etc.

## Rollback

If anything misbehaves: `sudo usermod -d /srv/mission-control mc` and move the dotfiles back
(`mv /srv/mc/.claude /srv/mission-control/` …), then restart. The Claude creds also exist on the
Windows PC (`~/.claude/.credentials.json`) as a re-copy source if needed.

## Out of scope

Changing `WorkingDirectory` (stays `/srv/mission-control`), the DB location, or the deploy layout.
