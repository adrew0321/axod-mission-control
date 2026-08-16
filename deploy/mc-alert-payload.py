#!/usr/bin/env python3
"""Build the Discord webhook payload for a failed systemd unit.

This lives in its own file rather than inline `python3 -c '...'` inside
mc-alert.sh on purpose. Embedding Python in shell quoting is what silently
broke every Discord alert until 2026-08-15: the shell does not expand
backslashes inside a single-quoted -c block, so an escaped quote reached
Python literally and raised SyntaxError. curl then POSTed an empty body and
Discord answered 400 — while the script still exited 0. A real file has no
quoting seam, and its logic can be tested directly.

Usage:
    mc-alert-payload.py UNIT HOST RESULT EXIT_STATUS APP_LINE SNIPPET

Prints one line of JSON on stdout. Any failure here should leave stdout empty
so the caller can fall back to a plain-text post.
"""

import json
import sys
from datetime import datetime, timezone

RED = 0xE74C3C

# Discord's documented ceilings. We stay under them rather than discovering
# them as a 400 at 3am.
MAX_DESCRIPTION = 4096
MAX_TITLE = 256

# systemd could not even start the process, so there is no script output to
# explain the failure — these codes are the whole story. See systemd.exec(5).
EXEC_FAILURES = {
    "200": "Working directory missing (200/CHDIR)",
    "202": "Failed to set up file descriptors (202/FDS)",
    "203": "Cannot execute — not executable or bad interpreter (203/EXEC)",
    "208": "Failed to set up stdin (208/STDIN)",
    "209": "Failed to set up stdout (209/STDOUT)",
}

# systemd's verdict when the process did run but ended badly.
RESULTS = {
    "timeout": "Timed out — killed by systemd",
    "oom-kill": "Killed — out of memory",
    "signal": "Killed by a signal",
    "core-dump": "Crashed (core dumped)",
    "start-limit-hit": "Restart limit hit — too many failures too fast",
}


def summarize(result, exit_status, app_line):
    """One line saying what actually went wrong, to be read before the log.

    The unit's own last log line wins whenever there is one: a script that
    printed "VERIFY FAILED for mc-...db" has already explained itself better
    than any classification could, and prefixing it with "Exited with status 1"
    would only add noise. systemd's machine-readable cause is the fallback, and
    it is all that exists when the service never got as far as running — which
    is precisely the 203/EXEC case that hid a 7-week backup outage.
    """
    if app_line.strip():
        return app_line.strip()
    if result in RESULTS:
        return RESULTS[result]
    if exit_status in EXEC_FAILURES:
        return EXEC_FAILURES[exit_status]
    # "0" is not a failure to report. systemd reports ExecMainStatus=0 for a
    # timeout or a signal, and for a unit that is currently fine — rendering
    # "Exited with status 0" as the headline of an alert is worse than saying
    # nothing, because it reads as a contradiction.
    if exit_status and exit_status != "0":
        return "Exited with status {}".format(exit_status)
    return "Failed for an unrecorded reason — see the log below"


def build_description(summary, snippet):
    """Summary first, then the raw log in a fenced block, within Discord's cap.

    When the log has to be cut, keep the TAIL: the last lines are the ones
    nearest the failure.
    """
    snippet = snippet.strip()
    if not snippet:
        return summary[:MAX_DESCRIPTION]

    fence = "\n```\n{}\n```"
    budget = MAX_DESCRIPTION - len(summary) - len(fence.format(""))
    if budget <= 0:
        return summary[:MAX_DESCRIPTION]
    if len(snippet) > budget:
        snippet = snippet[-budget:]
    return summary + fence.format(snippet)


def build(unit, host, result, exit_status, app_line, snippet):
    summary = summarize(result, exit_status, app_line)

    # An exit status is only meaningful when the process actually exited; for a
    # timeout or a signal systemd reports 0, which would read as success.
    exit_display = exit_status if result == "exit-code" and exit_status else "—"

    return {
        "embeds": [
            {
                "title": "🚨 {} failed".format(unit)[:MAX_TITLE],
                "color": RED,
                "description": build_description(summary, snippet),
                "fields": [
                    {"name": "Host", "value": host or "—", "inline": True},
                    {"name": "State", "value": result or "—", "inline": True},
                    {"name": "Exit", "value": exit_display, "inline": True},
                ],
                "footer": {"text": "Mission Control · {}".format(host)},
                "timestamp": datetime.now(timezone.utc).isoformat(),
            }
        ]
    }


def main(argv):
    args = (argv + [""] * 6)[:6]
    print(json.dumps(build(*args)))


if __name__ == "__main__":
    main(sys.argv[1:])
