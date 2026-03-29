# Changelog

## v3.20.0 (2026-03-29)

### 🔐 Security
- **Remove rehype-raw from markdown renderer** — Agent responses with unfenced HTML were rendered directly into the portal DOM, enabling XSS and breaking page layout. Raw HTML in chat is now safely escaped; code blocks with preview still work via sandboxed iframe.

### 🐛 Bug Fixes

#### Provider Authentication
- **Fix Anthropic API key/token save** — API keys entered through the portal settings were never persisted to auth-profiles.json. The portal now writes directly to all three config files (auth-profiles.json, openclaw.json, models.json) instead of relying on the `openclaw onboard` CLI which silently failed for non-OAuth providers.
- **Fix Claude setup-token extraction** — The token regex didn't match Claude CLI's actual output format (`Your OAuth token (valid for 1 year): sk-ant-oat01-...`). Now matches the `sk-ant-oat01-` prefix directly in PTY output, immune to format changes.
- **Fix save button disabled when no model selected** — Adding a provider when a default model was already configured left the Save button grayed out because `selectedModel` started as null.
- **Fix model default override** — All three setup flows (API key, OAuth, setup-token) auto-selected a model on mount, silently overwriting the user's existing default. Now checks for an existing default first.
- **Fix OpenClaw stdout diagnostic pollution** — `registerProviderModels` JSON parsing failed because OpenClaw CLI prints diagnostic messages to stdout before JSON output. Now strips non-JSON prefixes before parsing.

#### Chat Streaming
- **Fix stale "Agent is thinking" indicator on page refresh** — `stream-status` endpoint returned `active: true` from stale gateway `chatState` or soft-cleared StreamEventBus entries. Added: active flag check, 90s stale event guard, and 60s gateway activity guard.
- **Fix missed messages after phone lock/tab background** — Visibility change handler now reloads chat history when tab becomes visible and no stream is active, picking up responses that completed while backgrounded.

#### Code Preview
- **Fix HTML preview iframe white background** — Removed `bg-white` class from preview iframe; use transparent background so dark-themed apps render correctly.
- **Auto-detect bare HTML responses** — Agent responses with raw `<!DOCTYPE html>` (no markdown code fences) now auto-wrap in fences for proper code block + preview rendering.
- **Wrap partial HTML in clean document** — Partial HTML snippets get a minimal document wrapper with CSS reset to prevent style leakage.

#### Installer
- **Fix migration table count check** — Replaced PrismaClient-based check (which failed due to wrong working directory) with direct `psql` query. Prevents false "0 tables" errors during updates.
- **Fix hardcoded Anthropic model fallback** — Removed hardcoded `anthropic/claude-opus-4-6`; uses the gateway's configured default model instead.

## v3.19.0 (2026-03-28)

- Initial public release
