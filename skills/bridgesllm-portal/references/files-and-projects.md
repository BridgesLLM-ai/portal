# Files, Projects, Apps, and shares

These surfaces have different ownership and storage contracts. Do not treat them as interchangeable host paths.

## Files

Files is the authenticated user's isolated library, not a server filesystem browser.

Start with:

- GET /api/files/upload-config for current limits and upload mode.
- GET /api/files for the user's records.
- GET /api/files/resolve when resolving an owned file reference.

Normal multipart upload uses POST /api/files. Large upload uses the resumable /api/upload flow:

1. POST /api/upload/init
2. POST /api/upload/chunk with the issued upload ID and chunk index
3. pause/resume/status as needed
4. POST /api/upload/complete
5. DELETE /api/upload/:uploadId to cancel

The server currently advertises up to 2 GiB through upload-config, but trust the returned limit rather than this document. Completed files are scanned before they become usable.

Use file IDs and Portal content/download routes. Do not guess /var paths, construct another user's directory, or hand a host path to an agent.

## Projects

Projects are actor-scoped working trees with server-owned immutable identities.

Core routes:

- GET/POST /api/projects
- POST /api/projects/clone
- tree/file/raw/upload/download routes under /api/projects/:name
- POST /api/projects/:name/git
- check, dependency, deploy, process, activity, share, and Project Chat routes

Rules:

- Resolve every file beneath the selected project.
- Do not expose or modify server-owned project identity metadata.
- Use compare/race-safe editor operations and re-read after save.
- ZIP imports are staged, scanned, bounded, and extracted without links or traversal.
- Project activity is project-bound, not a global host transcript.
- Deletion must quiesce turns, workloads, provider state, and egress resources before removing the project.

## Legacy projects and lifecycle recovery

Projects preserved from 3.x remain visible with their files and any exactly associated Apps, but they are not automatically promoted into the 4.0 identity boundary. While preserved 3.x OpenClaw evidence exists, Project Chat, rename, delete, and other destructive Project-level operations remain unavailable. Do not call the legacy-adoption route, edit identity records, or recreate the Project as a workaround; preserve the files and use the available non-destructive surfaces until the lineage can be resolved safely.

For Projects created or safely admitted under the 4.0 identity boundary, lifecycle states converge automatically: a Project stuck in RENAMING or DELETING after an interrupted operation is rolled forward or back by expired-lease recovery on a later touching request. Re-read the Project list before attempting manual repair.

## Git, dependencies, and deployment

Networked Git and dependency installation run in attested Portal workload containers with brokered public egress. Local-only Git uses no network.

- Validate remote URL and current branch/status before pull, push, or checkout.
- Never add private-network exceptions to make a Git host work.
- Dependency install uses project-local state; no host package-manager shortcut.
- Deployment builds in a staged tree.
- Full-stack promotion keeps the previous release until the replacement starts successfully.
- Failure rolls back and restarts the previous app.
- Verify app status and the public/share route after deployment.

## Apps and shares

Apps are separate persisted deployments. /api/apps lists, uploads, deletes, and creates share links.

Project shares live under /api/projects/:name/share and /shares. They can carry expiration, password, download, and API-access policy. Read the saved policy and test an unauthenticated or wrong-password negative case before calling a share ready.

Never embed a Portal session cookie, internal port, filesystem path, or private upstream address in a share.

## Project Chat attachments

Attachments are:

- malware-scanned;
- bound to actor, immutable project, and provider;
- copied to .portal/attachments/<uuid>/ inside that project;
- referenced to the provider only by project_path.

Never pass a host absolute path, signed Portal URL, /api/files URL, or another project attachment.

## Storage discovery

Installations can relocate Portal data with environment/configuration. The common surfaces include a File library root, Project root, Apps root, upload/chunk staging, PostgreSQL, and external service state, but paths are not part of the user API.

For normal work, discover through Portal responses. For operator diagnosis, inspect the active service environment without printing secrets. Do not assume /portal, /opt/bridgesllm, or /var/portal-files is universal.
