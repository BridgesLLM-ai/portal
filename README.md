<p align="center">
  <img src="https://bridgesllm.ai/og-image.png" alt="BridgesLLM Portal" width="720">
</p>

<h1 align="center">BridgesLLM Portal</h1>

<p align="center">
  <strong>Free, open-source AI workstation. One install. Any VPS.</strong>
</p>

<p align="center">
  <a href="https://bridgesllm.ai"><img src="https://img.shields.io/badge/website-bridgesllm.ai-blue?style=flat-square" alt="Website"></a>
  <a href="https://github.com/Robertmonkey/bridgesllm-portal/releases"><img src="https://img.shields.io/github/v/release/Robertmonkey/bridgesllm-portal?style=flat-square&color=green" alt="Release"></a>
  <a href="https://github.com/Robertmonkey/bridgesllm-portal/blob/main/LICENSE"><img src="https://img.shields.io/badge/license-MIT-blue?style=flat-square" alt="License"></a>
  <a href="https://github.com/Robertmonkey/bridgesllm-portal/stargazers"><img src="https://img.shields.io/github/stars/Robertmonkey/bridgesllm-portal?style=flat-square" alt="Stars"></a>
</p>

---

BridgesLLM Portal turns any $20/month VPS into a full AI development workstation — multi-provider agent chat, sandboxed code execution, browser-based remote desktop, project management, file manager, email server, and more. All through your browser.

**No expensive hardware. No per-token API bills. No PhD required.**

## ⚡ Quick Install

```bash
curl -fsSL https://bridgesllm.ai/install.sh | sudo bash
```

That's it. Takes about 5 minutes. Opens a setup wizard in your browser when done.

### Requirements

- Ubuntu 22.04+ or Debian 12+
- 2GB RAM minimum (4GB recommended)
- 10GB free disk space
- Root or sudo access

## 🎯 What You Get

