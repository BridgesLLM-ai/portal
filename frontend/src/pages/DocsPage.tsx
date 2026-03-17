import { Link } from 'react-router-dom';

const resources = [
  {
    title: 'OpenClaw Documentation',
    href: 'https://docs.openclaw.ai',
    description: 'Core platform docs, configuration references, and operational guidance.',
  },
  {
    title: 'OpenClaw Source',
    href: 'https://github.com/openclaw/openclaw',
    description: 'Canonical source for architecture, route behavior, and implementation details.',
  },
  {
    title: 'OpenClaw Community',
    href: 'https://discord.com/invite/clawd',
    description: 'Community support, release chatter, and implementation discussion.',
  },
];

export default function DocsPage() {
  return (
    <div className="min-h-screen bg-slate-950 text-slate-100 px-6 py-16">
      <div className="mx-auto max-w-4xl">
        <div className="max-w-2xl">
          <p className="text-sm font-semibold uppercase tracking-[0.24em] text-emerald-400/80">Documentation</p>
          <h1 className="mt-3 text-4xl font-bold tracking-tight">Reference and operator resources</h1>
          <p className="mt-4 text-slate-300 text-lg">
            This portal route now serves as a practical documentation hub instead of a placeholder. Use it to jump directly to the real platform references.
          </p>
        </div>

        <div className="mt-10 grid gap-4 md:grid-cols-3">
          {resources.map((resource) => (
            <a
              key={resource.href}
              href={resource.href}
              target="_blank"
              rel="noopener noreferrer"
              className="rounded-2xl border border-white/10 bg-white/[0.03] p-5 transition-colors hover:border-emerald-400/40 hover:bg-white/[0.05]"
            >
              <h2 className="text-lg font-semibold text-white">{resource.title}</h2>
              <p className="mt-2 text-sm leading-6 text-slate-400">{resource.description}</p>
              <span className="mt-4 inline-flex text-sm font-medium text-emerald-300">Open resource →</span>
            </a>
          ))}
        </div>

        <div className="mt-10 flex flex-wrap gap-3">
          <Link
            to="/"
            className="inline-flex items-center justify-center rounded-xl px-5 py-3 font-semibold text-slate-900 bg-emerald-400 hover:bg-emerald-300 transition-colors"
          >
            Back to home
          </Link>
          <Link
            to="/dashboard"
            className="inline-flex items-center justify-center rounded-xl border border-white/10 px-5 py-3 font-semibold text-slate-100 hover:bg-white/[0.05] transition-colors"
          >
            Open dashboard
          </Link>
        </div>
      </div>
    </div>
  );
}
