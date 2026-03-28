# Agent Chat & Agent Tools

## Agent Chat

Portal page: `/agent-chats`. Multi-session chat with AI coding agents.

### Architecture

```
Frontend ChatInterface → WebSocket (/api/gateway/ws)
  → Portal backend (gateway.ts)
    → OpenClaw Gateway RPC (persistent WebSocket connection)
    → OR direct agent providers (Ollama, Native sessions)
```

### Providers

| Provider | ID | Description |
|----------|-----|-------------|
| OpenClaw | `OPENCLAW` | Primary agent — routes through OpenClaw gateway |
| Claude Code | `CLAUDE_CODE` | Anthropic's coding agent via OpenClaw |
| Codex | `CODEX` | OpenAI Codex via OpenClaw |
| Ollama | `OLLAMA` | Local/remote LLM (configurable host) |
| Gemini | `GEMINI` | Google Gemini via OpenClaw |
| Agent Zero | `AGENT_ZERO` | Agent Zero framework |

### Streaming

Chat uses single-bubble streaming: all text arrives in one message bubble, updating in real-time. Tool calls appear inline. `segment_break` is a frontend no-op (all text in one bubble).

The streaming pipeline:
1. User sends message via WebSocket
2. Backend creates/resumes OpenClaw session
3. OpenClaw streams `assistant` events
4. `StreamEventBus` broadcasts to connected WebSocket clients
5. Frontend appends text chunks to the active bubble

### WebSocket Protocol

Connect to `wss://<domain>/api/gateway/ws` with auth cookie.

**Client → Server:**
```json
{"type": "send", "sessionKey": "...", "message": "...", "model": "..."}
{"type": "history", "sessionKey": "...", "limit": 50}
```

**Server → Client:**
```json
{"type": "chunk", "sessionKey": "...", "text": "...", "role": "assistant"}
{"type": "tool_call", "sessionKey": "...", "name": "...", "args": "..."}
{"type": "done", "sessionKey": "..."}
{"type": "error", "sessionKey": "...", "message": "..."}
```

### Exec Approval

When an agent requests to run a command, the portal shows an approval dialog. The user can approve/deny. Approval flows through the persistent WebSocket connection to the OpenClaw gateway.

## Agent Tools

Portal page: `/agent-tools` (unified page with tabs).

### Tabs
- **Providers**: List installed agent providers with status, model selection
- **Automations**: Create/manage cron jobs (see [automations.md](automations.md))
- **Skills**: Browse/install OpenClaw skills from ClawHub
- **Usage**: Token usage and cost tracking

### Agent Installation

`POST /api/agent-tools/<toolId>/install` triggers installation of coding agents. The portal handles:
- Dependency installation (npm/pip)
- Configuration file creation
- Path setup
- Verification

### Model Switching

Users can switch models per-session via the chat UI. The portal calls `patchSessionModel()` on the OpenClaw gateway to change the active model mid-conversation.

### Provider Detection

`GET /api/agent-runtime/status` checks which providers are available by testing:
- Binary existence (claude, codex, etc.)
- Configuration validity
- Gateway connectivity
