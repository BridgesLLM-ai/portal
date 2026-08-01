# Administration and host operations

## Roles and authority

Portal roles are uppercase in the API and database:

- OWNER: sole ownership authority. Manages registration, roles, owner transfer, signed self-update, backups, branding, domains, mail installation, and other owner-only changes.
- SUB_ADMIN: root-equivalent operator for Main Agent Chat, Terminal, Tasks, maintenance, Remote Desktop, and admin read surfaces. Owner-only endpoints still reject it.
- USER: approved personal product use.
- VIEWER: approved read-limited access where an endpoint permits it.

Use the UI as a client, not as the permission boundary. Direct API calls must receive the same server-side decision.

## Dashboard and Usage

Metrics and Usage are observational. Missing telemetry, provider errors, or incomplete pagination must be reported as unavailable or partial, never converted into zero.

The Dashboard's three system checks — OpenClaw gateway, Portal updates, and server maintenance — run under server-side cooldowns. Opening the dashboard replays each check's cached result with its age ("Checked N min ago") instead of re-executing it; each check has its own refresh button that bypasses only that check's cooldown, and the main refresh button reloads only the resource gauges. Programmatically: `POST /api/admin/check-updates` with `{"force":true}` forces the update check (owner-only), `GET /api/gateway/health?forceVersion=1` forces a live gateway/version probe, and `GET /api/system/maintenance?refresh=1` forces a maintenance rescan. Responses carry `cached` and `checkedAt`/`cacheAgeMs`, so honor them instead of hammering the endpoints.

Regular users do not call operator-only diagnostics, alerts, maintenance, updater, or gateway controls. OWNER/SUB_ADMIN can inspect operational status. Socket namespaces for alerts and OpenClaw status are elevated-role surfaces.

## Settings and Admin

- GET /api/settings/public contains only genuinely public branding and login-page settings.
- GET /api/settings/client is authenticated and administrative.
- /api/admin is elevated. Individual mutations can be OWNER-only.
- Registration remains pending until OWNER approval. Do not describe registration as immediate signup.
- User deletion and ownership changes are destructive; inspect the exact target and confirmation state first.
- Mailbox provisioning is durable reconciliation. A pending mailbox task is not the same as a missing user.

When a setting is confusing, read its server schema/status and show current, proposed, and restart-impact values separately.

## Origin modes and capabilities

`GET /api/settings/public` reports `originMode` (`domain`, `tailnet`, or `local`) plus the capability truth: `mail.available` with a `reason`, and `appHosting`. Domain installs have full mail and hosted app-content. Tailnet (experimental) and local installs have no public mail authority and no isolated app-content origin: Mail surfaces render an honest unavailable state and every `/api/mail/*` mutation, mail installation, and new hosted deploy/share fails closed before side effects. Remote Desktop runtimes and share cleanup stay available. Treat those refusals as configuration truth, not bugs.

## Setup bootstrap

Fresh setup accepts credentials only after transport verification:

- Domain installs: complete real HTTPS verification first.
- Domainless installs: use the explicit localhost SSH-tunnel flow.
- Bootstrap and handoff secrets use URL fragments, are scrubbed immediately, expire, and are single-use.
- Setup sessions are hashed, origin-bound, expiring, and replay-resistant.
- A completed setup is locked. Reinstall is not an implicit password-reset path.

Never send a setup secret over public HTTP, move it into a query string, or paste it into logs.

## Signed updates

Normal release flow is OWNER-only:

1. Check update status.
2. Verify the signed manifest/artifact identity.
3. Run the real updater, which stages, backs up, migrates, restarts, runs postflight, and rolls back on failure.
4. Verify /health, authenticated readiness, app-content isolation, TLS when applicable, and the atomic deploy-provenance stamp.

Do not pull source, rebuild the live tree, copy arbitrary files over the runtime, or restart around a failed postflight. A legacy candidate stamp is diagnostic, not signed release provenance.

## Maintenance

GET /api/system/maintenance returns current health and available actions. POST /api/system/maintenance/actions/:actionId starts an admitted job.

Guarded update actions require:

- a structurally valid recent backup with verified database checksum;
- explicit maintenance-window acknowledgement;
- the global maintenance admission lock;
- no already-running durable maintenance job.

A 409 means another operation owns the lane. A 503 means admission or verification failed closed. Do not race it from another tab or call the underlying host command.

System remediation is OWNER-only, requires the exact typed confirmation, and must be re-read after completion.

## Backups

/api/backups is OWNER-only. Comprehensive backup scope includes database, Projects, Apps, both upload stores, Portal state/assets, Stalwart state/config, and OpenClaw state.

- Verify archive structure, MANIFEST.txt, database dump, and checksums.
- Keep-data uninstall removes executable runtime only and preserves persistent state.
- Restore is destructive. Confirm target backup, version compatibility, free space, and rollback path first.
- External/custom PostgreSQL is never silently dropped.

## Terminal and Tasks

Terminal and Main Agent Chat are intentional host-operator surfaces for OWNER/SUB_ADMIN. Input reaches a real PTY; client confirmation is accident prevention, not containment.

Before host mutations: identify target, current state, backup/rollback, and service impact. Prefer Portal maintenance/remediation actions when they exist.

Tasks under /api/agent-jobs are durable operator jobs. Read status and transcript, send input only to the intended active job, and use kill/abort once. Re-read terminal state instead of starting a duplicate job.

## Useful read-only checks

~~~bash
systemctl is-active bridgesllm-product.service
curl -fsS http://127.0.0.1:4001/health
journalctl -u bridgesllm-product.service -n 100 --no-pager
~~~

Use authenticated Portal endpoints for anything beyond the public health probe.