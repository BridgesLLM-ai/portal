import { useEffect, useState } from 'react';
import {
  Terminal, FolderTree, LayoutDashboard, MessageSquare, Wrench,
  Cpu, MemoryStick, HardDrive, GitBranch, GitCommit, Share2,
  Upload, Download, Eye, Code2, Rocket, Shield, Users, Settings,
  ChevronRight, Copy, Check, ArrowRight, Zap,
  Monitor, Globe, Lock, Server,
} from 'lucide-react';

const installCommand = 'Coming soon';

/* ─── Helpers ──────────────────────────────────────────── */

function useReveal() {
  useEffect(() => {
    const els = Array.from(document.querySelectorAll<HTMLElement>('[data-reveal]'));
    const obs = new IntersectionObserver(
      (entries) => entries.forEach((e) => {
        if (e.isIntersecting) {
          e.target.classList.add('opacity-100', 'translate-y-0');
          e.target.classList.remove('opacity-0', 'translate-y-6');
          obs.unobserve(e.target);
        }
      }),
      { threshold: 0.12, rootMargin: '0px 0px -60px 0px' },
    );
    els.forEach((el) => obs.observe(el));
    return () => obs.disconnect();
  }, []);
}

function SectionLabel({ children }: { children: React.ReactNode }) {
  return (
    <span className="inline-flex items-center gap-2 rounded-full border border-emerald-300/25 bg-emerald-500/10 px-3 py-1 text-[11px] font-semibold uppercase tracking-[0.16em] text-emerald-200/90 mb-4">
      {children}
    </span>
  );
}

/* ─── Main Landing ─────────────────────────────────────── */

