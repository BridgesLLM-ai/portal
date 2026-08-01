---
name: "bridgesllm-portal"
description: "Operate BridgesLLM Portal: chats, projects, files, mail, apps, tasks, admin, setup, maintenance, and Remote Desktop."
---

# BridgesLLM Portal

Use this skill to operate the installed Portal or diagnose its product surfaces. Prefer the authenticated Portal UI and API over direct database, filesystem, service, or OpenClaw mutations.

## Operating contract

1. Identify the authenticated user and role.
2. Read the surface's status, capabilities, or configuration endpoint before acting. Installed paths, model catalogs, limits, and optional services can differ.
3. Discover the installation's origin capabilities from GET /api/settings/public before promising features: `originMode` is `domain`, `tailnet`, or `local`; `mail.available` (with `reason`) and `appHosting` are the truth for Mail and hosted deploy/share availability. Private tailnet/local origins have no public mail authority and no isolated app-content origin, so Mail and new hosted shares are genuinely unavailable there — the backend fails those requests closed (409/503) before any side effect. Do not chase Stalwart, DNS, or Caddy when the capability contract already says unavailable.
4. Use Portal-owned APIs for Portal-owned state. They enforce ownership, scanning, path containment, leases, audit records, and cleanup.
5. Treat 401, 403, 409, 410, 423, 429, and 503 as state, policy, contention, retirement, or readiness signals. Do not bypass them with direct host access.
6. Re-read the resulting state after every mutation. Do not infer success from a button click or an accepted background job.
7. Keep secrets out of URLs, logs, transcripts, shell history, screenshots, and chat.
8. Never edit or rebuild the deployed Portal runtime as a normal operating shortcut. Portal updates verify a signed artifact and record deploy provenance.

The public origin terminates HTTPS through Caddy. The Portal backend normally listens on loopback port 4001, but use the configured origin and same-origin routes instead of assuming hostnames or ports.

## Pick the right surface

- **Main Agent Chat**: OWNER/SUB_ADMIN host-operator work. It can intentionally control the server.
- **Project Chat**: one authenticated actor plus one immutable project. Public Internet is brokered; host, private network, sibling user, and sibling project access are denied. Provider availability is attested and may be empty.
- **Projects**: source files, Git, dependencies, preview/deploy, shares, and project-bound activity.
- **Apps**: uploaded or project-deployed applications and share links.
- **Files**: the user's isolated file library. It is not a server filesystem browser.
- **Mail**: the signed-in user's mailbox plus role-authorized shared accounts.
- **Agent Tools / Skills / Automations / Tasks**: operator-managed runtimes and jobs.
- **Terminal**: an OWNER/SUB_ADMIN host shell. Its confirmation UI prevents accidents; it is not a privilege boundary.
- **Settings / Admin / Maintenance / Backups**: configuration and host operations with server-side role and safety gates.
- **Remote Desktop**: authenticated same-origin noVNC plus the visible Shared Browser.

## Role model

- **OWNER**: full product and host control; owner-only account, updater, backup, and high-risk settings operations.
- **SUB_ADMIN**: deliberate root-equivalent operator through Main Agent Chat, Terminal, Tasks, maintenance, and Remote Desktop. Some ownership and release actions remain OWNER-only.
- **USER**: approved daily-use surfaces for their own state.
- **VIEWER**: approved read-limited access where the server permits it.

Never infer permission from a visible control. The backend decision is authoritative.

## Shared Browser first for visible web work

For requests such as “open this,” “check the browser,” “show me,” authenticated UI debugging, or anything the user may guide live, use the Shared Browser before hidden browser automation.

Resolve this skill directory, then run:

~~~bash
bash <skill-dir>/scripts/shared-browser.sh launch [https://example.com]
bash <skill-dir>/scripts/shared-browser.sh tabs
bash <skill-dir>/scripts/shared-browser.sh current
bash <skill-dir>/scripts/shared-browser.sh navigate https://example.com
bash <skill-dir>/scripts/shared-browser.sh screenshot [output-path]
bash <skill-dir>/scripts/shared-browser.sh console [duration-ms]
bash <skill-dir>/scripts/shared-browser.sh evaluate 'document.title'
~~~

The helper targets loopback CDP 18801 for the browser visible in Remote Desktop. The hidden OpenClaw browser is a separate runtime. Load references/remote-desktop.md before setup, recovery, or service work.

## Debugging workflow

1. Reproduce through the affected Portal surface as the affected role.
2. Capture the visible state and browser console when relevant.
3. Inspect the Portal response/status and recent service logs without exposing credentials.
4. Distinguish product source, compiled runtime, persistent data, and external provider state.
5. Fix source in the development checkout, validate it, and deploy only through the signed candidate/update workflow.
6. Verify the exact request path, persistence after refresh/reconnect, and a nearby negative permission case.

Do not hand-edit backend/dist, frontend/dist, the live database, OpenClaw config, Caddy, or systemd merely to make a product test pass.

## Load only the reference you need

- references/agent-chat.md — Main vs Project Chat, providers, models, streaming, long turns, tools.
- references/files-and-projects.md — Files, chunked upload, Projects, Git, apps, shares, Project attachments.
- references/email.md — mailbox scope, send/read actions, attachments, scanning, reconciliation.
- references/automations.md — Automations and durable Tasks/jobs.
- references/admin.md — roles, Dashboard, Settings, Admin, setup, updates, maintenance, backups, Terminal.
- references/remote-desktop.md — noVNC, Shared Browser, runtime services, recovery, diagnostics.
- references/remote-gpu.md — Ollama backends, native Tailscale Remote GPU, model pulls, backend authority.

Model lists, package versions, prices, quotas, storage paths, and provider availability are intentionally discovered at runtime rather than embedded here.
