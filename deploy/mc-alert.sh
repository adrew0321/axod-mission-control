#!/usr/bin/env bash
# Failure notifier for Mission Control systemd units.
#
# Wired in via `OnFailure=mc-alert@%n.service` on the units that matter. Exists
# because deploy/mc-backup.service failed 49 nights running (2026-06-26 → 08-14)
# and nothing said a word. A backup job without this is a backup job you will
# discover is broken at the worst possible moment.
#
# Requires DISCORD_ALERT_WEBHOOK in /srv/mission-control/.env. Without it this
# still writes to the journal, so `journalctl -u mc-alert@*` remains a record.
#
# Usage: mc-alert.sh <failed-unit-name>
set -uo pipefail   # NOT -e: an alert script must never fail silently itself

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"

UNIT="${1:-unknown.service}"
HOST="$(hostname)"
WEBHOOK="${DISCORD_ALERT_WEBHOOK:-}"

STATUS="$(systemctl is-failed "$UNIT" 2>/dev/null || true)"
DETAIL="$(journalctl -u "$UNIT" -n 12 --no-pager 2>/dev/null | tail -12)"

# systemd's machine-readable verdict, used to summarise failures that produced
# no output of their own (203/EXEC, timeouts, OOM kills).
RESULT="$(systemctl show "$UNIT" -p Result --value 2>/dev/null || true)"
EXIT_STATUS="$(systemctl show "$UNIT" -p ExecMainStatus --value 2>/dev/null || true)"

# The unit's own last words. Drop systemd's bookkeeping lines and journalctl's
# '--' markers, then strip the syslog prefix, leaving just what the script said.
# When a script printed a real error, that line beats any classification.
APP_LINE="$(printf '%s\n' "$DETAIL" \
  | grep -vE ' systemd\[[0-9]+\]: ' \
  | grep -vE '^-- ' \
  | sed -E 's/^[A-Za-z]{3} +[0-9]+ [0-9]{2}:[0-9]{2}:[0-9]{2} [^ ]+ [^ ]+: //' \
  | tail -1)"

# Always leave a trace locally, webhook or not.
echo "ALERT: ${UNIT} on ${HOST} → ${STATUS}"
echo "$DETAIL"

if [ -z "$WEBHOOK" ]; then
  echo "DISCORD_ALERT_WEBHOOK unset — journal-only alert."
  exit 0
fi

# Embed descriptions allow 4096 chars; the builder trims to fit.
SNIPPET="$(printf '%s' "$DETAIL" | tail -c 2000)"

PAYLOAD="$(python3 "$SCRIPT_DIR/mc-alert-payload.py" \
  "$UNIT" "$HOST" "$RESULT" "$EXIT_STATUS" "$APP_LINE" "$SNIPPET" 2>/dev/null)"

# If the builder died, still say something rather than POSTing an empty body and
# collecting a 400. A degraded alert beats a silent one.
if [ -z "$PAYLOAD" ]; then
  echo "payload builder failed — falling back to plain text."
  PAYLOAD="$(printf '{"content":"ALERT: %s failed on %s (alert payload builder error)"}' \
    "$UNIT" "$HOST")"
fi

curl -fsS --max-time 20 -H "Content-Type: application/json" \
  -d "$PAYLOAD" "$WEBHOOK" >/dev/null \
  && echo "alert posted to Discord." \
  || echo "alert POST failed (unit failure still recorded above)."

exit 0
