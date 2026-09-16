import type { ProviderStatus } from './ProviderCard';
import type { ProviderAuthType, ProviderUIConfig } from './providerConfig';

/**
 * Provider coverage model.
 *
 * Every setup surface (Quick Start cards, the OpenClaw provider picker, the
 * post-login activation step) reads the same derivation so the UI never
 * confuses three different facts:
 *
 *   1. login      — does a credential exist, and where does it live
 *   2. OpenClaw   — has OpenClaw registered a runtime profile for it
 *   3. harness    — can the Portal-native Agent Chat harness use it
 *
 * All three come from the server (`/catalog` + `/status`). Nothing here is
 * inferred from static presets.
 */

export const SUBSCRIPTION_AUTH_TYPES: ReadonlySet<ProviderAuthType> = new Set<ProviderAuthType>([
  'oauth',
  'setup_token',
  'device_code',
  'native_cli',
]);

export interface HarnessLink {
  harness: string;
  name: string;
  /**
   * `shared`: the harness login is the same credential OpenClaw's runtime reads
   * on this server (verified for Claude: Portal and the gateway resolve the same
   * Claude credential store).
   * `harness-only`: the harness keeps its own login; OpenClaw needs its own.
   */
  login: 'shared' | 'harness-only';
}

export const HARNESS_BY_PROVIDER: Readonly<Record<string, HarnessLink>> = {
  anthropic: { harness: 'CLAUDE_CODE', name: 'Claude Code', login: 'shared' },
  'openai-codex': { harness: 'CODEX', name: 'Codex', login: 'harness-only' },
  xai: { harness: 'GROK', name: 'Grok Build', login: 'harness-only' },
  'google-antigravity': { harness: 'GEMINI', name: 'Google Antigravity', login: 'harness-only' },
  'portal-hermes': { harness: 'HERMES', name: 'Hermes', login: 'harness-only' },
  'portal-opencode': { harness: 'OPENCODE', name: 'OpenCode', login: 'harness-only' },
};

/** Providers that never register an OpenClaw runtime profile. */
export const PORTAL_NATIVE_ONLY_PROVIDERS: ReadonlySet<string> = new Set([
  'google-antigravity',
  'portal-hermes',
  'portal-opencode',
]);

export type CoverageState = 'ready' | 'needs_login' | 'needs_setup' | 'attention' | 'unavailable' | 'unknown';

export interface CoverageSignal {
  state: CoverageState;
  label: string;
  detail: string | null;
}

export type LoginSurface = 'openclaw' | 'shared-native' | 'portal-native';

export interface ProviderCoverage {
  providerId: string;
  /** Subscription-style sign-in (OAuth, setup-token, device code, native CLI). */
  subscription: boolean;
  /** Portal can run a guided setup flow for this provider right now. */
  guided: boolean;
  manualReason: string | null;
  loginSurface: LoginSurface;
  login: CoverageSignal;
  openclawRuntime: CoverageSignal;
  harness: (CoverageSignal & HarnessLink) | null;
  /**
   * A completed login should continue into OpenClaw model discovery and the
   * explicit default-model choice. False for Portal-native-only harnesses.
   */
  activatesOpenClaw: boolean;
}

export function isSubscriptionProvider(provider: ProviderUIConfig): boolean {
  if (SUBSCRIPTION_AUTH_TYPES.has(provider.primaryAuthType)) return true;
  return Boolean(provider.authOptions?.some((option) => SUBSCRIPTION_AUTH_TYPES.has(option.type)));
}

export function getLoginSurface(providerId: string): LoginSurface {
  if (PORTAL_NATIVE_ONLY_PROVIDERS.has(providerId)) return 'portal-native';
  if (HARNESS_BY_PROVIDER[providerId]?.login === 'shared') return 'shared-native';
  return 'openclaw';
}

export function getSharedLoginNote(providerId: string): string | null {
  if (HARNESS_BY_PROVIDER[providerId]?.login !== 'shared') return null;
  return 'One login, two runtimes: OpenClaw\'s Claude CLI runtime and Portal Claude Code sessions read the same Claude credential store on this server. Signing in is not the same as OpenClaw having a registered provider profile; the OpenClaw column below reports that separately.';
}

function describeHarnessLogin(status: ProviderStatus | null | undefined): CoverageSignal {
  switch (status?.nativeCliAuthStatus) {
    case 'authenticated':
      return { state: 'ready', label: 'Signed in', detail: status?.nativeCliAuthMessage || null };
    case 'needs_login':
      return { state: 'needs_login', label: 'Needs login', detail: status?.nativeCliAuthMessage || null };
    case 'unknown':
      return { state: 'unknown', label: 'Login not verified', detail: status?.nativeCliAuthMessage || null };
    case 'not_applicable':
      return { state: 'unavailable', label: 'No separate login', detail: status?.nativeCliAuthMessage || null };
    default:
      return { state: 'unknown', label: 'Not reported', detail: null };
  }
}

