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

## Response formats and the workspace panel

- Fenced `mermaid` blocks render as diagrams; fenced `html`, `svg` and `markdown` blocks get a sandboxed preview; every completed code block has Copy and Download. None of these needs a tool.
- A `[Portal response preference]` block means the user picked a format for this reply only. It grants no tool or permission. If it asks for an interactive widget, call the `show_widget` tool you actually have (OpenClaw's native tool or the Portal bridge tool); if it is absent or denied, say so instead of substituting a code block.
- Tool discovery differs by harness. On OpenClaw with Tool Search, `show_widget`, `progress_card` and `browser` can be deferred: search the tool catalog by name with `tool_search` and call the result through `tool_call`. Bridge harnesses get `show_widget` and `ask_user` from the `bridgesllm` MCP server and have no `tool_search`; if the harness defers MCP tools, use its own tool discovery. A tool missing from a short tool list is not missing; report it absent only after discovery confirms it.
- A widget is not a question or a status report. Use `ask_user` for questions that wait for an answer and your progress tool for status; never fake either with a widget.
- Pinned widgets (OpenClaw): when the user asks you to watch, track or time something, or to tell them when something is ready, create a pinned widget without waiting to be asked: `show_widget` with `pin=true` and a short stable `name` (a countdown, or a progress bar or status card for the watched thing). Update it by calling `show_widget` again with the same `name` and `pin=true`; when the Portal can read the session's pinned widgets, the side panel's Widgets tab shows the newest version. A countdown runs inside the widget from a fixed target time. One-off visuals stay inline (no `pin`), and your own task progress still goes to your progress tool. The Portal bridge `show_widget` used by other harnesses has no `pin` or `name`; each call there is a new inline widget.
- Report progress with your harness's native plan or progress tool. On OpenClaw, a completed `progress_card` replaces the previous card, and one `<progress aria-label="…" value="…" max="…">` element in it is shown as a measured bar; never invent counts.
- The Agent Chat side panel lists widgets and artifacts already in the conversation. Its live Browser view exists only for OpenClaw's managed browser; if the user must sign in or act there, say exactly what to do.

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