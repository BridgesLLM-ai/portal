# Backup and recovery

Portal backups are recovery artifacts, not ordinary exports. They contain
private project files, application data, database records, mail state, and
agent state in plaintext inside an authenticated archive. Store them like root
credentials: restrict access, encrypt off-host copies, and never attach one to
a public issue.

## Choose the right backup

The Dashboard offers two useful classes of backup:

- **Standard** (`daily`, `weekly`, or `monthly`) is an online data snapshot.
  Portal and OpenClaw remain available while it runs. It is useful for
  preserving data, but it is not the supported whole-host restore point because
  running services and databases were not fenced as one transaction.
- **Comprehensive** briefly fences the affected services and databases so the
  archive can satisfy the full restore contract. Use this before host
  maintenance or any operation for which the Dashboard promises rollback.

A recent filename is not proof that either backup completed. Use the status the
Portal reports after authenticated archive inspection:

- **Complete** means every required component was captured and the archive
  passed its integrity and authentication contract.
- **Incomplete — salvage only** means one or more required components were
  omitted. The Portal names the omitted components. You may download the
  archive for manual recovery, but it cannot authorize an update, maintenance
  action, or supported full restore.
- **Unclassified** is a legacy archive without a current authenticated
  classification. Treat it as unusable until the installed verifier accepts
  it; age and size alone do not make it safe.

Retention lock is separate from completeness. Locking an incomplete archive
prevents automatic deletion; it does not turn it into a complete backup.

## Verify before relying on an archive

Run verification on the host that owns the backup trust key:

```bash
sudo /opt/bridgesllm/portal/backup-full.sh \
  --verify-archive /absolute/path/to/portal-....tar.gz
```

For a supported full restore, use the stricter restore admission check. It
accepts comprehensive archives only:

```bash
sudo /opt/bridgesllm/portal/restore-full.sh \
  --verify-archive /absolute/path/to/portal-comprehensive-....tar.gz
```

Verification checks the signed inventory, HMAC authentication, required
components, nested archive policy, unsafe links and special files, and the
restore contract. It does not modify the running Portal.

## What a cross-host restore needs

Copying the `.tar.gz` file is not enough. A different host also needs:

1. The archive's separately safeguarded trust key. By default the source host
   keeps it at `/var/lib/bridgesllm/backup-trust/archive-hmac.key`. Never store
   the only copy inside the archive it authenticates.
2. The exact Portal release expected by the archive.
3. Compatible Portal environment and database authority. Restore admission
   rejects a different database topology or ambiguous environment instead of
   guessing.
4. Enough protected disk space for the archive, transaction staging, and the
   previous installation until commit finishes.

Keep the trust key in a separate encrypted secret store or offline recovery
package. Restrict it to root and verify its ownership and mode after copying.

## If a backup fails

The useful distinction is the failed component, not the generic word
"backup."

- `projects` plus an ordinary `.venv/bin/python3` link should be accepted by a
  current release. A link to an unapproved host path such as `/etc` or a secret
  directory remains unsafe and must fail.
- `openclaw-state` failures can identify a live SQLite snapshot or inventory
  change. Do not delete agent databases to make a backup pass.
- A degraded archive belongs to the bounded salvage area and never replaces the
  newest complete backup.
- Repeated scheduled failures remain visible in Backup Settings. Do not rely on
  a green systemd timer alone; the timer can fire while every archive degrades.

If verification reports a trust-key, version, environment, or database
mismatch, repair that exact prerequisite. Do not copy manifests, edit an
archive, disable HMAC checks, or broaden the allowed symlink roots. Those
shortcuts remove the evidence the restore transaction depends on.

## If startup reports a dependency-promotion quarantine

The Portal can deliberately remain on a status-only `503` response with this
public code:

```text
PROJECT_DEPENDENCY_PROMOTION_QUARANTINED
```

This is a recovery fence, not a normal crash loop. It means startup could not
prove that an interrupted Project dependency installation has one consistent
database and filesystem outcome. The real Portal routes, WebSockets, and
background jobs remain closed while the same process keeps the health endpoint
available. An updater must treat this response as unhealthy and follow its
normal journaled rollback path.

There are two different operator surfaces:

- If the whole Portal is serving the status-only response, application routes
  are intentionally closed. Do not try to bypass the fence through an API or
  edit the Project directly. Startup will resume an already-authorized repair
  only when its database receipt, filesystem journal, staged-tree digest, and
  pinned backup still agree.
- If the Portal is otherwise available and one Project card reports a contained
  dependency promotion, an Owner can use **Repair dependency update** on that
  card. This action is deliberately Project-specific; other users can see the
  warning but cannot authorize the repair.

The Owner repair only force-forwards the exact staged generation named by the
original durable decision. It does not merge unknown live files, preserve a
mixed generation, or abandon the staged generation. Before the button is
enabled, create a new authenticated **Complete** comprehensive backup after the
quarantine time and let Portal finish strict restore verification. Review the
exact Project identity, generation, promotion receipt, and backup shown in the
dialog, then type the displayed Project-specific confirmation phrase.

Keep the dialog open while practical, but a lost browser response or browser
reload is not a reason to submit a second repair. On reload, an Owner session
rediscovers the exact active repair receipt through a bounded read-only surface
even while the ordinary Project inventory is fenced. The dialog distinguishes
a backup that is eligible for a new repair from the exact recovery archive
already pinned to an admitted repair; never create a second repair or replace
that pinned evidence. The Project stays fenced until the staged generation is
verified all-new, the original decision is applied, the pinned backup is
reverified, displaced evidence is retired, and the exact Project identity
returns to `ACTIVE`.

Portal makes a bounded number of same-process continuation attempts while it
retains the Project writer fence and backup exclusion locks. If live
continuation becomes unavailable—for example after a lost lock holder—or those
attempts are exhausted, the dialog reports that startup recovery is required
and Portal requests a controlled service restart. Current-process polling and
mutation stop at that point; do not press the force-forward action again. After
Portal restarts, reload Projects. Portal will rediscover either the exact
durable receipt or the still-quarantined pre-repair operation, without inventing
a receipt that was never committed. Startup resumes only when the available
database receipt, disk journal, staged-tree digest, Project binding, and pinned
backup evidence agree.

Preserve both sides of the evidence. Do not delete a promotion journal,
staging directory, repair journal, backup lock, pinned archive, or database
decision row by hand, and do not repeatedly restart the service hoping that the
fence clears. Check the local service log for the Project dependency recovery
entry, then use one of these supported paths:

1. Correct the exact storage or database availability problem reported in the
   local log, without mutating the interrupted Project evidence.
2. If the evidence is damaged or cannot be attested, restore a verified
   **Complete** comprehensive archive using the normal restore procedure.

After a repair completes without an automatic startup handoff—or after a
restore—deliberately restart the Portal once. Startup reruns the
database-plus-filesystem reconciliation before opening any application route.
A clean restart removes completed recovery evidence automatically; a repeated
quarantine means the proof is still unresolved and should remain preserved for
support analysis.

## Before an update or maintenance action

The Dashboard may first find a fresh *candidate* by age and size. That is only
an inventory hint. The action is authorized after strict archive verification,
and the verifier may select an older fresh complete candidate if the newest one
is incomplete.

Security or package maintenance can change the host. A Portal backup protects
Portal recovery data; it does not uninstall or roll back operating-system
packages. Review the maintenance action's own rollback implications separately.
