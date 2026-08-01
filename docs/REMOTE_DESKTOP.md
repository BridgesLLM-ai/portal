# Remote Desktop architecture and operations

This document describes the Portal 4.0 Remote Desktop stack. It is a host-managed, same-origin noVNC integration; it is not a Docker service and it does not expose a raw VNC or websockify port publicly.

## Request path

```text
Authenticated OWNER or SUB_ADMIN browser
  |
  +-- /api/remote-desktop/* ------------> bridgesllm-product.service
  |                                        127.0.0.1:4001
  |
  +-- /novnc/vnc_portal.html -----------> signed noVNC files served by Portal
  |
  +-- /novnc/websockify ----------------> authenticated Portal WebSocket bridge
  |                                        127.0.0.1:6080 (websockify)
  |                                          |
  |                                          +--> 127.0.0.1:5901 (Xtigervnc :1)
  |
  +-- /novnc/audio ----------------------> authenticated Portal WebSocket bridge
                                           127.0.0.1:4714 by default
                                             |
                                             +--> parec / PulseAudio monitor
```

Caddy terminates public HTTPS and proxies the Portal to `127.0.0.1:4001`. The Portal serves the signed noVNC bundle itself. Websockify carries only the VNC WebSocket and runs as `bridgesrd`; it does not serve static files.

The configured Portal path is:

```text
/novnc/vnc_portal.html?reconnect=1&resize=smart
```

The noVNC client always uses the exact same-origin `/novnc/websockify` and `/novnc/audio` endpoints. Client-supplied host, port, or proxy-path overrides are not accepted.

## Runtime components

| Component | Identity | Listener or display | Managed by |
|---|---|---|---|
| Portal backend | `root` | `127.0.0.1:4001` | `bridgesllm-product.service` |
| Xtigervnc launcher | service starts as `root`; XFCE and PulseAudio run as `bridgesrd` | display `:1`, `127.0.0.1:5901` | `bridges-rd-xtigervnc.service` |
| XFCE session guard | `root`, controlling only the dedicated `bridgesrd` session | semantic checks on display `:1` | supervised inside `bridges-rd-xtigervnc.service` |
| Websockify | `bridgesrd` | `127.0.0.1:6080` -> `127.0.0.1:5901` | `bridges-rd-websockify.service` |
| Out-of-process health recovery | `root` | semantic check and bounded restart every 30 seconds | `bridges-rd-healthcheck.timer` -> `bridges-rd-healthcheck.service` |
| Audio bridge | Portal process; `parec` runs as `bridgesrd` | `127.0.0.1:4714` by default | Portal process |
| Shared Browser CDP | `bridgesrd` | optional `127.0.0.1:18801` while running | Shared Browser launcher |
| OpenClaw UI browser CDP | `bridgesrd` | optional `127.0.0.1:18802` while running | OpenClaw UI launcher |
| AI terminal runtimes | `bridgesrd` | local terminal processes; no browser listener | managed runtime launcher |

The old `bridges-rd-vnc.service`, every stock display-1 alias (`tigervncserver@:1.service`, `tigervncserver@1.service`, `vncserver@:1.service`, and `vncserver@1.service`), and the Docker noVNC bridge are disabled because they race the managed display or bypass Portal authentication. An exact Portal-owned legacy `rc.local` desktop stack is archived and stopped; an unknown administrator-owned `rc.local` is never edited.

Xtigervnc uses `-SecurityTypes None` only on its loopback listener. Portal authentication and the elevated-role gate protect the public path. X11 itself keeps access control enabled: the launcher creates `/home/bridgesrd/.Xauthority`, passes `-auth`, and never uses `-ac`.

## Accounts, files, and permissions

The dedicated desktop account is `bridgesrd`. Product launchers refuse to run a browser as another non-root account, and a root invocation immediately drops to `bridgesrd`.

The account intentionally has no interactive desktop password, so every lock path is disabled. Signed XFCE policy maps the lock command and Ctrl+Alt+L to `/bin/true`, removes the panel lock action, disables idle blanking/DPMS, and installs XDG autostart tombstones for the common locker daemons.

