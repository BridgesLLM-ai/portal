export interface SetupAiRuntimeStatus {
  ready?: boolean;
}

export interface SetupNavigationState {
  step: number;
  quickSetup: boolean;
}

export const SETUP_SESSION_STORAGE_KEY = 'bridgesllm.setup.session.v1';

export type SetupBrowserTransport = 'https' | 'loopback' | 'blocked';

export function getSetupBrowserTransport(protocol: string, hostname: string): SetupBrowserTransport {
  const normalizedProtocol = protocol.trim().toLowerCase().replace(/:$/, '');
  const normalizedHost = hostname.trim().toLowerCase().replace(/^\[|\]$/g, '');
  if (normalizedProtocol === 'https') return 'https';
  if (
    normalizedProtocol === 'http'
    && (normalizedHost === 'localhost' || normalizedHost === '127.0.0.1' || normalizedHost === '::1')
  ) {
    return 'loopback';
  }
  return 'blocked';
}

export type SetupFragmentCredential = {
  kind: 'bootstrap' | 'handoff';
  value: string;
};

export function readSetupFragmentCredential(hash: string): SetupFragmentCredential | null {
  if (!hash.startsWith('#')) return null;
  const params = new URLSearchParams(hash.replace(/^#/, ''));
  for (const kind of ['handoff', 'bootstrap'] as const) {
    const value = String(params.get(kind) || '').trim();
    if (/^[A-Za-z0-9_-]{32,512}$/.test(value)) return { kind, value };
  }
  return null;
}

/** Remove all bootstrap material while preserving only non-secret navigation. */
export function scrubSetupSecretsFromUrl(urlValue: string): string {
  const url = new URL(urlValue);
  url.searchParams.delete('token');
  url.searchParams.delete('setupToken');
  const fragment = new URLSearchParams(url.hash.replace(/^#/, ''));
  fragment.delete('bootstrap');
  fragment.delete('handoff');
  url.hash = fragment.toString();
  return url.toString();
}

export function buildSetupHttpsHandoffUrl(options: {
  targetUrl: string;
  handoffToken: string;
  navigation: SetupNavigationState;
}): string {
  if (!/^[A-Za-z0-9_-]{32,512}$/.test(options.handoffToken)) {
    throw new Error('HTTPS setup handoff is invalid.');
  }
  const target = new URL('/setup', options.targetUrl);
  if (target.protocol !== 'https:') throw new Error('HTTPS setup handoff requires an HTTPS target.');
  target.searchParams.set('step', String(options.navigation.step));
  if (options.navigation.quickSetup) target.searchParams.set('mode', 'quick');
  target.hash = new URLSearchParams({ handoff: options.handoffToken }).toString();
  return target.toString();
}

export function getSetupNavigationState(search: string, maximumStep: number): SetupNavigationState {
  const params = new URLSearchParams(search);
  const parsedStep = Number.parseInt(params.get('step') || '0', 10);
  const step = Number.isFinite(parsedStep) && parsedStep >= 0 && parsedStep <= maximumStep ? parsedStep : 0;
  const quickSetup = params.get('mode') === 'quick' && step === 2;
  return { step, quickSetup };
}

export function getPreviousSetupStep(options: SetupNavigationState): SetupNavigationState {
  if (options.quickSetup) return { step: 0, quickSetup: false };
  return { step: Math.max(0, options.step - 1), quickSetup: false };
}

export function isSetupAiRuntimeReady(status: SetupAiRuntimeStatus | null | undefined): boolean {
  return status?.ready === true;
}

export function getPostSetupDestination(options: {
  quickSetup: boolean;
  aiRuntimeReady: boolean;
  tailnetRequested?: boolean;
}): string {
  if (options.tailnetRequested) {
    return '/settings?tab=ai-providers&setup=complete&ollama=tailnet';
  }
  return options.quickSetup || !options.aiRuntimeReady
    ? '/settings?tab=ai-providers&setup=complete'
    : '/dashboard';
}

export const SETUP_LOGO_MAX_BYTES = 5 * 1024 * 1024;
export const SETUP_LOGO_MIME_TYPES = ['image/png', 'image/jpeg', 'image/webp', 'image/gif'] as const;

export function getSetupLogoValidationError(file: { type: string; size: number }): string | null {
  if (!(SETUP_LOGO_MIME_TYPES as readonly string[]).includes(file.type)) {
    return 'Use a PNG, JPEG, WebP, or GIF raster image. SVG is not supported.';
  }
  if (!Number.isFinite(file.size) || file.size <= 0) return 'The selected logo is empty.';
  if (file.size > SETUP_LOGO_MAX_BYTES) return 'Logo files must be 5 MB or smaller.';
  return null;
}
