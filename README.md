<p align="center">
  <img src="./assets/readme-hero.png" alt="BridgesLLM Portal" width="100%">
</p>

<h1 align="center">BridgesLLM Portal</h1>

<p align="center">
  <strong>Your AI workstation, on a server you own.</strong>
</p>

<p align="center">
  <a href="https://bridgesllm.ai"><img src="https://img.shields.io/badge/website-bridgesllm.ai-blue?style=flat-square" alt="Website"></a>
  <a href="https://github.com/BridgesLLM-ai/portal/releases"><img src="https://img.shields.io/github/v/release/BridgesLLM-ai/portal?style=flat-square&color=green" alt="Release"></a>
  <a href="https://github.com/BridgesLLM-ai/portal/blob/main/LICENSE"><img src="https://img.shields.io/badge/license-MIT-blue?style=flat-square" alt="License"></a>
  <a href="https://github.com/BridgesLLM-ai/portal/stargazers"><img src="https://img.shields.io/github/stars/BridgesLLM-ai/portal?style=flat-square" alt="Stars"></a>
  <a href="https://x.com/BridgesLlm90984"><img src="https://img.shields.io/badge/X-@BridgesLLM-000?style=flat-square&logo=x" alt="X (Twitter)"></a>
</p>

---

BridgesLLM Portal turns an Ubuntu or Debian VPS into an AI workstation you reach from any browser: agent chat, project workspaces, deployable apps, a file manager, a shared Chrome your agent drives while you watch, a full Linux desktop, mail, and a terminal. One login, one server, no tab sprawl.

