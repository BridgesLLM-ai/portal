# Changelog

All notable changes to BridgesLLM Portal are documented here.

## [3.16.0] — 2026-03-19

### Added
- **Auto-Dependency Detection** — When you run a Python, C++, or Node.js project, the system automatically detects missing dependencies (scans `requirements.txt`, `import` statements, `#include` directives, `package.json`) and installs them with live progress feedback. Cached after first install — subsequent runs are instant.
- **Unified Progress Notifications** — New polished notification card for deploy, dependency install, and build operations. SVG progress ring, live status text, collapsible log output, sound effects. Matches the Files page upload card quality.
- **Dependency Check API** — `GET /check-deps` returns what's needed without installing. `POST /install-deps` streams install progress via Server-Sent Events.
- **50+ Python module mappings** (cv2→opencv-python, PIL→Pillow, etc.) and **20+ C++ header mappings** (SDL2→libsdl2-dev, etc.) for smart auto-detection.

## [3.15.1] — 2026-03-19

### Fixed
- **Owner email account broken on fresh install (CRITICAL)** — Setup wizard never called `provisionUserMailbox` for the owner account. The mailbox was only created on first mail page visit via auto-provision, which failed because the `signature` column didn't exist yet (no migration). This left Stalwart and the DB with mismatched passwords, causing permanent 401 errors for the owner's email.
- **Missing database migration** — Added migration `20260319_add_mail_signature_forward` for the `signature`, `signatureHtml`, and `autoForwardTo` columns on `MailboxAccount`. Without this, fresh installs using `prisma migrate deploy` never created these columns, causing Prisma errors on any mailbox operation.
- **Password drift on provisioning retry** — `provisionUserMailbox` generated a new random password on every retry attempt. If Stalwart already had the account (409), it patched Stalwart with the new password, but if the DB upsert then failed, the passwords diverged permanently. Now reuses the existing DB password when one exists.
- **Blank white page on fresh install** — Tarball `--exclude='assets'` glob stripped `frontend/dist/assets/` (all JS/CSS bundles). Express served `index.html` for every asset request, returning `text/html` MIME type for `.js` files. Fixed exclude to be path-anchored (`--exclude='./assets'`).

## [3.15.0] — 2026-03-19

### Added
- **Runtime Projects** — Create Python (🐍) and C++ (⚙️) projects alongside HTML, React, and Node.js. Hit "Run" and they execute on the Remote Desktop in an xterm window. Build real apps from a tablet.
- **Syntax/Compile Checker** — "Check" button replaces Preview for runtime projects. Validates Python (`py_compile`), C++ (`g++ -fsyntax-only`), and Node (`node --check`) without executing.
- **Auto-Forward Email** — Forward incoming portal emails to your personal email address. Toggle in the mail sidebar. Tracks forwarded messages to prevent duplicates.
- **IMAP Setup Guide** — "Connect Your Phone" button in mail sidebar. Shows your credentials, IMAP/SMTP server settings, and step-by-step instructions for iPhone, Android, and Outlook.
- **HTML Email Signatures** — Auto-generated signature with your portal logo, name, and email. Per-user (stored in DB, not a global file). Editable.
- **Build Safety Guard** — `npx vite build` now **fails loudly** if `VITE_API_URL` is not set. Prevents silent deployment of broken frontend bundles. Runtime fallback to `/api` with console warning as backup.
- **Mail Credentials Endpoint** — `GET /api/mail/credentials` returns IMAP/SMTP settings for external mail client setup.

### Fixed
- **HTML Email Rendering** — HTML emails (newsletters, receipts, notifications) now display with their original styling instead of forced dark mode. Only plain text emails use dark background.
- **Mobile Email Layout** — Auto-resizing iframe eliminates scrollbar-in-scrollbar. Responsive scaling for images and tables. Compact headers on mobile.
- **API Client Fallback** — `client.ts` falls back to `/api` instead of empty string when `VITE_API_URL` is missing. Prevents all-endpoints-broken scenario.
- **Check Endpoint Double Prefix** — Fixed `/api/api/projects/...` bug in the frontend check call.

### Security
- **Shell Injection Hardening** — All user-derived filenames and project names in `execSync` calls are now shell-escaped via `shellEscape()`. Project names sanitized to `[a-zA-Z0-9_-]`.
- **Signature XSS Prevention** — User-submitted HTML signatures sanitized with `sanitize-html` before storage. Default signature template HTML-escapes all interpolated values.
- **Duplicate Process Prevention** — `pkill` kills existing xterm for a project before launching a new one.
- **Self-Forward Protection** — Cannot set auto-forward to your own portal email (prevents infinite loop).

### Changed
- Email signatures migrated from global file (`mail-signature.txt`) to per-user database fields on `MailboxAccount`
- Template picker grid changed from 3-column to 5-column for clean layout with 5 project types
- Deploy button shows ▶️ "Run" (Play icon) for runtime projects instead of 🚀 "Deploy" (Rocket icon)
- `detectDeployType()` return type expanded: `'static' | 'fullstack' | 'runtime'`

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
