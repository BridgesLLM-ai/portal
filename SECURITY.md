# Security Policy

## Supported releases

| Release | Status |
|---|---|
| 4.0.x | Current stable release |
| 3.26.x | Security fixes only during the 4.0 transition |
| Earlier releases | Upgrade required |

## Reporting a vulnerability

Do not open a public issue. Email **support@bridgesllm.com** with a description,
reproduction steps, affected version, and impact. We will acknowledge the report
and coordinate remediation and disclosure.

## Architecture

BridgesLLM Portal is a single-server product. Caddy terminates HTTPS and proxies
the React/Express application. The backend owns authentication, authorization,
PostgreSQL state, user files, project identities, provider coordination, mail
integration, backups, and system administration. OpenClaw and native provider
adapters are separate execution systems behind explicit Portal trust scopes.

```text
Browser --HTTPS--> Caddy --> Portal backend --> PostgreSQL
                              |-- OpenClaw gateway
                              |-- native provider adapters
                              |-- Stalwart JMAP
                              |-- controlled Project runtimes
                              `-- host services (elevated routes only)
```

## Authentication and authorization

- Access and refresh credentials use secure cookies or an authorization header;
  normal authenticated APIs do not accept query-string bearer tokens.
- First-run bootstrap credentials are short-lived, single-use, origin-bound,
  stored as hashes, transported in URL fragments, and accepted only after a
  verified HTTPS origin or an explicit localhost SSH-tunnel flow.
- Accounts have `ACTIVE`, `PENDING`, `DISABLED`, or `BANNED` status. Only active
  accounts can enter the Portal.
- `OWNER` and `SUB_ADMIN` are elevated operators. Main Agent Chat, Terminal,
  Remote Desktop, agent jobs, maintenance, and other host-control surfaces are
  restricted accordingly. `SUB_ADMIN` is intentionally root-equivalent for
  operations; the role-assignment UI states that consequence.
- `USER` can use interactive tenant surfaces such as Files, Projects, Project
  Chat, and Mail, subject to ownership checks. `VIEWER` is non-interactive.
- Owner-only actions, typed confirmations, durable admission locks, and
  server-side preconditions protect destructive or high-impact operations.

## Two agent trust scopes

### `HOST_OPERATOR`

Main Agent Chat is an operator surface for `OWNER` and `SUB_ADMIN`. Its purpose
is to administer the server, so an approved turn may read and modify host files,
run commands, and use the network. Treat it like an SSH session mediated by an
agent. Provider approval prompts are accident controls, not tenant isolation.

### `PROJECT_SANDBOX`

Project Chat is always keyed to the authenticated actor and one immutable
database project identity. Human workspace-sharing rules do not change that
principal. Enabled adapters receive one writable project mount and a non-root,
read-only, capability-dropped runtime. They do not receive sibling projects,
host configuration, provider credentials, the Docker socket, host namespaces,
devices, or published ports.

Every fresh and resumed turn synchronously verifies the exact provider config,
image ID, labels, mounts, environment, resource limits, network, proxy, and live
container. Failure makes the provider unavailable; there is no default-bridge,
host-adapter, or stale-container fallback.

Project workloads have useful public Internet access through an authenticated
Portal-controlled egress plane. The runtime has no direct route. The proxy and
firewall reject loopback, host interfaces, RFC1918, CGNAT, link-local/cloud
metadata, Docker/service networks, IPv6 ULA/link-local, mixed DNS results, DNS
rebinding, redirects to private destinations, unsafe schemes, and unapproved
ports. Public HTTPS, HTTPS Git, package registries, and asset downloads are the
supported positive paths.

See [docs/PROJECT_SANDBOXING.md](docs/PROJECT_SANDBOXING.md) for the complete
identity, lifecycle, provider-switch, cleanup, and qualification contract.

## Files, uploads, projects, and apps

- Canonical-path and inode-aware containment rejects traversal, symlink escapes,
  special files, cross-user paths, and project-root identity drift.
- Uploads, chunks, archives, images, mail attachments, thumbnails, and deployed
  app content have explicit count, size, time, and output bounds.
- User-controlled uploads are rejected when ClamAV reports malware **or when a
  required scan cannot complete**. The product does not silently accept
  unscanned content.
- ZIP extraction validates every entry and commits only after bounded extraction
  and scanning succeed.
- Active app content is isolated from the authenticated Portal origin. Share and
  API proxy requests are bound to the selected app/share identity and policy.
- Networked Git, dependency, and lifecycle operations use the same controlled
  Project workload runner; local-only operations use `network=none`.

## Network and transport

- Caddy provides TLS and security headers for Portal traffic. HTTP setup cannot
  receive owner or provider credentials.
- UFW defaults to denying unsolicited inbound traffic. Portal, JMAP, database,
  Remote Desktop internals, CDP, app backends, and provider control endpoints are
  loopback-only unless a documented public protocol deliberately requires
  exposure.
- Stalwart JMAP stays internal. Public mail protocols are exposed only through
  the configured mail service with TLS; SMTP relay policy remains enforced by
  Stalwart.
- Reverse proxies and application code use one trusted-proxy/IP policy rather
  than trusting arbitrary forwarded headers.
- WebSocket and Socket.IO namespaces repeat account and role authorization at
  connection time; server-wide operator streams are elevated-only.

## Secrets and provider authentication

- Runtime secrets are stored outside public artifacts and returned to clients
  only when a narrowly defined product flow requires it.
- Provider setup distinguishes browser OAuth, device flow, CLI reuse, setup
  tokens, and API keys. The backend is the provider catalog source; the frontend
  does not invent aliases or entitlement upgrades.
- Setup, OAuth, and password-reset state is expiring, owner-bound where
  applicable, replay-resistant, and redacted from logs and normal API responses.
- Signed release artifacts bind the manifest, complete runtime inventory, source
  version, and content hashes. A verified deployment stamp is written only after
  postflight checks succeed and is restored exactly on rollback.

## Data, mail, backups, and maintenance

- PostgreSQL migrations are shipped with the release and applied against the
  configured database URL, including external/custom PostgreSQL deployments.
- Mailbox provisioning uses durable reconciliation. Desired database state is
  retained and retried instead of deleting Stalwart data on a transient failure.
- Comprehensive backups cover the database, projects, apps, uploads, Portal
  state, Stalwart data/configuration, and OpenClaw state. “Keep data” uninstall
  preserves those locations.
- Guarded system updates require a fresh structurally valid backup, matching
  database checksum, explicit maintenance-window acknowledgement, and a
  server-side single-job lock.

## Known boundaries

1. **Single-server deployment.** Portal deliberately combines several services
   on one host. Project isolation reduces tenant blast radius but does not turn
   the VPS into separate virtual machines.
2. **Elevated agent operation.** Main Agent Chat and Terminal are powerful by
   design. Grant `SUB_ADMIN` only to people trusted with root-equivalent access.
3. **Docker is part of the boundary.** Images, daemon configuration, kernel, and
   firewall must remain patched. Release qualification includes adversarial live
   escape tests; no container system is a substitute for an independently
   isolated VM for hostile multi-tenant code.
4. **Third-party availability.** Provider, DNS, certificate, package-registry,
   and mail failures can make a feature unavailable. The Portal reports that
   state rather than fabricating success or zero usage.

## Hardening recommendations

- Use SSH keys, restrict administrative source addresses, and keep UFW enabled.
- Keep the supported Node, OpenClaw core/plugin pair, Docker, Caddy, PostgreSQL,
  Stalwart, ClamAV, and host packages current through the tested updater paths.
- Keep `clamav-daemon`, `clamav-freshclam`, and the configured host malware agent
  active; investigate any scan-unavailable state rather than bypassing it.
- Schedule and restore-test comprehensive backups, especially before upgrades.
- Review active users and reserve `OWNER`/`SUB_ADMIN` for trusted operators.
- Keep the Portal, provider control ports, database, app backends, Remote Desktop,
  CDP, and Docker interfaces off the public network.

## Responsible disclosure

We will work with good-faith reporters on verification, remediation, credit, and
coordinated disclosure. Public proof-of-concept publication should wait until a
fix is available to users.
