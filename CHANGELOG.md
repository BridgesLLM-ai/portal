# Changelog

All notable changes to BridgesLLM Portal are documented here.

## [3.23.9] — 2026-04-09

### Improved
- **Session controls are substantially better in both main chat and project chat** — OpenClaw sessions now expose native fast mode controls, project chats gained thinking controls, and session-control state behaves more consistently across reconnects.
- **Project model handling is more reliable** — the portal now preserves intended project models, normalizes model IDs reported back from session info, and reduces bad fallbacks that used to make model switching look flaky.
- **Agent chat recovery is tougher under long or interrupted runs** — reconnect behavior, control filtering, hidden-resume handling, and yielded-run recovery were tightened so stale streams and ghost resumes are far less likely.
- **OpenClaw compatibility hotfix is now explicit and admin-controlled** — admins can inspect the installed runtime patch state and apply the older OpenClaw long-run relay hotfix directly from Agent Chat session controls or Settings instead of relying on hidden manual server edits.
- **Ollama defaults were refreshed** — recommendation defaults now line up with the current Ollama guidance shipped in the portal.

### Fixed
- **Dormant and yielded-run reconnect bugs** — the portal now recovers more cleanly after inactive or backgrounded OpenClaw runs instead of leaving stale session controls or dead-looking chats behind.
- **Stale UI state after reloads** — the stale public-settings cache issue, hidden interrupted-stream bubbles after idle timeout, replayed duplicate chat output, and avatar 404 noise were all cleaned up.
- **Heartbeat/session-control edge cases** — false heartbeat-model update failures are avoided, and session-control refresh behavior is more stable.
- **Agent Tools request pressure is bounded** — tab request behavior is tighter, which reduces unnecessary gateway churn.
- **Approved signup passwords are preserved correctly** — the auth flow no longer drops the approved password state during signup.
- **Compatibility hotfix installs now bundle the actual patch helper** — portal releases now ship `scripts/patch-openclaw-long-run-relay-hotfix.sh`, so the admin action works on fresh installs instead of failing with a missing-script error.
- **Hotfix apply now restarts more safely on non-systemd OpenClaw setups** — when `openclaw gateway restart` only reports a disabled service, the portal now falls back to signaling the live gateway process so the patched runtime actually reloads.

## [3.23.8] — 2026-04-07

### Fixed
- **Project chat survives project renames** — assistant session identity is now stable per project instead of being tied to the mutable project name.
- **Large text files preview cleanly** — files over 10MB now open in a graceful read-only preview instead of hard failing, while edit limits remain enforced.
- **Project chat got real session controls** — session controls and slash-command autocomplete are now available directly in project chat.
- **Tasks tab no longer stampedes the gateway** — task loading was reduced to a single cached gateway fetch with in-flight dedupe and stale fallback behavior.

### Security
- **Project downloads stop leaking internal agent state** — clean and stripped exports now exclude `.assistant-*`, `.agent-*`, `.marcus-*`, and `.portal-project.json` files.

### Maintenance
- **Release packaging is tighter** — release and public-export scripts now exclude editor backup files, and release tarballs omit unneeded frontend and backend source trees.

## [3.23.7] — 2026-04-07

### Improved
- **Agent chats recover more gracefully** — reloads, reconnects, attachment handoff, and active stream recovery are all more reliable now.
- **Project AI chat is much more stable** — history recovery, first-open model selection, per-project session routing, and rapid switching between projects all behave more predictably.
- **Files and chat links are more dependable** — attachment access across refreshes and split-host installs is fixed, and file links resolve more cleanly.
- **Tasks and session controls feel cleaner** — long-running work, summaries, and related session controls load with less friction.
- **Missing frontend assets now fail safely** — bad asset requests return proper 404s instead of cascading into blank-page failures.
- **Project model defaults are saner** — providers excluded by auth-order overrides are pushed behind healthy options instead of surfacing first.

### Security
- **File access is tighter** — AI file helper routes are constrained to the correct user and project paths.
- **Share links are safer** — mutations are now scoped to the correct owner and project instead of raw link id alone.
- **Signed tool URLs are harder to abuse** — origin selection is stricter, and browser direct-gateway exposure is narrower.

## [3.23.6] — 2026-04-05

### 🐛 Bug Fixes

#### Mobile Auth / 2FA
- **Clear stale auth cookies before the 2FA handoff** — login responses that enter email/TOTP verification now explicitly expire leftover access and refresh cookies, so old mobile Safari sessions cannot poison the next step with a bad refresh attempt.
- **Clear broken cookies on refresh failure and best-effort logout** — invalid/expired refresh-token paths now actively clear auth cookies, and logout still clears the browser session even when the access token is already dead.
- **Stop bogus session refresh retries during unauthenticated / 2FA-pending flows** — the frontend now limits cookie-based session recovery to explicit restore-session probes and refuses to refresh while 2FA is pending, preventing the generic mobile `login failed` collapse.

