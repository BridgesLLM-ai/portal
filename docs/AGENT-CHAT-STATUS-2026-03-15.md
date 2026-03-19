# Agent Chat — Status After March 15 Sprint
**Updated:** 2026-03-15 1:00 PM EDT
**Reference:** OPENCLAW-UI-AUDIT-2026-03-15.md

---

## ✅ Fixed Today

### 🔴 P0 — Critical
| Issue | Commit | Status |
|-------|--------|--------|
| Sub-agent yield/resume breaks stream | `9d0c2a3` | ✅ Fixed — subscription stays alive across done events |
| chat.final clobbers post-tool text (tool args/results in message body) | `78afd70` | ✅ Fixed — smart reconciliation skips multi-segment concat |
| Stop button doesn't actually stop (sub-agent resume restarts stream) | `493abf9` | ✅ Fixed — abort tears down stream subscription via cleanup registry |
| History reload shows internal monologue + raw tool data | `ca9e882` | ✅ Fixed — only last text segment shown; toolResults merged into pills |
| Stream doesn't reconnect after backend restart | `fc33d5e` | ✅ Fixed — global event forwarding + gateway fallback for stream-status |

### 🟠 P1 — Important
| Issue | Commit | Status |
|-------|--------|--------|
| chat.inject not implemented | `7094e5c` | ✅ Implemented — REST + WS handler + frontend context method |
| Seq-gap tracking on backend WS | `39fd485` | ✅ Implemented — lastSeq + stateVersion tracked on reconnect |

### 🟡 P2 — Features
| Issue | Commit | Status |
|-------|--------|--------|
| Slash commands (8 commands) | `99597b7` | ✅ Implemented — /new /stop /model /models /export /help /status /clear |
| Terminal command library (318 commands) | `e48d4ab` | ✅ Audited and rebuilt — 89 OpenClaw commands, Caddy added, PM2 removed |
| Tool pills visible during thinking phase | `493abf9` | ✅ Fixed — streaming bubble renders even with empty content |
| Compaction indicator | pre-existing | ✅ Working — compaction_start/end events forwarded via global handler |

---

## 🔴 Known Remaining Issues

### 1. Compaction events may not fire reliably
- **Symptom:** Had a context compaction, never saw a warning. Sent a message during it with no indication.
- **Root cause candidates:**
  - The OpenClaw gateway may not emit `compaction` stream events for the `main` agent session (only for sub-agents?)
  - The PersistentGatewayWs `handleAgentEvent` has a check: `if (!streamEventBus.hasSubscribers(sessionKey)) return;` BEFORE the compaction check — but compaction is in `handleAgentEvent`, and the compaction bypass is on line 141 of the event handler. **Wait — compaction events come through the `agent` event handler, and the bypass IS correct (line 141 checks `stream === 'compaction'` before the subscriber check on line 155).** So this should work.
  - The `chat` event handler may also carry compaction state — need to verify the gateway emits compaction on the `agent` stream, not just the `chat` stream.
  - **Most likely:** The gateway emits compaction as a `chat.state` event, not as an `agent` stream event. Our `handleChatEvent` doesn't check for compaction state.

### 2. Page refresh during streaming loses last message
- **Symptom:** If you refresh the page before the final message comes through, you don't see it.
- **Root cause:** History is loaded from persisted JSONL files. The last in-flight message hasn't been written to JSONL yet (it's still streaming). The `refreshChat` function should check stream-status first (it does), but if the timing is wrong, it may miss the transition.
- **Fix needed:** After loading history, if stream-status reports active, the reconnect subscriber should capture the latest text from the stream-status response and show it.

### 3. Stream reconnection reliability after backend restart
- **Symptom:** After `systemctl restart`, the portal chat shows no stream activity.
- **Improvement deployed:** (`fc33d5e`) Global event forwarding + gateway fallback. But there's still a timing race: if the frontend checks stream-status before PersistentGatewayWs reconnects AND before the gateway RPC completes, it may report inactive. 
- **Additional fix needed:** Frontend should retry stream-status with a short delay (2-3s) after getting `active: false` when the WS just reconnected.

---

## 🟠 Still TODO (from audit)

### P1 — Protocol
- [ ] Idempotency key dedup on frontend (handle `in_flight` response on double-click)
- [ ] Verify abort preserves partial output (show partial text after cancel)
- [ ] tick/pong keepalive support

### P2 — Features
- [ ] Chat search (substring filter across history)
- [ ] Pinned messages (localStorage-backed)
- [ ] Chat export (markdown download)
- [ ] Fallback indicator (model fallback toast when Opus → Sonnet)
- [ ] Message grouping (visual cohesion for consecutive same-role messages)

### P3 — Nice-to-have
- [ ] Command palette (Cmd+K)
- [ ] Focus mode
- [ ] Multi-session switching
- [ ] Session cache (LRU)
- [ ] Attachment upload passthrough in chat

---

## Architecture Summary

### Event Flow (current state)
```
OpenClaw Gateway
    ↓ (WebSocket, persistent)
PersistentGatewayWs (backend singleton)
    ↓ (handleAgentEvent / handleChatEvent)
StreamEventBus (pub/sub, session-scoped)
    ↓ per-session subscribers (from handleWsSend/handleWsReconnect)
    ↓ global subscriber (from handlePortalWsConnection — fallback)
Browser WebSocket (portal frontend)
    ↓ (handleWsEvent in ChatStateProvider)
React State (messages, streaming phase, tool calls, thinking)
    ↓
ChatInterface.tsx (rendering)
```

### Key Behavioral Notes
- Per-session subscribers survive `done` events (for sub-agent resume)
- Per-session subscribers are torn down on abort or WS close
- Global subscriber forwards ALL events when no per-session subscriber exists
- stream-status falls back to gateway RPC when StreamEventBus is empty
- History parser shows only last text segment for messages with tool calls
- toolResult messages are merged into preceding assistant's toolCalls on history load
