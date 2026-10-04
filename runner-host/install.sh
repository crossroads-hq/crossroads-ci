#!/usr/bin/env bash
#
# Install (or, with --uninstall, remove) idle-only package updates on a
# runner host. Run as root on the WSL Ubuntu that hosts the fleet runners:
#
#   sudo runner-host/install.sh
#   sudo runner-host/install.sh --uninstall   # restores Ubuntu's own timers
#
# Installing masks apt-daily.timer and apt-daily-upgrade.timer, whose
# unscheduled runs hold the dpkg lock under CI jobs (crossroads-ci#50), and
# replaces them with fleet-idle-update.timer. It also installs
# fleet-tmp-clean.timer, which removes stale CI scratch folders from /tmp daily,
# and masks tmp.mount, so that from the next WSL restart /tmp is a directory on
# the root disk instead of a RAM-backed tmpfs.
set -euo pipefail

here="$(cd "$(dirname "$0")" && pwd)"
[ "$(id -u)" -eq 0 ] || { echo "run as root (sudo)" >&2; exit 1; }

apt_timers=(apt-daily.timer apt-daily-upgrade.timer)
no_periodic=/etc/apt/apt.conf.d/99-fleet-no-periodic
# Runners never prune their _diag logs (8,201 files, 2.1 GB on 2026-10-01).
# systemd-tmpfiles-clean.timer, already daily on Ubuntu, applies this rule.
diag_rule=/etc/tmpfiles.d/fleet-runner-diag.conf
DIAG_RETAIN_DAYS="${DIAG_RETAIN_DAYS:-14}"

# Return once no update is running or queued. fleet-idle-update.service is
# Type=oneshot without RemainAfterExit: it is "activating" while its script
# runs and never "active", so `systemctl is-active` cannot see a running update.
# A state that cannot be read, or one not listed here, is unknown: stop.
wait_for_updater() {
  local props state pid job
  while :; do
    props="$(systemctl show fleet-idle-update.service -p ActiveState -p MainPID -p Job)" \
      || { echo "cannot read the state of fleet-idle-update.service" >&2; exit 1; }
    state="$(sed -n 's/^ActiveState=//p' <<<"$props")"
    pid="$(sed -n 's/^MainPID=//p' <<<"$props")"
    job="$(sed -n 's/^Job=//p' <<<"$props")"
    case "$pid" in ''|*[!0-9]*) echo "fleet-idle-update.service: no MainPID in: $props" >&2; exit 1;; esac
    case "$state" in
      # failed: the last update ended badly, but it has ended.
      inactive|failed) if [ "$pid" -eq 0 ] && [ -z "$job" ]; then return 0; fi ;;
      activating|deactivating) ;;
      *) echo "fleet-idle-update.service is in an unexpected state: ${state:-none}" >&2; exit 1;;
    esac
    echo "an update is in progress; waiting for it to finish"
    sleep "${UPDATER_POLL_SECONDS:-10}"
  done
}

# Where a path's files are stored. -T, because /tmp on the root disk is a plain
# directory, not a mount point, and findmnt without it would report nothing.
backing_fs() {
  local fs
  if ! fs="$(findmnt -T "$1" -no SOURCE,FSTYPE,TARGET)" || [ -z "$fs" ]; then
    echo "cannot tell which filesystem holds $1" >&2
    exit 1
  fi
  printf '%s\n' "$fs"
}

if [ "${1:-}" = "--uninstall" ]; then
  systemctl disable --now fleet-idle-update.timer fleet-tmp-clean.timer 2>/dev/null || true
  # Disabling the timer does not end a run already in progress. Wait for it
  # rather than stop it: killing apt mid-upgrade can leave dpkg half-configured.
  wait_for_updater
  rm -f /etc/systemd/system/fleet-idle-update.service \
        /etc/systemd/system/fleet-idle-update.timer \
        /usr/local/sbin/fleet-idle-update "$no_periodic" "$diag_rule" \
        /etc/systemd/system/fleet-tmp-clean.service \
        /etc/systemd/system/fleet-tmp-clean.timer \
        /usr/local/sbin/fleet-tmp-clean
  systemctl unmask "${apt_timers[@]}" tmp.mount
  systemctl daemon-reload
  systemctl enable --now "${apt_timers[@]}"
  echo "removed; Ubuntu's apt timers are back. /etc/default/fleet-idle-update and /var/lib/fleet-idle-update were kept."
  echo "/tmp becomes a tmpfs again at the next WSL restart."
  exit 0
fi

install -m 0755 "$here/fleet-idle-update.sh" /usr/local/sbin/fleet-idle-update
install -m 0644 "$here/fleet-idle-update.service" "$here/fleet-idle-update.timer" /etc/systemd/system/
# Failed and cancelled jobs leave scratch folders (some with a whole npm cache)
# in /tmp; on 2026-10-03 they filled the host and every job failed with ENOSPC.
install -m 0755 "$here/fleet-tmp-clean.sh" /usr/local/sbin/fleet-tmp-clean
install -m 0644 "$here/fleet-tmp-clean.service" "$here/fleet-tmp-clean.timer" /etc/systemd/system/
[ -e /etc/default/fleet-idle-update ] || install -m 0644 "$here/fleet-idle-update.default" /etc/default/fleet-idle-update

# Belt and braces: the masked timers are the trigger, these settings are what
# they would have done.
cat > "$no_periodic" <<'CONF'
// Managed by crossroads-ci runner-host/install.sh: packages update only
// through fleet-idle-update.timer, when every runner is idle.
APT::Periodic::Update-Package-Lists "0";
APT::Periodic::Unattended-Upgrade "0";
CONF

cat > "$diag_rule" <<CONF
# Managed by crossroads-ci runner-host/install.sh. Prune runner diagnostic
# logs older than ${DIAG_RETAIN_DAYS} days. The newest job log, which
# fleet-idle-update reads, is always recent. The runner's own blocks/ and
# pages/ caches are left alone.
e /home/*/actions-runner*/_diag - - - ${DIAG_RETAIN_DAYS}d
x /home/*/actions-runner*/_diag/blocks
x /home/*/actions-runner*/_diag/pages
CONF

systemctl disable --now "${apt_timers[@]}" 2>/dev/null || true
systemctl mask "${apt_timers[@]}"
# Ubuntu mounts /tmp as a tmpfs of half the RAM (4.4 GB here), which leftover
# scratch folders filled on 2026-10-04. Masked, /tmp is a directory on the root
# disk from the next WSL restart. No --now: the mounted /tmp, and the jobs
# using it, stay as they are until then.
systemctl mask tmp.mount
systemctl daemon-reload
systemctl enable --now fleet-idle-update.timer fleet-tmp-clean.timer

echo "installed."
# Plain assignments, so a failed lookup stops the script here (set -e) rather
# than comparing two empty strings as equal.
tmp_fs="$(backing_fs /tmp)"
root_fs="$(backing_fs /)"
if [ "$tmp_fs" = "$root_fs" ]; then
  echo "/tmp is on the root disk."
else
  echo "/tmp is still a separate filesystem ($tmp_fs)."
  echo "It moves to the root disk at the next WSL restart; see runner-host/README.md for how to pause the fleet first."
fi
systemctl list-timers --no-pager --all 'fleet-idle-update*' 'fleet-tmp-clean*' '*apt*'
