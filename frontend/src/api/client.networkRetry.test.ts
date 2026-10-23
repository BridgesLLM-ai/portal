// @vitest-environment jsdom
import axios, {
  AxiosError,
  type AxiosAdapter,
  type AxiosResponse,
  type InternalAxiosRequestConfig,
} from 'axios';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useAuthStore } from '../contexts/AuthContext';
import { resetWorkspaceAuthorizationForTests } from '../utils/workspaceAuthorization';
import client from './client';

const originalAdapter = client.defaults.adapter;

function ok(config: InternalAxiosRequestConfig): AxiosResponse {
  return { data: { ok: true }, status: 200, statusText: 'OK', headers: {}, config };
}

describe('transient network retry', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    resetWorkspaceAuthorizationForTests();
    useAuthStore.setState({
      user: { id: 'user-1', email: 'user-1@example.com', username: 'user-1', role: 'OWNER' as const },
      isAuthenticated: true,
      sessionRestoreError: false,
    } as any);
    vi.spyOn(axios, 'post');
  });

  afterEach(() => {
    client.defaults.adapter = originalAdapter;
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it.each(['post', 'put', 'patch', 'delete'])(
    'does not replay a %s mutation after its response is lost',
    async (method) => {
      const adapter = vi.fn(async (config: InternalAxiosRequestConfig) => {
        throw new AxiosError('net::ERR_NETWORK_CHANGED', 'ERR_NETWORK', config);
      });
      client.defaults.adapter = adapter as AxiosAdapter;
      const request = client.request({
        method,
        url: '/projects/alpha/install-deps',
        data: { stateVersion: 1 },
        ...({ _silent: true } as any),
      }).catch((error) => error);
      await vi.advanceTimersByTimeAsync(5_000);
      expect((await request).code).toBe('ERR_NETWORK');
      expect(adapter).toHaveBeenCalledTimes(1);
      expect(axios.post).not.toHaveBeenCalled();
    },
  );

  it('still retries an idempotent GET after a transient network error', async () => {
    let calls = 0;
    const adapter = vi.fn(async (config: InternalAxiosRequestConfig) => {
      calls += 1;
      if (calls === 1) throw new AxiosError('net::ERR_NETWORK_CHANGED', 'ERR_NETWORK', config);
      return ok(config);
    });
    client.defaults.adapter = adapter as AxiosAdapter;
    const request = client.get('/projects', { ...({ _silent: true } as any) });
    await vi.advanceTimersByTimeAsync(5_000);
    await expect(request).resolves.toMatchObject({ status: 200 });
    expect(adapter).toHaveBeenCalledTimes(2);
  });

  it('honors an explicit opt-out for idempotent polling', async () => {
    const adapter = vi.fn(async (config: InternalAxiosRequestConfig) => {
      throw new AxiosError('net::ERR_NETWORK_CHANGED', 'ERR_NETWORK', config);
    });
    client.defaults.adapter = adapter as AxiosAdapter;
    const request = client.get('/projects', { ...({ _silent: true, _skipNetworkRetry: true } as any) })
      .catch((error) => error);
    await vi.advanceTimersByTimeAsync(5_000);
    expect((await request).code).toBe('ERR_NETWORK');
    expect(adapter).toHaveBeenCalledTimes(1);
  });
});