## [3.23.5] — 2026-04-05

### 🐛 Bug Fixes

#### Claude (OpenClaw) Setup
- **Revert the Claude CLI bridge detour** — Claude/OpenClaw setup is back on the normal setup-token path instead of trying to repurpose the server Claude Code login as an OpenClaw auth bridge.
- **Show a hard Anthropic Extra Usage warning throughout setup** — the Claude provider card, provider picker, setup flow, and completion state now warn that OpenClaw-driven Claude requests require Anthropic Extra Usage and may require purchasing an Extra Usage bundle.
- **Add a direct link to Anthropic usage settings** — admins can jump straight to `https://claude.ai/settings/usage` from the warning UI instead of hunting through Anthropic settings.
- **Keep native Claude Code login separate** — native Claude Code remains available for the portal's native agent path, but it is no longer presented as the OpenClaw Claude provider setup.

#### Project Chat
- **Unstick project chat when streams end without a final `done`** — project chat now treats `stream_ended` as terminal so the UI stops spinning when the gateway never emits a last completion event.

## [3.23.4] — 2026-04-05

### 🐛 Bug Fixes

#### Claude Subscription / OpenClaw
- **Stop driving the broken `claude-cli/...` model path** — Claude Subscription setup now imports the server Claude Code OAuth session into OpenClaw as an Anthropic OAuth profile, keeps the live model on canonical `anthropic/...` IDs, and explicitly prefers that Claude CLI-backed profile in `auth.order` instead of sending the gateway into `Unknown model` / `Missing auth` failures.
- **Scrub leaked portal OpenClaw env before local CLI calls** — the AI setup flow and other OpenClaw CLI helpers now strip inherited `OPENCLAW_API_URL` / `OPENCLAW_GATEWAY_TOKEN`-style service env before spawning `openclaw`, so setup works from the real systemd service context instead of only from a clean root shell.
- **Auto-repair stale Claude model config** — legacy `claude-cli/sonnet-4.6` / `claude-cli/...` defaults, fallbacks, and model registry entries are now normalized back onto canonical Anthropic model IDs so stale config cannot keep poisoning new chats.
- **Make OpenClaw chat/session model switching actually stick** — project session bootstrap now patches existing sessions onto the intended selected/default model instead of silently reusing an older Claude/Codex session model.
- **Unstick turns that ended on `stream_ended` without final `done`** — both main chat and project chat now treat `stream_ended` as a terminal state, clearing the spinner/watchdog even when the gateway never emits a final completion event.

#### Model Picker Clarity
- **Add clearer model labels and collapse broken Claude duplicates** — OpenClaw model lists are normalized before they reach the UI, duplicate `claude-cli/...` catalog variants collapse onto Anthropic IDs, and chat model pickers now show clearer display names plus provider/runtime badges and the canonical model ID.

## [3.23.3] — 2026-04-04

### 🔧 Maintenance

#### Claude Subscription / OpenClaw Setup
- **Make Claude subscription setup prefer the server Claude CLI path** — The Claude Subscription setup flow now tells admins to log into Claude Code on the server first, then connect OpenClaw to the local `claude-cli/...` runtime instead of steering people toward API-key billing.
- **Add OpenClaw Claude CLI bridge for Anthropic** — The portal can now switch OpenClaw’s Anthropic path over to `claude-cli` by running the proper OpenClaw CLI auth flow on the server, then setting the chosen Claude model automatically.
- **Detect Claude CLI-backed Anthropic setups correctly** — AI Provider status now recognizes Anthropic/OpenClaw setups that are using `claude-cli/...` model references, labels them as `Claude CLI`, and surfaces missing native Claude login as an actual error state.
- **Clean up Claude CLI-backed Anthropic config on removal** — Removing the Claude Subscription provider now also removes `claude-cli/...` model defaults, fallbacks, and registry entries instead of leaving stale Anthropic CLI config behind.
- **Clarify the native Claude login handoff** — After Claude Code server login, the portal now explicitly points admins back to the Claude Subscription card to connect that login to OpenClaw.

## [3.23.2] — 2026-04-04

### 🐛 Bug Fixes

#### Claude Code / Native Agent Chat
- **Fix Claude Code OAuth sessions being overridden by bad Anthropic API keys** — Native Claude chats now prefer the server's local Claude OAuth login over inherited `ANTHROPIC_API_KEY` values, fixing the false `Invalid API key · Fix external API key` failure in Agent Chat after successful OAuth setup.
- **Harden native-provider session routing when switching providers** — Agent Chat no longer tries to reuse OpenClaw session IDs (`main`, `new-*`, or `agent:*`) as Claude/Codex/Gemini native session IDs. When you switch into a native provider, the portal now opens a fresh native session instead of failing history loads or sends against a foreign session key.

