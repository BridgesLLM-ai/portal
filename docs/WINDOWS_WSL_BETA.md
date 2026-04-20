# Windows / WSL 2 Beta Install Notes

Research snapshot: April 19, 2026.

## Bottom line

BridgesLLM Portal should stay **VPS-first**, and the Windows / WSL route should be treated as an **experimental test-drive path that is still untested in the field and under active development**:

- **Windows users test locally through WSL 2**
- **Production installs still belong on Ubuntu/Debian VPSes**
- We do **not** try to fake a native Windows server installer yet

That is the cleanest compromise between low friction and not shipping a cursed maintenance nightmare.

## Product strategy

The best strategy is **one install experience, multiple entrypoints**.

For now, the first working Windows path is:

- install Ubuntu in WSL 2
- run the normal Linux installer in a **local beta profile**
- open the portal from Windows at `http://localhost:4001`
- skip domain + HTTPS in the setup wizard

That gives people a real hands-on trial before paying for a VPS.

## Why this path won

### Why not a native Windows installer first?

Because the portal is still deeply Linux-shaped:

- PostgreSQL
- Docker sandboxes
- OpenClaw gateway
- VNC / noVNC remote desktop stack
- Linux package assumptions
- systemd-managed services

A true Windows-native installer would mean a second ops matrix for:

- service management
- firewall rules
- reverse proxy behavior
- Docker/runtime differences
- filesystem and permission differences
- browser/desktop stack differences

That is too much surface area for the current stage.

### Why WSL 2 is good enough for beta

Current Microsoft docs support the core pieces we need:

- `wsl --install` is the standard entrypoint for Windows 10/11
- current Ubuntu-on-WSL installs support `systemd`
- Windows can reach services in WSL via `localhost`
- Docker Desktop officially supports WSL 2 integration

That means WSL 2 is a realistic low-friction bridge, not a hack.

## What we implemented

The installer now supports a **local beta profile** and auto-selects it on WSL.

### Local beta behavior

When WSL is detected, the installer now:

- switches to `INSTALL_PROFILE=local`
- requires `systemd` to be available
- skips Caddy setup
- skips UFW setup
- serves the portal directly from the backend on `http://localhost:4001`
- writes local-safe origins:
  - `CORS_ORIGIN=http://localhost:4001,http://127.0.0.1:4001`
- writes:
  - `PORTAL_URL=http://localhost:4001`
  - `INSTALL_PROFILE=local`
- prints a localhost setup URL at the end of install

This is intentionally a **test-drive profile**, not the main production path. It is experimental, not yet field-proven, and still being worked on.

## Windows user flow

### Prerequisite

Install WSL 2 with Ubuntu first.

Microsoft reference:
- https://learn.microsoft.com/en-us/windows/wsl/install
- https://learn.microsoft.com/en-us/windows/wsl/systemd

### Recommended command once WSL is ready

From **PowerShell**:

```powershell
wsl -d Ubuntu -u root -- bash -lc "curl -fsSL https://bridgesllm.ai/install.sh | bash -s -- --local"
```

Then open:

```text
http://localhost:4001
```

If the installer prints a setup token URL, use that exact URL.

### In the setup wizard

For local Windows testing:

- create the admin account
- connect AI providers
- **skip domain + HTTPS**
- treat mail/domain features as VPS-only for now
- treat public project share links and stable external URLs as VPS-only for now

## Known limitations

This path is for testing, not the final polished Windows story.

### Expected limitations

- no automatic public HTTPS in local mode
- no domain-first setup flow in local mode
- project share links generated in local mode are local-machine links, not public VPS links
- mail/domain workflows are not the point of this path
- LAN exposure is not the default WSL networking story
- Windows users may still need Docker Desktop or a clean native Docker setup inside WSL

### Important Docker note

Docker Desktop documents WSL integration, but also warns against mixing Docker Desktop with a separate conflicting Docker Engine install inside the same distro.

Reference:
- https://docs.docker.com/desktop/features/wsl/

If we see Windows testers hitting Docker weirdness, this is one of the first places to look.

## Why this still fits the product

This keeps the main message honest:

- **BridgesLLM Portal is VPS-targeted**
- **Windows local installs are a beta test-drive path**

That is exactly what we want.

People get to try the real product on their home machine, but we do not pretend that a home Windows laptop is the canonical deployment target.

## Open WebUI comparison

Open WebUI’s public direction is basically the right shape to copy:

- recommend the easiest supported path first
- tolerate WSL / Docker for Windows users
- avoid pretending a giant universal shell script solves everything
- move toward desktop/native packaging later if demand justifies it

References:
- https://docs.openwebui.com/getting-started/quick-start/
- https://docs.openwebui.com/roadmap/

## Next likely step

If Windows demand is real, the next layer should be a small **PowerShell bootstrapper** that:

- checks whether WSL/Ubuntu exists
- checks whether systemd is enabled
- launches the Linux installer with `--local`
- prints the final localhost URL clearly

That would give Windows users a cleaner one-command entrypoint **without** forcing us to build a full native Windows installer yet.
