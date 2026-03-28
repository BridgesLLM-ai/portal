---
name: bridgesllm-portal
description: 'Comprehensive guide for operating the BridgesLLM Portal — a self-hosted AI platform. Use when working with portal features including Remote Desktop (shared browser, VNC), email (reading/sending via Stalwart), file management, projects, agent chat, automations, terminal, apps deployment, dashboard, user accounts, system administration, or debugging the portal itself. Triggers on: portal, bridgesllm, Remote Desktop, shared browser, desktop browser, check the browser, console errors, email, send email, read email, inbox, file manager, upload, project, deploy, agent chat, automations, cron jobs, terminal, apps, dashboard, user account, settings, admin, setup wizard.'
---

# BridgesLLM Portal

Self-hosted AI platform running on a VPS. Stack: React+Vite frontend, Express+Prisma backend, PostgreSQL, Caddy reverse proxy.

**Portal backend**: `http://127.0.0.1:3000` (internal) → `https://<domain>/` (public via Caddy)
**OpenClaw gateway**: `http://127.0.0.1:18789`
**Service**: `bridgesllm-product.service`

## Architecture Overview

```
Caddy (HTTPS) → Express backend (:3000)
                 ├── React SPA (frontend)
                 ├── PostgreSQL (Prisma ORM)
                 ├── OpenClaw gateway (RPC + WebSocket)
                 ├── Stalwart mail (JMAP :8580)
                 ├── Remote Desktop (VNC :5901, noVNC :6080)
                 └── Agent providers (Claude Code, Codex, OpenClaw, Ollama, Gemini, Agent Zero)
```

## Features — Quick Reference

| Feature | Page Route | Backend Route | Reference |
|---------|-----------|---------------|-----------|
| Dashboard | `/dashboard` | `/api/system-stats` | — |
| Agent Chat | `/agent-chats` | `/api/gateway/ws` | [agent-chat.md](references/agent-chat.md) |
| Agent Tools | `/agent-tools` | `/api/agent-tools`, `/api/skills` | [agent-chat.md](references/agent-chat.md) |
| Remote Desktop | `/desktop` | `/api/remote-desktop` | [remote-desktop.md](references/remote-desktop.md) |
| Email | `/mail` | `/api/mail` | [email.md](references/email.md) |
| Files | `/files` | `/api/files` | [files-and-projects.md](references/files-and-projects.md) |
| Projects | `/projects` | `/api/projects` | [files-and-projects.md](references/files-and-projects.md) |
| Terminal | `/terminal` | `/api/terminal` | — |
| Apps | `/apps` | `/api/apps` | [files-and-projects.md](references/files-and-projects.md) |
| Automations | `/agent-tools` (tab) | `/api/automations` | [automations.md](references/automations.md) |
| Settings | `/settings` | `/api/settings-public` | — |
| Admin | `/admin` | `/api/admin` | [admin.md](references/admin.md) |

## File System Layout

```
/opt/bridgesllm/portal/          # Portal source + built assets
  ├── backend/src/               # TypeScript source
  ├── backend/dist/              # Compiled JS (what runs)
  ├── frontend/src/              # React source
  ├── frontend/dist/             # Built SPA (served by Express)
  └── skills/                    # Bundled OpenClaw skills
/portal/                         # Runtime data
  ├── projects/                  # User projects (code, git repos)
  ├── apps/                      # Deployed apps
  └── project-zips/              # Upload staging
/var/portal-files/               # User file uploads
  └── user-<uuid>/uploads/       # Per-user upload directory
/etc/caddy/Caddyfile             # Reverse proxy config
/var/lib/stalwart-mail/          # Email server data
```

## Shared Browser (Remote Desktop)

Control the shared Chrome visible in the VNC desktop. Both agent and user see the same browser.

**Policy:** For portal UI work, debugging, "open this", "check the browser", console inspection, or anything Robert may want to watch or guide live, use this shared browser path first. Treat OpenClaw's hidden headless browser as fallback-only for cases where the user explicitly wants invisible/background automation or the shared browser is unavailable.

**Decision rule:** If the request is visual, auth-gated, collaborative, or phrased like "open this," "check this page," "show me," "look at the browser," or "go there for me," do **not** default to pasting links into chat. Instead, launch the shared browser and navigate there so the user can see the same page. Only send raw links when the user explicitly asks for a link, wants something for later, or the shared browser path is not the right tool.

- **CDP port**: 18801 (shared desktop Chrome)
- **OpenClaw headless**: 18800 (separate — agent automation, NOT visible)
- **Profile**: `/home/bridgesrd/.config/bridges-agent-browser`

### Commands

The shared browser script is at `scripts/shared-browser.sh` relative to this skill directory.
Resolve the full path before running: `SKILL_DIR/<this skill's directory>/scripts/shared-browser.sh`

```bash
# First, always check if Chrome is running — launch if needed:
bash <skill-dir>/scripts/shared-browser.sh launch

# Then use these commands:
bash <skill-dir>/scripts/shared-browser.sh tabs                    # List open tabs
bash <skill-dir>/scripts/shared-browser.sh current                 # Get active page title + URL
bash <skill-dir>/scripts/shared-browser.sh navigate <url>          # Navigate to URL (user sees it)
bash <skill-dir>/scripts/shared-browser.sh screenshot [path]       # Capture page screenshot
bash <skill-dir>/scripts/shared-browser.sh console [duration_ms]   # Capture console output (default 3s)
bash <skill-dir>/scripts/shared-browser.sh evaluate '<js>'         # Run JavaScript on the page
bash <skill-dir>/scripts/shared-browser.sh launch [url]            # Start Chrome if not running
```

Where `<skill-dir>` is the directory containing this SKILL.md file (e.g., `~/.openclaw/workspace-main/skills/bridgesllm-portal`).

### When to Use Shared Browser

- **Debugging**: User says "look at this" → `screenshot` + `console`
- **Showing work**: Navigate to a page so user can see it in the VNC iframe
- **Testing portal**: Open the portal URL, check for errors, fix, reload
- **Collaborative**: User opens a page, you read it; you navigate, they interact

## Portal Debugging Workflow

When debugging portal issues:

1. **`screenshot`** — see what the user sees
2. **`console`** — read JavaScript errors
3. **`evaluate 'document.querySelector(...)'`** — inspect DOM state
4. Read backend logs: `journalctl -u bridgesllm-product -n 50 --no-pager`
5. Fix source in `/opt/bridgesllm/portal/`
6. Build: `cd backend && npm run build` or `cd frontend && npm run build`
7. Restart: `systemctl restart bridgesllm-product`
8. Verify fix in shared browser

## Quick Reference — Common Operations

### Restart portal
```bash
systemctl restart bridgesllm-product.service
```

### Check portal logs
```bash
journalctl -u bridgesllm-product -n 100 --no-pager
```

### Rebuild backend only
```bash
cd /opt/bridgesllm/portal/backend && npm run build
systemctl restart bridgesllm-product
```

### Rebuild frontend only
```bash
cd /opt/bridgesllm/portal/frontend && npm run build
# No restart needed — Express serves static files
```

### Check service health
```bash
systemctl is-active bridgesllm-product
curl -s http://127.0.0.1:3000/api/system-stats/ | head -c 200
```