## [3.23.1] — 2026-04-02

### 🐛 Hotfixes

#### Agent Chat / Gateway Model Compatibility
- **Fix React crash in Agent Chat selector** — The portal no longer assumes agent `model` fields are always plain strings. This fixes `model.split is not a function` crashes on `/agent-chats` when OpenClaw returns structured model configs.
- **Normalize gateway model values at the backend boundary** — Structured OpenClaw model configs (for example `{ primary, fallbacks }`) are now converted into stable string model IDs before the portal API returns them.
- **Harden model rendering across the UI** — Agent Chat, Agent Tools, Usage, and Terminal status views now safely render model labels even if a non-string value slips through.

## [3.23.0] — 2026-04-02

### ✨ New Features

#### Background Tasks Visibility
- **Add Background Tasks page and Agent Tools tab** — Admins can now view running and recent subagents/cron-backed jobs in a dedicated Tasks view, with status, model, duration, parent session, summaries, and failures.
- **Add `/api/gateway/tasks` backend endpoint** — The portal now queries OpenClaw session state directly to surface detached task activity in the UI.

### 🐛 Bug Fixes

#### Agent Chat / Project Chat
- **Fix stale assistant text after reconnect** — Stream resume now only rehydrates accumulated text while the assistant is actively streaming. Tool/thinking reconnects no longer replay stale content from a prior phase.
- **Suppress phantom live-bubble content during reconnect/tool phases** — Project chat now clears resume-seeded content when real tool/thinking events arrive, preventing duplicated or misleading partial assistant output after tab sleep, disconnects, or tool transitions.

#### Tasks UI
- **Fix Tasks page double-`/api` request bug** — Corrected the Tasks page client path so it requests `/api/gateway/tasks` instead of the broken `/api/api/gateway/tasks`.

## [3.22.0] — 2026-04-01

### 🔧 Maintenance

#### OpenClaw Gateway Compatibility
- **Updated OpenClaw gateway compatibility to 2026.3.31** — Picks up improved exec approval handling, better provider error recovery (Anthropic transient errors now retry instead of failing), hardened config SecretRef round-trips, and background task flow improvements.
- **Installer version bump** — Installer now targets v3.22.0 and is compatible with the latest OpenClaw gateway release.

### 🛡️ Infrastructure
- **Remove unused analytics and installer subdomain routes** — Removed dead Caddy proxy routes (`analytics.bridgesllm.ai`, `install.bridgesllm.ai`) that had no DNS records configured and were generating continuous TLS certificate errors. Analytics dashboard remains accessible through the portal project behind authentication. Installer continues to work at `bridgesllm.ai/install.sh`.
- **Remove public analytics dashboard exposure** — Closed two unauthenticated routes (`/analytics` on the marketing site, `/api/dashboard` on the portal domain) that exposed the analytics dashboard publicly. Data is now only accessible through the authenticated portal.

## [3.21.0] — 2026-03-31

### ✨ New Features

#### Remote Desktop Clipboard & Mobile Keyboard
- **Clipboard paste into Remote Desktop** — New floating toolbar (bottom-right) with a clipboard panel. Paste text from your phone or desktop clipboard directly into the VNC session. Three modes:
  - **Read** — reads your device clipboard into the text area
  - **Paste** — sends text to the VNC clipboard and simulates Ctrl+V
  - **Type** — sends text character-by-character as keystrokes (for password fields, terminals, and apps that don't support clipboard paste)
- **Mobile keyboard support** — Keyboard button opens a hidden input that captures your phone's soft keyboard and forwards all keystrokes to the VNC session. Handles printable characters, Enter, Backspace, Tab, arrow keys, Delete, Home, and End.
- **Works on all devices** — Desktop browsers, iOS Safari, Android Chrome. No additional setup or plugins required.


## [3.20.1] — 2026-03-29

### 🐛 Bug Fixes

#### Native CLI Agent Login
- **Fix Claude Code native login on headless servers** — Replaced the broken localhost callback relay approach with Claude's correct manual PKCE OAuth flow. The portal now generates the auth URL, accepts Anthropic's pasted authorization code, exchanges it directly for tokens, and writes the Claude credentials file itself.
- **Fix Codex read-only sessions** — Codex agent chats now launch with `--full-auto`, giving the session `workspace-write` sandboxing with `on-request` approvals instead of the unusable default read-only sandbox.
- **Fix Gemini native auth detection** — Gemini availability now recognizes the real OAuth credentials path (`~/.gemini/oauth_creds.json`), so successful logins become selectable in agent chat.

#### Agent Chat / Project Chat
- **Refresh provider availability when opening the agent selector** — Newly authenticated native CLI providers no longer require a hard refresh before they appear as usable.
- **Align project sandbox chat defaults with gateway config** — Project assistant chats now report and inherit the configured gateway default model instead of stale hardcoded Anthropic fallbacks.

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
