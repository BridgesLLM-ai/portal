import { coverageStateClass, type CoverageSignal, type ProviderCoverage } from './providerCoverage';

interface ProviderCoverageChipsProps {
  coverage: ProviderCoverage;
  /** Render the detail sentences under the chips. */
  showDetails?: boolean;
  compact?: boolean;
}

function Chip({ heading, signal, compact }: { heading: string; signal: CoverageSignal; compact: boolean }) {
  return (
    <span
      className={`inline-flex items-center gap-1 rounded-full border ${compact ? 'px-1.5 py-0.5 text-[10px]' : 'px-2 py-0.5 text-[11px]'} font-medium ${coverageStateClass(signal.state)}`}
      data-coverage-state={signal.state}
    >
      <span className="opacity-70">{heading}:</span>
      <span>{signal.label}</span>
    </span>
  );
}

/**
 * The three facts every provider surface must keep apart: where the login
 * lives, whether OpenClaw registered a runtime profile for it, and whether the
 * Portal-native harness can use it.
 */
export default function ProviderCoverageChips({ coverage, showDetails = false, compact = false }: ProviderCoverageChipsProps) {
  const loginHeading = coverage.loginSurface === 'shared-native'
    ? 'Shared login'
    : coverage.loginSurface === 'portal-native'
      ? 'Portal login'
      : 'Login';
  const details = [
    coverage.login.detail ? `Login: ${coverage.login.detail}` : null,
    coverage.openclawRuntime.detail ? `OpenClaw: ${coverage.openclawRuntime.detail}` : null,
    coverage.harness?.detail ? `${coverage.harness.name}: ${coverage.harness.detail}` : null,
  ].filter((detail): detail is string => Boolean(detail));

  return (
    <div className="space-y-1" data-testid={`provider-coverage-${coverage.providerId}`}>
      <div className="flex flex-wrap items-center gap-1.5">
        <Chip heading={loginHeading} signal={coverage.login} compact={compact} />
        <Chip heading="OpenClaw" signal={coverage.openclawRuntime} compact={compact} />
        {coverage.harness ? (
          <Chip heading={`${coverage.harness.name} harness`} signal={coverage.harness} compact={compact} />
        ) : null}
      </div>
      {showDetails && details.length ? (
        <ul className={`space-y-0.5 ${compact ? 'text-[10px]' : 'text-[11px]'} leading-relaxed text-slate-400`}>
          {details.map((detail) => <li key={detail}>{detail}</li>)}
        </ul>
      ) : null}
    </div>
  );
}
