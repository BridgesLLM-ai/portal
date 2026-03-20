# Changelog

## [3.17.2] — 2026-03-20

### Added
- **Remote Desktop in installer** — Full VNC desktop (XFCE + PulseAudio + themes + Chrome/Firefox) now provisioned during install. No longer requires manual auto-setup click from the dashboard. Updates also re-provision Remote Desktop to apply fixes.

### Fixed
- **ZIP uploads use pure JS extraction** — Replaced system `unzip` binary dependency with `extract-zip` (yauzl). Fresh servers no longer need `unzip` installed. Also eliminates shell injection risk from string-interpolated exec calls.
- **Remote Desktop race condition** — Stock `vncserver@1.service` (from tigervnc package) competed with `bridges-rd-xtigervnc` for display `:1`. On fresh installs it could win the race, launching a bare VNC session with no desktop theme, no PulseAudio, no XFCE. Installer and auto-setup now disable and mask the stock service.
- **Dashboard updater version tracking** — `PORTAL_VERSION` was stuck at `3.14.0` since initial release; update checker never showed available updates.

## [3.17.0] — 2026-03-20

### Added
- **Remote Desktop Audio** — Full audio pipeline from VNC desktop to browser
  - PulseAudio virtual sink captures all desktop audio (pygame, browser, any app)
  - WebSocket proxy streams raw PCM at CD quality (44100Hz, 16-bit, stereo)
  - Web Audio API playback with low-latency scheduling (~30ms end-to-end)
  - Volume control slider in Remote Desktop toolbar
  - Auto-reconnect on network interruptions
  - Mobile Safari / older Android compatibility (webkitAudioContext, user gesture handling)
  - Tab visibility handling prevents audio burst on return
- **Auto-Dependency Detection** — Python/C++/Node projects auto-detect and install deps
  - Scans requirements.txt, import statements, #include headers, package.json
  - Per-project Python virtual environments (PEP 668 compatible)
  - SSE progress streaming with unified progress notification UI
  - Dependency cache prevents redundant reinstalls

### Fixed
- Python projects now have audio — xterm launch exports PulseAudio environment variables
- PulseAudio `module-suspend-on-idle` blocked parec from streaming (unloaded on startup)
- `.venv` and `.deps-installed` excluded from project downloads and file tree
- Upload progress bar visibility (initial width fix)
- parec latency reduced (20ms buffer), Web Audio scheduling tightened

### Security
- All user-derived values in exec calls sanitized via `shellEscape()`


All notable changes to BridgesLLM Portal are documented here.

## [3.14.0] — 2026-03-17

### Fixed
- **Agent Chat Connection Failure (CRITICAL)** — `PersistentGatewayWs` sent unsupported top-level properties (`lastSeq`, `stateVersion`) in the WebSocket connect request. OpenClaw 2026.3.x strict validation rejected these, causing **every** connection attempt to fail silently. Dashboard showed "Connected" (green) while Agent Chat was completely broken. Root cause: the gateway's connect param schema only accepts `auth`, `client`, `device`, `role`, `scopes`, `caps`, `minProtocol`, `maxProtocol`. All other properties are now stripped.
- **Dashboard False Positive** — health endpoint and green dot used an HTTP probe to the gateway's web UI root, which always returns 200 if the process is running. Now requires the authenticated persistent WebSocket to be connected before reporting "Connected."
- **Missing RPC Scope** — `openclawGatewayRpc.ts` only requested `operator.admin` scope. Added `operator.read` to fix `config.get` "missing scope" errors.

### Added
- **Reconnect Button** — when the dashboard detects the gateway is reachable but the real-time WebSocket is dead, it shows a "Reconnect" button instead of a dead-end error message. Triggers `POST /api/gateway/reconnect` which forces a PersistentGatewayWs reconnect with up to 8s wait.

### Changed
- Dashboard health endpoint now returns `chatReady` (authenticated WS) in addition to `connected` (HTTP probe)
- Green avatar dot checks `/api/gateway/health` with `wsConnected` instead of the basic `/api/gateway/status` probe
- Tailnet-specific hostnames removed from committed source (use `VITE_ALLOWED_HOSTS` env var instead)
- GitHub export script rewritten — eliminates `.work/` duplication bug, adds comprehensive exclusions for internal docs, job data, test files, and build artifacts

## [3.13.0] — 2026-03-16

### Added
- **Project Rename** — double-click or pencil icon in sidebar to rename projects inline
- **Dynamic OG Tags** — portal generates Open Graph meta tags from branding settings
- **Search Engine Visibility Toggle** — choose whether search engines index your portal
- **Dependency Version Tracking** — dashboard shows versions of all installed components
- **Feature Carousel** — marketing site now shows live video demos of every feature

### Fixed
- **Gateway Token Resolution** — centralized token resolver reads from `openclaw.json` at runtime, eliminating token mismatch issues after `openclaw onboard`
- **Chat Streaming Jank** — unified render path prevents React unmount/remount flicker during streaming
- **Unclosed Code Fences** — auto-closes unclosed markdown code blocks during streaming for proper rendering
- **HTML Auto-Preview** — HTML and SVG code blocks default to preview view with deferred iframe loading
- **Accent-Colored Streaming Border** — streaming chat bubbles use your theme accent color with smooth fade
- **Monaco Editor Black Box** — added CDN stylesheet to CSP `style-src` for proper editor rendering
- **Installer Token Sync** — reads live gateway token after OpenClaw starts, patches `.env.production` if mismatched
- **Update rsync Safety** — excludes `.env.production` and `.env` from `--delete` during updates
- **Self-Update Process Survival** — uses `systemd-run --scope` to survive service restart
- **Shell Injection Prevention** — domain regex validation before shell execution in self-update

### Changed
- Dashboard health check triggers gateway reconnect when token exists but WS is disconnected
- Installer generates token early to prevent empty token in fresh `openclaw.json`

## [3.12.0] — 2026-03-16

### Fixed
- Chat streaming transitions and rendering reliability
- Accent-colored dashed border on streaming bubbles

## [3.11.0] — 2026-03-16

### Added
- Dependency version tracking in heartbeat telemetry
- Three-tier update strategy in installer (always/minor-only/never)

### Fixed
- Monaco editor CSP stylesheet blocking (CDN added to `style-src`)

## [3.10.0] — 2026-03-16

### Added
- Telemetry V2 with install lifecycle events and download tracking

### Fixed
- `DATABASE_URL` hardcoded port in update path

## [3.9.0] — 2026-03-16

### Added
- Dynamic OG tags for portal (injected from SystemSetting)
- Search engine visibility toggle (`noindex` meta tag)

### Fixed
- Shell injection in self-update domain parameter (CRITICAL)
- JWT refresh secret auto-generation for old installs

## [3.8.0] — 2026-03-16

### Fixed
- Self-update process killed by systemd stop — now uses `systemd-run --scope`
- Avatar shows stale cached image after crop/save

## [3.7.0] — 2026-03-16

### Fixed
- OpenClaw token mismatch — portal reads token from `openclaw.json` at runtime
- rsync `--exclude='assets'` blocking frontend JS deployment (CRITICAL)
- Corrupted `MAIL_DOMAIN` from missing trailing newline in env file
- `userMailService.ts` module-scope caching of stale env values
- GIF crop/zoom disabled in avatar editor
- Project agent default model hardcoded to unavailable `opus-4-6`

---

*For the full commit history, see [GitHub Releases](https://github.com/BridgesLLM-ai/portal/releases).*
