# AKIRA memory vault — setup

AKIRA's long-term memory is a private git repo checked out on the Mini at
`data/akira-memory/`, synced to your laptop Obsidian.

## One-time

1. **Create a private GitHub repo** `akira-memory`. Seed it with an empty `INDEX.md`.
2. **Mini deploy key:** as `mc`,
   `ssh-keygen -t ed25519 -f ~/.ssh/akira-memory -N ""`; add the `.pub` to the repo's
   Deploy keys with **write** access; add a host alias in `~/.ssh/config`
   (`Host github-akira-memory` / `IdentityFile ~/.ssh/akira-memory`).
3. **Clone on the Mini:**
   `sudo -u mc git clone git@github-akira-memory:<you>/akira-memory.git /srv/mission-control/data/akira-memory`
4. **Set the PIN + (optional) paths** in the Mini `.env`:
   `AKIRA_MEMORY_PIN=<your unlock PIN>` (optional `AKIRA_MEMORY_DIR`, `AKIRA_MEMORY_PULL_MS`).
   Restart `mission-control`.
5. **Laptop:** clone the repo, open the folder in Obsidian, enable the **Git plugin**
   (auto pull/commit/push on an interval).

## Notes
- The app repo ignores `data/akira-memory/` — it's a separate repo.
- Memory is plaintext (so Obsidian can read it); privacy = private repo + login + the
  PIN-locked Settings panel. Never store secrets in memory.
