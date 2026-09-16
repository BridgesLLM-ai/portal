import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ post: vi.fn() }));
vi.mock('./client', () => ({ default: { post: mocks.post } }));
import { gatewayAPI } from './endpoints';

describe('gatewayAPI.injectNote', () => {
  beforeEach(() => vi.clearAllMocks());

  it('uses the Portal broker contract and waits for acknowledgment without network retries', async () => {
    let acknowledge!: (value: unknown) => void;
    mocks.post.mockReturnValue(new Promise((resolve) => { acknowledge = resolve; }));
    const settled = vi.fn();
    const result = gatewayAPI.injectNote('agent:main:owned', 'synthetic note').then(settled);
    await Promise.resolve();
    expect(settled).not.toHaveBeenCalled();
    expect(mocks.post).toHaveBeenCalledWith('/gateway/chat/inject', {
      session: 'agent:main:owned', text: 'synthetic note',
    }, { _skipNetworkRetry: true });
    acknowledge({ data: { ok: true, sessionKey: 'agent:main:owned' } });
    await result;
    expect(settled).toHaveBeenCalledWith({ ok: true, sessionKey: 'agent:main:owned' });
  });

  it('propagates refusal instead of reporting a successful append', async () => {
    const error = new Error('Admin access required');
    mocks.post.mockRejectedValue(error);
    await expect(gatewayAPI.injectNote('foreign-session', 'note')).rejects.toBe(error);
    expect(mocks.post).toHaveBeenCalledTimes(1);
  });
});
