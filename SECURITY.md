# Security Policy

## Supported Versions

| Version | Supported          |
|---------|--------------------|
| 3.x     | ✅ Active support  |
| < 3.0   | ❌ No longer supported |

## Reporting a Vulnerability

If you discover a security vulnerability, please report it responsibly:

1. **Do NOT open a public issue**
2. Email **support@bridgesllm.com** with:
   - Description of the vulnerability
   - Steps to reproduce
   - Potential impact assessment
3. You'll receive an acknowledgment within 48 hours
4. We'll work with you on a fix and coordinated disclosure

## Architecture Overview

BridgesLLM Portal runs as a Node.js backend behind Caddy (automatic HTTPS reverse proxy) on a single server. The portal manages user authentication, routes requests to OpenClaw (the AI agent framework), and provides the browser-based UI. All communication happens over HTTPS.

```
Browser ──HTTPS──▶ Caddy ──▶ Portal Backend ──▶ OpenClaw Gateway
                                    │
                                    ├──▶ Database (PostgreSQL via Prisma)
                                    ├──▶ File System (sandboxed paths)
                                    └──▶ Docker (project sandboxes)
```

## Security Measures

### Network & Transport

- **HTTPS only** — automatic TLS certificates via Let's Encrypt, managed by Caddy. HSTS enabled with `max-age=15552000; includeSubDomains`.
- **Firewall** — UFW configured during installation. Only ports 22 (SSH), 80 (HTTP redirect), and 443 (HTTPS) are exposed externally. Internal Docker bridge ports are restricted to container subnets.
- **Security headers** — Content-Security-Policy, X-Content-Type-Options (`nosniff`), X-Frame-Options (`SAMEORIGIN`), Referrer-Policy (`strict-origin-when-cross-origin`) set via Caddy and Express middleware.
- **Shell-escape enforcement** — all user-influenced parameters (commit messages, branch names, file paths, URLs) are properly escaped before reaching any shell command. Input validated against strict allowlist regexes.

### Authentication & Authorization

- **JWT authentication** — separate access and refresh tokens. Access tokens are short-lived. Tokens are read from the `Authorization` header or secure cookies only — query parameter authentication was removed to prevent token leakage in server logs and browser history.
- **Role-based access control** — four account roles:
  - **Owner** — full administrative access, user management, system configuration
  - **Sub-Admin** — elevated access, can manage users and settings
  - **User** — standard interactive access to chat, projects, files, terminal
  - **Viewer** — read-only access (cannot use interactive features)
- **Account states** — accounts can be Active, Pending (requires admin approval), Disabled, or Banned. Only Active accounts can access the portal.
- **Setup wizard protection** — a middleware (`requireSetupComplete`) prevents access to the portal until initial setup is finished, preventing unauthorized use during installation.

### Code Execution Sandboxing

- **Docker isolation** — project agents run inside isolated Docker containers (`openclaw-sandbox:bookworm-slim`). Each project gets its own container with:
  - A bind mount limited to that project's directory only
  - No access to the host workspace (`workspaceAccess: "none"`)
  - Sandboxing mode set to `all` (all commands run inside the container)
  - Session-scoped containers that are cleaned up when the session ends
- **Network control** — sandbox containers use Docker bridge networking. The container can reach the internet (for package installs, web fetches) but cannot access the host's local services unless explicitly configured.

### File System Protection

- **Path sandbox middleware** — a dedicated middleware (`pathSandbox`) prevents project agents and API consumers from accessing files outside their designated project directory (`/portal/projects/{userId}/{projectName}/`). It protects against:
  - Directory traversal attacks (`../`)
  - Symlink escapes
  - Absolute paths pointing outside the project
  - Access to system directories (`/root`, `/etc`, `/proc`, `/sys`, `/var/log`, `/var/run`, `/tmp`, `/home`)
  - Access to portal source code directories
  - Access to other users' uploads (`/portal/files/`)
- **Violation tracking** — repeated sandbox violations from the same source are tracked and escalated. Three violations within 15 minutes triggers heightened monitoring.
- **User file isolation** — user uploads are stored at `/portal/files/{userId}/`, separated from project files. Each user can only access their own uploads.

### Input Validation & Database

- **Parameterized queries** — all database access goes through Prisma ORM, which uses parameterized queries. No raw SQL string concatenation.
- **Schema validation** — API inputs are validated using Zod schemas before processing.
- **PostgreSQL database** — stored locally on the server. No external database connections.

### Malware Scanning

- **ClamAV integration** — uploaded files are scanned for malware using the ClamAV daemon (`clamdscan`) before being stored. If a threat is detected, the upload is rejected. If ClamAV is unavailable, the system logs a warning but allows the upload (fail-open — see Known Limitations).

### Mail Server

- **Loopback binding** — the built-in Stalwart mail server is configured to accept connections from localhost only. It is not exposed as an open relay.

### Credential Storage

- **API keys and tokens** — stored in the OpenClaw configuration file on the server's local filesystem. Access to this file requires server-level (SSH/root) access.
- **Gateway authentication** — the portal communicates with the OpenClaw gateway using a token stored in a restricted file (`600` permissions).
- **Third-party secrets** — credentials for external services (X API, etc.) are stored in dedicated files with `600` permissions under `~/.clawdbot/secrets/` or `~/.openclaw/secrets/`.

## Known Limitations

These are areas where the current security model has trade-offs. We document them here for transparency:

1. **Single-server model** — BridgesLLM Portal runs everything (portal, database, agent, sandbox containers) on one server. There is no network-level separation between the portal backend and the agent runtime. This is a deliberate trade-off for simplicity and cost. For high-security deployments, consider running the portal behind a VPN or restricting SSH access.

2. **ClamAV fail-open** — if the ClamAV daemon is not running, file uploads proceed without scanning. This prevents the scan system from blocking normal operations, but means uploads are unscanned during ClamAV downtime. Monitor ClamAV service health if upload scanning is important to your deployment.

3. **Main agent workspace access** — the main OpenClaw agent (outside of project sandboxes) runs with full server access. It can read and write files, run commands, and access the network. Project agents are sandboxed, but the main agent is intentionally unrestricted to support administrative tasks. Users should understand that conversations with the main agent have the same trust level as an SSH session.

4. **Container escape** — Docker provides process and filesystem isolation, not a full security boundary. A determined attacker with code execution inside a container may attempt to escape. For untrusted workloads, consider additional hardening (gVisor, user namespaces, or dedicated VMs).

5. **No built-in audit log UI** — the portal does not currently expose a consolidated audit log of all agent actions in the browser. Server logs (journalctl) capture all activity, but there is no searchable, user-facing audit trail yet. This is on the roadmap.

## Hardening Recommendations

For production deployments:

- **Restrict SSH access** — use key-based authentication only, disable password login, and consider restricting SSH to specific IP ranges or a VPN.
- **Enable automatic security updates** — configure `unattended-upgrades` for the host OS.
- **Monitor ClamAV** — ensure `clamav-daemon` and `clamav-freshclam` are both running so uploaded files are scanned with current signatures.
- **Back up regularly** — the database, configuration, and project files should be backed up. The installer does not configure automated backups.
- **Review firewall rules** — verify that only necessary ports are exposed. The default UFW configuration is restrictive, but custom rules may widen the attack surface.

## Responsible Disclosure

We appreciate the security research community and will:
- Acknowledge your contribution in release notes (with permission)
- Not take legal action against good-faith security research
- Work to fix verified vulnerabilities within 7 days
