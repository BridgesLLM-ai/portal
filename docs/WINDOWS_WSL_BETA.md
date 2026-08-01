# Windows / WSL 2 Experimental Preview

BridgesLLM Portal is designed and supported for compatible Ubuntu or Debian
VPS hosts. Windows through WSL 2 is an experimental local preview: it is useful
for trying the Portal on one computer, but it is not a production hosting
profile and is not yet qualified for the full feature set.

## What you need

- Windows with WSL 2 available
- An Ubuntu WSL distribution with `systemd` enabled
- At least 3.5 GB RAM available to the environment
- At least 35 GB free disk space
- Administrator access for the initial WSL setup
- Docker support if you want to try Project Chat runtimes

Microsoft's current WSL setup references are:

- <https://learn.microsoft.com/windows/wsl/install>
- <https://learn.microsoft.com/windows/wsl/systemd>

## Recommended installation

Open Windows Terminal with PowerShell and run:

```powershell
irm https://raw.githubusercontent.com/BridgesLLM-ai/portal/main/installer/install-windows.ps1 | iex
```

The bootstrapper checks for WSL and Ubuntu, starts the Ubuntu installation when
needed, and then launches the normal Portal installer with the local profile.
Windows or WSL can require a restart before the command can continue.

If Ubuntu WSL is already configured, you can run the Linux installer directly:

```powershell
wsl -u root -- bash -lc "curl -fsSL https://bridgesllm.ai/install.sh | bash -s -- --local"
```

When installation finishes, open the exact localhost setup URL printed by the
installer. It normally starts with:

```text
http://localhost:4001
```

The setup credential is carried in the URL fragment, exchanged once, and then
removed from the address bar.

## Local-profile behavior

On WSL, the installer uses `INSTALL_PROFILE=local` and:

- requires `systemd` inside the distribution;
- serves the Portal on localhost instead of configuring public Caddy HTTPS;
- skips the host UFW configuration used by a VPS install;
- writes localhost-only Portal and CORS origins; and
- keeps public-domain readiness features unavailable.

Create the Owner first, then use Settings readiness cards to connect only the
providers and optional capabilities available in the local environment.

## Limitations

- No supported public HTTPS or custom-domain hosting profile
- No production mail-domain workflow
- No internet-facing app share links
- No default LAN exposure
- Remote Desktop and desktop-browser behavior can differ from a VPS
- Project Chat requires compatible Docker, kernel, and isolation behavior and
  can remain unavailable even when the rest of the Portal works
- Sleep, shutdown, WSL networking, Docker, and Windows updates can interrupt
  local services

Use a supported Ubuntu or Debian VPS for a stable public deployment.

## Docker note

Docker Desktop supports WSL 2 integration, but running it alongside a separate
Docker Engine inside the same distribution can create conflicting daemons and
socket state. Choose one Docker setup for the distribution and verify it before
enabling Project Chat. See:

- <https://docs.docker.com/desktop/features/wsl/>

## Troubleshooting

Check that WSL is version 2, Ubuntu is running, and `systemd` is active:

```powershell
wsl --list --verbose
wsl -u root -- systemctl is-system-running
```

Inside Ubuntu, verify the Portal service and local health endpoint:

```bash
systemctl is-active bridgesllm-product
curl -fsS http://127.0.0.1:4001/health
```

If the browser cannot reach localhost after WSL or Windows networking changes,
restart the WSL distribution and recheck the service before reinstalling.
