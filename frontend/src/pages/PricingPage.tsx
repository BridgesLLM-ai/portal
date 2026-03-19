import { Link } from 'react-router-dom';

const tiers = [
  {
    name: 'Free',
    price: '$0',
    subtitle: 'Self-hosted',
    features: ['Unlimited agents', 'All core features', 'Run on your own infrastructure'],
    cta: { label: 'Start Free', to: '/setup' },
    highlight: true,
  },
  {
    name: 'Setup Service',
    price: '$X',
    subtitle: 'One-time',
    features: ['We install and configure everything', 'Domain + SSL setup', 'Production-ready handoff'],
    cta: { label: 'Contact Support', href: 'mailto:support@bridgesllm.ai' },
  },
  {
    name: 'Pro',
    price: 'Coming Soon',
    subtitle: 'Future',
    features: ['Team collaboration features', 'Priority support', 'Advanced org controls'],
    cta: { label: 'View Docs', to: '/docs' },
  },
];

export default function PricingPage() {
  return (
    <div
      className="min-h-dvh text-slate-100"
      style={{ background: 'radial-gradient(1100px 650px at 20% 0%, rgba(16,185,129,0.15), transparent 55%), linear-gradient(160deg, #05070f 0%, #0b1220 45%, #080d18 100%)' }}
    >
      <div className="mx-auto w-full max-w-6xl px-6 py-14 sm:py-20">
        <div className="text-center max-w-3xl mx-auto">
          <p className="text-emerald-400/90 text-sm uppercase tracking-[0.2em] mb-3">Pricing</p>
          <h1 className="text-4xl sm:text-5xl font-bold tracking-tight">Simple pricing. No surprises.</h1>
          <p className="mt-5 text-slate-300">Start free by self-hosting. Or let us do the setup for you.</p>
        </div>

        <div className="mt-12 grid grid-cols-1 md:grid-cols-3 gap-5">
          {tiers.map((tier) => (
            <article
              key={tier.name}
              className={`rounded-2xl border p-6 bg-slate-900/55 ${tier.highlight ? 'border-emerald-500/40' : 'border-slate-800'}`}
            >
              <h2 className="text-xl font-semibold">{tier.name}</h2>
              <p className="text-slate-400 text-sm mt-1">{tier.subtitle}</p>
              <p className="text-3xl font-bold mt-4">{tier.price}</p>
              <ul className="mt-5 space-y-2 text-sm text-slate-300">
                {tier.features.map((f) => <li key={f}>• {f}</li>)}
              </ul>
              <div className="mt-6">
                {'to' in tier.cta ? (
                  <Link to={tier.cta.to!} className="inline-flex rounded-xl px-4 py-2.5 font-semibold bg-emerald-400 text-slate-900 hover:bg-emerald-300 transition-colors">{tier.cta.label}</Link>
                ) : (
                  <a href={tier.cta.href!} className="inline-flex rounded-xl px-4 py-2.5 font-semibold border border-slate-700 hover:bg-slate-800/70 transition-colors">{tier.cta.label}</a>
                )}
              </div>
            </article>
          ))}
        </div>
      </div>
    </div>
  );
}
