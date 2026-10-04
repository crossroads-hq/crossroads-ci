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

It also installs `fleet-tmp-clean.timer` and masks `tmp.mount` (see below).

`sudo runner-host/install.sh --uninstall` removes it, restores Ubuntu's
timers and unmasks `tmp.mount`. It waits for an update already in progress
rather than killing apt.

## Stale scratch folders in /tmp

CI jobs create scratch folders in `/tmp` and never remove them when a job
dies (out of disk, cancelled, timed out):

- **crossroads-ui:** `crossroads-*`, for example `crossroads-export-install-*`
  or `crossroads-dt1-react18-*`. Some hold a whole npm cache.
- **crossroads-evolution:** embedded-Postgres data directories,
  `evolution-test-pg-*` and `evolution-a11y-pg-*`, 66–127 MB each.

On 2026-10-04, 73 leftover Postgres folders filled `/tmp` to 98%. That
`/tmp` is a 4.4 GB tmpfs (RAM-backed), separate from the 1 TB root disk.
Every job on every runner then failed with `ENOSPC: no space left on device`.

`fleet-tmp-clean` runs once a day (`fleet-tmp-clean.timer`, plus 20 minutes
after boot). It removes top-level entries in `/tmp` matching
`crossroads-* evolution-*-pg-*` (`PATTERNS`). It never removes a folder in
use:

- **Recently changed:** if anything inside it changed within `RETAIN_HOURS`
  (24), it stays.
- **Live Postgres:** a Postgres data directory stays while its postmaster is
  running, however idle that server is. That means the PID in
  `postmaster.pid` is running *and* has this directory on its command line
  (`-D <dir>`). A reused PID after a crash doesn't count.

Each run logs how many it removed and kept, and how much space it freed.
Settings go in `/etc/default/fleet-tmp-clean` (`TMP_DIR`, `PATTERNS`,
`RETAIN_HOURS`). The shared npm cache in the runner user's home is left alone,
because a running job may be using it.

### /tmp on the root disk

A 4.4 GB tmpfs fills within a day of a few failed runs, faster than a daily
clean can keep up with. It also runs out of files before it runs out of
bytes: the tmpfs allows 1,048,576 inodes, and one `evolution-test-pg-*`
folder holds up to 166,000. On the evening of 2026-10-04, 21 folders, all
under two hours old, used 755,000 of them with `/tmp` only 51% full, and
jobs failed with the same `ENOSPC`. So `install.sh` also masks systemd's
`tmp.mount`.
From the next WSL restart, `/tmp` is a plain directory on the root disk
instead of a RAM-backed tmpfs. Until that restart nothing changes: the
mounted `/tmp` and the jobs using it are left alone, and `install.sh` says
which of the two states the host is in.

**How much room that is.** Inside WSL the root disk reports 1007 GB, but it
is a virtual disk: one file, `ext4.vhdx`, on the Windows `C:` volume. On
2026-10-04 that file was 75 GB, fully allocated and not sparse, and `C:` had
83 GB free of 237 GB. So `/tmp` can grow by about 100 GB (20 GB of slack
inside the file, then the 83 GB), not 900 GB, and
filling `C:` stalls the whole VM and Windows with it. Both cleaners stay for
that reason. To read the real numbers, in PowerShell on the Windows side:

```powershell
Get-Volume C
Get-ChildItem "$env:LOCALAPPDATA\wsl" -Recurse -Filter ext4.vhdx
```

