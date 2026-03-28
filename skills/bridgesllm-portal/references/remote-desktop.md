# Remote Desktop

**Default browser rule:** if the task is collaborative/visible, use the shared desktop Chrome path (`scripts/shared-browser.sh`) so Robert can see what the agent is doing. Hidden headless browsing is fallback-only.

Full Linux desktop (XFCE) accessible via noVNC in the browser. Portal page: `/desktop`.

## Architecture

```
User browser → noVNC iframe (wss://<domain>/novnc/websockify)
                → websockify (:6080) → Xtigervnc (:5901)
                    └── XFCE desktop (DISPLAY=:1)
                        └── Shared Chrome (CDP :18801)
```

## Services

| Service | Port | Unit |
|---------|------|------|
| Xtigervnc | 5901 | `bridges-rd-xtigervnc.service` |
| Websockify | 6080 | `bridges-rd-websockify.service` |
| Shared Chrome | 18801 (CDP) | Launched on demand |

## User: bridgesrd

Desktop runs under `bridgesrd` system user. Home: `/home/bridgesrd`. Desktop shortcuts in `~/Desktop/`.

## Shared Browser

Chrome runs inside the VNC desktop with `--remote-debugging-port=18801`. Both agent and user see the same window.

- **Launcher**: `/usr/local/bin/bridges-rd-shared-chrome.sh`
- **Profile dir**: `/home/bridgesrd/.config/bridges-agent-browser`
- **Log**: `/tmp/bridges-agent-browser.log`
- **CDP endpoint**: `http://127.0.0.1:18801/json/list`

### Important: Port Separation

- **18800**: OpenClaw headless Chrome (built-in `browser` tool) — invisible, automation only
- **18801**: Shared desktop Chrome — visible in VNC, both agent and user can see/interact
- These are completely separate Chrome instances with separate profiles
- The `shared-browser.sh` script targets 18801; the OpenClaw `browser` tool targets 18800

## Backend API

- `GET /api/remote-desktop/status` — Health check (VNC, noVNC, Chrome status)
- `POST /api/remote-desktop/auto-setup` — Full automated setup (creates user, services, Chrome, skill)
- `POST /api/remote-desktop/recover` — Attempt recovery of broken services
- `GET /api/agent-browser/status` — Shared Chrome status + tabs via CDP
- `GET /api/agent-browser/screenshot` — CDP screenshot of active tab
- `POST /api/agent-browser/open-in-desktop` — Launch Chrome with URL in VNC desktop

## Setup

Auto-setup (`POST /api/remote-desktop/auto-setup`) performs:
1. Create `bridgesrd` system user
2. Install TigerVNC + noVNC + XFCE
3. Create systemd services (VNC + websockify)
4. Configure Caddy reverse proxy for noVNC path
5. Configure OpenClaw allowed path prefixes
6. Write shared Chrome launcher script + desktop shortcut
7. Install `bridgesllm-portal` skill into OpenClaw workspace
8. Verify all ports and services

## Troubleshooting

- **Black screen in noVNC**: Restart VNC — `systemctl restart bridges-rd-xtigervnc bridges-rd-websockify`
- **Chrome won't launch**: Check log at `/tmp/bridges-agent-browser.log`
- **CDP not responding**: Verify Chrome is running — `pgrep -u bridgesrd -fa chrome`
- **Port conflict**: Ensure 18801 isn't occupied — `ss -tlnp | grep 18801`
- **Permission issues**: Chrome profile must be owned by `bridgesrd` — `chown -R bridgesrd:bridgesrd /home/bridgesrd/.config/bridges-agent-browser`
