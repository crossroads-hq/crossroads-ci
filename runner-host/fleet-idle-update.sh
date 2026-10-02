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
# pauses the runners while it works.
#
# "Idle since" is the later of two observations:
#   - the first poll that found no job running (STATE_DIR/idle-since), and
#   - the newest runner job log (_diag/Worker_*.log): the runner writes one per
#     job and keeps touching it until the job ends. This catches a job that
#     started and finished between two polls, which a poll alone never sees.
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
# Runner diagnostic folders; each holds one Worker_*.log per job.
WORKER_LOG_DIRS="${WORKER_LOG_DIRS:-/home/*/actions-runner*/_diag}"
SYSTEMCTL="${SYSTEMCTL:-systemctl}"
APT_GET="${APT_GET:-apt-get}"
# A job is running when the runner has spawned its worker process. The listener
# (Runner.Listener) is always up and does not count.
BUSY_CMD="${BUSY_CMD:-pgrep -f Runner.Worker}"
REBOOT_FLAG="${REBOOT_FLAG:-/var/run/reboot-required}"
# Empty disables the wall-clock bound (tests on hosts without coreutils timeout).
TIMEOUT_CMD="${TIMEOUT_CMD-timeout}"

log() { printf 'fleet-idle-update: %s\n' "$*"; }
# A file holding the epoch, for tests that need time to pass mid-run.
clock() { if [ -n "${NOW_FILE:-}" ]; then cat "$NOW_FILE"; else date +%s; fi; }
# shellcheck disable=SC2086 # BUSY_CMD is a command line, split on purpose
busy() { $BUSY_CMD >/dev/null 2>&1; }
read_state() {
  if [ -s "$STATE_DIR/$1" ]; then cat "$STATE_DIR/$1"; fi
}
write_state() { printf '%s\n' "$2" > "$STATE_DIR/$1"; }
mtime() { stat -c %Y "$1" 2>/dev/null || stat -f %m "$1"; }
# Epoch of the newest runner job log, or 0 when there is none; fails when a
# folder cannot be read, because "unknown" must never pass for "no jobs".
# Each folder is listed by `ls -t` reading the directory itself, so no file
# names travel through argv: a per-file stat walk took 56s over the host's
# 8,201 logs, and globbing every path into one argv would eventually exceed
# ARG_MAX and fail.
last_job_activity() {
  local newest=0 dir listing name m
  # shellcheck disable=SC2086 # WORKER_LOG_DIRS is a glob of a few folders
  for dir in $WORKER_LOG_DIRS; do
    [ -d "$dir" ] || continue
    # shellcheck disable=SC2012 # ls -t is the portable mtime sort
    listing="$(ls -1t "$dir")" || return 1
    name="$(printf '%s\n' "$listing" | grep -m1 '^Worker_.*\.log$' || true)"
    [ -n "$name" ] || continue
    m="$(mtime "$dir/$name")" || return 1
    if [ "$m" -gt "$newest" ]; then newest="$m"; fi
  done
  echo "$newest"
}
# last_job_activity, or stop: an unreadable job log means idle is unknown.
job_activity() {
  local v
  if ! v="$(last_job_activity)"; then
    log "ERROR: could not read runner job logs; idle unknown, not updating" >&2
    exit 1
  fi
  echo "$v"
}

mkdir -p "$STATE_DIR"

# One run at a time; a second timer firing while an update is in progress
# simply leaves.
exec 9>"$STATE_DIR/lock"
if command -v flock >/dev/null && ! flock -n 9; then
  log "another run holds the lock; leaving it to finish"
  exit 0
fi

now="$(clock)"
[ -n "$(read_state first-run)" ] || write_state first-run "$now"

last_success="$(read_state last-success)"
if [ -n "$last_success" ] && [ $(( now - last_success )) -lt $(( MIN_INTERVAL_HOURS * 3600 )) ]; then
  exit 0
fi
# Measured from the last update, or from the first run on a host that has
# never managed one -- otherwise a host busy since installation never warns.
since="${last_success:-$(read_state first-run)}"
if [ $(( now - since )) -ge $(( STALE_WARN_DAYS * 86400 )) ]; then
  log "WARNING: no update for $(( (now - since) / 86400 )) days; the host has not been idle for ${IDLE_MINUTES} minutes since"
fi

if busy; then
  if [ -n "$(read_state idle-since)" ]; then log "a job is running; idle clock reset"; fi
  rm -f "$STATE_DIR/idle-since"
  exit 0
fi

idle_since="$(read_state idle-since)"
if [ -z "$idle_since" ]; then
  write_state idle-since "$now"
  idle_since="$now"
fi
job_end="$(job_activity)"
[ "$job_end" -gt "$idle_since" ] && idle_since="$job_end"
idle_for=$(( now - idle_since ))
if [ "$idle_for" -lt $(( IDLE_MINUTES * 60 )) ]; then
  exit 0
fi

# Find the runner units BEFORE the final check, so the gap between that check
# and the stop is as small as it can be. A failed listing must not read as "no
# runners": that would update with every runner still taking jobs.
if ! listing="$("$SYSTEMCTL" list-units --type=service --state=active --plain --no-legend "$RUNNER_UNITS")"; then
  log "ERROR: could not list runner units; not updating"
  exit 1
fi
units=()
while IFS= read -r unit; do
  [ -n "$unit" ] && units+=("$unit")
done < <(printf '%s\n' "$listing" | awk 'NF {print $1}')

# Final check, immediately before pausing: the clock proves the past, not now.
# The runner has no drain mode, so a job assigned between this line and the
# stop below cannot be refused; the gap is one process-table read. A job log
# touched since this moment is reported after the stop, so such a loss is
# never silent.
checked_at="$(clock)"
# A standalone assignment, so a failed scan stops the run under set -e. Inside
# `[ "$(...)" ]` the failure would be discarded and the update would go ahead.
if busy; then final_scan="busy"; else final_scan="$(job_activity)"; fi
if [ "$final_scan" = busy ] || [ "$final_scan" -gt "$job_end" ]; then
  rm -f "$STATE_DIR/idle-since"
  log "a job started at the last moment; idle clock reset"
  exit 0
fi

restart_runners() {
  if [ "${#units[@]}" -gt 0 ]; then
    "$SYSTEMCTL" start "${units[@]}" || log "WARNING: could not restart: ${units[*]}"
    log "runners resumed (${#units[@]})"
  fi
}
trap restart_runners EXIT
if [ "${#units[@]}" -gt 0 ]; then
  "$SYSTEMCTL" stop "${units[@]}"
  after_stop="$(job_activity)"
  if [ "$after_stop" -ge "$checked_at" ] && [ "$after_stop" -gt "$job_end" ]; then
    log "WARNING: a job began as the runners were paused and was interrupted; re-run it"
  fi
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

# Stamped at completion, not at start: an hour-long update must not make the
# next one due 23 hours later.
write_state last-success "$(clock)"
rm -f "$STATE_DIR/idle-since"
log "update complete"
if [ -e "$REBOOT_FLAG" ]; then
  # Never reboot unattended: restarting WSL takes every runner down with it.
  log "NOTICE: the update requires a reboot; restart WSL at a quiet moment"
fi
