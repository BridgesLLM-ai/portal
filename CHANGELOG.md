# Changelog

All notable changes to BridgesLLM Portal are documented here.

## [3.20.0] — 2026-03-29

### 🔐 Security
- **Remove rehype-raw from markdown renderer** — Agent responses with unfenced HTML were rendered directly into the portal DOM via rehype-raw, enabling XSS and breaking page layout. Raw HTML in chat is now safely escaped; code blocks with preview still work via sandboxed iframe.

### 🚨 Critical
- **Fix installer destroying portal on update** — The installer hardcoded `bridgesllm_portal` on port 5432 for the database URL and migration check. Installs using different database names or ports (common on established servers) would fail the check with "0 tables created" and abort — without restarting the portal service. Result: dead portal after clicking "Update". Fixed: preserve existing DATABASE_URL on updates, parse it for migration checks, and always restart the service if the update fails mid-way.

### 🐛 Bug Fixes

#### Provider Authentication
- **Fix Anthropic API key/token save** — API keys entered through portal settings were never persisted to auth-profiles.json. The portal now writes directly to all three config files (auth-profiles.json, openclaw.json, models.json) instead of relying on `openclaw onboard` which silently failed for non-OAuth providers.
- **Fix Claude setup-token extraction** — Token regex didn't match Claude CLI's actual output format. Now matches the `sk-ant-oat01-` prefix directly, immune to format changes.
- **Fix save button disabled when no model selected** — Adding a provider when a default model was already configured left the Save button grayed out because `selectedModel` started as null.
- **Fix model default override** — All three setup flows (API key, OAuth, setup-token) auto-selected a model on mount, silently overwriting the user's existing default. Now checks for an existing default first.
- **Fix OpenClaw stdout diagnostic pollution** — `registerProviderModels` JSON parsing failed because OpenClaw CLI prints diagnostic messages to stdout before JSON output. Now strips non-JSON prefixes before parsing.

#### Chat Streaming
- **Fix stale "Agent is thinking" indicator** — `stream-status` endpoint returned `active: true` from stale gateway `chatState` or soft-cleared StreamEventBus entries. Added: active flag check in `getStreamStatus()`, 90s stale event guard on the endpoint, and 60s gateway activity guard.
- **Fix missed messages after phone lock/tab background** — Visibility change handler now reloads chat history when tab becomes visible and no stream is active, picking up responses that completed while the device was backgrounded.

#### Code Preview
- **Fix HTML preview iframe white background** — Removed `bg-white` class from preview iframe so dark-themed app previews render correctly.
- **Auto-detect bare HTML responses** — Agent responses with raw `<!DOCTYPE html>` (no markdown code fences) now auto-wrap in fences for proper code block + preview rendering.
- **Wrap partial HTML in clean document** — Partial HTML snippets get a minimal document wrapper with CSS reset to prevent style leakage into the portal.

#### Installer
- **Fix migration table count check** — Replaced PrismaClient-based check (failed due to wrong working directory) with direct `psql` query. Prevents false "0 tables" errors during updates.
- **Fix hardcoded Anthropic model fallback** — Removed hardcoded `anthropic/claude-opus-4-6`; uses the gateway's configured default model instead.

## [3.19.0] — 2026-03-26

### ✨ AI Provider Setup Wizard
- **One-click OAuth sign-in** for ChatGPT/Codex, Google Gemini, and Claude — automated PTY-based auth flows handle the entire process.
- **Step-by-step wizard** with provider-specific prerequisites (subscription checks, Google Cloud Project ID, OAuth consent screen instructions).
- **Claude automated setup** — runs `claude setup-token` server-side, captures auth URL, opens browser, detects completion, and saves credentials automatically. Falls back to manual token paste if needed.
- **Google Gemini enhancements** — auto-confirms caution prompt, supports `GOOGLE_CLOUD_PROJECT` for paid accounts, auto-detects when local callback server completes auth.
- **Auto-completion polling** — frontend polls session status every 2–3s, detects when OAuth finishes without user intervention.
- **All provider models registered automatically** — after auth, discovers and adds all available models as fallbacks so they appear in every model switcher.

