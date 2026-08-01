import { parseOpenClawAuthProbeResult } from '../services/openclawAuthProbe';

describe('OpenClaw exact auth-profile probe', () => {
  test('accepts only the exact live credential with an ok result', () => {
    expect(parseOpenClawAuthProbeResult({
      auth: {
        probes: {
          results: [
            { provider: 'xai', profileId: 'xai:old', status: 'ok', model: 'xai/grok-4.3' },
            { provider: 'xai', profileId: 'xai:portal-oauth-123', status: 'ok', model: 'xai/grok-4.3', latencyMs: 321 },
          ],
        },
      },
    }, 'xai', 'xai:portal-oauth-123')).toEqual({
      provider: 'xai',
      profileId: 'xai:portal-oauth-123',
      status: 'ok',
      model: 'xai/grok-4.3',
      latencyMs: 321,
    });
  });

  test('rejects transport success when the exact profile was not probed', () => {
    expect(() => parseOpenClawAuthProbeResult({
      auth: { probes: { results: [{ provider: 'xai', profileId: 'xai:old', status: 'ok' }] } },
    }, 'xai', 'xai:new')).toThrow('did not probe the exact');
  });

  test.each(['missing', 'expired', 'error', 'static'])('rejects exact profile status %s', (status) => {
    expect(() => parseOpenClawAuthProbeResult({
      auth: { probes: { results: [{ provider: 'xai', profileId: 'xai:new', status }] } },
    }, 'xai', 'xai:new')).toThrow(`(${status})`);
  });

  test('rejects a successful exact-profile probe when OpenClaw used a different model', () => {
    expect(() => parseOpenClawAuthProbeResult({
      auth: { probes: { results: [{ provider: 'xai', profileId: 'xai:new', status: 'ok', model: 'xai/grok-build-0.1' }] } },
    }, 'xai', 'xai:new', 'xai/grok-4.3')).toThrow('instead of the selected model');
  });

  test('surfaces the probe reason and actionable xAI entitlement guidance', () => {
    expect(() => parseOpenClawAuthProbeResult({
      auth: { probes: { results: [{ provider: 'xai', profileId: 'xai:new', status: 'error', error: 'HTTP 403 account not entitled' }] } },
    }, 'xai', 'xai:new')).toThrow(/account not entitled/);
    expect(() => parseOpenClawAuthProbeResult({
      auth: { probes: { results: [{ provider: 'xai', profileId: 'xai:new', status: 'error', error: 'HTTP 403 account not entitled' }] } },
    }, 'xai', 'xai:new')).toThrow(/SuperGrok or X Premium subscription is required/);
  });

  test('classifies xAI rate limiting distinctly from entitlement', () => {
    expect(() => parseOpenClawAuthProbeResult({
      auth: { probes: { results: [{ provider: 'xai', profileId: 'xai:new', status: 'error', message: 'rate limit exceeded (429)' }] } },
    }, 'xai', 'xai:new')).toThrow(/rate limiting the probe/);
  });
});