export default function LandingPage() {
  const [copied, setCopied] = useState(false);
  useReveal();

  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(installCommand);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch { /* noop */ }
  };

  return (
    <div
      className="min-h-screen text-slate-100 antialiased"
      style={{
        background:
          'radial-gradient(1200px 700px at 15% -10%, rgba(16,185,129,0.12), transparent 52%), radial-gradient(900px 500px at 88% 10%, rgba(99,102,241,0.11), transparent 55%), linear-gradient(180deg, #05070f 0%, #0b1220 52%, #08101c 100%)',
        fontFamily: 'Inter, ui-sans-serif, system-ui, -apple-system, sans-serif',
      }}
    >
      <div className="pointer-events-none fixed inset-x-0 top-0 z-50 h-px bg-gradient-to-r from-transparent via-emerald-300/40 to-transparent" />

      {/* ─── Header ─── */}
      <header className="sticky top-0 z-40 border-b border-white/10 bg-[#070d18]/80 backdrop-blur-xl">
        <nav className="mx-auto flex w-full max-w-7xl items-center justify-between px-4 py-3 sm:px-6 lg:px-8">
          <a href="#top" className="group inline-flex items-center gap-2">
            <span className="text-lg font-semibold tracking-tight text-white sm:text-xl">BridgesLLM</span>
            <span className="rounded-full border border-emerald-300/40 bg-emerald-500/15 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-[0.14em] text-emerald-300">
              Portal
            </span>
          </a>
          <div className="flex items-center gap-4">
            <a href="#features" className="hidden text-sm text-slate-300 hover:text-white transition sm:block">Features</a>
            <a href="#how" className="hidden text-sm text-slate-300 hover:text-white transition sm:block">How It Works</a>
            <a
              href="#install"
              className="inline-flex items-center justify-center rounded-lg border border-emerald-300/30 bg-emerald-500/90 px-4 py-2 text-sm font-semibold text-slate-950 transition hover:bg-emerald-400"
            >
              Get Started
            </a>
          </div>
        </nav>
      </header>

      <main id="top">
        {/* ─── Hero ─── */}
        <section className="mx-auto w-full max-w-7xl px-4 pb-16 pt-16 sm:px-6 sm:pb-24 sm:pt-20 lg:px-8 lg:pt-24">
          <div data-reveal className="mx-auto max-w-3xl text-center opacity-0 translate-y-6 transition-all duration-700">
            <SectionLabel>Free &amp; Self-Hosted</SectionLabel>
            <h1 className="mt-4 text-4xl font-semibold tracking-[-0.03em] text-white sm:text-5xl lg:text-6xl">
              Your AI Agents.<br />
              <span className="bg-gradient-to-r from-emerald-300 to-violet-300 bg-clip-text text-transparent">Your Server. Your Rules.</span>
            </h1>
            <p className="mx-auto mt-6 max-w-2xl text-base leading-relaxed text-slate-300 sm:text-lg">
              A full web workspace for Claude Code, Codex, and OpenClaw — with a real terminal, file manager, code editor, project management, and AI chat. All running on your VPS.
            </p>
            <div className="mt-9 flex flex-col items-center justify-center gap-3 sm:flex-row">
              <a href="#install" className="inline-flex w-full items-center justify-center rounded-xl bg-emerald-500 px-6 py-3 text-sm font-semibold text-slate-950 transition hover:bg-emerald-400 sm:w-auto">
                Install Free <ArrowRight size={16} className="ml-2" />
              </a>
              <a href="#features" className="inline-flex w-full items-center justify-center rounded-xl border border-violet-300/35 bg-violet-500/15 px-6 py-3 text-sm font-semibold text-violet-100 transition hover:bg-violet-500/25 sm:w-auto">
                Explore Features
              </a>
            </div>
          </div>

          {/* Hero mockup — full portal overview */}
          <div data-reveal className="mt-14 opacity-0 translate-y-6 transition-all duration-700 delay-200">
            <HeroPortalMockup />
          </div>
        </section>

        {/* ─── Old Way vs BridgesLLM ─── */}
        <section className="mx-auto w-full max-w-7xl px-4 py-14 sm:px-6 sm:py-20 lg:px-8">
          <div className="grid gap-6 lg:grid-cols-2" data-reveal>
            <div className="rounded-2xl border border-rose-300/20 bg-rose-500/[0.06] p-6 sm:p-8 opacity-0 translate-y-6 transition-all duration-700">
              <h2 className="text-2xl font-semibold tracking-[-0.02em] text-white">The old way</h2>
              <ul className="mt-5 space-y-3 text-sm text-slate-300 sm:text-base">
                {[
                  'SSH into your VPS every time you want to code',
                  'Juggle terminal windows and tmux sessions',
                  "Can't see what your agent is doing without CLI",
                  'SCP files back and forth to edit them',
                  'No web access — laptop-only workflows',
                ].map((item) => (
                  <li key={item} className="flex items-start gap-3">
                    <span className="mt-0.5 text-base">❌</span>
                    <span>{item}</span>
                  </li>
                ))}
              </ul>
            </div>
            <div className="rounded-2xl border border-emerald-300/25 bg-emerald-500/[0.08] p-6 sm:p-8 opacity-0 translate-y-6 transition-all duration-700 delay-150">
              <h2 className="text-2xl font-semibold tracking-[-0.02em] text-white">The BridgesLLM way</h2>
              <ul className="mt-5 space-y-3 text-sm text-slate-200 sm:text-base">
                {[
                  'Open a URL on any device — phone, tablet, laptop',
                  'Chat with agents like texting a developer',
                  'Full web terminal with tabs, autocomplete, and AI assist',
                  'Browse, upload, edit files right in the browser',
                  'Deploy projects with one click',
                ].map((item) => (
                  <li key={item} className="flex items-start gap-3">
                    <span className="mt-0.5 text-base">✅</span>
                    <span>{item}</span>
                  </li>
                ))}
              </ul>
            </div>
          </div>
        </section>

        {/* ─── Features ─── */}
        <section id="features" className="scroll-mt-20 mx-auto w-full max-w-7xl px-4 py-14 sm:px-6 sm:py-20 lg:px-8">
          <div className="text-center mb-14" data-reveal>
            <SectionLabel>What&apos;s Inside</SectionLabel>
            <h2 className="text-3xl font-semibold tracking-[-0.02em] text-white sm:text-4xl">
              Not just a chat box. A full command center.
            </h2>
            <p className="mt-4 max-w-2xl mx-auto text-slate-300">
              Every tool you need to manage your AI agents, your server, and your projects — in one place.
            </p>
          </div>

          <div className="space-y-10">
            {/* Feature 1: Dashboard */}
            <FeatureBlock
              label="Dashboard"
              title="Live system metrics at a glance"
              description="CPU, memory, disk, and network — all in real-time with sparkline charts. Activity feed shows everything your agents are doing. Know your server's health without touching a terminal."
              visual={<DashboardMockup />}
              reverse={false}
            />

            {/* Feature 2: Terminal */}
            <FeatureBlock
              label="Web Terminal"
              title="A real terminal in your browser"
              description="Full xterm.js terminal with multiple tabs, built-in autocomplete, command history, and an AI assistant panel that can explain errors and suggest fixes. Open as many shells as you need — all in one view."
              visual={<TerminalMockup />}
              reverse
            />

            {/* Feature 3: Files */}
            <FeatureBlock
              label="File Manager"
              title="Browse, upload, and edit — no SCP required"
              description="Full file tree with drag-and-drop upload, download, preview for images and media, and inline code editing. Resumable uploads with progress tracking. Manage your entire server filesystem from the browser."
              visual={<FilesMockup />}
              reverse={false}
            />

            {/* Feature 4: Projects */}
            <FeatureBlock
              label="Projects"
              title="A web IDE with git, deploy, and share"
              description="Monaco code editor with syntax highlighting. Full git integration — branches, commits, diffs, push/pull. One-click deploy. Generate share links for others to view your projects. AI-powered code analysis."
              visual={<ProjectsMockup />}
              reverse
            />

            {/* Feature 5: Agent Chat */}
            <FeatureBlock
              label="Agent Chat"
              title="Talk to your coding agents like teammates"
              description="Multi-session chat with Claude Code, Codex, and OpenClaw. See streamed output as it happens. Full conversation history. Switch between agents or run them in parallel."
              visual={<AgentChatMockup />}
              reverse={false}
            />

            {/* Feature 6: Agent Tools */}
            <FeatureBlock
              label="Agent Tools"
              title="Install coding agents with one click"
              description="Browse available agents — Claude Code, Codex, OpenClaw — and install them directly from the UI. The portal handles dependencies, configuration, and updates."
              visual={<AgentToolsMockup />}
              reverse
            />
          </div>
        </section>

        {/* ─── Setup Wizard ─── */}
        <section className="mx-auto w-full max-w-7xl px-4 py-14 sm:px-6 sm:py-20 lg:px-8">
          <div data-reveal className="rounded-2xl border border-white/10 bg-white/[0.02] p-6 sm:p-10 opacity-0 translate-y-6 transition-all duration-700">
            <div className="grid gap-8 lg:grid-cols-2 items-center">
              <div>
                <SectionLabel>First Run</SectionLabel>
                <h2 className="text-3xl font-semibold tracking-[-0.02em] text-white sm:text-4xl">
                  Guided setup in 6 steps
                </h2>
                <p className="mt-4 text-slate-300 leading-relaxed">
                  The setup wizard walks you through account creation, portal branding, theme customization, registration settings, and Ollama model installation. It detects your RAM and recommends the right models for your hardware.
                </p>
                <ul className="mt-6 space-y-3 text-sm text-slate-300">
                  {[
                    'Create your admin account',
                    'Name and brand your portal',
                    'Choose dark or light theme + accent color',
                    'Set registration mode (open, approval, or closed)',
                    'Auto-detect hardware and recommend AI models',
                    'Install Ollama models with one click',
                  ].map((item, i) => (
                    <li key={i} className="flex items-center gap-3">
                      <span className="flex items-center justify-center w-6 h-6 rounded-full bg-emerald-500/20 text-emerald-300 text-xs font-bold">{i + 1}</span>
                      {item}
                    </li>
                  ))}
                </ul>
              </div>
              <SetupWizardMockup />
            </div>
          </div>
        </section>

        {/* ─── Security ─── */}
        <section className="mx-auto w-full max-w-7xl px-4 py-14 sm:px-6 sm:py-20 lg:px-8">
          <div className="text-center mb-10" data-reveal>
            <SectionLabel>Security</SectionLabel>
            <h2 className="text-3xl font-semibold tracking-[-0.02em] text-white sm:text-4xl">
              Your data never leaves your machine
            </h2>
          </div>
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4" data-reveal>
            {[
              { icon: Server, title: 'Self-Hosted', desc: 'Runs 100% on your VPS. No cloud dependency.' },
              { icon: Lock, title: 'HTTPS by Default', desc: 'Caddy handles SSL automatically — for IPs and domains.' },
              { icon: Users, title: 'Multi-User Auth', desc: 'Role-based access with admin approval workflows.' },
              { icon: Shield, title: 'Your Keys, Your Data', desc: 'API keys and conversations stay on your hardware.' },
            ].map((item) => (
              <div key={item.title} className="rounded-2xl border border-white/10 bg-white/[0.03] p-5 text-center">
                <div className="mx-auto w-12 h-12 rounded-xl bg-emerald-500/15 flex items-center justify-center mb-4">
                  <item.icon size={22} className="text-emerald-300" />
                </div>
                <h3 className="text-base font-semibold text-white">{item.title}</h3>
                <p className="mt-2 text-sm text-slate-400">{item.desc}</p>
              </div>
            ))}
          </div>
        </section>

        {/* ─── How It Works ─── */}
        <section id="how" className="scroll-mt-24 mx-auto w-full max-w-7xl px-4 py-14 sm:px-6 sm:py-20 lg:px-8">
          <div className="text-center mb-10" data-reveal>
            <SectionLabel>Installation</SectionLabel>
            <h2 className="text-3xl font-semibold tracking-[-0.02em] text-white sm:text-4xl">
              From zero to running in under 10 minutes
            </h2>
          </div>

          <div className="grid gap-4 md:grid-cols-3" data-reveal>
            {[
              { num: '01', title: 'Get a VPS', desc: 'Any Ubuntu 22.04+ or Debian 12 VPS with 1GB+ RAM. DigitalOcean, Vultr, Hostinger — whatever you prefer.', icon: Server },
              { num: '02', title: 'Run one command', desc: 'The installer handles Docker, Caddy, SSL, and all dependencies. Optionally pass your domain for automatic HTTPS.', icon: Terminal, code: installCommand },
              { num: '03', title: 'Open your portal', desc: "Access via your server's IP or your domain. Run the setup wizard, install your agents, and start building.", icon: Rocket },
            ].map((step) => (
              <div key={step.num} className="rounded-2xl border border-white/10 bg-white/[0.03] p-5">
                <div className="flex items-center gap-3 mb-3">
                  <span className="text-3xl font-semibold tracking-[-0.03em] text-emerald-300">{step.num}</span>
                  <div className="w-9 h-9 rounded-xl bg-emerald-500/15 flex items-center justify-center">
                    <step.icon size={18} className="text-emerald-300" />
                  </div>
                </div>
                <h3 className="text-xl font-semibold text-white">{step.title}</h3>
                <p className="mt-3 text-sm leading-relaxed text-slate-300">{step.desc}</p>
                {step.code && (
                  <code className="mt-4 block overflow-x-auto rounded-lg border border-white/10 bg-black/40 px-3 py-2 text-xs text-slate-200">
                    {step.code}
                  </code>
                )}
              </div>
            ))}
          </div>

          {/* Access options */}
          <div className="mt-8 grid gap-4 md:grid-cols-2" data-reveal>
            <div className="rounded-2xl border border-white/10 bg-white/[0.03] p-6">
              <div className="flex items-center gap-3 mb-3">
                <div className="w-10 h-10 rounded-xl bg-emerald-500/20 flex items-center justify-center">
                  <Globe size={20} className="text-emerald-300" />
                </div>
                <h3 className="text-lg font-semibold text-white">Access via IP</h3>
              </div>
              <p className="text-sm text-slate-300 leading-relaxed">
                No domain needed. The installer configures HTTPS on your server&apos;s IP address. Open <code className="text-emerald-200 bg-emerald-500/10 px-1.5 py-0.5 rounded text-xs">https://your.server.ip</code> and you&apos;re in.
              </p>
            </div>
            <div className="rounded-2xl border border-white/10 bg-white/[0.03] p-6">
              <div className="flex items-center gap-3 mb-3">
                <div className="w-10 h-10 rounded-xl bg-violet-500/20 flex items-center justify-center">
                  <Globe size={20} className="text-violet-300" />
                </div>
                <h3 className="text-lg font-semibold text-white">Bring your domain</h3>
              </div>
              <p className="text-sm text-slate-300 leading-relaxed">
                Pass <code className="text-violet-200 bg-violet-500/10 px-1.5 py-0.5 rounded text-xs">--domain portal.yourdomain.com</code> during install. Point your DNS A record — Caddy handles Let&apos;s Encrypt automatically.
              </p>
            </div>
          </div>
        </section>

        {/* ─── Supported Agents ─── */}
        <section className="mx-auto w-full max-w-7xl px-4 py-14 sm:px-6 sm:py-20 lg:px-8">
          <div className="text-center mb-10" data-reveal>
            <SectionLabel>Supported Agents</SectionLabel>
            <h2 className="text-3xl font-semibold tracking-[-0.02em] text-white sm:text-4xl">
              Works with the tools you already use
            </h2>
            <p className="mt-4 text-slate-300">More agents coming based on demand.</p>
          </div>

          <div className="grid gap-4 md:grid-cols-3" data-reveal>
            {[
              { name: 'Claude Code', vendor: 'Anthropic', desc: 'Pair-program with Claude in a guided, chat-first workflow. Real code changes, explained step by step.', color: 'violet' },
              { name: 'Codex', vendor: 'OpenAI', desc: 'Run planning, implementation, and iteration cycles from a modern web workspace. Full-auto or guided mode.', color: 'emerald' },
              { name: 'OpenClaw', vendor: 'OpenClaw', desc: 'Orchestrate tools, automations, and multi-step tasks. Connect to your services and let it work.', color: 'amber' },
            ].map((agent) => {
              const borderColor = agent.color === 'violet' ? 'border-violet-300/20' : agent.color === 'emerald' ? 'border-emerald-300/20' : 'border-amber-300/20';
              const badgeBg = agent.color === 'violet' ? 'bg-violet-500/10 text-violet-200' : agent.color === 'emerald' ? 'bg-emerald-500/10 text-emerald-200' : 'bg-amber-500/10 text-amber-200';
              return (
                <article key={agent.name} className={`rounded-2xl border ${borderColor} bg-white/[0.03] p-6`}>
                  <div className="flex items-center justify-between gap-3">
                    <h3 className="text-xl font-semibold text-white">{agent.name}</h3>
                    <span className={`rounded-full border border-white/10 ${badgeBg} px-2.5 py-1 text-[11px] font-semibold uppercase tracking-[0.12em]`}>
                      Supported
                    </span>
                  </div>
                  <p className="mt-2 text-sm text-slate-400">{agent.vendor}</p>
                  <p className="mt-4 text-sm leading-relaxed text-slate-300">{agent.desc}</p>
                </article>
              );
            })}
          </div>
        </section>

        {/* ─── Install CTA ─── */}
        <section id="install" className="scroll-mt-24 border-y border-white/10 bg-black/20 px-4 py-16 sm:px-6 lg:px-8">
          <div className="mx-auto max-w-4xl text-center" data-reveal>
            <h2 className="text-3xl font-semibold tracking-[-0.02em] text-white sm:text-4xl">
              Ready to own your AI workspace?
            </h2>
            <p className="mt-4 text-slate-300">Install once. Keep ownership forever. No accounts, no subscriptions, no cloud lock-in.</p>

            <div className="mt-8 rounded-2xl border border-white/10 bg-[#040814] p-4 text-left sm:p-5">
              <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
                <code className="block overflow-x-auto text-sm text-slate-100">{installCommand}</code>
                <button
                  type="button"
                  disabled
                  className="inline-flex shrink-0 items-center justify-center gap-2 rounded-lg bg-slate-700 px-4 py-2 text-sm font-semibold text-slate-300 cursor-not-allowed"
                >
                  Coming Soon
                </button>
              </div>
            </div>

            <p className="mt-6 text-sm text-slate-400">
              Requires: Ubuntu 22.04/24.04 or Debian 12 · 1GB+ RAM · Root access
            </p>
          </div>
        </section>

        {/* ─── Support ─── */}
        <section className="mx-auto w-full max-w-7xl px-4 py-14 sm:px-6 sm:py-20 lg:px-8">
          <div className="rounded-2xl border border-white/10 bg-gradient-to-br from-white/[0.04] to-white/[0.01] p-7 text-center sm:p-10" data-reveal>
            <h2 className="text-2xl font-semibold tracking-[-0.02em] text-white sm:text-3xl">Support the project</h2>
            <p className="mx-auto mt-4 max-w-2xl text-slate-300">
              BridgesLLM is free forever. If it saves you hours, consider buying us a coffee.
            </p>
            <a
              href="https://www.paypal.com/ncp/payment/Z7DN57NBDVJLC"
              target="_blank"
              rel="noreferrer"
              className="mt-7 inline-flex items-center justify-center rounded-xl bg-violet-500 px-6 py-3 text-sm font-semibold text-white transition hover:bg-violet-400"
            >
              Donate via PayPal
            </a>
          </div>
        </section>
      </main>

      {/* ─── Footer ─── */}
      <footer className="border-t border-white/10 px-4 py-8 sm:px-6 lg:px-8">
        <div className="mx-auto flex w-full max-w-7xl flex-col items-center justify-between gap-3 text-sm text-slate-400 md:flex-row">
          <p>BridgesLLM — Self-hosted AI agent portal.</p>
          <div className="flex items-center gap-3">
            <a href="/docs" className="hover:text-slate-100 transition">Docs</a>
            <span className="text-slate-600">|</span>
            <a href="mailto:support@bridgesllm.ai" className="hover:text-slate-100 transition">Support</a>
          </div>
          <p>© 2026 BridgesLLM</p>
        </div>
      </footer>
    </div>
  );
}

