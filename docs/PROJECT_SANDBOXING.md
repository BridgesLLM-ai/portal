# Project Sandbox Contract

Portal 4.0 separates two deliberately different execution scopes. They must
never share a provider session or silently fall back into one another.

## Trust zones

### Main Agent Chat: `HOST_OPERATOR`

Main Agent Chat is available only to `OWNER` and `SUB_ADMIN`. Those roles are
operationally root-equivalent: an approved agent turn may inspect or modify the
host, Portal, OpenClaw, services, and files outside a project. Provider approval
prompts reduce accidents; they are not a filesystem sandbox.

### Project Chat: `PROJECT_SANDBOX`

Project Chat is bound to the authenticated actor and one immutable Portal
project identity. A Project provider receives:

- exactly one writable project mount;
- a read-only, non-root runtime with a read-only root filesystem;
- no Docker socket, host configuration, host credentials, sibling mounts,
  devices, published ports, or host namespace access;
- a Portal-owned conversation, durable turn lease, replay log, provider
  binding, and cleanup record; and
- public Internet access only through the authenticated Portal egress plane.

The boundary is workspace isolation, not an offline jail. Public HTTPS, safe
redirects, HTTPS Git, package registries, and asset downloads are intended to
work. Loopback, RFC1918, CGNAT, link-local and metadata ranges, Docker/service
networks, IPv6 ULA/link-local, mixed public/private DNS answers, DNS rebinding,
private redirects, non-HTTP schemes, and unapproved ports are denied.

## Server-owned identity

Project runtime identity is not read from a project file. Portal keys it from:

- the authenticated user ID;
- an immutable database project UUID;
- canonical project root plus device, inode, and birth-time identity;
- provider and runtime adapter;
- immutable runtime image ID;
- filesystem and egress policy versions; and
- a hash of the complete expected policy.

Copied project files, renamed folders, matching user-ID prefixes, or a
client-provided session key cannot alias another runtime. `SUB_ADMIN` workspace
sharing for the human Projects UI never changes the authenticated principal
used by Project Chat.

## Filesystem and process enforcement

Every enabled provider adapter must attest the desired and actual runtime
before a fresh or resumed turn. For the OpenClaw adapter this includes the exact
agent configuration, container image, user, command, labels, mounts, rootfs,
capabilities, resource limits, environment, network membership, proxy identity,
and live container state. Inspection, configuration, patch, image, firewall,
mount, or egress failure makes the provider unavailable.

Attachments are malware-scanned, copied into a project-owned internal
attachment directory, and passed to providers only as project-relative paths.
Host paths and reusable Portal download URLs are not provider input.

Project lifecycle and Git jobs use the same workload runner. Local-only
commands use `network=none`; networked operations receive the controlled egress
plane. No operation falls back to Docker's default bridge or a host adapter.

## Network enforcement

Each workload receives a unique internal Docker network. Its only outward path
is a mount-free, non-root, read-only proxy sidecar on a separate public network.
Firewall rules are installed and checked before the workload starts. The proxy
resolves and validates all DNS answers, pins the approved address, revalidates
redirects, and requires authenticated proxy credentials. HTTPS tunneling is
limited to a matching TLS SNI destination.

The proxy cannot make arbitrary Internet destinations safe by itself; kernel
network isolation prevents bypass. Both controls are required and attested.

## Conversation and provider switching

Portal owns the visible transcript and accepts user messages only from the
client. Assistant, tool, system, provider, run, and completion provenance are
server-owned. One durable turn lease exists per physical project. Provider
switches use versioned compare-and-swap state and are rejected during an active
turn. Each provider keeps a separate resumable binding and receives a bounded,
quoted transcript handoff rather than another provider's opaque state.

Providers remain visible but unavailable until their Project adapter can prove
the complete contract. Main-chat capability never qualifies a provider for
Projects.

## Deletion and recovery

Project deletion first marks the immutable identity as deleting, rejects new
turns, quiesces durable work, removes provider resources before egress
resources, removes every actor-specific qualification grant for the immutable
project, and repeatedly verifies zero residual state. Cleanup is retryable
across process restarts. A path cannot be safely reused while the old project
identity still has live resources.

## Release qualification

Unit tests and configuration inspection are necessary but insufficient. Every
provider enabled in a release candidate must pass live fresh/resume/reconnect,
abort, deletion/recreation, public HTTPS/Git/package, and authenticated model
tests. Negative probes must cover sibling users/projects, host files and
credentials, Unix sockets, loopback, private and metadata ranges, Docker peers
and gateway, IPv6 private forms, hostile proxy variables, redirects, DNS
rebinding, stale containers, extra mounts, and policy/configuration failures.

OpenClaw is not enabled merely because its runtime and proxy images exist. An
approved user must explicitly run qualification for their authenticated actor
and immutable project. Portal stores the result as expiring, root-private,
HMAC-authenticated evidence bound to the exact project root identity, runtime
and proxy image digests, sandbox and egress policy fingerprints, live resource
identities, complete probe matrix, and authenticated model response. Provider
capability, binding, switching, history/replay, and every fresh or resumed turn
revalidate that evidence. Any missing, expired, tampered, or drifted evidence
leaves OpenClaw unavailable; the turn path still synchronously attests the live
container and egress plane before execution.

Release builds fail closed: a missing runtime, proxy image, pinned image ID, or
credential root leaves the provider unavailable instead of weakening the
boundary.