| Path | Purpose | Expected owner/mode |
|---|---|---|
| `/home/bridgesrd/.Xauthority` | X11 authentication cookie | `bridgesrd:bridgesrd`, `0600` |
| `/home/bridgesrd/.bridges-rd-env` | canonical desktop environment | `bridgesrd:bridgesrd`, `0640` |
| `/tmp/bridges-rd-runtime` | private runtime sockets, including PulseAudio | `bridgesrd:bridgesrd`, `0700` |
| `/var/log/bridges-rd` | Xtigervnc/XFCE/PulseAudio/window-fit logs | `bridgesrd:bridgesrd` |
| `/run/bridges-rd/health-state.json` | last semantic health/recovery result and rate-limit state | `root:root`, `0644` |
| `/home/bridgesrd/.config/bridges-agent-browser` | Shared Browser state root | `bridgesrd:bridgesrd`, `0700` |
| `/home/bridgesrd/.config/bridges-agent-browser/session/profile` | reset-on-launch Shared Browser profile | private under the state root |
| `/home/bridgesrd/.config/bridges-agent-browser/logs/launcher.log` | Shared Browser launcher log | private under the state root |
| `/home/bridgesrd/.config/openclaw-control-ui-browser` | persistent OpenClaw UI browser profile | `bridgesrd:bridgesrd`, `0700` |
| `/home/bridgesrd/Desktop/Shared Chrome.desktop` | Shared Browser shortcut | `bridgesrd:bridgesrd` |
| `/home/bridgesrd/Desktop/OpenClaw Web UI.desktop` | OpenClaw UI shortcut | `bridgesrd:bridgesrd` |
| `/home/bridgesrd/Desktop/AI - *.desktop` | applicable Claude Code, Codex, Grok Build, Antigravity, and Ollama terminal-runtime shortcuts; Agent Zero is intentionally absent pending its authenticated exchange | `bridgesrd:bridgesrd` |
| `/var/lib/bridgesllm/remote-desktop-ai-launchers/manifest.tsv` | exact runtime identity, intent, mode, auth boundary, target, and icon digest chosen during provisioning | `root:root`, `0644` |
| `/var/lib/bridgesllm/remote-desktop-ai-launchers.lock` | stable lifecycle lock serializing launcher mutation and coherent verification snapshots even while the manifest state directory is absent | `root:root`, `0600` |
| `/home/bridgesrd/.config/bridges-ai-runtime-browser` | reserved private state for a future authenticated local UI; no current shortcut uses it | `bridgesrd:bridgesrd`, `0700` |

The Shared Browser profile and logs must not be placed in `/tmp`. The OpenClaw UI's private `dashboard-url` and `launch.html` files keep its fragment token out of the Chrome process list and are mode `0600`.

Chrome/Chromium runs with its normal Linux sandbox. Do not add `--no-sandbox`, `--disable-gpu-sandbox`, or `--disable-setuid-sandbox` to either product launcher. Headless flags used only by isolated test harnesses are a separate concern.

The AI runtime launcher catalog has four explicit surface modes: `native-gui`, `local-web`, `terminal-tui`, and `vendor-site`, although the current catalog provisions terminal runtimes only. Portal-installed Claude Code, Codex, Grok Build, and Antigravity open their actual CLIs as `terminal-tui` shortcuts under the `bridgesrd` account, with a separate desktop sign-in rather than copied Portal CLI credentials. Their version probes use the same exact pins and no-update flags as the installer. An optional CLI that is genuinely absent emits no shortcut and does not make all of Remote Desktop unhealthy; an installed but wrong-version, broken, stale, or misidentified runtime fails readiness. Ollama opens as a local runtime terminal. There is no consumer-site fallback.

Launcher install and removal hold one stable lifecycle lock, then re-attest each manifest, desktop entry, and icon by type, content, and device/inode immediately before changing its path. Portal lifecycle callers are therefore serialized, and an observed same-name replacement fails closed. This is not a claim of kernel-atomic protection against a deliberately adversarial `bridgesrd` process: that account owns its Desktop and can change its own shortcuts again after setup completes.