### 🎛 Wizard UX Improvements
- **Correct step ordering** — AI Coding Tools (install CLIs) appears before Connect an AI Provider (requires CLIs).
- **No auto-advance** — connecting a provider no longer skips to the next wizard step. Users can add multiple providers before clicking Continue.
- **Model selection optional** — "All models added automatically" messaging with optional default selection.
- **Provider cards with row layout** — clean card UI for ChatGPT, Gemini, Claude, and OpenClaw "More" options.

### 🔔 OAuth Expiration Tracking
- Provider cards now display token expiry dates with color-coded urgency badges.
- Visual states: green (healthy), amber (expiring within 14 days), red (expiring within 3 days or expired).
- Expired tokens show "Re-authenticate to restore access" with one-click re-auth flow.

### 🖥 Remote Desktop
- **Resize support fixed** — changed VNC `AcceptSetDesktopSize` from 0 to 1. Browser window resizing now works.

### 🐛 Bug Fixes
- Fixed installer hanging on "Waiting for package manager" — `awk` self-matching bug where the package-manager-busy check detected its own process.
- Fixed avatar 404 console errors — return null instead of path to non-existent default file.
- Fixed WebSocket disconnect on terminal session close.
- Installer uses `openclaw@latest` instead of pinned version.

### 🔐 Security
- Removed tracked SSH terminal keys from repository (now generated per-instance).
- Removed stale compiled assets directory from tracked files.
- Cleaned internal documentation of test infrastructure details.

### 📦 Installer
- Package manager busy check excludes awk/grep/ps/bash from self-matching.
- VNC launcher creates resize-enabled sessions by default.

## [3.18.2] — 2026-03-24

### 🔐 Security Hardening
- **Systematic shell-escape enforcement** across all backend `execSync` paths — every user-influenced parameter (commit messages, branch names, file paths, URLs, remote names) now uses proper single-quote shell escaping instead of double-quote interpolation.
- **Input validation tightened** — branch names, remote names, and commit hashes are validated against strict allowlist regexes before reaching any shell command.
- **Desktop env file permissions** reduced from world-readable to owner+group only.

### 🖥️ Remote Desktop
- **Centralized desktop environment** — all Remote Desktop launch paths (projects, agent browser, shared Chrome) now source a single canonical env file (`/home/bridgesrd/.bridges-rd-env`) written at VNC startup. Eliminates the class of bugs where environment variables were silently dropped during `su` login shell transitions.
- **Python/pygame audio fix** — projects using audio (pygame, SDL) no longer crash with "ALSA: Couldn't open audio device" because `DISPLAY`, `PULSE_SERVER`, and `SDL_AUDIODRIVER` are now guaranteed to reach the child process.
- **New `desktopEnv.ts` module** — `desktopExec()` and `desktopExecDetached()` helpers provide a single, tested code path for running commands as the desktop user with full environment inheritance.
- **Graceful fallback** — older installs that haven't re-run Remote Desktop setup get inline environment exports as a fallback, so nothing breaks during the update window.

### 🤖 OpenClaw Integration
- **Bundled `bridgesllm-portal` skill** — a comprehensive AgentSkill for operating the portal ships in every install. Covers Remote Desktop, shared browser (CDP), email, file management, projects, agent chat, automations, terminal, apps deployment, dashboard, and system administration. Automatically installed into the OpenClaw workspace during setup wizard and refreshed on Remote Desktop auto-setup.

### 🔧 Installer
- **Package-manager wait disabled** — `apt-get` handles lock contention natively; the custom wait loop caused false-positive blocking on fresh VPS instances where idle daemons (`unattended-upgrade-shutdown --wait-for-signal`, `packagekitd`) were detected as blockers.
- **Real progress bars** — installer now shows actual download sizes, real package counts, and pulse animations for indeterminate steps instead of estimated placeholders.
- **OpenClaw version display fix** — summary no longer stutters `OpenClaw OpenClaw 2026.x.x`.

