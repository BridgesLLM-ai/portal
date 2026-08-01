# Agent Chat, providers, tools, and skills

## Two different security products

**Main Agent Chat** is HOST_OPERATOR. OWNER and SUB_ADMIN intentionally get host-level agent capabilities. Approval prompts help humans control actions but do not sandbox the agent.

**Project Chat** is PROJECT_SANDBOX. Its identity is the authenticated actor plus a server-owned immutable project instance. It receives one writable project mount and brokered public HTTP(S) egress. It must not see host state, credentials, private networks, metadata, sibling containers, sibling users, or sibling projects.

Never route Project Chat through a Main Chat adapter or fall back to an unverified provider.

## Capability discovery

For Main Chat, inspect authenticated provider/runtime status and the live model catalog. Provider, auth method, model, and runtime are separate choices.

For Project Chat, GET /api/projects/:name/chat/providers is authoritative. If verification fails or the server reports no selectable providers, show them unavailable. Do not fabricate an OpenClaw fallback.

Model rules:

- Preserve an explicit model selection.
- Canonicalize legacy provider prefixes only when the model identity stays exact.
- Never upgrade or downgrade an entitlement-sensitive model silently.
- Use the live provider catalog. If an explicit model is absent, ask for a supported choice.
- Keep runtime/provider metadata out of the model ID.

## Sending and switching

Main Chat uses the Portal gateway/provider transport and server-owned session state.

Project Chat requires:

1. current server-selected provider;
2. no active transition or turn;
3. durable turn lease;
4. synchronous sandbox and egress attestation;
5. server-owned assistant/tool provenance.

The request provider must match the selected provider. Switching is a versioned server transition and is rejected during an active turn. After switch or reconnect, re-read state before sending.

The composer is usable immediately: verification and sandbox preparation run in the background, and a first message queues until the runtime attests. Same-provider model changes apply to the next turn as a metadata patch (no container work); provider switches stage progress and may take longer cold. Never surface attestation internals as user workflow — status is Ready, Preparing, or Needs attention.

Attachments to Project Chat are malware-scanned, actor/project/provider-bound, copied beneath the project's private .portal/attachments area, and referenced by project_path. Never send a host path, signed Portal URL, or /api/files URL to a Project provider.

## Long turns and reconnect

Turns can run for hours. Treat the event log and server run state as authoritative:

- keep the run/session identifier;
- render text, reasoning, and tool events independently;
- reconnect with the last durable cursor;
- replay missed events before accepting live events;
- deduplicate by durable event identity;
- do not infer completion because text paused while tools continue;
- do not create a replacement turn while state is unknown;
- abort once, await acknowledgement, then re-read status.

A browser refresh may recover presentation, but it must not be required for correctness.

## Tool calls and approvals

Tool events are not assistant text. Preserve their name, arguments, status, output bounds, and run provenance.

For Main Chat, exec approval can authorize powerful host behavior. Approve only the specific requested action and do not turn one approval into a blanket grant.

For Project Chat, approval never widens the filesystem or egress boundary, adds directories, grants broad Bash, or enables dangerous provider flags.

## Agent Tools and Skills

/api/agent-tools and /api/skills are elevated operational surfaces.

- Read status before install/uninstall.
- Treat install as a durable Task and follow its transcript.
- Verify the binary/plugin/skill after completion.
- ClawHub discovery is not proof that a skill is trusted or compatible.
- Managed Portal skill updates come from the signed Portal bundle; do not hand-edit the deployed copy.
- Keep volatile provider/model lists out of skills. Teach discovery and compatibility rules instead.

## Failure handling

- 401: session missing/expired.
- 403: role or ownership denial.
- 409/423: active turn, provider transition, lease, or cleanup conflict.
- 429: bounded retry with server guidance.
- 503: provider/runtime/sandbox verification failed; leave provider unavailable.
- 410: retired endpoint; update the caller rather than reviving client-owned state.