| Feature | Description |
|---------|-------------|
| **Multi-Provider Agent Chat** | Claude, Codex, Gemini, Ollama — all via flat-rate OAuth subscriptions, not per-token billing. Switch models mid-conversation. Powered by [OpenClaw](https://github.com/openclaw/openclaw). |
| **AI-Powered Projects** | Create projects, edit code in-browser, assign AI agents to tasks. Git integration, live preview, and autonomous background agents. |
| **Sandboxed Code Execution** | Run AI-generated code in isolated Docker containers per project. Nothing breaks your server. |
| **Browser-Based Remote Desktop** | Full graphical desktop via NoVNC. Run GUI apps, browser automation, or visual workflows from any device. |
| **File Manager** | Browse, upload, edit, and manage server files. Drag-and-drop, in-browser editing, archive extraction. |
| **Built-In Email Server** | Stalwart mail server included. Send from your own domain — no third-party required. |
| **Self-Updating Dashboard** | One-click updates from the browser. Admin dashboard with user management, storage, and session monitoring. |
| **Setup Wizard** | Everything configured in-browser. Domain, SSL, OAuth, users — no CLI expertise needed. |

## 🏗️ Architecture

```
┌──────────────────────────────────────────────────┐
│                  Your Browser                     │
└──────────────────┬───────────────────────────────┘
                   │ HTTPS (Caddy)
┌──────────────────▼───────────────────────────────┐
│             BridgesLLM Portal                     │
│  ┌─────────────┐  ┌──────────────┐               │
│  │   React UI  │  │  Express API │               │
│  │  (Vite SPA) │  │  (Node.js)   │               │
│  └─────────────┘  └──────┬───────┘               │
│                          │                        │
│  ┌───────────────────────▼─────────────────────┐ │
│  │           OpenClaw Gateway                   │ │
│  │  (Agent framework — persistent WS)           │ │
│  └──────┬────────┬────────┬────────┬───────────┘ │
│         │        │        │        │              │
│    Claude    Codex    Gemini    Ollama            │
│   (OAuth)  (OAuth)  (OAuth)   (local)            │
│                                                   │
│  ┌────────────┐  ┌─────────┐  ┌──────────────┐  │
│  │ PostgreSQL │  │  Docker  │  │   Stalwart   │  │
│  │    (DB)    │  │(sandbox) │  │   (email)    │  │
│  └────────────┘  └─────────┘  └──────────────┘  │
└──────────────────────────────────────────────────┘
```

## 💰 Cost Comparison

| Setup | Monthly Cost | Hardware Upfront |
|-------|-------------|-----------------|
| **VPS + BridgesLLM Portal** | **$80–140/mo** | **$0** |
| Mac Mini M4 + API keys | $217–517/mo | $800 |
| Gaming PC + API keys | $285–635/mo | $1,200 |
| Cloud IDEs (Codespaces) | $58+/mo | $0 (limited AI) |

*Portal is free. VPS is $20–40/mo. AI subscriptions (Claude, Codex, Gemini) are ~$20/mo each — flat-rate, not per-token.*

## 🔧 Tech Stack

- **Frontend:** React 19 + Vite + Tailwind CSS + Monaco Editor
- **Backend:** Node.js + Express + Prisma + PostgreSQL
- **Agent Framework:** [OpenClaw](https://github.com/openclaw/openclaw) (open-source)
- **AI Providers:** Anthropic (Claude), OpenAI (Codex), Google (Gemini), Ollama (local)
- **Reverse Proxy:** Caddy (automatic HTTPS)
- **Containers:** Docker (per-project sandboxing)
- **Remote Desktop:** NoVNC + Xfce4
- **Email:** Stalwart Mail Server

## 📸 Screenshots

Visit [bridgesllm.ai](https://bridgesllm.ai) to see live video demos of every feature.

## 🔄 Updating

From your portal dashboard, click the **Update** button. Or from SSH:

```bash
curl -fsSL https://bridgesllm.ai/install.sh | sudo bash -s -- --update
```

Updates preserve all your data, projects, and configuration.

## 🔒 Security

- All traffic encrypted via automatic Let's Encrypt SSL
- Portal runs behind Caddy reverse proxy (port 4001 not exposed)
- Code execution sandboxed in Docker containers
- Database credentials auto-generated, never exposed
- Gateway auth via token-based WebSocket protocol
- Email server locked to loopback interface

## 📋 Roadmap

- [ ] GitHub integration (push/pull from project panel)
- [ ] Team collaboration (multi-user project sharing)
- [ ] Plugin system for custom AI providers
- [ ] Mobile-optimized UI
- [ ] Built-in CI/CD pipeline
- [ ] Template marketplace (starter projects)

## 🤝 Contributing

Contributions are welcome. Please open an issue first to discuss significant changes.

1. Fork the repo
2. Create your feature branch (`git checkout -b feature/amazing-feature`)
3. Commit your changes (`git commit -m 'Add amazing feature'`)
4. Push to the branch (`git push origin feature/amazing-feature`)
5. Open a Pull Request

## 📄 License

This project is licensed under the MIT License — see the [LICENSE](LICENSE) file for details.

## 🙏 Acknowledgments

- [OpenClaw](https://github.com/openclaw/openclaw) — the agent framework that powers intelligent features
- [Anthropic](https://anthropic.com), [OpenAI](https://openai.com), [Google](https://ai.google.dev) — AI providers
- [Caddy](https://caddyserver.com) — automatic HTTPS reverse proxy
- [Stalwart](https://stalw.art) — mail server
- [NoVNC](https://novnc.com) — browser-based VNC client

---

<p align="center">
  <strong>Built by <a href="https://github.com/Robertmonkey">Robert Bridges</a></strong>
  <br>
  <a href="https://bridgesllm.ai">Website</a> · <a href="https://github.com/Robertmonkey/bridgesllm-portal/issues">Issues</a> · <a href="https://github.com/Robertmonkey/bridgesllm-portal/releases">Releases</a>
</p>
