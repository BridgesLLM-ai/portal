# Back up Portal data

Portal backups protect the work you made, not the whole VPS.

| Backup | Included |
| --- | --- |
| Standard — daily, weekly, monthly | Portal database and settings, projects, uploads, app files, assets, and the keys needed to read saved Portal settings |
| Comprehensive | The same Portal data, plus available agent personality files and Portal-native conversation history as a reference export |

Neither format installs or restores OpenClaw, AI tools, containers, model downloads,
the operating system, or mail. Provider logins and upstream runtime databases are
excluded. Use your VPS provider's snapshot service for whole-server recovery.

## Create and download

Use **Settings → Backups**. Existing schedules use the same data-only runner.
Portal remains online. PostgreSQL uses a consistent database snapshot; project
files are copied live, so pause project edits for a cross-file checkpoint.

The UI reports **Complete** only after archive verification and authenticated
publication. Missing optional agent context is reported in the manifest; it does
not turn a saved project backup into a failure.

Archives contain private files and Portal settings keys. Keep a private,
encrypted off-server copy. Do not attach an archive to an issue.

Retention keeps seven daily, four weekly, three monthly, and three comprehensive
data backups. A retention lock keeps a backup until you explicitly unlock it.
Legacy archives are not pruned by the new runner.

## Verify

Use the installed helper on a private, root-owned copy:

~~~bash
sudo python3 /opt/bridgesllm/portal/backup-data.py verify /absolute/path/to/backup.tar.gz
~~~

This reads the archive, validates its paths and format, and checks the database
dump's checksum without changing installed data. On the original host, the
--require-receipt option additionally authenticates the archive against its
publication receipt and local trust key.

## Restore projects and settings

Install the same Portal version, with the same data layout, first. Save current
work, pause running agents/apps, and use the command shown beside the backup in
Settings:

~~~bash
sudo python3 /opt/bridgesllm/portal/backup-data.py restore /absolute/path/to/backup.tar.gz --confirm
~~~

The helper verifies and stages the archive, loads its database into an isolated
PostgreSQL database, and checks restored project roots before switching data.
Portal and its OpenClaw gateway briefly stop for the switch. The installation,
runtime versions, and service definitions are not restored from the archive.

The previous database and data directories remain in the printed recovery
location. A failed switch attempts to restore them. If recovery itself fails,
service start remains fenced and restore.json identifies the retained databases
and directories for your administrator or agent. Do not delete this checkpoint
until Portal works correctly. Restores need room for both old and staged data.

Saved Portal accounts come from the backup. Provider subscription logins remain
on the destination host; sign in again if restoring to another VPS.

The optional agent-export directory is **reference material**, not an automatic
replacement of a running harness. Import the personality files or conversations
you want after configuring that harness. OpenClaw's runtime database and
provider-internal history are deliberately outside this contract.

## Older full-server archives

Existing full-server archives remain listed as **Legacy server archive**. They
use restore-full.sh, not the data helper. Their original trust key, matching
Portal release, and legacy offline-recovery requirements still apply.
Read the installed restore-full.sh --help before using one.

The old full-server machinery is retained only for compatibility. Normal UI and
scheduled backups no longer enter it.
