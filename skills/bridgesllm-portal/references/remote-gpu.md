# Ollama backends and native Remote GPU

The Portal can run models on the server's local Ollama or on a remote GPU
machine reached natively over the user's Tailscale tailnet. One attested
"authority" decides which backend serves requests. Discover state through the
API; never assume which backend is active.

## Architecture (native, current)

- The remote machine runs plain Ollama bound to loopback plus a persistent
  Tailscale Serve TCP listener that exposes it tailnet-only.
- The server joins the user's tailnet ("server network" step) and the Portal
  pins the exact Tailscale peer identity before trusting it.
- The Portal talks native Ollama HTTP (tags, pull, chat/generate) with real
  streaming. There is no custom pairing helper, no Windows service, and no
  activation-code flow in the native path.
- Legacy helper/pairing records may still exist as read-only migration
  signals surfaced through `GET /api/ollama/tailnet/status`. Do not
  resurrect the retired helper workflow from older docs;
  `POST /api/ollama/tailnet/legacy-helper-retirement` retires leftover rows.

## Routes

Backend state and models:

- `GET /api/ollama/status` — runtime/backend health as the Portal sees it.
- `GET /api/ollama/models`, `GET /api/ollama/catalog`,
  `GET /api/ollama/recommendations` — installed models and curated choices.
- `POST /api/ollama/pull`, `GET /api/ollama/pulls`,
  `GET /api/ollama/pull/:jobId`, `DELETE /api/ollama/pull/:jobId` — model
  downloads run as durable jobs with per-layer streaming progress; pulls are
  routed through the active authority, so remote models are pulled onto the
  remote machine through the same flow.

Native Tailnet backend lifecycle:

- `GET /api/ollama/tailnet/status` — authoritative overview; read this first.
- `GET /api/ollama/tailnet/server-network` /
  `POST .../server-network/install` / `POST .../server-network/connect` —
  step 1: put the server on the user's tailnet (official installer download,
  auth-key via send-once field or a sign-in link the user approves).
- `GET /api/ollama/tailnet/setup-bundle.zip` — guided Windows setup for the
  GPU machine (loopback Ollama + persistent Tailscale Serve).
- `POST /api/ollama/tailnet/connect`, `POST /api/ollama/tailnet/verify`,
  `POST /api/ollama/tailnet/reverify` — bind and attest the exact peer.
- `DELETE /api/ollama/tailnet/authority` — owner-only removal of the native
  binding (CAS-guarded). Current authority state is read from
  `GET /api/ollama/tailnet/status`, not a separate GET.

## Rules

- Read `tailnet/status` before advising; the machine states (server not on
  tailnet, peer unreachable, unverified, empty model list) each have distinct
  next steps the response describes.
- A remote authority locks only the local-runtime enable switch; model/tier
  preferences remain editable.
- Model changes do not require re-binding or re-verification of the peer.
- An empty remote model list is not failure: pull through the Portal's pull
  routes, which target the active authority.
- Verification failures fail closed. Do not work around them by pointing the
  Portal at a raw IP, opening firewall ports, or bypassing the tailnet.
- Local Ollama status lives on `GET /api/ollama/status` and the system
  control surfaces; do not conflate "local runtime disabled" with "no
  backend" when a remote authority is active.
