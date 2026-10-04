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
  newest runner job log (`_diag/Worker_*.log`, written throughout each job;
  an unreadable log folder stops the run rather than reading as idle),
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

It also installs `/etc/tmpfiles.d/fleet-runner-diag.conf`, which prunes runner
diagnostic logs older than 14 days (`DIAG_RETAIN_DAYS`) through Ubuntu's
daily `systemd-tmpfiles-clean.timer`. The runners never prune `_diag`
themselves: 8,201 files and 2.1 GB on 2026-10-01. The runners' `blocks/` and
`pages/` caches are excluded.

It also installs `fleet-tmp-clean.timer` (see below).

`sudo runner-host/install.sh --uninstall` removes it and restores Ubuntu's
timers. It waits for an update already in progress rather than killing apt.

## Stale scratch folders in /tmp

CI jobs create scratch folders in `/tmp`, such as `crossroads-export-install-*`
or `crossroads-dt1-react18-*`. Some hold a complete npm cache. A job that dies
(out of disk, cancelled, timed out) never removes its own. On 2026-10-03 they
filled the host, and every job on every runner failed with `ENOSPC: no space
left on device`.

`fleet-tmp-clean` runs once a day (`fleet-tmp-clean.timer`, plus 20 minutes
after boot). It removes top-level entries in `/tmp` matching `crossroads-*`
only when nothing inside them has changed for 24 hours (`RETAIN_HOURS`). A
folder a job is still writing to is never touched. It logs how many it removed
and kept, and how much space it freed. Settings go in
`/etc/default/fleet-tmp-clean` (`TMP_DIR`, `PATTERNS`, `RETAIN_HOURS`). It
leaves the shared npm cache in the runner user's home alone, because a running
job may be using it.

To free space now rather than wait for the timer:

```bash
sudo systemctl start fleet-tmp-clean.service
journalctl -u fleet-tmp-clean -n 5
```

`node --test runner-host/tmp-clean.test.js` runs the script against a scratch
directory with backdated files. CI runs it with the other runner-host tests.

### Watch it

```bash
systemctl list-timers fleet-idle-update.timer
journalctl -u fleet-idle-update -n 50
```

### Tests

`node --test runner-host/idle-update.test.js` runs the script against stub
`systemctl`, `apt-get` and busy-check commands with a fake clock. CI runs it
with shellcheck in the "Scripts and profiles" job.