/* ─────────────────────────────────────────────────────────
   FEATURE BLOCK — alternating layout with mockup
   ───────────────────────────────────────────────────────── */

function FeatureBlock({ label, title, description, visual, reverse }: {
  label: string; title: string; description: string; visual: React.ReactNode; reverse: boolean;
}) {
  return (
    <div
      data-reveal
      className={`grid items-center gap-6 rounded-2xl border border-white/10 bg-white/[0.02] p-5 opacity-0 translate-y-6 transition-all duration-700 sm:p-8 lg:grid-cols-2 lg:gap-10 ${
        reverse ? 'lg:[&>*:first-child]:order-2 lg:[&>*:last-child]:order-1' : ''
      }`}
    >
      <div>
        <SectionLabel>{label}</SectionLabel>
        <h3 className="text-2xl font-semibold tracking-[-0.02em] text-white sm:text-3xl">{title}</h3>
        <p className="mt-4 text-slate-300 leading-relaxed">{description}</p>
      </div>
      {visual}
    </div>
  );
}

/* ─────────────────────────────────────────────────────────
   MOCKUP COMPONENTS — realistic UI representations
   ───────────────────────────────────────────────────────── */

function MockupWindow({ title, badge, children }: { title?: string; badge?: string; children: React.ReactNode }) {
  return (
    <div className="rounded-xl border border-white/10 bg-[#060b15]/90 overflow-hidden">
      <div className="flex items-center justify-between border-b border-white/10 px-3 py-2 text-xs text-slate-400">
        <div className="flex items-center gap-1.5">
          <span className="h-2 w-2 rounded-full bg-rose-400/80" />
          <span className="h-2 w-2 rounded-full bg-amber-400/80" />
          <span className="h-2 w-2 rounded-full bg-emerald-400/80" />
          {title && <span className="ml-2 text-slate-500">{title}</span>}
        </div>
        {badge && (
          <span className="rounded-full border border-emerald-300/25 bg-emerald-500/10 px-2 py-0.5 text-[10px] font-medium text-emerald-200">
            {badge}
          </span>
        )}
      </div>
      {children}
    </div>
  );
}