## [3.18.0] — 2026-03-23

This is a major release covering a full week of intensive development. Dozens of new features, hundreds of fixes, and significant architectural improvements across every layer of the portal.

### 🖥️ Shared Browser & Remote Desktop
- **Shared Browser** — full shared Chrome browser embedded in the Remote Desktop page, controllable by both users and agents via CDP. Agents can navigate, screenshot, evaluate JS, and interact with pages through the portal skill.
- **Smart adaptive resolution** — VNC viewport now auto-adjusts to match your browser window size instead of using a fixed resolution.
- **Viewport stability overhaul** — eliminated resize oscillation, phantom viewport pollution, iframe reload loops, and Chrome state file contamination that caused resolution drift.
- **Chrome cold-start reliability** — `--no-sandbox` flag, network warm-up sequence, and fresh temp profiles prevent blank/broken browser sessions.
- **Full XFCE desktop config** — ships a complete desktop theme (Greybird + elementary icons), panel layout, keyboard shortcuts, and session defaults so Remote Desktop looks polished out of the box.
- **Remote Desktop audio** — PulseAudio → WebSocket → Web Audio API pipeline for streaming desktop audio to the browser. Includes mobile Safari support and reconnect safety.
- **Remote Desktop in installer** — auto-installs and configures Xtigervnc, noVNC, XFCE, and audio on fresh installs and updates.
- **Agent browser viewer** — live CDP screenshot streaming panel merged into the Remote Desktop page, so you can watch what the agent sees in real time.

### 💬 Agent Chat
- **FYI mode** — message queue with remove and drain for agent yield states, so the agent can park non-urgent messages for you to review.
- **Drag/drop + paste attachments** — drop files or paste images directly into the chat composer.
- **Reconnect indicator + button** — visible connection state with one-click reconnect when the WebSocket drops.
- **Unified Session Controls panel** — thinking level slider, quick-reply model picker, and compaction model selector in one place.
- **Adaptive thinking level** — Opus/Claude 4.6 defaults to the right thinking tier automatically.
- **Thinking bubble visibility** — thinking chip shows during thinking phase even without reasoning content; compaction events no longer pollute the thinking bubble.
- **Aborted run preservation** — partial streamed text is now preserved when a run is aborted, instead of blanking the response.
- **Agent status rail** — unified connected/compacting/streaming state indicator with explicit color mapping.
- **Streaming reliability** — reconnect after restart, survive sub-agent yield/resume across run boundaries, prevent `chat.final` from clobbering post-tool text, fix cascade text length tracking, fix duplicate StreamEventBus subscribers.
- **Session isolation** — agent switching properly isolates sessions; compaction events don't leak across providers.
- **Project chat alignment** — project chat panels now use the same streaming, reconnection, and graduation logic as main chat.

### 🛒 Skill Marketplace
- **Working Extensions/Skills panel** — browse, search, explore, inspect, install, and uninstall skills from clawhub.com directly in the portal UI.
- **Marketplace metadata enrichment** — cards show real descriptions, authors, versions, and download counts instead of placeholder text.
- **Backend fully rewritten** — replaced non-existent `openclaw skills search/install` commands with the real `clawhub` CLI.

### 🔐 Approval Workflows
- **Native approval modal** — exec approval decisions now use the real OpenClaw runtime values (`allow-once`, `allow-always`, `deny`).
- **Modal waits for backend** — approval modal stays open until the backend confirms success, preventing premature close.
- **Visible-browser policy** — enforces that the agent's browser is visible during main portal sessions; hidden browser requests are denied.

### 📧 Email
- **Owner mail provisioning** — automatic mailbox creation during setup with password drift prevention.
- **Mail signature and auto-forward** — database migration and UI support for per-user email signatures and forwarding rules.
- **Share link email** — branded email with optional password sent from user's own mailbox via the share panel.

