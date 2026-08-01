BridgesLLM Portal — Remote GPU with native Tailscale + Ollama
==============================================================

This folder makes a Windows computer's Ollama available to your Portal over
your private Tailscale network.

There is no BridgesLLM helper service, Node.js dependency, pairing secret,
scheduled task, or window that must remain open. Ollama keeps listening only
on its normal loopback address. Tailscale stores a private TCP forward and
restores it after Windows or Tailscale restarts.

WINDOWS
-------
1. Install and open Ollama:
     https://ollama.com/download
2. Install Tailscale and sign in to the SAME tailnet as the Portal:
     https://tailscale.com/download
3. Extract this zip to a local Windows drive and double-click Start-Here.cmd.
   On Windows, Tailscale says Serve commands should run in an Administrator
   terminal. If this terminal is not already elevated, setup requests one
   Windows UAC prompt. Choose Yes and continue in the Administrator PowerShell
   window.
4. The first time this PC uses Tailscale Serve, Tailscale may print a one-time
   https://login.tailscale.com approval page. Open that exact page, approve
   Serve for your tailnet, then run Start-Here.cmd again. The second run uses
   the same one-time elevation check.
5. When the setup says Ready, return to:
     Portal -> Settings -> AI Providers -> Remote GPU
6. Refresh devices, select this PC, review the narrow Tailscale Grant, and
   click Connect.
7. Browse models in the Portal. Choose Download to see live Ollama progress,
   then choose Use model. Switching models does not rebuild the Remote GPU
   connection.

The small Command Prompt window opened by Start-Here.cmd is expected. It waits
for the one Administrator PowerShell setup and then exits with that setup's
exact result. Only the Administrator window performs setup. It does not remain
open in the background: read the result, press Enter once, and both launcher
and setup are finished. Do not start a second copy while the UAC-launched
window is running. Declining UAC stops before any Tailscale Serve command.

UPGRADING FROM THE RETIRED HELPER
---------------------------------
Normal setup never removes the older helper. It detects the exact reserved
BridgesLLM-OllamaTailnetHelper-v1 scheduled task and
LocalAppData\BridgesLLM\OllamaTailnetHelper state folder read-only, then leaves
them working while you configure and test the native connection. This prevents
a failed Portal Connect attempt from breaking an existing Remote GPU.

Only after the Portal shows this PC as the active native Remote GPU, run this
from the same extracted folder:

    Start-Here.cmd --retire-legacy-helper

That post-activation mode first verifies the exact device-owned Tailscale
listener still forwards tcp:11435 to 127.0.0.1:11434. It then verifies the
legacy task marker, action, Windows user, exact state folder, and every folder
entry before asking you to type RETIRE. It removes only that exact legacy task
and allowed state files. Any unknown task or file stops cleanup without being
changed. The native Serve listener stays configured. Downloaded copies of the
old zip are not searched for or deleted.

Retirement uses the same Administrator check as normal setup. If needed, it
requests one UAC prompt and passes only the retirement switch to the elevated
window. It never falls back to unelevated cleanup or opens another elevation
window if Windows did not grant an Administrator token.

WHAT THE SETUP RUNS
-------------------
The durable configuration is one native Tailscale command:

    tailscale serve --bg --tcp=11435 tcp://127.0.0.1:11434

Port 11435 is reachable only through Tailscale and forwards to Ollama's normal
Windows loopback API on port 11434.

To remove only the BridgesLLM Remote GPU listener:

    tailscale serve --tcp=11435 off

Do not use "tailscale serve reset"; it can remove unrelated services you have
configured in Tailscale.

LINUX / macOS
-------------
The same native Tailscale Serve command works when Ollama is listening on
127.0.0.1:11434. Configure its startup through your operating system's normal
Ollama and Tailscale services; no BridgesLLM daemon is required.

SECURITY
--------
- This setup does not expose Ollama to the public Internet or your LAN.
- Ollama does not provide its own API authentication. Use the exact Tailscale
  Grant shown by the Portal so only the Portal node can reach this device on
  tcp:11435. Existing broad allow rules are additive and must also be reviewed.
- The Portal pins the chosen Tailscale device identity and re-checks it before
  requests. It does not accept a hostname, URL, redirect, or fallback target.
- If the selected device address/key or the Portal Tailnet address changes,
  refresh the device list and apply the newly rendered exact Grant before
  reconnecting. Portal will not reuse an acknowledgement from an older
  identity or Grant snapshot.
- Tailscale encrypts traffic between the Portal and GPU device.

FILES
-----
  Start-Here.cmd            Double-click; requests UAC once when needed.
  Setup-OllamaTailnet.ps1   Idempotent Administrator-checked native setup.
  README.txt                This file.