function describeOpenClawCredential(status: ProviderStatus | null | undefined): CoverageSignal {
  switch (status?.status) {
    case 'configured':
      return { state: 'ready', label: 'Credential saved', detail: status.warning || null };
    case 'expired':
      return { state: 'attention', label: 'Expired', detail: status.error || null };
    case 'cooldown':
      return { state: 'attention', label: 'Cooling down', detail: status.error || null };
    case 'error':
      return { state: 'attention', label: 'Needs attention', detail: status.error || null };
    case 'manual':
      return { state: 'unavailable', label: 'Manual configuration', detail: status.error || null };
    case 'unconfigured':
      return { state: 'needs_login', label: 'Not signed in', detail: null };
    default:
      return { state: 'unknown', label: 'Not reported', detail: null };
  }
}

export function describeOpenClawRuntime(
  providerId: string,
  status: ProviderStatus | null | undefined,
  login: CoverageSignal,
): CoverageSignal {
  if (PORTAL_NATIVE_ONLY_PROVIDERS.has(providerId)) {
    return { state: 'unavailable', label: 'Not an OpenClaw runtime', detail: 'This harness runs in Portal\'s own profile and never registers an OpenClaw provider or default model.' };
  }
  if (!status) return { state: 'unknown', label: 'Not reported', detail: null };
  const readiness = status.readiness;
  switch (status.status) {
    case 'configured': {
      if (readiness && readiness.state !== 'ready') {
        return {
          state: readiness.state === 'needs_setup' ? 'needs_setup' : 'attention',
          label: readiness.state === 'needs_setup' ? 'Needs setup' : 'Readiness check failed',
          detail: readiness.message,
        };
      }
      return {
        state: 'ready',
        label: status.currentModel ? `Registered · ${status.currentModel}` : 'Registered',
        detail: status.warning || readiness?.message || null,
      };
    }
    case 'expired':
      return { state: 'attention', label: 'Expired', detail: status.error || null };
    case 'cooldown':
      return { state: 'attention', label: 'Cooling down', detail: status.error || null };
    case 'error':
      return { state: 'attention', label: 'Needs attention', detail: status.error || null };
    case 'manual':
      return { state: 'unavailable', label: 'Manual configuration', detail: status.error || null };
    case 'unconfigured':
      return login.state === 'ready'
        ? { state: 'needs_setup', label: 'Not registered', detail: 'Signed in, but OpenClaw has not registered this login as a provider profile yet. Continue to model discovery to register it and choose a model.' }
        : { state: 'needs_setup', label: 'Not registered', detail: null };
    default:
      return { state: 'unknown', label: 'Not reported', detail: null };
  }
}

export function deriveProviderCoverage(
  provider: ProviderUIConfig,
  status: ProviderStatus | null | undefined,
): ProviderCoverage {
  const loginSurface = getLoginSurface(provider.id);
  const harnessLink = HARNESS_BY_PROVIDER[provider.id] || null;
  const login = loginSurface === 'openclaw'
    ? describeOpenClawCredential(status)
    : describeHarnessLogin(status);
  const openclawRuntime = describeOpenClawRuntime(provider.id, status, login);
  const harness = harnessLink
    ? { ...harnessLink, ...describeHarnessLogin(status) }
    : null;
  return {
    providerId: provider.id,
    subscription: isSubscriptionProvider(provider),
    guided: provider.guidedSetup.status === 'available',
    manualReason: provider.guidedSetup.status === 'manual' ? provider.guidedSetup.reason : null,
    loginSurface,
    login,
    openclawRuntime,
    harness,
    activatesOpenClaw: !PORTAL_NATIVE_ONLY_PROVIDERS.has(provider.id),
  };
}

export function buildProviderCoverageMap(
  providers: readonly ProviderUIConfig[],
  statusMap: ReadonlyMap<string, ProviderStatus>,
): Map<string, ProviderCoverage> {
  return new Map(providers.map((provider) => [provider.id, deriveProviderCoverage(provider, statusMap.get(provider.id))]));
}

export function coverageStateClass(state: CoverageState): string {
  switch (state) {
    case 'ready':
      return 'border-emerald-500/30 bg-emerald-500/10 text-emerald-200';
    case 'needs_login':
    case 'needs_setup':
      return 'border-amber-500/30 bg-amber-500/10 text-amber-200';
    case 'attention':
      return 'border-red-500/30 bg-red-500/10 text-red-200';
    case 'unavailable':
      return 'border-slate-700 bg-slate-800/70 text-slate-400';
    default:
      return 'border-slate-700 bg-slate-800/70 text-slate-300';
  }
}
