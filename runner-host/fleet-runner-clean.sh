#!/usr/bin/env bash
#
# Weekly housekeeping for the runners on this host, done only while the host is
# idle:
#
#   - _work/_temp entries older than TEMP_RETAIN_DAYS;
#   - checkouts under _work that nothing has touched for WORK_RETAIN_DAYS (the
#     runner clones them again on the next job);
#   - local branches in the checkouts that remain, only those git itself calls
#     fully merged (`git branch -d`, never -D), never the checked-out branch,
#     main or master;
#   - the runner user's npm cache when it has grown past NPM_CACHE_MAX_MB;
#   - stopped containers, unused networks, dangling images and build cache, if
#     Docker is installed (never volumes, never images in use).
#
# Why it waits for idle: a job assigned to a runner while its directory is
# being cleaned fails in ways that look like the job's own fault. The runner has
# no drain mode, so the only safe moment is when no Runner.Worker exists. The
# script polls for WAIT_MINUTES for such a moment, and checks again before each
# runner and each removal; if a job starts, it stops where it is. A host that
# is never idle for that long is logged as a WARNING and left for next week.
#
# _diag is left to /etc/tmpfiles.d/fleet-runner-diag.conf and /tmp to
# fleet-tmp-clean; this covers what neither does.
#
# The directories are written to by CI job code, and this runs as root, so git
# is run as each checkout's owner with hooks disabled, never as root.
#
# Installed by install.sh with fleet-runner-clean.timer (weekly). Settings come
# from /etc/default/fleet-runner-clean. Commands are overridable through the
# environment so the logic can be tested without root or Docker
# (runner-host/runner-clean.test.js).
set -euo pipefail

RUNNER_DIRS="${RUNNER_DIRS:-/home/*/actions-runner*}"
TEMP_RETAIN_DAYS="${TEMP_RETAIN_DAYS:-3}"
WORK_RETAIN_DAYS="${WORK_RETAIN_DAYS:-14}"
NPM_CACHE_MAX_MB="${NPM_CACHE_MAX_MB:-4096}"
WAIT_MINUTES="${WAIT_MINUTES:-120}"
POLL_SECONDS="${POLL_SECONDS:-60}"
BUSY_CMD="${BUSY_CMD:-pgrep -f Runner.Worker}"
# Empty disables Docker cleanup.
DOCKER="${DOCKER-docker}"
DOCKER_UNTIL="${DOCKER_UNTIL:-168h}"

for v in TEMP_RETAIN_DAYS WORK_RETAIN_DAYS NPM_CACHE_MAX_MB WAIT_MINUTES POLL_SECONDS; do
  case "${!v}" in ''|*[!0-9]*) echo "$v must be a whole number" >&2; exit 2;; esac
done
[ "$WORK_RETAIN_DAYS" -ge 1 ] || { echo "WORK_RETAIN_DAYS must be at least 1" >&2; exit 2; }
[ "$TEMP_RETAIN_DAYS" -ge 1 ] || { echo "TEMP_RETAIN_DAYS must be at least 1" >&2; exit 2; }

log() { printf 'fleet-runner-clean: %s\n' "$*"; }
# shellcheck disable=SC2086 # BUSY_CMD is a command line, split on purpose
busy() { $BUSY_CMD >/dev/null 2>&1; }

# Stop, successfully, the moment a job is running: what is left waits a week.
ensure_idle() {
  if busy; then
    log "a job started; stopping here, the rest waits for the next run"
    summary
    exit 0
  fi
}

removed=0 freed_kb=0 branches=0 caches=0
summary() {
  log "removed $removed folder(s), pruned $branches local branch(es), cleared $caches cache(s); freed $((freed_kb / 1024)) MB"
}

# Run a command as the owner of $1 when running as root, so a checkout's own
# configuration is never read with root's privileges.
as_owner() {
  local path="$1" user
  shift
  user="$(stat -c %U "$path")"
  if [ "$(id -u)" -eq 0 ] && [ "$user" != root ]; then
    runuser -u "$user" -- "$@"
  else
    "$@"
  fi
}

