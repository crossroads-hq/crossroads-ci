#!/usr/bin/env bash
#
# Remove scratch folders that CI jobs leave in /tmp: crossroads-ui's
# crossroads-* folders (some hold a whole npm cache) and crossroads-evolution's
# embedded-Postgres data directories, evolution-test-pg-* and
# evolution-a11y-pg-* (66-127 MB each). A job that dies (out of disk,
# cancelled, timed out) never removes its own, so they pile up until /tmp
# fills and every job on the host fails with ENOSPC. On 2026-10-04, 73
# Postgres folders had filled the 4.4 GB tmpfs /tmp to 98%.
#
# An entry is removed only when nothing inside it has changed for
# RETAIN_HOURS, and, for a Postgres data directory, when no running process
# that is its postmaster (the PID in postmaster.pid, with this directory on its
# command line) remains, so a folder in use is never touched.
# Installed by install.sh with fleet-tmp-clean.timer (daily).
set -euo pipefail

TMP_DIR="${TMP_DIR:-/tmp}"
PATTERNS="${PATTERNS:-crossroads-* evolution-*-pg-*}"   # space-separated globs, top level only
RETAIN_HOURS="${RETAIN_HOURS:-24}"

case "$RETAIN_HOURS" in ''|*[!0-9]*) echo "RETAIN_HOURS must be a whole number" >&2; exit 2;; esac
[ "$RETAIN_HOURS" -ge 1 ] || { echo "RETAIN_HOURS must be at least 1" >&2; exit 2; }
[ -d "$TMP_DIR" ] || { echo "no such directory: $TMP_DIR" >&2; exit 2; }
minutes=$((RETAIN_HOURS * 60))

removed=0 kept=0 freed_kb=0
for pattern in $PATTERNS; do
  while IFS= read -r -d '' entry; do
    # A Postgres data directory whose server is still running, however long
    # it has been idle, is in use. A live PID alone is not proof: after a
    # crash the PID can be reused by any process, which would keep a dead
    # directory forever. The postmaster is started with -D <this directory>,
    # so the process must also carry this path on its command line.
    if [ -f "$entry/postmaster.pid" ]; then
      pid="$(head -n1 "$entry/postmaster.pid" 2>/dev/null || true)"
      case "$pid" in ''|*[!0-9]*) ;; *)
        args="$(ps -ww -o args= -p "$pid" 2>/dev/null || true)"
        case "$args" in *"$entry"*) kept=$((kept + 1)); continue ;; esac ;;
      esac
    fi
    # Anything inside changed recently (or unreadable): a job may still own it.
    if [ -n "$(find "$entry" -mmin "-$minutes" -print -quit 2>/dev/null || echo unreadable)" ]; then
      kept=$((kept + 1))
      continue
    fi
    size_kb="$(du -sk "$entry" 2>/dev/null | cut -f1)"
    if rm -rf -- "$entry"; then
      removed=$((removed + 1))
      freed_kb=$((freed_kb + ${size_kb:-0}))
    else
      echo "could not remove $entry" >&2
    fi
  done < <(find "$TMP_DIR" -mindepth 1 -maxdepth 1 -name "$pattern" -mmin "+$minutes" -print0)
done

echo "removed $removed, kept $kept still in use, freed $((freed_kb / 1024)) MB in $TMP_DIR"
