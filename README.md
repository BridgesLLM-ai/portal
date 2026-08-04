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

Ubuntu 22.04+ or Debian 12+ · 3.5 GB RAM (4 GB+ recommended) · 35 GB disk · root or sudo. A domain unlocks HTTPS, mail, and public share links.

## What changed in 4.0

4.0 is a foundation release. Less new surface area, more of the workstation actually holding together under load, restarts, and upgrades.

- **Answer an agent from wherever you are.** When an agent needs a decision, a notification follows you across the Portal. Expand it, pick an option or type a reply, send. No hunting for the tab it came from.
- **Long turns survive a closed laptop.** Reconnect mid-run and the conversation replays instead of pretending it died. Steer or cancel a turn in flight; tool calls and thinking stay attached to the message they belong to.
- **Every project runs in its own box.** A project agent gets one writable workspace and the public internet. Your host, your other projects, private networks, and credentials stay out of reach — verified before each turn, not assumed at startup.
- **Upgrades stop eating your work.** Backups now cover project and standalone app sources. Update and restore bring back the apps that were running, and a failed promotion leaves the last good deployment in place.
- **Provider setup tells you the truth up front.** The Portal confirms the model you picked is the model that will actually run, and says a provider is unavailable at setup time instead of failing quietly three prompts later.
- **Updates you can watch and undo.** One button in the Dashboard: signed release notes, backup check, migrations, health checks, automatic rollback if the new build won't come up healthy.
- **Everything else got a pass.** Setup, Files, Mail, Terminal, Remote Desktop, Apps, Tasks, Skills, Settings, Admin, light mode, and accessibility all got reliability and clarity work.

Read the complete [4.0.12 changelog](CHANGELOG.md#4012---2026-08-04) and [release history](https://github.com/BridgesLLM-ai/portal/releases).

## What you get

**Agent Chat** — One conversation surface for OpenClaw and native harnesses. Switch providers and models mid-thread, watch tool calls as they run, approve what needs approving, steer or stop a turn, and pick the conversation back up after a reload.

**Projects and code sandbox** — Create or import a project, edit in Monaco, run Git, install dependencies, preview or deploy, and hand the whole thing to an agent scoped to that one workspace.

**Apps** — Deploy static or full-stack apps out of a project, manage their processes, and hand out share links with a password, an expiry, or a use limit.

**Shared browser and Remote Desktop** — Watch an agent drive a real Chrome session, or take the full Xfce desktop through noVNC with audio, clipboard, and resize handling.

**Files** — Browse, search, upload, preview, edit, download, archive, and drop files straight into a project. Large uploads resume where they left off.

**Mail** — A bundled Stalwart mail server: accounts, folders, search, attachments, signatures, and forwarding on your own domain.

**Terminal, tasks, and skills** — A browser terminal on the host, scheduled recurring agent work, background jobs you can inspect, and skills from [ClawHub](https://clawhub.ai).

**Setup and admin** — Setup creates a secure Owner first, then walks optional domain/TLS, mail, providers, local models, and Remote Desktop. Admin covers accounts, storage, alerts, backups, maintenance, and updates.

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

Either path verifies one signed artifact, checks for a fresh backup, applies migrations, validates the tested OpenClaw core/plugin pair, runs authenticated health checks afterward, and rolls back if the candidate can't come up. Unrelated host-tool upgrades stay in explicit maintenance actions rather than riding along inside every Portal update.

### Read this before upgrading to 4.0

- **Everyone signs in once more.** Accounts and managed data carry over.
- **3.x projects and apps carry over** — files, the apps attached to them, and which apps were running. Projects still carrying old OpenClaw state stay readable, but Project Chat, rename, and delete wait until that state can be reconciled safely. The Portal would rather block than guess.
- **A Complete wipe only removes what it recorded.** If you copied managed data somewhere else before uninstalling, check the host yourself.

## Privacy and telemetry

Your data, files, projects, credentials, and services stay on your server. Requests to an external AI provider leave it, under that provider's terms; public shares and enabled mail protocols are reachable from outside on purpose.

Fresh 4.0 setup defaults limited operational telemetry to **on** and shows you the choice before setup finishes. When enabled, the Portal reports shortly after startup and roughly every 24 hours while running. That report carries a random install ID, Portal and dependency versions, user count, uptime, Node version, OS, and architecture. It carries no messages, prompts, project files, credentials, usernames, or email addresses. Turning it off stops that report. Separately, opening the Dashboard checks the version endpoint for updates, and the installer reports install/update milestones with the event type, version, OS, and install ID — normal request metadata reaches the receiving service either way.

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

- [ ] 4.1: retire multi-user accounts only once sessions, projects, files, apps, shares, and runtime state can be removed or reassigned in one transaction
- [ ] 4.1: prove Complete wipe positively, beyond the recorded managed paths
- [ ] Deep-link agent questions to the exact conversation, plus a durable notification history
- [ ] Qualify more Project Chat providers against the same filesystem and egress escape matrix
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
