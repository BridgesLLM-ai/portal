import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  get: vi.fn(),
  post: vi.fn(),
}));

vi.mock('./client', () => ({
  default: {
    get: mocks.get,
    post: mocks.post,
  },
}));

import { gatewayAPI } from './endpoints';

describe('gatewayAPI.patchSessionModel', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.get.mockResolvedValue({ data: { provider: 'AGENT_ZERO', models: [] } });
    mocks.post.mockResolvedValue({ data: { ok: true } });
  });

  it('uses the explicit reset contract for an empty model', async () => {
    await gatewayAPI.patchSessionModel('native-session-1', '   ', 'CODEX');

    expect(mocks.post).toHaveBeenCalledWith('/gateway/session-model', {
      session: 'native-session-1',
      provider: 'CODEX',
      reset: true,
    });
    expect(mocks.post.mock.calls[0]?.[1]).not.toHaveProperty('model');
  });

  it('sends only the normalized model field for an explicit selection', async () => {
    await gatewayAPI.patchSessionModel('agent:main:main', '  openai/gpt-5.5  ', 'OPENCLAW');

    expect(mocks.post).toHaveBeenCalledWith('/gateway/session-model', {
      session: 'agent:main:main',
      provider: 'OPENCLAW',
      model: 'openai/gpt-5.5',
    });
    expect(mocks.post.mock.calls[0]?.[1]).not.toHaveProperty('reset');
  });

  it('bounds Agent Zero model switches and disables generic network retries', async () => {
    await gatewayAPI.patchSessionModel(
      'agent_zero-user-1',
      'codex_oauth/gpt-5.6-terra',
      'AGENT_ZERO',
    );

    expect(mocks.post).toHaveBeenCalledWith(
      '/gateway/session-model',
      {
        session: 'agent_zero-user-1',
        provider: 'AGENT_ZERO',
        model: 'codex_oauth/gpt-5.6-terra',
      },
      expect.objectContaining({
        timeout: expect.any(Number),
        _skipNetworkRetry: true,
      }),
    );
  });

  it('bounds the Agent Zero readiness catalog without changing other providers', async () => {
    await gatewayAPI.models('AGENT_ZERO');
    expect(mocks.get).toHaveBeenLastCalledWith(
      '/gateway/models',
      expect.objectContaining({
        params: { provider: 'AGENT_ZERO' },
        timeout: expect.any(Number),
        _skipNetworkRetry: true,
      }),
    );

    await gatewayAPI.models('CODEX');
    expect(mocks.get).toHaveBeenLastCalledWith('/gateway/models', {
      params: { provider: 'CODEX' },
    });
  });
});
