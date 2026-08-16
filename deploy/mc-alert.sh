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

UNIT="${1:-unknown.service}"
HOST="$(hostname)"
WEBHOOK="${DISCORD_ALERT_WEBHOOK:-}"

STATUS="$(systemctl is-failed "$UNIT" 2>/dev/null || true)"
DETAIL="$(journalctl -u "$UNIT" -n 12 --no-pager 2>/dev/null | tail -12)"

# Always leave a trace locally, webhook or not.
echo "ALERT: ${UNIT} on ${HOST} → ${STATUS}"
echo "$DETAIL"

if [ -z "$WEBHOOK" ]; then
  echo "DISCORD_ALERT_WEBHOOK unset — journal-only alert."
  exit 0
fi

# Discord hard-caps messages at 2000 chars; keep well clear.
SNIPPET="$(printf '%s' "$DETAIL" | tail -c 1200)"
# Values come in as argv, not os.environ, so the Python source needs no quoted
# dict keys. The shell does NOT expand backslashes inside a single-quoted -c
# block, so an escaped \" here reaches Python literally and is a SyntaxError
# inside an f-string expression — which is exactly how every Discord post
# failed with a 400 until 2026-08-15.
PAYLOAD="$(python3 -c '
import json, sys
unit, host, status, snippet = sys.argv[1:5]
print(json.dumps({
    "content": f":rotating_light: **{unit}** failed on `{host}` (state: {status})\n```\n{snippet}\n```"
}))' "$UNIT" "$HOST" "$STATUS" "$SNIPPET")"

curl -fsS --max-time 20 -H "Content-Type: application/json" \
  -d "$PAYLOAD" "$WEBHOOK" >/dev/null \
  && echo "alert posted to Discord." \
  || echo "alert POST failed (unit failure still recorded above)."

exit 0
