# Named App credentials

The Portal Owner can hand a login or key (an API token, a service account file) to one Portal-managed fullstack
Project App. The value never goes into App source, `.env`, Git or the App's data directory.

## Contract

| | |
|---|---|
| Slot | Name `^[a-z][a-z0-9-]{0,62}$`, at most 16 per App. The value is opaque UTF-8 text, 1 B to 64 KiB, with no NUL. |
| Storage | Two tables. `ProjectAppCredential` holds appId, slot, ciphertext, revision, updatedAt, and the user or operator who wrote it. `ProjectAppCredentialSet` holds the per-App revision counter. They come from one additive migration, `20261020160000_project_app_credentials`. Values use the Portal's authenticated encryption (`portal-secret:v1`). No plaintext, hash or fingerprint of a value is stored. CHECKs bound slot names, the ciphertext prefix and length, and the actor shape. |
| Revision | Every set, replace, removal and import bumps the App's counter. A slot's revision is the counter at its write, so revisions are never reused, even after a slot is removed and added again. |
| Deletion | Both tables cascade from `App`. Deleting the App, deleting its Project, or retiring its user (which removes the Project identity, then the user) removes its credentials. |
| Audit | Each change writes an `ActivityLog` row in the same transaction: `APP_CREDENTIAL_SET`, `_REPLACED`, `_REMOVED` or `_IMPORTED`, with resource `project-app-credential`, the actor, App, slot and revision. The row never carries the value or its size. |
| Owner API | `GET /api/app-credentials/:appId` lists the slots. `PUT /:appId/:slot {value, expectedRevision}` adds or replaces one; `expectedRevision: null` means add only. `DELETE /:appId/:slot?expectedRevision=N` removes one. Callers must be the Portal Owner with an approved account. Responses send `Cache-Control: private, no-store`. Rate limits per Owner are 60 reads per minute and 30 changes per 10 minutes. Requests must be JSON, with a 400 KB body bound. Parser errors are answered in place and never reach the global error handler, which logs whole error objects (a JSON syntax error quotes the body). Responses carry names, revisions, times and actors. `runtime.restartRequired` says when the running container predates a change. |
| Operator CLI | `node dist/cli/appCredentialImport.js --app <id> --slot <slot> --from-file <absolute path> [--replace] [--dry-run] [--allow-multiple-links]`. See the Operator CLI section. |
| UI | Projects → the App's deployment panel (Portal-managed container) → Credentials. The Owner manages the list; other users see a note. Single-line values use a native password field. Multiline pastes and "Load from a file" preserve the complete contents without rendering them; use "Clear value" to replace the entry. The Owner can add, replace (exact revision) and remove (after confirmation). The panel says changes apply on the next start or redeploy. |

## Operator CLI

- **Who and where.** Root only. Run it from the installed backend folder.
- **Quiet by design.** It loads `backend/.env` itself before anything touches the database. It suppresses all library
  output while it works, because Prisma prints whole failed invocations. It prints only its receipt or one safe
  failure line.
- **Reading the file.** It reads through one `O_NOFOLLOW` descriptor and refuses:
  - symlinks anywhere in the path;
  - non-regular files;
  - files over 64 KiB;
  - world-readable, world-writable or group-writable files;
  - files with more than one hard link, unless `--allow-multiple-links` is given after the operator has checked every link.
- **Snapshot limit.** It reads the file twice and compares inode metadata to detect ordinary changes. That is not an
  atomic snapshot against a writer holding a shared writable mapping. Import only a quiescent file with trusted
  ownership and no other open or mapped writer.
- **Checks before writing.** It proves the process holds the Portal encryption key (an existing Portal secret must
  decrypt). It checks that the App is a live fullstack Project App.
- **Result.** It writes through the same store and audit as the Owner API, with actor `operator`. The JSON receipt
  lists app, slot, bytes, storedAt and revision. On failure it exits 2 with `app-credential-import: <safe message>`.

## Projection into the App container

- **Reading.** When the App's resident container is prepared (`prepareLifecyclePlan`, mode `app`), the credentials of
  that exact App, owner and Project are read and decrypted. A value that does not decrypt fails the start, with an
  error that names the slot.
- **Writing.** The values go to a fresh `/run/bridgesllm/app-credentials/<appId>-<16 hex>`.
  - The parent directory is root-owned, mode 0700, and must be tmpfs (checked with `statfs`); otherwise the App is not
    started.
  - The per-start directory is mode 0500. Each file is named after its slot and is mode 0400. All are owned 1000:1000.
- **Mounting.** The directory is bind-mounted read-only at `/portal/credentials`, and
  `PORTAL_CREDENTIALS_DIR=/portal/credentials` names it. Values never go into the environment, argv or labels. The
  runtime fingerprint covers slot names, the revision and the directory inode only, and it is unchanged for an App
  without credentials.
- **Plan checks.** The workload plan refuses the attachment for every workload kind except `PORTAL_APP` and for another
  App's workload ID. It also refuses `PORTAL_CREDENTIALS_DIR` without an attested attachment.
- **Attestation.** It re-proves the directory inode, mode, ownership, tmpfs and exact file set. The container must then
  have exactly two mounts: the writable Project bind and the read-only credential bind.
- **Fresh container per start.** An App container left from an earlier start is removed and created fresh, never
  resumed. This includes a container that survived a Portal crash, and one that still mounts an earlier credential
  directory. Before removal, its name and durable identity labels must match.
- **Removal.** A directory is removed:
  - in `finally`, whenever the prepared container is removed;
  - for every directory of that App, during durable cleanup by identity (restart, Project deletion);
  - when its preparation fails;
  - when reconciliation finds the container exited or missing;
  - at Portal boot, which sweeps them all.

Scope: only the App's own resident container receives credentials. Project Chat and OpenClaw sandboxes, Git and
lifecycle jobs (npm install/build), and other Apps never do.

## What this does and does not protect

- **App code can read its own credential.** The guarantee covers platform-managed delivery and write-only management.
  App code that deliberately copies a credential into a response, log, workspace or its own state is outside what the
  platform can prevent.
- **Backups.** A database backup carries the encrypted rows. Anyone who also holds the Portal's encryption root can
  decrypt them, as for every other Portal-encrypted secret. The root is `PORTAL_ENCRYPTION_KEY`, or `JWT_SECRET` when
  no `PORTAL_ENCRYPTION_KEY` is set. Treat a backup that contains both as secret-equivalent.
- **Swap and core dumps.** The projection lives on tmpfs, which can be swapped. Workload containers and the Portal unit
  do not set a core-dump limit. Excluding swap and core dumps is host policy (encrypted or no swap,
  `LimitCORE=0` / `--ulimit core=0`) and is not claimed here.