Agent Zero is fail-closed. Its raw loopback login page is not a ready desktop surface. The verifier reports a blocker while the managed runtime exists but Portal lacks a backend-issued, short-lived, single-use browser exchange bound to the current Portal user. Static Agent Zero credentials, persistent login URLs, and CLI OAuth-to-cookie handoffs are prohibited. OpenClaw Web UI remains a separate signed launcher and is not part of this catalog.

## Signed runtime files

The installer and in-Portal repair path converge on these signed product files:

```text
installer/scripts/bridges-rd-xtigervnc-start.sh
installer/scripts/bridges-rd-session-guard.sh
installer/scripts/bridges-rd-healthcheck.sh
installer/scripts/bridges-rd-window-fit.sh
static/scripts/bridges-rd-shared-chrome.sh
static/scripts/bridges-rd-openclaw-ui.sh
static/scripts/bridges-rd-ai-launchers.sh
static/novnc/vnc_portal.html
static/novnc/core/rfb.js
```

They install as:

```text
/usr/local/bin/bridges-rd-xtigervnc-start.sh
/usr/local/bin/bridges-rd-session-guard.sh
/usr/local/bin/bridges-rd-healthcheck.sh
/usr/local/bin/bridges-rd-window-fit.sh
/usr/local/bin/bridges-rd-shared-chrome.sh
/usr/local/bin/bridges-rd-openclaw-ui.sh
/usr/local/bin/bridges-rd-ai-launchers.sh
```

All signed Remote Desktop runtime scripts are mandatory release-inventory members. The product runtime never sources a launcher from the managed Portal skill.

## Installer and repair behavior

Fresh install, signed update, and `POST /api/remote-desktop/auto-setup` use the same runtime contract:

- Install TigerVNC, noVNC, websockify, XFCE, D-Bus/X11 utilities, `xauth`, `xclip`, `xsel`, PulseAudio, `wmctrl`, and `xdotool`.
- Create the `bridgesrd` account and private runtime/state directories.
- Install the signed launchers and desktop entries.
- Provision only exact, version-attested Claude Code, Codex, Grok Build, Antigravity, and Ollama terminal runtimes. Missing optional runtimes receive no shortcut. Agent Zero receives no shortcut until Portal can issue a short-lived, single-use exchange bound to the active Portal user. Re-running setup reconciles signed assets only after proving ownership; it never overwrites or removes a same-name foreign replacement.
- Generate a fresh Xauthority cookie and the canonical desktop environment.
- Bind VNC, websockify, the audio bridge, and browser debugging listeners to loopback only.
- Enable `bridges-rd-xtigervnc.service`, `bridges-rd-websockify.service`, and the 30-second `bridges-rd-healthcheck.timer`.
- Wait for `xfce4-session`, `xfwm4`, and `xfdesktop`; refuse READY while a locker/greeter is present; then supervise that semantic policy with systemd watchdog heartbeats.
- Verify live listeners, process arguments, the real lock-free XFCE session, guard supervision, X11 access control, file ownership, modes, and signed-file parity before reporting success.
- Store `remoteDesktop.url` as `/novnc/vnc_portal.html?reconnect=1&resize=smart` and the normal allowed prefixes as `/novnc,/vnc`.

Status polling is read-only. The signed session guard repairs harmless no-lock/idle drift in place and deliberately exits after repeated semantic failures so systemd can restart the stack with bounded start limits. A separate timer survives Portal outages and VNC start-limit exhaustion: it rechecks the real XFCE session every 30 seconds, shares the setup/recovery mutation lock, allows at most three automatic restarts per ten minutes, and then suppresses restarts for 15 minutes. Its sanitized result is written atomically to `/run/bridges-rd/health-state.json`. Setup and recovery are serialized so concurrent requests cannot race service or package changes.

## Authenticated API

Every endpoint below requires an approved elevated Portal account (`OWNER` or `SUB_ADMIN`). Cookie-authenticated mutations also pass the Portal same-origin CSRF boundary.

