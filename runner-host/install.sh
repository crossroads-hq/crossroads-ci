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
# replaces them with fleet-idle-update.timer.
set -euo pipefail

here="$(cd "$(dirname "$0")" && pwd)"
[ "$(id -u)" -eq 0 ] || { echo "run as root (sudo)" >&2; exit 1; }

apt_timers=(apt-daily.timer apt-daily-upgrade.timer)
no_periodic=/etc/apt/apt.conf.d/99-fleet-no-periodic
# Runners never prune their _diag logs (8,201 files, 2.1 GB on 2026-10-01).
# systemd-tmpfiles-clean.timer, already daily on Ubuntu, applies this rule.
diag_rule=/etc/tmpfiles.d/fleet-runner-diag.conf
DIAG_RETAIN_DAYS="${DIAG_RETAIN_DAYS:-14}"

if [ "${1:-}" = "--uninstall" ]; then
  systemctl disable --now fleet-idle-update.timer 2>/dev/null || true
  # Disabling the timer does not end a run already in progress. Wait for it
  # rather than stop it: killing apt mid-upgrade can leave dpkg half-configured.
  while systemctl is-active --quiet fleet-idle-update.service; do
    echo "an update is in progress; waiting for it to finish"
    sleep 10
  done
  rm -f /etc/systemd/system/fleet-idle-update.service \
        /etc/systemd/system/fleet-idle-update.timer \
        /usr/local/sbin/fleet-idle-update "$no_periodic" "$diag_rule"
  systemctl unmask "${apt_timers[@]}"
  systemctl daemon-reload
  systemctl enable --now "${apt_timers[@]}"
  echo "removed; Ubuntu's apt timers are back. /etc/default/fleet-idle-update and /var/lib/fleet-idle-update were kept."
  exit 0
fi

install -m 0755 "$here/fleet-idle-update.sh" /usr/local/sbin/fleet-idle-update
install -m 0644 "$here/fleet-idle-update.service" "$here/fleet-idle-update.timer" /etc/systemd/system/
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
systemctl daemon-reload
systemctl enable --now fleet-idle-update.timer

echo "installed."
systemctl list-timers --no-pager --all 'fleet-idle-update*' '*apt*'