/* ─── Hero Portal Mockup ─── */

function HeroPortalMockup() {
  return (
    <div className="mx-auto max-w-6xl overflow-hidden rounded-2xl border border-white/10 bg-[#060b15]/80 shadow-[0_24px_70px_-30px_rgba(0,0,0,0.7)] backdrop-blur">
      <div className="flex items-center justify-between border-b border-white/10 px-4 py-3 text-xs text-slate-400 sm:px-6">
        <div className="flex items-center gap-2">
          <span className="h-2.5 w-2.5 rounded-full bg-rose-400" />
          <span className="h-2.5 w-2.5 rounded-full bg-amber-400" />
          <span className="h-2.5 w-2.5 rounded-full bg-emerald-400" />
          <span className="ml-3 text-slate-500">portal.yourdomain.com</span>
        </div>
        <span className="rounded-full border border-emerald-300/30 bg-emerald-500/10 px-2 py-0.5 font-medium text-emerald-200">
          ● Connected
        </span>
      </div>

      <div className="grid min-h-[480px] grid-cols-1 md:grid-cols-[56px_1fr]">
        {/* Sidebar nav icons */}
        <aside className="hidden md:flex flex-col items-center gap-1 border-r border-white/10 bg-slate-950/60 py-4 px-1">
          {[
            { Icon: LayoutDashboard, active: true },
            { Icon: Terminal, active: false },
            { Icon: FolderTree, active: false },
            { Icon: Code2, active: false },
            { Icon: MessageSquare, active: false },
            { Icon: Wrench, active: false },
            { Icon: Settings, active: false },
          ].map((item, i) => (
            <div
              key={i}
              className={`w-10 h-10 rounded-xl flex items-center justify-center transition ${
                item.active
                  ? 'bg-emerald-500/20 text-emerald-300'
                  : 'text-slate-500'
              }`}
            >
              <item.Icon size={18} />
            </div>
          ))}
        </aside>

        {/* Dashboard content */}
        <div className="p-4 sm:p-6">
          <div className="flex items-center justify-between mb-5">
            <h3 className="text-lg font-semibold text-white">Dashboard</h3>
            <span className="text-xs text-slate-500">Last updated: just now</span>
          </div>

          <div className="grid grid-cols-2 lg:grid-cols-4 gap-3 mb-5">
            <MiniMetric icon={Cpu} label="CPU" value="12%" color="#10b981" />
            <MiniMetric icon={MemoryStick} label="Memory" value="3.2 GB" color="#8b5cf6" />
            <MiniMetric icon={HardDrive} label="Disk" value="47%" color="#f59e0b" />
            <MiniMetric icon={Zap} label="Sessions" value="3" color="#06b6d4" />
          </div>

          <div className="grid gap-4 lg:grid-cols-2">
            <div className="rounded-xl border border-white/10 bg-white/[0.02] p-4">
              <p className="text-xs font-semibold uppercase tracking-wider text-slate-400 mb-3">CPU Usage (24h)</p>
              <MiniChart />
            </div>
            <div className="rounded-xl border border-white/10 bg-white/[0.02] p-4">
              <p className="text-xs font-semibold uppercase tracking-wider text-slate-400 mb-3">Recent Activity</p>
              <div className="space-y-2.5">
                {[
                  { action: 'Claude Code session started', time: '2m ago', emoji: '\u{1F916}' },
                  { action: 'Project deployed: api-v2', time: '15m ago', emoji: '\u{1F680}' },
                  { action: 'File uploaded: schema.sql', time: '1h ago', emoji: '\u{1F4C4}' },
                  { action: 'New user approved: sarah', time: '3h ago', emoji: '\u{1F464}' },
                ].map((item, i) => (
                  <div key={i} className="flex items-center gap-3 text-xs">
                    <span>{item.emoji}</span>
                    <span className="text-slate-300 flex-1">{item.action}</span>
                    <span className="text-slate-500">{item.time}</span>
                  </div>
                ))}
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

function MiniMetric({ icon: Icon, label, value, color }: { icon: any; label: string; value: string; color: string }) {
  return (
    <div className="rounded-xl border border-white/[0.08] bg-white/[0.03] p-3">
      <div className="flex items-center gap-2 mb-2">
        <div className="w-7 h-7 rounded-lg flex items-center justify-center" style={{ backgroundColor: color + '20' }}>
          <Icon size={14} style={{ color }} />
        </div>
        <span className="text-xs text-slate-400">{label}</span>
      </div>
      <p className="text-xl font-bold text-white">{value}</p>
    </div>
  );
}

function MiniChart() {
  const pts = [12, 18, 15, 22, 19, 14, 25, 20, 16, 23, 18, 12, 15, 28, 22, 17, 13, 19, 24, 16];
  const max = Math.max(...pts);
  const w = 280; const h = 60;
  const d = pts.map((p, i) => `${i === 0 ? 'M' : 'L'}${(i / (pts.length - 1)) * w},${h - (p / max) * h}`).join(' ');
  return (
    <svg viewBox={`0 0 ${w} ${h}`} className="w-full h-16" preserveAspectRatio="none">
      <defs>
        <linearGradient id="chartGrad" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor="#10b981" stopOpacity="0.3" />
          <stop offset="100%" stopColor="#10b981" stopOpacity="0" />
        </linearGradient>
      </defs>
      <path d={`${d} L${w},${h} L0,${h} Z`} fill="url(#chartGrad)" />
      <path d={d} fill="none" stroke="#10b981" strokeWidth="2" strokeLinejoin="round" />
    </svg>
  );
}

/* ─── Dashboard Feature Mockup ─── */
function DashboardMockup() {
  return (
    <MockupWindow title="Dashboard" badge="Live">
      <div className="p-4">
        <div className="grid grid-cols-3 gap-2 mb-3">
          <MiniMetric icon={Cpu} label="CPU" value="24%" color="#10b981" />
          <MiniMetric icon={MemoryStick} label="RAM" value="6.1 GB" color="#8b5cf6" />
          <MiniMetric icon={HardDrive} label="Disk" value="52%" color="#f59e0b" />
        </div>
        <div className="rounded-lg border border-white/10 bg-white/[0.02] p-3">
          <p className="text-[10px] font-semibold uppercase tracking-wider text-slate-400 mb-2">Activity Feed</p>
          <div className="space-y-2">
            {[
              { t: 'Codex: Built REST API endpoints', c: 'text-emerald-300' },
              { t: 'File uploaded: migrations.sql (2.4 MB)', c: 'text-violet-300' },
              { t: 'User "mike" approved by admin', c: 'text-amber-300' },
            ].map((item, i) => (
              <div key={i} className={`text-xs ${item.c} flex items-center gap-2`}>
                <span className="w-1.5 h-1.5 rounded-full bg-current flex-shrink-0" />
                {item.t}
              </div>
            ))}
          </div>
        </div>
      </div>
    </MockupWindow>
  );
}

/* ─── Terminal Feature Mockup ─── */
function TerminalMockup() {
  return (
    <MockupWindow title="Terminal">
      <div>
        {/* Tab bar */}
        <div className="flex items-center gap-0 border-b border-white/10 bg-slate-950/40 px-2">
          {['bash 1', 'bash 2', 'bash 3'].map((tab, i) => (
            <button
              key={tab}
              className={`px-3 py-2 text-xs border-b-2 transition ${
                i === 0
                  ? 'border-emerald-400 text-emerald-200 bg-white/[0.03]'
                  : 'border-transparent text-slate-500 hover:text-slate-300'
              }`}
            >
              {tab}
            </button>
          ))}
        </div>
        {/* Terminal content */}
        <div className="p-4 font-mono text-xs leading-relaxed bg-[#0a0e1a]" style={{ minHeight: '180px' }}>
          <p><span className="text-emerald-400">user@vps</span><span className="text-slate-500">:</span><span className="text-blue-400">~/project</span><span className="text-slate-500">$</span> <span className="text-slate-200">docker ps</span></p>
          <p className="text-slate-400 mt-1">CONTAINER ID   IMAGE            STATUS         PORTS</p>
          <p className="text-slate-300">a1b2c3d4e5f6   bridgesllm-app   Up 3 hours     0.0.0.0:4001-&gt;4001/tcp</p>
          <p className="text-slate-300">f6e5d4c3b2a1   postgres:16      Up 3 hours     5432/tcp</p>
          <p className="text-slate-300">1a2b3c4d5e6f   caddy:latest     Up 3 hours     80/tcp, 443/tcp</p>
          <p className="mt-2"><span className="text-emerald-400">user@vps</span><span className="text-slate-500">:</span><span className="text-blue-400">~/project</span><span className="text-slate-500">$</span> <span className="text-slate-200 animate-pulse">_</span></p>
        </div>
      </div>
    </MockupWindow>
  );
}

/* ─── Files Feature Mockup ─── */
function FilesMockup() {
  return (
    <MockupWindow title="File Manager">
      <div className="grid grid-cols-[180px_1fr] min-h-[200px]">
        {/* File tree */}
        <div className="border-r border-white/10 bg-slate-950/40 p-3 text-xs">
          <div className="space-y-1">
            {[
              { name: 'project/', indent: 0, type: 'dir' },
              { name: 'src/', indent: 1, type: 'dir' },
              { name: 'index.ts', indent: 2, type: 'file' },
              { name: 'server.ts', indent: 2, type: 'file', active: true },
              { name: 'routes/', indent: 2, type: 'dir' },
              { name: 'api.ts', indent: 3, type: 'file' },
              { name: 'package.json', indent: 1, type: 'file' },
              { name: 'Dockerfile', indent: 1, type: 'file' },
            ].map((f, i) => (
              <div
                key={i}
                className={`flex items-center gap-1.5 px-1.5 py-1 rounded cursor-default ${
                  f.active ? 'bg-emerald-500/15 text-emerald-200' : 'text-slate-400'
                }`}
                style={{ paddingLeft: `${f.indent * 12 + 6}px` }}
              >
                {f.type === 'dir' ? (
                  <FolderTree size={12} className="text-amber-400/70 flex-shrink-0" />
                ) : (
                  <Code2 size={12} className="text-slate-500 flex-shrink-0" />
                )}
                <span className="truncate">{f.name}</span>
              </div>
            ))}
          </div>
        </div>
        {/* File actions / preview */}
        <div className="p-4">
          <div className="flex items-center gap-2 mb-3">
            <span className="text-sm font-medium text-white">server.ts</span>
            <span className="text-xs text-slate-500">2.4 KB</span>
          </div>
          <div className="flex gap-2 mb-3">
            <button className="inline-flex items-center gap-1 rounded-lg border border-white/10 bg-white/[0.03] px-2.5 py-1.5 text-xs text-slate-300">
              <Download size={12} /> Download
            </button>
            <button className="inline-flex items-center gap-1 rounded-lg border border-white/10 bg-white/[0.03] px-2.5 py-1.5 text-xs text-slate-300">
              <Eye size={12} /> Preview
            </button>
            <button className="inline-flex items-center gap-1 rounded-lg border border-emerald-300/20 bg-emerald-500/10 px-2.5 py-1.5 text-xs text-emerald-200">
              <Upload size={12} /> Upload
            </button>
          </div>
          <div className="rounded-lg border border-white/10 bg-black/30 p-3 font-mono text-[11px] text-slate-300 leading-relaxed">
            <p><span className="text-violet-300">import</span> express <span className="text-violet-300">from</span> <span className="text-emerald-300">{`'express'`}</span>;</p>
            <p><span className="text-violet-300">import</span> cors <span className="text-violet-300">from</span> <span className="text-emerald-300">{`'cors'`}</span>;</p>
            <p className="text-slate-500 mt-1">// Server configuration</p>
            <p><span className="text-violet-300">const</span> app = <span className="text-amber-300">express</span>();</p>
            <p>app.<span className="text-amber-300">use</span>(<span className="text-amber-300">cors</span>());</p>
          </div>
        </div>
      </div>
    </MockupWindow>
  );
}

/* ─── Projects Feature Mockup ─── */
function ProjectsMockup() {
  return (
    <MockupWindow title="Projects" badge="api-v2">
      <div className="p-4">
        {/* Project header bar */}
        <div className="flex items-center justify-between mb-3">
          <div className="flex items-center gap-3">
            <div className="flex items-center gap-1.5 text-xs text-slate-300">
              <GitBranch size={14} className="text-violet-300" />
              <span>main</span>
            </div>
            <div className="flex items-center gap-1.5 text-xs text-emerald-300">
              <GitCommit size={14} />
              <span>3 ahead</span>
            </div>
          </div>
          <div className="flex gap-2">
            <button className="inline-flex items-center gap-1 rounded-lg border border-white/10 bg-white/[0.03] px-2.5 py-1.5 text-xs text-slate-300">
              <Share2 size={12} /> Share
            </button>
            <button className="inline-flex items-center gap-1 rounded-lg border border-emerald-300/20 bg-emerald-500/15 px-2.5 py-1.5 text-xs text-emerald-200">
              <Rocket size={12} /> Deploy
            </button>
          </div>
        </div>
        {/* Monaco-like editor */}
        <div className="rounded-lg border border-white/10 bg-[#1e1e2e] overflow-hidden">
          <div className="flex items-center gap-0 border-b border-white/10 bg-[#181825] px-2">
            <span className="px-3 py-1.5 text-xs text-emerald-200 border-b-2 border-emerald-400 bg-white/[0.03]">index.ts</span>
            <span className="px-3 py-1.5 text-xs text-slate-500">routes.ts</span>
            <span className="px-3 py-1.5 text-xs text-slate-500">config.ts</span>
          </div>
          <div className="p-3 font-mono text-[11px] leading-relaxed">
            <div className="flex">
              <div className="text-slate-600 text-right pr-3 select-none w-8">1<br/>2<br/>3<br/>4<br/>5<br/>6</div>
              <div>
                <p><span className="text-violet-300">export</span> <span className="text-violet-300">async function</span> <span className="text-amber-300">startServer</span>() {'{'}</p>
                <p>  <span className="text-violet-300">const</span> port = process.env.<span className="text-cyan-300">PORT</span> || <span className="text-amber-200">4001</span>;</p>
                <p>  <span className="text-violet-300">await</span> db.<span className="text-amber-300">connect</span>();</p>
                <p>  app.<span className="text-amber-300">listen</span>(port, () {'=> {'}</p>
                <p>    console.<span className="text-amber-300">log</span>(<span className="text-emerald-300">{"`Server running on ${port}`"}</span>);</p>
                <p>  {'});'}</p>
              </div>
            </div>
          </div>
        </div>
        {/* Git status bar */}
        <div className="mt-3 flex items-center gap-4 text-xs text-slate-500">
          <span className="flex items-center gap-1"><span className="w-2 h-2 rounded-full bg-emerald-400" /> 2 added</span>
          <span className="flex items-center gap-1"><span className="w-2 h-2 rounded-full bg-amber-400" /> 1 modified</span>
          <span className="flex items-center gap-1"><span className="w-2 h-2 rounded-full bg-rose-400" /> 0 deleted</span>
        </div>
      </div>
    </MockupWindow>
  );
}

/* ─── Agent Chat Feature Mockup ─── */
function AgentChatMockup() {
  return (
    <MockupWindow title="Agent Chat">
      <div className="grid grid-cols-[160px_1fr] min-h-[220px]">
        {/* Session sidebar */}
        <div className="border-r border-white/10 bg-slate-950/40 p-3">
          <p className="text-[10px] font-semibold uppercase tracking-wider text-slate-500 mb-2">Sessions</p>
          <div className="space-y-1.5">
            {[
              { name: 'Build auth API', agent: 'Claude Code', active: true },
              { name: 'Fix CSS layout', agent: 'Codex', active: false },
              { name: 'Debug workers', agent: 'OpenClaw', active: false },
            ].map((s, i) => (
              <div
                key={i}
                className={`rounded-lg px-2.5 py-2 cursor-default ${
                  s.active
                    ? 'border border-emerald-300/30 bg-emerald-500/10'
                    : 'border border-transparent'
                }`}
              >
                <p className={`text-xs font-medium ${s.active ? 'text-emerald-100' : 'text-slate-400'}`}>{s.name}</p>
                <p className="text-[10px] text-slate-500 mt-0.5">{s.agent}</p>
              </div>
            ))}
          </div>
        </div>

        {/* Chat */}
        <div className="flex flex-col p-4 gap-3">
          <div className="self-end max-w-[80%] rounded-2xl rounded-br-md border border-violet-300/25 bg-violet-500/15 px-3.5 py-2.5 text-sm text-violet-50">
            Build me JWT auth with refresh tokens.
          </div>
          <div className="max-w-[90%] rounded-2xl rounded-bl-md border border-emerald-300/15 bg-emerald-500/8 px-3.5 py-2.5 text-sm text-emerald-50">
            <p className="mb-2">Done. Here{`'`}s what I built:</p>
            <div className="rounded-lg border border-white/10 bg-black/25 p-2 text-xs text-slate-200 font-mono">
              <p className="text-slate-500">// auth/jwt.ts</p>
              <p><span className="text-violet-300">export</span> <span className="text-amber-300">generateTokenPair</span>(userId)</p>
              <p><span className="text-violet-300">export</span> <span className="text-amber-300">verifyRefreshToken</span>(token)</p>
              <p><span className="text-violet-300">export</span> <span className="text-amber-300">authMiddleware</span>(req, res, next)</p>
            </div>
            <p className="mt-2 text-xs text-emerald-200/70">3 files created · 4 tests passing</p>
          </div>
        </div>
      </div>
    </MockupWindow>
  );
}

/* ─── Agent Tools Feature Mockup ─── */
function AgentToolsMockup() {
  return (
    <MockupWindow title="Agent Tools">
      <div className="p-4 space-y-3">
        {[
          { name: 'Claude Code', vendor: 'Anthropic', status: 'installed', version: 'v2.1.61' },
          { name: 'Codex CLI', vendor: 'OpenAI', status: 'installed', version: 'v1.0.9' },
          { name: 'OpenClaw', vendor: 'OpenClaw', status: 'available', version: 'latest' },
        ].map((tool) => (
          <div key={tool.name} className="flex items-center justify-between rounded-xl border border-white/10 bg-white/[0.02] px-4 py-3">
            <div className="flex items-center gap-3">
              <div className={`w-9 h-9 rounded-xl flex items-center justify-center ${
                tool.status === 'installed' ? 'bg-emerald-500/15' : 'bg-slate-500/15'
              }`}>
                <Wrench size={16} className={tool.status === 'installed' ? 'text-emerald-300' : 'text-slate-400'} />
              </div>
              <div>
                <p className="text-sm font-medium text-white">{tool.name}</p>
                <p className="text-xs text-slate-500">{tool.vendor} · {tool.version}</p>
              </div>
            </div>
            {tool.status === 'installed' ? (
              <span className="rounded-full border border-emerald-300/25 bg-emerald-500/10 px-2.5 py-1 text-[10px] font-semibold uppercase tracking-wider text-emerald-200">
                Installed
              </span>
            ) : (
              <button className="rounded-lg border border-violet-300/25 bg-violet-500/15 px-3 py-1.5 text-xs font-semibold text-violet-200 hover:bg-violet-500/25 transition">
                Install
              </button>
            )}
          </div>
        ))}
      </div>
    </MockupWindow>
  );
}

/* ─── Setup Wizard Mockup ─── */
function SetupWizardMockup() {
  return (
    <MockupWindow title="Setup Wizard">
      <div className="p-5">
        {/* Progress bar */}
        <div className="flex items-center gap-2 mb-5">
          <div className="flex-1 h-1.5 bg-white/5 rounded-full overflow-hidden">
            <div className="h-full w-4/6 bg-gradient-to-r from-emerald-500 to-emerald-400 rounded-full" />
          </div>
          <span className="text-xs text-slate-400">Step 4 of 6</span>
        </div>

        <h4 className="text-base font-semibold text-white mb-1">Registration Mode</h4>
        <p className="text-xs text-slate-400 mb-4">Control who can create accounts on your portal.</p>

        <div className="space-y-2">
          {[
            { mode: 'Open', desc: 'Anyone can register', active: false },
            { mode: 'Approval', desc: 'Admin must approve new users', active: true },
            { mode: 'Closed', desc: 'Only admin can create accounts', active: false },
          ].map((opt) => (
            <div
              key={opt.mode}
              className={`flex items-center gap-3 rounded-xl border px-4 py-3 cursor-default ${
                opt.active
                  ? 'border-emerald-300/30 bg-emerald-500/10'
                  : 'border-white/10 bg-white/[0.02]'
              }`}
            >
              <div className={`w-4 h-4 rounded-full border-2 flex items-center justify-center ${
                opt.active ? 'border-emerald-400' : 'border-slate-600'
              }`}>
                {opt.active && <div className="w-2 h-2 rounded-full bg-emerald-400" />}
              </div>
              <div>
                <p className={`text-sm font-medium ${opt.active ? 'text-emerald-100' : 'text-slate-300'}`}>{opt.mode}</p>
                <p className="text-xs text-slate-500">{opt.desc}</p>
              </div>
            </div>
          ))}
        </div>

        <div className="mt-5 flex justify-end gap-2">
          <button className="rounded-lg border border-white/10 px-4 py-2 text-xs text-slate-300">Back</button>
          <button className="rounded-lg bg-emerald-500 px-4 py-2 text-xs font-semibold text-slate-950">Continue</button>
        </div>
      </div>
    </MockupWindow>
  );
}