# Remove $1 and count what it freed.
remove() {
  local size_kb
  size_kb="$(du -sk "$1" 2>/dev/null | cut -f1)"
  if rm -rf -- "$1"; then
    removed=$((removed + 1))
    freed_kb=$((freed_kb + ${size_kb:-0}))
  else
    log "could not remove $1" >&2
  fi
}

# True when anything inside $1 changed within $2 days, or cannot be read.
recently_changed() {
  [ -n "$(find "$1" -mtime "-$2" -print -quit 2>/dev/null || echo unreadable)" ]
}

prune_branches() {
  local repo="$1" current b
  as_owner "$repo" git -c core.hooksPath=/dev/null -c safe.directory="$repo" -C "$repo" rev-parse --git-dir >/dev/null 2>&1 || return 0
  current="$(as_owner "$repo" git -c core.hooksPath=/dev/null -c safe.directory="$repo" -C "$repo" symbolic-ref --short -q HEAD || true)"
  while IFS= read -r b; do
    [ -n "$b" ] || continue
    [ "$b" = "$current" ] && continue
    case "$b" in main|master) continue ;; esac
    # -d, not -D: git refuses a branch that is not merged.
    if as_owner "$repo" git -c core.hooksPath=/dev/null -c safe.directory="$repo" -C "$repo" branch -d -- "$b" >/dev/null 2>&1; then
      branches=$((branches + 1))
    fi
  done < <(as_owner "$repo" git -c core.hooksPath=/dev/null -c safe.directory="$repo" -C "$repo" for-each-ref --format='%(refname:short)' refs/heads 2>/dev/null)
}

clean_runner() {
  local dir="$1" work="$1/_work" entry repo home cache mb
  ensure_idle

  if [ -d "$work/_temp" ]; then
    while IFS= read -r -d '' entry; do
      ensure_idle
      remove "$entry"
    done < <(find "$work/_temp" -mindepth 1 -maxdepth 1 -mtime "+$TEMP_RETAIN_DAYS" -print0)
  fi

  if [ -d "$work" ]; then
    while IFS= read -r -d '' entry; do
      # The top-level mtime is only the last time a name was added or removed
      # in it; a long job can write deep inside for days.
      if recently_changed "$entry" "$WORK_RETAIN_DAYS"; then continue; fi
      ensure_idle
      remove "$entry"
    done < <(find "$work" -mindepth 1 -maxdepth 1 -type d ! -name '_*' -mtime "+$WORK_RETAIN_DAYS" -print0)

    # <owner>/<repo> checkouts that remain: _work/<repo>/<repo>/.git
    for repo in "$work"/*/*/; do
      [ -e "${repo}.git" ] || continue
      ensure_idle
      prune_branches "${repo%/}"
    done
  fi

  home="$(dirname "$dir")"
  cache="$home/.npm/_cacache"
  if [ -d "$cache" ]; then
    mb=$(( $(du -sk "$cache" | cut -f1) / 1024 ))
    if [ "$mb" -gt "$NPM_CACHE_MAX_MB" ]; then
      ensure_idle
      remove "$cache"
      caches=$((caches + 1))
      log "cleared the npm cache in $home (${mb} MB, limit ${NPM_CACHE_MAX_MB} MB)"
    fi
  fi
}

# Wait for the host to go idle, but not for ever.
waited=0
while busy; do
  if [ "$waited" -ge $(( WAIT_MINUTES * 60 )) ]; then
    log "WARNING: the host was not idle for ${WAIT_MINUTES} minutes; nothing cleaned this week"
    exit 0
  fi
  sleep "$POLL_SECONDS"
  waited=$((waited + POLL_SECONDS))
done

# Runners home directories are a glob of a few folders.
# shellcheck disable=SC2086
for dir in $RUNNER_DIRS; do
  [ -d "$dir" ] || continue
  clean_runner "$dir"
done

# Docker is per host, not per runner. Checked again just before: a job may have
# started while the runners were being cleaned.
if [ -n "$DOCKER" ] && command -v "$DOCKER" >/dev/null 2>&1; then
  ensure_idle
  if "$DOCKER" system prune -f --filter "until=$DOCKER_UNTIL" >/dev/null 2>&1; then
    log "pruned Docker objects older than $DOCKER_UNTIL"
  else
    log "WARNING: docker system prune failed" >&2
  fi
fi

summary
