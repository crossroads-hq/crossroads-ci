#!/usr/bin/env bash
#
# Remove scratch folders that CI jobs leave in /tmp. Tests create them with
# names such as crossroads-export-install-* or crossroads-dt1-react18-*, and
# some hold a whole npm cache; a job that dies (out of disk, cancelled, timed
# out) never removes its own, so they pile up until the disk fills and every
# job on the host fails with ENOSPC.
#
# An entry is removed only when nothing inside it has changed for
# RETAIN_HOURS, so a job still writing to its folder is never touched.
# Installed by install.sh with fleet-tmp-clean.timer (daily).
set -euo pipefail

TMP_DIR="${TMP_DIR:-/tmp}"
PATTERNS="${PATTERNS:-crossroads-*}"   # space-separated globs, top level only
RETAIN_HOURS="${RETAIN_HOURS:-24}"

case "$RETAIN_HOURS" in ''|*[!0-9]*) echo "RETAIN_HOURS must be a whole number" >&2; exit 2;; esac
[ "$RETAIN_HOURS" -ge 1 ] || { echo "RETAIN_HOURS must be at least 1" >&2; exit 2; }
[ -d "$TMP_DIR" ] || { echo "no such directory: $TMP_DIR" >&2; exit 2; }
minutes=$((RETAIN_HOURS * 60))

removed=0 kept=0 freed_kb=0
for pattern in $PATTERNS; do
  while IFS= read -r -d '' entry; do
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