### 🔧 Installer & Fresh-VPS UX
- **Fresh-VPS transparency** — installer now detects `apt`/`dpkg`/`cloud-init`/`unattended-upgrades` blockers, shows what it's waiting on with elapsed time, and continues automatically. No more "the installer looks frozen."
- **Safe package-manager recovery** — if package state is interrupted (not actively busy), installer attempts `dpkg --configure -a` + `apt-get -f install` before failing.
- **Per-package install verification** — replaced unreliable count-based checks with per-package `dpkg -s` verification.
- **Auto-dependency detection** — unified progress notifications for missing system dependencies.
- **Three-tier update strategy** — choose always/minor-only/never for component updates.
- **Dependency version tracking** — dashboard shows versions of all installed components (PostgreSQL, Caddy, Docker, Ollama, OpenClaw, Node).

### 🔗 OpenClaw Compatibility
- **Persistent gateway hardening** — stripped unsupported connect params that caused silent WebSocket rejections on OpenClaw 2026.3.x.
- **Gateway RPC routing** — all RPC now routes through the persistent WS to prevent clientId collision that broke chat streaming.
- **Health endpoint accuracy** — dashboard now requires authenticated persistent WebSocket before reporting "Connected" instead of just checking HTTP reachability.
- **Reconnect button** — when gateway is reachable but WS auth fails, a reconnect button appears instead of a dead-end error.
- **Token resolution centralized** — portal reads gateway token from `openclaw.json` at runtime, eliminating token mismatch after `openclaw onboard`.

### 🎨 UI/UX
- **Lazy loading + React.memo + skeleton loading** — significantly faster page loads and smoother navigation.
- **Terminal tab persistence** — terminal tabs survive navigation between pages.
- **Slash command autocomplete** — categorized palette with provider-aware commands, scroll-into-view, and blur dismiss.
- **Dynamic OG tags** — portal generates Open Graph meta tags from branding settings.
- **Search engine visibility toggle** — choose whether search engines can index your portal.
- **Project rename** — double-click or pencil icon in sidebar to rename projects inline.
- **Feature carousel** — marketing site shows live video demos of every feature.
- **YouTube embed support** — CSP now allows YouTube frames in portal-hosted pages.

### 🔒 Security
- **Cookie-first auth** — removed localStorage token exposure paths.
- **Domain-aware auth cookies** — cookies respect the actual deployment domain.
- **Shell injection prevention** — domain regex validation before shell execution in self-update.
- **Self-update process survival** — uses `systemd-run --scope` to survive service restart.
- **Share access hardening** — signed share cookies, usage limits, and tighter public share gating.
- **Step 10 security audit** — comprehensive audit with npm audit fixes.

### 📊 Infrastructure
- **README architecture** now uses a Mermaid diagram instead of misaligned ASCII boxes.
- **README requirements** updated to match real minimums (3.5GB RAM, 35GB disk).
- **Telemetry V2** — install lifecycle events, download tracking, heartbeat with dependency versions.
- **Release process** — verified on external test box before production alignment.
- **GitHub export** rewritten to eliminate `.work/` duplication and add comprehensive exclusions for internal docs.

### Bug Fixes (selected)
- Fixed installed skills endpoint crash when OpenClaw emits JSON on stderr
- Fixed pre-existing TypeScript build errors in setup-legacy and gateway RPC
- Fixed Monaco editor black box (CSP blocking jsdelivr CDN stylesheet)
- Fixed session stability / unexplained logouts
- Fixed rsync `--delete` nuking projects on update
- Fixed corrupted `MAIL_DOMAIN` from missing trailing newline
- Fixed SVG wallpaper rendering (missing librsvg2-common)
- Fixed `DATABASE_URL` hardcoded port in update path
- Fixed HTTP/IP installs — `crypto.randomUUID` replaced with safe client ID fallback
- Fixed thinking slider sending invalid `sessions.patch` field instead of `/think`
- Fixed compaction model control to use real OpenClaw options

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