- `GET /api/remote-desktop/status` — returns `ready`, `degraded`, or `unavailable`, signed-asset parity, service/listener/process checks, browser state checks, and recovery timing.
- `GET /api/remote-desktop/clipboard?selection=clipboard|primary` — reads the X11 selection as `bridgesrd`.
- `POST /api/remote-desktop/clipboard` — writes `clipboard`, `primary`, or `both`; payloads are limited to 1 MiB.
- `POST /api/remote-desktop/recover` — first repairs lock/idle policy without interrupting the desktop. If structural recovery is still required, it returns `restartRequired`; retrying with `confirmation: "RESTART REMOTE DESKTOP"` authorizes the disruptive restart.
- `POST /api/remote-desktop/auto-setup` — installs/repairs packages, files, settings, and services; requires `confirmation: "SET UP REMOTE DESKTOP"`.

Shared Browser integration is also elevated-role only:

- `GET /api/agent-browser/status`
- `GET /api/agent-browser/screenshot/:targetId`
- `POST /api/agent-browser/open-in-desktop` — accepts only an empty URL or an HTTP(S) URL without embedded credentials, then returns the private state/profile/log paths.
- WebSocket `/api/agent-browser/stream` — exact-path authenticated stream with client, payload, and backpressure limits.

## Verification

Run the public source contracts first:

```bash
cd backend
DATABASE_URL=postgresql://test:test@127.0.0.1:5432/test \
  npm test -- --runInBand \
  src/tests/remoteDesktopContract.test.ts \
  src/tests/remoteDesktopHealthState.test.ts \
  src/services/remoteDesktopMutationLock.test.ts \
  src/services/remoteDesktopPolicy.test.ts
```

On an installed host:

```bash
systemctl is-active bridgesllm-product.service
systemctl is-active bridges-rd-xtigervnc.service
systemctl is-active bridges-rd-websockify.service
systemctl is-active bridges-rd-healthcheck.timer
/usr/local/bin/bridges-rd-session-guard.sh check
/usr/local/bin/bridges-rd-ai-launchers.sh verify
cat /run/bridges-rd/health-state.json

ss -H -ltn | grep -E '127\.0\.0\.1:(4001|5901|6080|4714|18801|18802)'
ps -eo user:32=,args= | grep '[X]tigervnc :1'
ps -eo user:32=,args= | grep '[w]ebsockify 127.0.0.1:6080 127.0.0.1:5901'
pgrep -u bridgesrd -af 'xfce4-screensaver|light-locker|xscreensaver|xss-lock' && echo 'unexpected locker' || true

stat -c '%U:%G:%a %n' \
  /home/bridgesrd/.Xauthority \
  /home/bridgesrd/.bridges-rd-env \
  /home/bridgesrd/.config/bridges-agent-browser \
  /home/bridgesrd/.config/bridges-agent-browser/logs \
  /home/bridgesrd/.config/openclaw-control-ui-browser

curl -fsS http://127.0.0.1:4001/health
# Supply an authenticated Portal cookie jar for the API check.
curl -fsS -b portal-cookie-jar http://127.0.0.1:4001/api/remote-desktop/status
```

Ports `18801` and `18802` are expected to be absent while their browsers are idle. Every listener that is present must remain loopback-only. A healthy Xtigervnc command contains `-localhost=1` and `-auth /home/bridgesrd/.Xauthority`, and does not contain `-ac`.

## Troubleshooting

Start with `GET /api/remote-desktop/status`; its checks distinguish a missing service, exposed listener, stale signed file, missing clipboard tool, unsafe browser-state directory, and optional browser/audio availability.

```bash
journalctl -u bridgesllm-product.service -n 150 --no-pager
journalctl -u bridges-rd-xtigervnc.service -n 150 --no-pager
journalctl -u bridges-rd-websockify.service -n 150 --no-pager
journalctl -u bridges-rd-healthcheck.service -n 150 --no-pager
tail -n 150 /var/log/bridges-rd/xfce.log
tail -n 150 /var/log/bridges-rd/pulseaudio.log
tail -n 150 /home/bridgesrd/.config/bridges-agent-browser/logs/launcher.log
```

Use the authenticated recovery endpoint or the Desktop page's recovery control first; harmless lock/idle drift is repaired without disconnecting the user. Only its confirmed restart fallback and auto-setup interrupt active desktop work. Use auto-setup when packages, signed launchers, units, or permissions need repair.

Do not expose ports 5901, 6080, 4714, 18801, or 18802; remove the Portal auth gate; restore the legacy service; disable X11 access control; or weaken the browser sandbox as a troubleshooting shortcut.
