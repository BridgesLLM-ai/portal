# Remote Desktop - Architecture & Troubleshooting (noVNC)

## Architecture

```
Browser (Portal UI)
  │
  ├─ /api/remote-desktop/status   → Portal Backend (3001) → host checks (127.0.0.1:5901 / 127.0.0.1:6080)
  │
  └─ /novnc/* (iframe, admin auth) → Portal Backend (3001) → noVNC/websockify (127.0.0.1:6080 only)
                                                   │
                                                   └─ VNC loopback (127.0.0.1:5901)
                                                          │
                                                          └─ Xtigervnc :1 + XFCE session
```

## Components

| Component | Service | Port | Restart |
|---|---|---|---|
| Portal backend | docker `portal` container | 3001 | unless-stopped |
| noVNC/websockify | `bridges-rd-websockify.service` | 127.0.0.1:6080 only | always |
| VNC/XFCE stack | `bridges-rd-xtigervnc.service` | 127.0.0.1:5901 only | always |

## Installer behavior

`installer/install.sh` now:
- Installs required desktop packages (`xvfb`, `x11vnc`, `novnc`, `websockify`, `xfce4`, `dbus-x11`)
- Creates dedicated system user: `bridgesrd`
- Creates and enables self-healing systemd units:
  - `/etc/systemd/system/bridges-rd-vnc.service`
  - `/etc/systemd/system/bridges-rd-websockify.service`
- Performs health checks for loopback-only 5901 and 6080
- Keeps raw websockify loopback-only so Remote Desktop must pass through portal auth instead of a public port
- Seeds portal settings:
  - `remoteDesktop.url=/novnc/vnc.html?autoconnect=1&reconnect=1&resize=remote`
  - `remoteDesktop.allowedPathPrefixes=/novnc,/vnc,/guacamole`

## Runtime diagnostics

Backend API:
- `GET /api/remote-desktop/status` (auth required)
- Returns `ready | degraded | unavailable` plus diagnostics and remediation hints.

Frontend:
- Desktop page polls health every 15s
- Shows backend readiness badge and includes health message in error state

## Quick verification

```bash
# Services up
systemctl is-active bridges-rd-vnc.service
systemctl is-active bridges-rd-websockify.service

# Ports listening (must stay loopback-only)
ss -ltn | grep -E '127.0.0.1:5901|127.0.0.1:6080'

# websockify reachable only on loopback
curl -I http://127.0.0.1:6080

# Backend readiness route (with auth cookie/token)
curl -s http://127.0.0.1:3001/api/remote-desktop/status
```

## Common fixes

```bash
# Restart RD stack
sudo systemctl restart bridges-rd-vnc.service bridges-rd-websockify.service

# Check recent logs
sudo journalctl -u bridges-rd-vnc.service -n 100 --no-pager
sudo journalctl -u bridges-rd-websockify.service -n 100 --no-pager

# Re-run installer safely (idempotent)
sudo bash installer/install.sh --domain your.domain.tld
```
