# Installer rerun and recovery

Use a trusted installer copy. From the directory containing `install.sh`:

```sh
sudo bash install.sh --status
sudo bash install.sh --recover --dry-run
sudo bash install.sh --recover
```

`--status` is a read-only snapshot, not a service-health check. It reports the
Portal filesystem classification, whether the existing operation lock is held,
known journal/fence paths, and the latest safe root-only installer log by filename.
It does not create the lock, inspect process command lines, print secrets, or
validate journal contents. The latest log is **not necessarily the active
operation's log**. The displayed `tail` command lets you inspect it locally.

If a foreground installer is still open, return to its terminal for progress.
To request that installer's stop, press Ctrl+C there once and wait for its final
result. There is no attach or remote stop command for an unidentified process.
A quiet log does not prove a freeze. Never delete the shared lock file or kill a
PID guessed from a log; the lock's inode is the exclusion boundary.

`--recover` acquires the same lifetime lock and uses the same sealed recovery
owners as ordinary operation admission, then exits without starting a new
install or update. It can restore or finish an interrupted update, reconcile
supported OpenClaw/native transaction states, or finish an interrupted uninstall.
This can change runtime/service state or complete the already-authorized
uninstall. It does not override invalid journals, manual-rescue authority,
backup/restore barriers, or reboot fences. Those refusals keep their recovery
artifacts and require their existing owner or local diagnosis. Dry-run acquires
no admission lock, creates no files, and performs no recovery.

Recovery logs are created privately **after** lock acquisition, without
truncating an older log. A same-name log collision refuses the run. Success means
that supported admission recovery checks completed, not that Portal is healthy
or a fresh installation was completed. If partial files remain, recovery exits 2
and says automatic file repair is unavailable. Choose any subsequent operation
separately.

## What rerun can safely offer

| Filesystem evidence | Available route |
| --- | --- |
| Runtime/configuration passes local attestation | Update or Repair through the existing protected update transaction; live health and further admission checks still apply. |
| Retained-data receipt is present, runtime removed | Reinstall/reconnect only after the existing receipt and exact retained-tree verification pass. |
| Portal path absent | Install starts fresh stages. Review prior logs and database state first; absence is not proof of a fresh host. |
| Empty, incomplete, linked, writable, inconsistent, or otherwise unverified Portal path | Inspect status/logs; recover supported journaled work if present. No automatic fresh-install resume or file-overlay repair. Preserve the tree, database, secrets, and backups for local diagnosis. |

An empty Portal directory is deliberately **not** an installable fresh target.
The database stage runs before runtime deployment and may already have created
credentials; repeating fresh provisioning can rotate the local database user's
password. There is no durable fresh-install receipt authorizing replay of
arbitrary interrupted stages. `--repair` is not a bypass for missing runtime
attestation, and `--install` never replaces a partial directory.

The interactive menu also offers read-only status, journal-only recovery, and
Exit (the default). Partial paths no longer get misleading Update/Repair choices.
Neither the menu nor status claims to know the cause of a prior freeze.

## Existing hosts missing build tools

Older fresh installations could omit compilers when node-pty was prebuilt.
Ordinary updates still require `make`, `g++`, `gcc`, and `python3`; they refuse
before release staging or downtime and never run apt or repair host packages.
New fresh installations converge these tools in the system-package stage,
independently of native-module prebuilts.

If admission names missing build tools, install them as a **separate root
host-maintenance operation**, then retry the signed updater:

```sh
env DEBIAN_FRONTEND=noninteractive NEEDRESTART_MODE=l NEEDRESTART_SUSPEND=1 \
  apt-get update -qq
env DEBIAN_FRONTEND=noninteractive NEEDRESTART_MODE=l NEEDRESTART_SUSPEND=1 \
  apt-get install -y -qq build-essential python3
command -v make g++ gcc python3
systemctl --version
```

The policy suppresses package prompts and the apt needrestart hook; review any
restart/reboot needs separately. Do not remove package-manager locks or change
the host's needrestart configuration. Systemd 249 or newer is required; Ubuntu's
daemon need not be in PATH because admission uses `systemctl --version`.
