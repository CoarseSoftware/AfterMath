#!/usr/bin/env bash
# After Math review waiter.
#
# Blocks (in a background task) until the review session reaches a state the
# agent must act on, then prints a small event to stdout and exits. The
# agent's session wakes on exit and continues from the stdout.
#
# Usage: wait-for-review.sh <session-dir> [interval-seconds]
#
# Exit events (stdout):
#   EVENT=fix    one or more files are RELEASABLE: released by the human
#                (ready: true) with open feedback (unresolved comments or
#                unanswered discussion). The agent works only those files;
#                the rest of the session keeps waiting.
#   EVENT=done   the human CONFIRMED "Commit changes" for this session (the
#                manifest has a commit field with the chosen commit options).
#                A fully-accepted session WITHOUT a commit field is NOT done —
#                the human is still deciding (they may revise or un-accept).
#
# "Revise" is per-file; the session-level "Revise all" button in the GUI
# releases every file that has open feedback, which also wakes the waiter for
# all of them.
#
# Wakes only when the releasable-feedback signature actually changes (or the
# session gets a confirmed commit), so identical rewrites never wake the agent.
# Requires node (the review protocol is JSON).

set -uo pipefail

SESSION_DIR="${1:?usage: wait-for-review.sh <session-dir> [interval-seconds]}"
INTERVAL="${2:-5}"
case "$INTERVAL" in (*[!0-9]*|'') INTERVAL=5;; esac
[ -f "$SESSION_DIR/manifest.json" ] || { echo "ERROR=no manifest at $SESSION_DIR" >&2; exit 2; }

# One helper for all protocol queries: <mode> = state | sig | payload
helper() {
  node -e '
    const fs = require("fs");
    const crypto = require("crypto");
    const dir = process.argv[2];
    const mode = process.argv[1];
    const name = (p) => crypto.createHash("sha1").update(p).digest("hex").slice(0, 12) + ".json";
    const read = (p) => {
      try { return JSON.parse(fs.readFileSync(dir + "/" + name(p), "utf8")); }
      catch { return null; }
    };
    const m = JSON.parse(fs.readFileSync(dir + "/manifest.json", "utf8"));
    const reviews = (m.files || []).map(read);
    const releasable = (r) =>
      r && r.ready === true &&
      ((r.comments || []).some((c) => !c.resolved) || (r.discussion || []).some((d) => !d.answered));
    if (mode === "state") {
      const states = reviews.map((r) => (r ? r.status : "missing"));
      const allAccepted = states.length > 0 && states.every((s) => s === "accepted");
      // done REQUIRES the confirmed "Commit changes" (manifest.commit).
      // Every-file-accepted without it is still under consideration.
      process.stdout.write(allAccepted && m.commit ? "done" : reviews.some(releasable) ? "fix" : "wait");
    } else if (mode === "sig") {
      const parts = [];
      for (const r of reviews) {
        if (!releasable(r)) continue;
        for (const c of r.comments || []) if (!c.resolved) parts.push(c.id);
        for (const d of r.discussion || []) if (!d.answered) parts.push(d.id);
      }
      process.stdout.write(parts.join(" "));
    } else if (mode === "payload") {
      const files = [];
      for (const r of reviews) {
        if (!releasable(r)) continue;
        files.push({
          path: r.path,
          // Open comments only — `resolved` is left exactly as on disk
          // (false here): only the human marks comments resolved.
          comments: (r.comments || []).filter((c) => !c.resolved),
          discussion: (r.discussion || []).filter((d) => !d.answered),
        });
      }
      process.stdout.write(JSON.stringify({ session: m.session, submission: m.submission, files }, null, 2));
    }
  ' "$1" "$SESSION_DIR"
}

# Start from an empty baseline: if releasable feedback already exists when the
# waiter starts, wake immediately (the agent still has work to do).
LAST_SIG=""

while true; do
  state="$(helper state 2>/dev/null)" || state="wait"

  case "$state" in
    done)
      echo "EVENT=done"
      echo "SESSION_DIR=$SESSION_DIR"
      exit 0
      ;;
    fix)
      sig="$(helper sig || echo "")"
      if [ "$sig" != "$LAST_SIG" ]; then
        echo "EVENT=fix"
        echo "SESSION_DIR=$SESSION_DIR"
        echo "PAYLOAD<<AM_EOF"
        helper payload
        echo "AM_EOF"
        exit 0
      fi
      ;;
  esac

  sleep "$INTERVAL"
done
