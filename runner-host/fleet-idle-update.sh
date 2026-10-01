#!/usr/bin/env bash
#
# Update the runner host's packages only when the fleet has been idle.
#
# Ubuntu's apt-daily / apt-daily-upgrade timers fire on their own schedule and
# hold the dpkg lock for minutes. A CI job that reaches `playwright
# install-deps` meanwhile cannot take the lock and fails before any test runs
# (crossroads-ci#50) -- a red required check with nothing behind it. Masking
# the timers alone would stop updates entirely, so this replaces them: run from
# a systemd timer, it updates only after every runner on the host has been idle
# for IDLE_MINUTES without a break, at most once per MIN_INTERVAL_HOURS, and
# pauses the runners while it works so no job can start mid-update.
#
# Each run is one cheap observation; the idle clock lives in STATE_DIR:
#   busy now               -> reset the clock, exit
#   idle, no clock yet     -> start the clock, exit
#   idle < IDLE_MINUTES    -> exit
#   idle >= IDLE_MINUTES   -> re-check, stop runners, update, start runners
#
# Settings come from /etc/default/fleet-idle-update (see install.sh). Every
# external command is overridable through the environment so the logic can be
# tested without root, systemd or apt (runner-host/idle-update.test.js).
set -euo pipefail

IDLE_MINUTES="${IDLE_MINUTES:-30}"
MIN_INTERVAL_HOURS="${MIN_INTERVAL_HOURS:-24}"
STALE_WARN_DAYS="${STALE_WARN_DAYS:-7}"
UPDATE_TIMEOUT_MINUTES="${UPDATE_TIMEOUT_MINUTES:-45}"
STATE_DIR="${STATE_DIR:-/var/lib/fleet-idle-update}"
RUNNER_UNITS="${RUNNER_UNITS:-actions.runner.*}"
SYSTEMCTL="${SYSTEMCTL:-systemctl}"
APT_GET="${APT_GET:-apt-get}"
# A job is running when the runner has spawned its worker process. The listener
# (Runner.Listener) is always up and does not count.
BUSY_CMD="${BUSY_CMD:-pgrep -f Runner.Worker}"
REBOOT_FLAG="${REBOOT_FLAG:-/var/run/reboot-required}"
# Empty disables the wall-clock bound (tests on hosts without coreutils timeout).
TIMEOUT_CMD="${TIMEOUT_CMD-timeout}"
now="${NOW:-$(date +%s)}"

log() { printf 'fleet-idle-update: %s\n' "$*"; }
# shellcheck disable=SC2086 # BUSY_CMD is a command line, split on purpose
busy() { $BUSY_CMD >/dev/null 2>&1; }
read_state() { [ -s "$STATE_DIR/$1" ] && cat "$STATE_DIR/$1" || true; }
write_state() { printf '%s\n' "$2" > "$STATE_DIR/$1"; }

mkdir -p "$STATE_DIR"

# One run at a time; a second timer firing while an update is in progress
# simply leaves.
exec 9>"$STATE_DIR/lock"
if command -v flock >/dev/null && ! flock -n 9; then
  log "another run holds the lock; leaving it to finish"
  exit 0
fi

last_success="$(read_state last-success)"
if [ -n "$last_success" ]; then
  age=$(( now - last_success ))
  if [ "$age" -lt $(( MIN_INTERVAL_HOURS * 3600 )) ]; then
    exit 0
  fi
  if [ "$age" -ge $(( STALE_WARN_DAYS * 86400 )) ]; then
    log "WARNING: last update was $(( age / 86400 )) days ago; the host has not been idle for ${IDLE_MINUTES} minutes since"
  fi
fi

if busy; then
  if [ -n "$(read_state idle-since)" ]; then log "a job started; idle clock reset"; fi
  rm -f "$STATE_DIR/idle-since"
  exit 0
fi

idle_since="$(read_state idle-since)"
if [ -z "$idle_since" ]; then
  write_state idle-since "$now"
  log "host idle; idle clock started"
  exit 0
fi

idle_for=$(( now - idle_since ))
if [ "$idle_for" -lt $(( IDLE_MINUTES * 60 )) ]; then
  exit 0
fi

# Re-check immediately before pausing: the clock proves the past, not now.
if busy; then
  rm -f "$STATE_DIR/idle-since"
  log "a job started at the last moment; idle clock reset"
  exit 0
fi

# Pause only the runners that are running now, and bring exactly those back,
# whatever happens below.
# A read loop rather than mapfile, and the ${a[@]+...} guards below, keep this
# working on bash 3.2 as well as the host's bash 5.
units=()
while IFS= read -r unit; do
  [ -n "$unit" ] && units+=("$unit")
done < <("$SYSTEMCTL" list-units --type=service --state=active --plain --no-legend "$RUNNER_UNITS" | awk '{print $1}')
restart_runners() {
  if [ "${#units[@]}" -gt 0 ]; then
    "$SYSTEMCTL" start "${units[@]}" || log "WARNING: could not restart: ${units[*]}"
    log "runners resumed (${#units[@]})"
  fi
}
trap restart_runners EXIT
if [ "${#units[@]}" -gt 0 ]; then
  "$SYSTEMCTL" stop "${units[@]}"
  log "idle for $(( idle_for / 60 )) minutes; runners paused (${#units[@]}), updating"
else
  log "idle for $(( idle_for / 60 )) minutes; no active runner units, updating"
fi

export DEBIAN_FRONTEND=noninteractive
apt_opts=(-q -y -o DPkg::Lock::Timeout=300 -o Dpkg::Options::=--force-confdef -o Dpkg::Options::=--force-confold)
bound=()
[ -n "$TIMEOUT_CMD" ] && bound=("$TIMEOUT_CMD" "$(( UPDATE_TIMEOUT_MINUTES * 60 ))")
${bound[@]+"${bound[@]}"} "$APT_GET" "${apt_opts[@]}" update
${bound[@]+"${bound[@]}"} "$APT_GET" "${apt_opts[@]}" upgrade

write_state last-success "$now"
rm -f "$STATE_DIR/idle-since"
log "update complete"
if [ -e "$REBOOT_FLAG" ]; then
  # Never reboot unattended: restarting WSL takes every runner down with it.
  log "NOTICE: the update requires a reboot; restart WSL at a quiet moment"
fi