Deleting files in Linux does **not** give the space back to `C:`. The disk
is not sparse (`sparseVhd=true` in `.wslconfig` applies only to disks created
after it was set), so the file only grows. Tested 2026-10-04: with Linux using
55 GB, the file stayed at 74.975 GB allocated through a 2 GB write, its
deletion and `fstrim` (which trimmed 925 GiB on its first run), and `C:` free
space did not move. The 20 GB between what Linux uses and the file's size is
room already taken from `C:`: new scratch data fills that first, and only
then does the file grow. Getting space back needs the disk compacted with
WSL shut down, which has not been done. Do not reach for
`wsl --manage Ubuntu --set-sparse true`: recent WSL releases refuse it
because of a data-corruption risk unless forced with `--allow-unsafe`
([microsoft/WSL#13075](https://github.com/microsoft/WSL/issues/13075)).
WSL's source has a one-time `wsl --manage <distro> --compact`, but the help
of the host's WSL 2.7.12 does not list it, so check `wsl --help` first.

**What cleans it.** A disk-backed `/tmp` no longer empties at restart.

- `fleet-tmp-clean` removes the known large folders after 24 hours, as above.
- Ubuntu's own rule (`q /tmp 1777 root root 10d` in
  `/usr/lib/tmpfiles.d/tmp.conf`, run daily by
  `systemd-tmpfiles-clean.timer`) cleans eligible inactive entries under a
  10-day policy. It weighs access, modification and change times, and skips
  excluded or locked entries, so it is not a deadline counted from creation.

**Restarting WSL to apply it.** This takes every runner offline and discards
what is in the tmpfs. In WSL, as root:

1. Stop new update runs: `systemctl stop fleet-idle-update.timer`.
2. Wait for a running update to end. The update service pauses the runners
   itself while apt runs and restarts them when it exits, so "no job is
   running" does not prove the host is idle. It is a oneshot service, shown
   as `activating`, never `active`, while it runs. Go on only when

   ```bash
   systemctl show fleet-idle-update.service -p ActiveState -p MainPID -p Job
   ```

   prints `ActiveState=inactive`, `MainPID=0` and an empty `Job=`. On
   `activating`, `deactivating` or a job number, wait. On anything else, or
   if the command fails, start the timer again and find out why first.
3. Stop the runners one at a time, each when it has no job. Waiting for the
   whole fleet to be idle at once does not work on a busy day: on 2026-10-04
   three 12 to 17 minute jobs overlapped for longer than the wait. A stopped
   runner takes no new job, so this always finishes.

   ```bash
   if listing="$(systemctl list-units --type=service --state=active \
        --plain --no-legend 'actions.runner.*')" && [ -n "$listing" ]; then
     awk '{print $1}' <<<"$listing" > /root/fleet-units
     cat /root/fleet-units
   else
     echo "could not list the runner units: stop here" >&2
   fi
   ```

   Go on only if it printed every runner you expect (four on the fleet host
   today). A failed or short listing would leave a runner out of the list,
   still running and free to take a job during the shutdown.

   Keep that list: a glob such as `'actions.runner.*'` only matches units
   systemd has loaded, so it will not start a runner that is stopped. Then,
   for each unit in the list, when none of the processes in its control group
   (`systemctl show <unit> -p ControlGroup --value`, then
   `/sys/fs/cgroup<that>/cgroup.procs`) is a `Runner.Worker`, run
   `systemctl stop <unit>`. Repeat until all are stopped.
4. Immediately before shutting down, repeat the check in step 2, then run
   this. An empty answer is not enough: `pgrep` exits 1 for "nothing
   matched" and 2 or 3 when it could not look, and a failed `systemctl` also
   prints nothing.

   ```bash
   ok=yes
   pgrep -f Runner.Worker >/dev/null; [ $? -eq 1 ] || ok=no
   pgrep -x 'apt-get|dpkg' >/dev/null; [ $? -eq 1 ] || ok=no
   if left="$(systemctl list-units --type=service --state=active \
        --plain --no-legend 'actions.runner.*')"; then
     [ -z "$left" ] || ok=no
   else
     ok=no
   fi
   echo "safe to shut down: $ok"
   ```

   Shut down only on `yes`. On `no`,
   `systemctl start $(cat /root/fleet-units) fleet-idle-update.timer`
   and start again.
5. In Windows: `wsl --shutdown`, then run the "WSL AutoStart" scheduled task,
   which holds the VM open. The runner services and timers start at boot.
6. Leave the host alone for five minutes, then check:

   ```bash
   findmnt -T /tmp -no SOURCE,FSTYPE,TARGET
   findmnt -T / -no SOURCE,FSTYPE,TARGET
   ```

   The two lines must match. `-T` matters: once `/tmp` is a plain directory,
   `findmnt /tmp` prints nothing.

To go back: `sudo systemctl unmask tmp.mount` and restart the same way.

The fleet host was moved this way on 2026-10-04: `/tmp` went from 1,048,576
inodes on tmpfs to the root disk's 67 million.

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
