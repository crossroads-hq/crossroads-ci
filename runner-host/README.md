# Runner host

Setup that lives on the machine hosting the self-hosted fleet runners: the
WSL2 Ubuntu on the Windows box `runner`, reached with `ssh runner`.

## Idle-only package updates

Ubuntu's `apt-daily` timers update packages on their own schedule and hold the
dpkg lock for minutes. A CI job that reaches `playwright install-deps` in that
window fails before any test runs ([#50](https://github.com/crossroads-hq/crossroads-ci/issues/50)).

`fleet-idle-update` replaces those timers. Every 10 minutes it checks whether
any runner is executing a job (a `Runner.Worker` process):

- A job is running: the idle clock resets.
- Idle: idle time is counted from the later of the first idle poll and the
  newest runner job log (`_diag/Worker_*.log`, written throughout each job),
  so a job that starts and ends between two polls still counts. Only after
  **`IDLE_MINUTES` (default 30) of unbroken idle** does it update, at most once
  every **`MIN_INTERVAL_HOURS` (default 24)**, measured from when the last
  update finished.
- To update, it lists the runner units (aborting if that fails), re-checks
  for a job, pauses the runner services so none can start mid-update (GitHub
  queues jobs meanwhile), runs `apt-get update` and `upgrade`, and resumes the
  runners, even if the update fails. The runner has no drain mode, so a job
  assigned in the instant between that last check and the pause can still be
  interrupted; the log says so if it happens.
- It never reboots. A pending reboot is logged for you to do at a quiet moment.
- It logs a warning once `STALE_WARN_DAYS` (default 7) pass without an update,
  counted from the first run on a host that has never managed one.
- The service allows 100 minutes (`TimeoutStartSec`), covering both apt steps
  at the default `UPDATE_TIMEOUT_MINUTES`; raise both together.

### Install

On the runner host, from a checkout of this repository:

```bash
sudo runner-host/install.sh
```

This masks `apt-daily.timer` and `apt-daily-upgrade.timer`, turns off apt's
periodic settings, installs the script, service and timer, and writes the
defaults to `/etc/default/fleet-idle-update` (edit them there; reinstalling
never overwrites that file).

`sudo runner-host/install.sh --uninstall` removes it and restores Ubuntu's
timers. It waits for an update already in progress rather than killing apt.

### Watch it

```bash
systemctl list-timers fleet-idle-update.timer
journalctl -u fleet-idle-update -n 50
```

### Tests

`node --test runner-host/idle-update.test.js` runs the script against stub
`systemctl`, `apt-get` and busy-check commands with a fake clock. CI runs it
with shellcheck in the "Scripts and profiles" job.
