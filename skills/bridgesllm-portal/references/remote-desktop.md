# Remote Desktop and Shared Browser

Remote Desktop is a host-managed, authenticated same-origin noVNC stack. It is not a Docker noVNC service and it does not expose raw VNC, websockify, audio, or CDP publicly.

## Runtime shape

- Portal backend: loopback 4001.
- Xtigervnc display :1: loopback 5901.
- websockify: bridgesrd on loopback 6080 to 5901.
- audio bridge: loopback 4714 by default.
- Shared Browser: bridgesrd, optional loopback CDP 18801.
- OpenClaw UI browser: bridgesrd, optional loopback CDP 18802.

Caddy exposes only the authenticated Portal origin. The noVNC client uses exact same-origin /novnc/websockify and /novnc/audio paths.

OWNER and SUB_ADMIN are the allowed Portal roles.

## Security contract

- X11 access control stays enabled.
- /home/bridgesrd/.Xauthority is bridgesrd-owned mode 0600.
- Xtigervnc uses -auth and loopback; never -ac.
- websockify runs as bridgesrd.
- Shared Browser state is /home/bridgesrd/.config/bridges-agent-browser, mode 0700.
- Session profile is beneath session/profile.
- Launcher log is /home/bridgesrd/.config/bridges-agent-browser/logs/launcher.log.
- Chrome/Chromium keeps its Linux sandbox. Never add --no-sandbox, --disable-gpu-sandbox, or --disable-setuid-sandbox.
- Ports 5901, 6080, 4714, 18801, and 18802 stay loopback-only.

The installed product launchers live under /usr/local/bin. The managed Portal skill contains operator helpers, but the product runtime never sources its service launchers from the skill directory.

## API

- GET /api/remote-desktop/status
- GET/POST /api/remote-desktop/clipboard
- POST /api/remote-desktop/recover with confirmation RESTART REMOTE DESKTOP
- POST /api/remote-desktop/auto-setup with confirmation SET UP REMOTE DESKTOP
- GET /api/agent-browser/status
- GET /api/agent-browser/screenshot/:targetId
- POST /api/agent-browser/open-in-desktop
- authenticated WebSocket /api/agent-browser/stream

Status is read-only and reports ready, degraded, or unavailable with service, listener, process, asset, launcher, clipboard, audio, CDP, and provenance checks. It does not restart services automatically.

Setup/recovery are disruptive and serialized. Re-read status after completion.

## Shared Browser

Use scripts/shared-browser.sh for a browser the user can see and operate in Remote Desktop. It talks only to loopback CDP 18801.

The hidden OpenClaw browser is a different browser/profile and is fallback-only for invisible work.

## Diagnostics

Start with the authenticated status response, then inspect only the failing layer:

~~~bash
systemctl is-active bridges-rd-xtigervnc.service
systemctl is-active bridges-rd-websockify.service
ss -H -ltn
ps -eo user:32=,args=
journalctl -u bridges-rd-xtigervnc.service -n 150 --no-pager
journalctl -u bridges-rd-websockify.service -n 150 --no-pager
tail -n 150 /var/log/bridges-rd/xfce.log
tail -n 150 /var/log/bridges-rd/pulseaudio.log
tail -n 150 /home/bridgesrd/.config/bridges-agent-browser/logs/launcher.log
~~~

Ports 18801 and 18802 may be absent while browsers are idle. Every present listener must be loopback-only.

Use Portal recovery for a service restart and auto-setup only for missing packages, units, launchers, or permissions. Do not expose a port, restore a legacy VNC unit, disable X11 access control, run the browser as root, or weaken the browser sandbox as a “fix.”