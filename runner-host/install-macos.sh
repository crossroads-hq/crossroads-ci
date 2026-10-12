#!/usr/bin/env bash
#
# Install (or, with --uninstall, remove) the weekly cleanup agents on a Mac.
# Run as the user who owns the runner folders; no sudo:
#
#   WORKTREE_ROOTS="$HOME/code" runner-host/install-macos.sh
#   runner-host/install-macos.sh --uninstall
#
# Two launchd agents, both in ~/Library/LaunchAgents:
#   com.crossroads.fleet-runner-clean  Sundays 04:00. Runs fleet-runner-clean.sh,
#       the same idle-only cleanup the Linux host runs (old _work checkouts,
#       _temp, merged local branches in the checkouts, an oversized npm cache,
#       Docker leftovers). It can delete, as the systemd timer does.
#   com.crossroads.clean-worktrees    Sundays 05:00, only if WORKTREE_ROOTS is
#       set. REPORT ONLY: it runs clean-worktrees.sh without APPLY, so it lists
#       worktrees that could go and removes nothing. Read the log, then run
#       `APPLY=1 clean-worktrees <roots>` yourself. A scheduled deletion of
#       a developer's working folders is not something to do unattended.
#
# The scripts are copied to ~/Library/Application Support/crossroads-ci, so the
# agents keep working when this checkout moves or is deleted. Re-run this script
# after pulling to update them. Logs: ~/Library/Logs/crossroads-ci/.
#
# A launchd job runs only while the Mac is on; a missed Sunday runs when the Mac
# wakes. Folders such as ~/Documents and ~/Desktop are protected by macOS: the
# first run may need /bin/bash granted Full Disk Access (System Settings,
# Privacy & Security), or WORKTREE_ROOTS pointed somewhere unprotected.
set -euo pipefail

here="$(cd "$(dirname "$0")" && pwd)"
[ "$(uname -s)" = "Darwin" ] || { echo "this installer is for macOS; on Linux use runner-host/install.sh" >&2; exit 1; }
[ "$(id -u)" -ne 0 ] || { echo "run as your own user, not root: these are per-user LaunchAgents" >&2; exit 1; }

support="$HOME/Library/Application Support/crossroads-ci"
agents="$HOME/Library/LaunchAgents"
logs="$HOME/Library/Logs/crossroads-ci"
domain="gui/$(id -u)"
labels=(com.crossroads.fleet-runner-clean com.crossroads.clean-worktrees)

unload() {
  launchctl bootout "$domain/$1" 2>/dev/null || true
}

if [ "${1:-}" = "--uninstall" ]; then
  for l in "${labels[@]}"; do
    unload "$l"
    rm -f "$agents/$l.plist"
  done
  rm -f "$support/fleet-runner-clean" "$support/clean-worktrees"
  echo "removed. Logs in $logs were kept."
  exit 0
fi

# XML-escape a value for a plist <string>.
xml() { sed -e 's/&/\&amp;/g' -e 's/</\&lt;/g' -e 's/>/\&gt;/g' <<<"$1"; }

mkdir -p "$support" "$agents" "$logs"
install -m 0755 "$here/fleet-runner-clean.sh" "$support/fleet-runner-clean"
install -m 0755 "$here/../scripts/clean-worktrees.sh" "$support/clean-worktrees"

# One agent. $1 label, $2 program, $3 weekday hour, $4 extra <key>/<string>
# environment lines, $5.. program arguments.
write_agent() {
  local label="$1" program="$2" hour="$3" env_xml="$4" arg
  shift 4
  {
    echo '<?xml version="1.0" encoding="UTF-8"?>'
    echo '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">'
    echo '<plist version="1.0"><dict>'
    echo "  <key>Label</key><string>$(xml "$label")</string>"
    echo '  <key>ProgramArguments</key><array>'
    echo "    <string>$(xml "$program")</string>"
    for arg in "$@"; do echo "    <string>$(xml "$arg")</string>"; done
    echo '  </array>'
    echo '  <key>StartCalendarInterval</key><dict>'
    echo "    <key>Weekday</key><integer>0</integer>"
    echo "    <key>Hour</key><integer>$hour</integer>"
    echo '    <key>Minute</key><integer>0</integer>'
    echo '  </dict>'
    echo '  <key>EnvironmentVariables</key><dict>'
    echo '    <key>PATH</key><string>/usr/bin:/bin:/usr/sbin:/sbin:/usr/local/bin:/opt/homebrew/bin</string>'
    printf '%s' "$env_xml"
    echo '  </dict>'
    # Low priority, like the Linux units: CI jobs share this machine.
    echo '  <key>ProcessType</key><string>Background</string>'
    echo '  <key>LowPriorityIO</key><true/>'
    echo '  <key>Nice</key><integer>10</integer>'
    echo "  <key>StandardOutPath</key><string>$(xml "$logs/$label.log")</string>"
    echo "  <key>StandardErrorPath</key><string>$(xml "$logs/$label.log")</string>"
    echo '</dict></plist>'
  } > "$agents/$label.plist"
  plutil -lint "$agents/$label.plist" >/dev/null
  unload "$label"
  launchctl bootstrap "$domain" "$agents/$label.plist"
  echo "installed $label"
}

# Settings for the runner cleanup come from the environment of this run, so a
# changed limit is one re-run away; unset ones keep the script's defaults.
runner_env=""
for v in RUNNER_DIRS TEMP_RETAIN_DAYS WORK_RETAIN_DAYS NPM_CACHE_MAX_MB WAIT_MINUTES DOCKER DOCKER_UNTIL; do
  if [ -n "${!v+x}" ]; then
    runner_env="$runner_env    <key>$v</key><string>$(xml "${!v}")</string>
"
  fi
done
write_agent com.crossroads.fleet-runner-clean "$support/fleet-runner-clean" 4 "$runner_env"

if [ -n "${WORKTREE_ROOTS:-}" ]; then
  roots=()
  # Space-separated roots; a path containing a space is not supported here.
  # shellcheck disable=SC2206
  roots=($WORKTREE_ROOTS)
  write_agent com.crossroads.clean-worktrees "$support/clean-worktrees" 5 "" "${roots[@]}"
else
  unload com.crossroads.clean-worktrees
  rm -f "$agents/com.crossroads.clean-worktrees.plist"
  echo "WORKTREE_ROOTS not set: the worktree report agent was not installed."
fi

echo
echo "Run one now to check it:"
echo "  launchctl kickstart -k $domain/com.crossroads.fleet-runner-clean"
echo "  tail -f '$logs/com.crossroads.fleet-runner-clean.log'"
