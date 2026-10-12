#!/usr/bin/env bash
#
# Install (or, with --uninstall, remove) the weekly runner cleanup as a macOS
# LaunchDaemon that runs AS THE RUNNER USER. Run it with sudo:
#
#   sudo RUNNER_USER=ghrunner runner-host/install-macos-daemon.sh
#   sudo runner-host/install-macos-daemon.sh --uninstall
#
# Use this, not install-macos.sh, when the runners live under another macOS
# user (/Users/ghrunner/actions-runner-1, ...). install-macos.sh makes a per-user
# LaunchAgent that runs as you, and a runner folder owned by someone else can be
# read through the staff group but not cleaned. A LaunchDaemon in
# /Library/LaunchDaemons runs without anyone logged in and can run as any user.
#
# The job runs as RUNNER_USER, never as root: it removes things in that user's
# own folders and nothing else. The script itself is installed root-owned under
# /usr/local/libexec/crossroads-ci, so the runner user, whose CI jobs run
# arbitrary code, cannot edit what runs on its behalf weekly. Re-run after
# pulling to update it.
#
# Weekly, Sundays 04:00, idle-only: see fleet-runner-clean.sh. Settings
# (WORK_RETAIN_DAYS, NPM_CACHE_MAX_MB, DOCKER=, ...) are read from the
# environment of this run and stored in the plist. Logs: /var/log/crossroads-ci.
#
# ROOT is a test hook that prefixes every installed path.
set -euo pipefail

here="$(cd "$(dirname "$0")" && pwd)"
[ "$(uname -s)" = "Darwin" ] || { echo "this installer is for macOS; on Linux use runner-host/install.sh" >&2; exit 1; }
[ "$(id -u)" -eq 0 ] || { echo "run with sudo: it installs a system LaunchDaemon" >&2; exit 1; }

label=com.crossroads.fleet-runner-clean.daemon
root="${ROOT:-}"
libexec="$root/usr/local/libexec/crossroads-ci"
plist="$root/Library/LaunchDaemons/$label.plist"
logs="$root/var/log/crossroads-ci"

if [ "${1:-}" = "--uninstall" ]; then
  launchctl bootout "system/$label" 2>/dev/null || true
  rm -f "$plist" "$libexec/fleet-runner-clean"
  echo "removed $label. Logs in $logs were kept."
  exit 0
fi

runner_user="${RUNNER_USER:-}"
[ -n "$runner_user" ] || { echo "set RUNNER_USER to the macOS user that owns the runners, for example: sudo RUNNER_USER=ghrunner $0" >&2; exit 1; }
case "$runner_user" in
  root) echo "RUNNER_USER must not be root" >&2; exit 1 ;;
  *[!A-Za-z0-9._-]*) echo "RUNNER_USER has characters a user name does not: $runner_user" >&2; exit 1 ;;
esac
id "$runner_user" >/dev/null 2>&1 || { echo "no such user: $runner_user" >&2; exit 1; }

# XML-escape a value for a plist <string>.
xml() { sed -e 's/&/\&amp;/g' -e 's/</\&lt;/g' -e 's/>/\&gt;/g' <<<"$1"; }

mkdir -p "$libexec" "$logs" "$(dirname "$plist")"
install -m 0755 "$here/fleet-runner-clean.sh" "$libexec/fleet-runner-clean"
chown root:wheel "$libexec" "$libexec/fleet-runner-clean"
chown "$runner_user" "$logs"

# The default looks only in the runner user's own home; override with RUNNER_DIRS.
RUNNER_DIRS="${RUNNER_DIRS-/Users/$runner_user/actions-runner*}"
env_xml=""
for v in RUNNER_DIRS TEMP_RETAIN_DAYS WORK_RETAIN_DAYS NPM_CACHE_MAX_MB WAIT_MINUTES DOCKER DOCKER_UNTIL; do
  if [ -n "${!v+x}" ]; then
    env_xml="$env_xml    <key>$v</key><string>$(xml "${!v}")</string>
"
  fi
done

{
  echo '<?xml version="1.0" encoding="UTF-8"?>'
  echo '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">'
  echo '<plist version="1.0"><dict>'
  echo "  <key>Label</key><string>$label</string>"
  echo "  <key>UserName</key><string>$(xml "$runner_user")</string>"
  echo '  <key>ProgramArguments</key><array>'
  echo '    <string>/usr/local/libexec/crossroads-ci/fleet-runner-clean</string>'
  echo '  </array>'
  echo '  <key>StartCalendarInterval</key><dict>'
  echo '    <key>Weekday</key><integer>0</integer>'
  echo '    <key>Hour</key><integer>4</integer>'
  echo '    <key>Minute</key><integer>0</integer>'
  echo '  </dict>'
  echo '  <key>EnvironmentVariables</key><dict>'
  echo '    <key>PATH</key><string>/usr/bin:/bin:/usr/sbin:/sbin:/usr/local/bin:/opt/homebrew/bin</string>'
  printf '%s' "$env_xml"
  echo '  </dict>'
  echo '  <key>ProcessType</key><string>Background</string>'
  echo '  <key>LowPriorityIO</key><true/>'
  echo '  <key>Nice</key><integer>10</integer>'
  echo "  <key>StandardOutPath</key><string>$(xml "/var/log/crossroads-ci/$label.log")</string>"
  echo "  <key>StandardErrorPath</key><string>$(xml "/var/log/crossroads-ci/$label.log")</string>"
  echo '</dict></plist>'
} > "$plist"
# launchd refuses a system job whose plist is not root-owned and writable only by root.
chmod 0644 "$plist"
chown root:wheel "$plist"
plutil -lint "$plist" >/dev/null

launchctl bootout "system/$label" 2>/dev/null || true
launchctl bootstrap system "$plist"
echo "installed $label, running as $runner_user"
echo
echo "Run it now to check it:"
echo "  sudo launchctl kickstart -k system/$label"
echo "  tail -f /var/log/crossroads-ci/$label.log"
