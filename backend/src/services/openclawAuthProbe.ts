import { execFileSync } from 'child_process';
import { buildOpenClawCliEnv, extractJsonFromCliOutput } from '../utils/openclawCli';

export interface OpenClawAuthProbeResult {
  provider: string;
  profileId: string;
  status: string;
  model: string | null;
  latencyMs: number | null;
}

function normalizeId(value: unknown, label: string): string {
  const normalized = String(value || '').trim();
  if (!normalized || normalized.length > 200 || !/^[A-Za-z0-9._:-]+$/.test(normalized)) {
    throw new Error(`Invalid OpenClaw ${label}.`);
  }
  return normalized;
}

export function parseOpenClawAuthProbeResult(
  payload: unknown,
  provider: string,
  profileId: string,
  expectedModel?: string,
): OpenClawAuthProbeResult {
  const parsed = typeof payload === 'string' ? JSON.parse(payload) : payload as any;
  const results = Array.isArray(parsed?.auth?.probes?.results) ? parsed.auth.probes.results : [];
  const exact = results.find((entry: any) => (
    String(entry?.provider || '').trim() === provider
    && String(entry?.profileId || '').trim() === profileId
  ));
  if (!exact) {
    throw new Error(`OpenClaw did not probe the exact ${provider} credential ${profileId}.`);
  }

  const status = String(exact.status || '').trim().toLowerCase();
  if (status !== 'ok') {
    const reason = String(
      exact.error || exact.message || exact.detail || exact.reason || '',
    ).replace(/\s+/g, ' ').trim().slice(0, 300);
    const normalizedReason = reason.toLowerCase();
    let guidance = '';
    if (provider === 'xai') {
      if (/entitle|not eligible|ineligible|subscription|forbidden|403|no access|unauthorized|401/.test(normalizedReason)
        || (!reason && (status === 'unauthorized' || status === 'forbidden'))) {
        guidance = ' This usually means the signed-in xAI account is not entitled to API model access — a SuperGrok or X Premium subscription is required for the OpenClaw xAI provider. Sign in with an entitled account, or use the xAI API-key path instead.';
      } else if (/rate.?limit|quota|429/.test(normalizedReason)) {
        guidance = ' xAI is rate limiting the probe; wait for its quota window and retry the sign-in.';
      } else if (/timeout|timed out|unreachable|econn|network/.test(normalizedReason) || status === 'timeout') {
        guidance = ' The probe could not reach xAI in time; check connectivity and retry.';
      }
    }
    const detail = reason ? `${status || 'error'}: ${reason}` : (status || 'unknown status');
    throw new Error(
      `OpenClaw could not verify the ${provider} credential ${profileId} with a live model probe (${detail}).${guidance}`,
    );
  }

  const probedModel = typeof exact.model === 'string' && exact.model.trim() ? exact.model.trim() : null;
  if (expectedModel && probedModel !== expectedModel) {
    throw new Error(`OpenClaw probed ${probedModel || 'an unknown model'} instead of the selected model ${expectedModel} with ${profileId}.`);
  }

  return {
    provider,
    profileId,
    status,
    model: probedModel,
    latencyMs: typeof exact.latencyMs === 'number' && Number.isFinite(exact.latencyMs) ? exact.latencyMs : null,
  };
}

export function probeOpenClawAuthProfile(
  providerInput: string,
  profileIdInput: string,
  probeTimeoutMs = 20_000,
  expectedModel?: string,
): OpenClawAuthProbeResult {
  const provider = normalizeId(providerInput, 'provider id');
  const profileId = normalizeId(profileIdInput, 'profile id');
  const boundedProbeTimeout = Math.min(Math.max(Math.floor(probeTimeoutMs), 5_000), 60_000);
  const raw = execFileSync('openclaw', [
    'models',
    'status',
    '--agent',
    'main',
    '--probe',
    '--probe-provider',
    provider,
    '--probe-profile',
    profileId,
    '--probe-timeout',
    String(boundedProbeTimeout),
    '--probe-max-tokens',
    '8',
    '--json',
  ], {
    encoding: 'utf8',
    env: buildOpenClawCliEnv(),
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: boundedProbeTimeout + 15_000,
    maxBuffer: 1024 * 1024 * 16,
  });

  return parseOpenClawAuthProbeResult(extractJsonFromCliOutput(raw), provider, profileId, expectedModel);
}
