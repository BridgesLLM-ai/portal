# BridgesLLM Portal — Launch Checklist

## Legal / Licensing
- [ ] All dependencies audited (no AGPL/GPL in closed distribution)
- [ ] LICENSE file present (choose: MIT / proprietary)
- [ ] Terms of Service page
- [ ] Privacy Policy page

## Security
- [ ] JWT_SECRET fail-fast in production ✅
- [ ] Agent jobs require approved user ✅
- [ ] Admin-only routes guarded ✅
- [ ] No hardcoded secrets in repo ✅
- [ ] Rate limiting on auth endpoints ✅
- [ ] No Marcus/personal branding leaks ✅ (5 backward-compat refs remain)

## Installer / Onboarding
- [ ] One-command install tested on Ubuntu 22.04
- [ ] One-command install tested on Ubuntu 24.04
- [ ] One-command install tested on Debian 12
- [ ] Setup wizard completes cleanly on fresh install
- [ ] Feature Readiness panel shows correct status post-install
- [ ] Ollama wizard step works (skip + install paths)

## Features (Tier-1)
- [ ] Agent Chats: OpenClaw adapter working
- [ ] Agent Chats: Claude Code adapter working
- [ ] Agent Chats: Codex adapter working
- [ ] Agent Tools: detect/install/test for all Tier-1 tools
- [ ] Terminal: presets for all Tier-1 tools
- [ ] Settings: all tabs save/load correctly
- [ ] Settings: SMTP test email works
- [ ] Remote Desktop: configured state works (not recursive)
- [ ] Multi-user: approval workflow tested
- [ ] Ollama: local model detection + settings

## Go-to-Market
- [ ] Landing page live at bridgesllm.ai
- [ ] Install guide with affiliate links
- [ ] GitHub repo public with README
- [ ] Pricing page / donation link
- [ ] Terms + Privacy pages
- [ ] Discord/support channel