Bring your own providers — Claude, Codex, Gemini, API keys, or Ollama running locally or on a GPU box across your Tailnet. The Portal is built on [OpenClaw](https://github.com/openclaw/openclaw), and if OpenClaw is already on the box, the installer adopts it rather than standing up a second copy.

```bash
curl -fsSL https://bridgesllm.ai/install.sh | sudo bash
```

Choose **Install** on a new server, or **Update / Repair** when Portal is already installed. Update and Repair preserve your data and leave AI runtimes unchanged. Nothing changes until you choose. For unattended installation, add `-s -- --install`; use `--repair` to reinstall Portal files without deleting data.

Ubuntu 22.04+ or Debian 12+ · 3.5 GB RAM (4 GB+ recommended) · 35 GB disk · root or sudo. A domain unlocks HTTPS, mail, and public share links.

## What changed in 4.1

4.1 turns the 4.0 foundation into a calmer workstation: stronger long-running chat, truthful provider readiness, safer recovery, and updates that keep the Portal and its AI tools compatible without silently changing the host.

- **Existing-install updates change Portal, not the whole host.** OpenClaw, native CLIs, Docker/AppArmor, Project runtimes, Remote Desktop, Ollama, and unrelated services stay unchanged while the signed Portal transaction stages, proves, and cuts over the new release.
- **AI-tool updates are explicit compatibility bundles.** After the Portal update, the Dashboard can install one Portal-qualified set of OpenClaw 2026.9.1, Codex CLI 0.153.2, Claude Code 2.1.260, and ClawHub 0.23.3. Exact versions and package identities are signed and verified together; upstream `latest` tags and independent self-updaters are not used.
- **The transition is staged, not improvised.** An ordinary Portal-only update can retain the supported OpenClaw 2026.7.1 lane without mutating or restarting it. The separate compatibility action then moves the complete tested tool tuple, or restores the complete predecessor tuple on failure. Fresh installs converge directly to the same qualified bundle.
- **Long Agent Chat runs keep one identity.** Reconnect, history, steering, clarification replies, and confirmed aborts stay attached to the exact run through refreshes, retries, Gateway restarts, and competing tabs.
- **Provider readiness is evidence, not optimism.** Codex and Claude re-check exact root-owned local packages before launch. GPT-6 Astra appears through the Codex runtime when the qualified bundle is installed, but its availability still depends on the connected OpenAI account. Hermes and OpenCode appear when their runtimes and credentials qualify. Missing or drifted tools are shown as unavailable rather than repaired behind your back.
- **Backups protect your work, not the whole VPS.** Standard backups save projects and Portal settings/data. Comprehensive adds available agent personality and Portal-native history as reference exports. AI runtimes, provider logins, mail, and the operating system are excluded; legacy archives keep their existing readers.
- **Progress means what it says.** Fresh installs use semantic phases, measured percentages only for measured work, stable narrow-terminal output, and clean plain/`NO_COLOR` fallbacks. Dashboard updates stop presenting compatibility markers as fake precision.
- **Account retirement is transactional.** Admission closes first, then managed sessions, projects, files, apps, shares, credentials, and runtime state are removed or reassigned with durable recovery evidence.

Read the complete [5.0.2 changelog](CHANGELOG.md#502---2026-09-09) and [release history](https://github.com/BridgesLLM-ai/portal/releases).

## What you get

**Agent Chat** — One conversation surface for OpenClaw and native harnesses, with separate saved histories. Switch harnesses, use supported model controls, inspect tasks and tool calls, render Mermaid diagrams, steer or stop a turn, and return after a reload.

**Projects and code sandbox** — Create or import a project, edit in Monaco, run Git, install dependencies, preview or deploy, and hand the whole thing to an agent scoped to that one workspace.

**Apps** — Deploy static or full-stack apps out of a project, manage their processes, and hand out share links with a password, an expiry, or a use limit.

**Shared browser and Remote Desktop** — Watch an agent drive a real Chrome session, or take the full Xfce desktop through noVNC with audio, clipboard, and resize handling.

**Files** — Browse, search, upload, preview, edit, download, archive, and drop files straight into a project. Large uploads resume where they left off.

**Mail** — A bundled Stalwart mail server: accounts, folders, search, attachments, signatures, and forwarding on your own domain.

**Terminal, tasks, and skills** — A browser terminal on the host, scheduled recurring agent work, background jobs you can inspect, and skills from [ClawHub](https://clawhub.ai).

**Setup and admin** — Setup creates a secure Owner first, then walks optional domain/TLS, mail, providers, local models, and Remote Desktop. Admin covers accounts, storage, alerts, backups, maintenance, and updates. The [backup and recovery guide](docs/BACKUP_AND_RECOVERY.md) explains data-backup scope, verification, restore, and legacy archive compatibility.

## Architecture

```mermaid
flowchart TD
    Browser["Your Browser"] -->|HTTPS via Caddy| Portal

    subgraph Portal["BridgesLLM Portal"]
      UI["React UI\nVite SPA"]
      API["Express API\nNode.js"]
      UI --> API
      API --> Gateway["OpenClaw Gateway\nPersistent runtime"]
      API --> DB["PostgreSQL\nPortal data"]
      API --> Docker["Project runtimes\nIsolated containers"]
      API --> Mail["Stalwart Mail\nOptional"]
    end

    Gateway --> Providers["Your AI providers"]
    Gateway --> Ollama["Ollama\nLocal or Tailnet GPU"]
```

Caddy terminates HTTPS in front of a loopback-only backend. The OpenClaw gateway owns agent sessions, approvals, and provider traffic. Project runtimes are non-root containers with one writable mount and no route to the host, private networks, or each other. PostgreSQL and the persistent data roots hold everything the backup contract covers.

## What this doesn't do

Straight answers, in one place, rather than a disclaimer stapled to every paragraph:

- **The Portal is free. Running it isn't.** You pay for the VPS and for whatever provider you connect. Subscription sign-in, metered API keys, and local compute all bill differently, and the Portal doesn't paper over that with a flat rate.
- **Provider availability is yours, not ours.** Which models you can reach depends on your accounts and entitlements. The Portal reports what it can actually run.
- **Mail needs a real domain.** Correct DNS and public mail ports, or it stays off.
- **Project isolation needs a capable host.** Compatible kernel, Docker, and AppArmor. Nested-container hosts can install with `--skip-project-runtimes`, which leaves Project Chat disabled.
- **Windows/WSL is a preview.** Local test drive only — not a supported production profile. See [docs/WINDOWS_WSL_BETA.md](docs/WINDOWS_WSL_BETA.md).
- **Anything you send a provider leaves your server.** Under that provider's terms. Public shares and enabled mail ports are reachable from outside by design.
- **Fresh installs enable limited telemetry.** Install ID, versions, user count, uptime, Node/OS/arch — never prompts, files, credentials, or addresses. Turn it off during setup or in Settings. [Full detail below.](#privacy-and-telemetry)

## Updating

Use the Owner-only **Update** button in the Dashboard. From SSH:

```bash
curl -fsSL https://bridgesllm.ai/install.sh | sudo bash -s -- --update
```

Either path authenticates the signed release and exact installer, checks backup recoverability, stages the Portal while the current service remains online, proves a private candidate, and cuts over only after its runtime, schema, and readiness match the requested version. A failed Portal transaction rolls back its owned state.

Ordinary Portal updates do not install, repair, configure, approve, or restart OpenClaw, Codex, Claude Code, ClawHub, Docker/AppArmor, Project runtimes, Remote Desktop, Ollama, or unrelated services. The retained OpenClaw 2026.7.1 lane remains supported while you review the new Portal. When you are ready, the Owner-only **Update compatible AI tools** action installs the exact Portal-qualified OpenClaw 2026.9.1, Codex CLI 0.153.2, Claude Code 2.1.260, and ClawHub 0.23.3 bundle. It does not follow upstream `latest` tags, and a failed transaction restores the prior tested tuple instead of leaving mixed versions. Fresh installs converge to that same exact bundle.

### Read this before upgrading to 4.1

- **Portal update first, compatibility update second.** The Portal stage keeps the current AI runtime online. The separate tool stage is deliberate because OpenClaw, its plugins, and native harnesses must move and roll back as one tested compatibility unit.
- **GPT-6 Astra is account-dependent.** Portal uses the exact `gpt-6-astra` model ID through the qualified Codex runtime and never silently makes it the default or fallback. A connected OpenAI account still has to be entitled to use it.
- **Do not independently update the managed tools.** Package drift is reported as needing repair. The compatibility action—not an upstream self-updater—is the supported route back to an attested bundle.
- **Existing upgrades do not add Hermes or OpenCode automatically.** Those optional runtimes remain available only when their own installed packages and credentials qualify.
- **DeepSeek API models and the native DeepSeek Harness are different paths.** API-model access remains available through supported providers; the native Harness is disabled and non-selectable in 4.1.
- **A Complete wipe only removes what it recorded.** If you copied managed data somewhere else before uninstalling, check the host yourself.

## Privacy and telemetry

Your data, files, projects, credentials, and services stay on your server. Requests to an external AI provider leave it, under that provider's terms; public shares and enabled mail protocols are reachable from outside on purpose.

Fresh setup defaults limited operational telemetry to **on** and shows you the choice before setup finishes. When enabled, the Portal reports shortly after startup and roughly every 24 hours while running. That report carries a random install ID, Portal and dependency versions, user count, uptime, Node version, OS, and architecture. It carries no messages, prompts, project files, credentials, usernames, or email addresses. Turning it off stops that report. Separately, opening the Dashboard checks the version endpoint for updates, and a fresh installation sends start and completion events with the event type, version, OS, and install ID. Ordinary Portal updates do not send installer lifecycle events. Normal request metadata reaches the receiving service either way.

## Windows test drive (WSL 2 beta)

VPS-first, but you can kick the tires locally through WSL 2. Experimental, not field-tested, not production.

```powershell
irm https://raw.githubusercontent.com/BridgesLLM-ai/portal/main/installer/install-windows.ps1 | iex
```

If Ubuntu WSL is already set up:

```powershell
wsl -u root -- bash -lc "curl -fsSL https://bridgesllm.ai/install.sh | bash -s -- --local"
```

Then open `http://localhost:4001`. Public hosting, custom-domain HTTPS, and internet-facing share links stay VPS features. Caveats in [docs/WINDOWS_WSL_BETA.md](docs/WINDOWS_WSL_BETA.md).

## Security

- **Secure bootstrap** — HTTPS or an explicit localhost tunnel, with single-use expiring credentials
- **Project isolation** — immutable actor/project identity, one writable mount, no host fallback, verified before each turn
- **Scoped egress** — public web, Git, and package access; no private, metadata, Docker, or host-network reachability
- **Path and content protection** — canonical containment, size-limited archives and uploads, isolated active app content, malware-scan failures treated as failures
- **Role-based access** — Owner, Sub-Admin, User, and Viewer, with account approval states
- **Signed rollback-safe updates** — manifest and content binding, runtime inventory, migrations, postflight checks, deploy provenance
- **Least-exposed services** — internal APIs, the database, browser control, Remote Desktop, and app backends stay loopback-only unless a documented public protocol needs otherwise

These boundaries assume a supported host and correct operator configuration. Reporting process in [SECURITY.md](SECURITY.md).

## Roadmap

- [ ] Prove Complete wipe positively beyond the recorded managed paths before broadening its authority
- [ ] Deep-link agent questions to the exact conversation, plus a durable notification history
- [ ] Qualify more Project Chat providers against the same filesystem and egress escape matrix
- [ ] Add and qualify a native DeepSeek SDK harness, separate from DeepSeek API-model access
- [ ] Grow the Windows/WSL preview into a supported local profile
- [ ] Broaden browser, mobile, long-turn, and low-spec performance testing

## Contributing

Contributions welcome. Open an issue before substantial changes so the design and security boundary can be discussed first. Fork, branch, test, push, open a PR — details in [CONTRIBUTING.md](CONTRIBUTING.md).

## License

MIT — see [LICENSE](LICENSE).

## Acknowledgments

[OpenClaw](https://github.com/openclaw/openclaw) · [Anthropic](https://anthropic.com) · [OpenAI](https://openai.com) · [Google](https://ai.google.dev) · [Caddy](https://caddyserver.com) · [Stalwart](https://stalw.art) · [NoVNC](https://novnc.com)

---

<p align="center">
  <strong>Built by <a href="https://github.com/Robertmonkey">Robert Bridges</a></strong>
  <br>
  <a href="https://bridgesllm.ai">Website</a> ·
  <a href="https://x.com/BridgesLlm90984">X (Twitter)</a> ·
  <a href="https://github.com/BridgesLLM-ai/portal/issues">Issues</a> ·
  <a href="https://github.com/BridgesLLM-ai/portal/releases">Releases</a>
</p>
