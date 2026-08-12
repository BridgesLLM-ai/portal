// @vitest-environment jsdom
import axios, {
  AxiosError,
  type AxiosAdapter,
  type AxiosResponse,
  type InternalAxiosRequestConfig,
} from 'axios';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useAuthStore } from '../contexts/AuthContext';
import {
  PORTAL_AUTHORIZATION_VERSION_HEADER,
  StaleWorkspaceAuthorizationResponseError,
  resetWorkspaceAuthorizationForTests,
} from '../utils/workspaceAuthorization';
import {
  AUTH_REFRESH_CONFLICT_MAX_WAIT_MS,
  publishAuthRefreshSuccess,
} from '../utils/authRefreshConvergence';
import client from './client';

const originalAdapter = client.defaults.adapter;

function actor(id: string, authorizationVersion: number) {
  return {
    id,
    email: `${id}@example.com`,
    username: id,
    role: 'SUB_ADMIN' as const,
    authorizationVersion,
  };
}

function axiosResponse(
  config: InternalAxiosRequestConfig,
  authorizationVersion: number,
): AxiosResponse {
  return {
    data: { ok: true },
    status: 200,
    statusText: 'OK',
    headers: {
      [PORTAL_AUTHORIZATION_VERSION_HEADER.toLowerCase()]: String(authorizationVersion),
    },
    config,
  };
}

describe('Axios workspace authorization request identity', () => {
  beforeEach(() => {
    resetWorkspaceAuthorizationForTests();
    useAuthStore.setState({
      user: actor('user-1', 3),
      isAuthenticated: true,
      sessionRestoreError: false,
    });
  });

  afterEach(() => {
    client.defaults.adapter = originalAdapter;
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it('stamps the actor generation on workspace requests', async () => {
    const adapter = vi.fn(async (config: InternalAxiosRequestConfig) => (
      axiosResponse(config, 3)
    ));
    client.defaults.adapter = adapter as AxiosAdapter;

    await expect(client.get('/files')).resolves.toMatchObject({ data: { ok: true } });

    const config = adapter.mock.calls[0][0];
    expect(config.headers.get(PORTAL_AUTHORIZATION_VERSION_HEADER)).toBe('3');
  });

  it('rejects a response whose original actor is no longer signed in', async () => {
    let settle!: (response: AxiosResponse) => void;
    const adapter = vi.fn((config: InternalAxiosRequestConfig) => (
      new Promise<AxiosResponse>((resolve) => {
        settle = (response) => resolve({ ...response, config });
      })
    ));
    client.defaults.adapter = adapter as AxiosAdapter;
    const request = client.get('/files');
    await vi.waitFor(() => expect(adapter).toHaveBeenCalledTimes(1));

    useAuthStore.setState({ user: actor('user-2', 1) });
    settle(axiosResponse(adapter.mock.calls[0][0], 3));

    await expect(request).rejects.toBeInstanceOf(StaleWorkspaceAuthorizationResponseError);
  });

  it('does not replay a 401 request under a different user after refresh settles', async () => {
    let settleRefresh!: () => void;
    const refresh = new Promise<void>((resolve) => {
      settleRefresh = resolve;
    });
    vi.spyOn(axios, 'post').mockImplementation(async () => {
      await refresh;
      return {} as AxiosResponse;
    });
    const adapter = vi.fn(async (config: InternalAxiosRequestConfig) => {
      throw new AxiosError(
        'Unauthorized',
        'ERR_BAD_REQUEST',
        config,
        undefined,
        {
          data: { error: 'expired' },
          status: 401,
          statusText: 'Unauthorized',
          headers: {
            [PORTAL_AUTHORIZATION_VERSION_HEADER.toLowerCase()]: '3',
          },
          config,
        },
      );
    });
    client.defaults.adapter = adapter as AxiosAdapter;

    const request = client.post('/files/mutate', { value: 'user-1 payload' });
    const rejected = expect(request).rejects.toBeInstanceOf(
      StaleWorkspaceAuthorizationResponseError,
    );
    await vi.waitFor(() => expect(axios.post).toHaveBeenCalledTimes(1));
    useAuthStore.setState({ user: actor('user-2', 1), isAuthenticated: true });
    settleRefresh();

    await rejected;
    expect(adapter).toHaveBeenCalledTimes(1);
  });

  it('does not replay a network retry under a different signed-in actor', async () => {
    vi.useFakeTimers();
    const adapter = vi.fn(async (config: InternalAxiosRequestConfig) => {
      throw new AxiosError('Network unavailable', 'ERR_NETWORK', config);
    });
    client.defaults.adapter = adapter as AxiosAdapter;

    const request = client.post('/files/mutate', { value: 'user-1 payload' });
    const rejected = expect(request).rejects.toBeInstanceOf(
      StaleWorkspaceAuthorizationResponseError,
    );
    await vi.waitFor(() => expect(adapter).toHaveBeenCalledTimes(1));
    useAuthStore.setState({ user: actor('user-2', 1), isAuthenticated: true });
    await vi.advanceTimersByTimeAsync(500);

    await rejected;
    expect(adapter).toHaveBeenCalledTimes(1);
  });

  it('clears a falsely persisted login when the refresh cookie is missing', async () => {
    vi.spyOn(axios, 'post').mockRejectedValue(new AxiosError(
      'Refresh token required',
      'ERR_BAD_REQUEST',
      undefined,
      undefined,
      {
        data: { error: 'Refresh token required' },
        status: 401,
        statusText: 'Unauthorized',
        headers: {},
        config: {} as InternalAxiosRequestConfig,
      },
    ));
    client.defaults.adapter = vi.fn(async (config: InternalAxiosRequestConfig) => {
      throw new AxiosError(
        'Access token required',
        'ERR_BAD_REQUEST',
        config,
        undefined,
        {
          data: { error: 'Access token required' },
          status: 401,
          statusText: 'Unauthorized',
          headers: {
            [PORTAL_AUTHORIZATION_VERSION_HEADER.toLowerCase()]: '3',
          },
          config,
        },
      );
    }) as AxiosAdapter;

    await expect(client.get('/gateway/sessions')).rejects.toMatchObject({
      response: { status: 401 },
    });

    expect(useAuthStore.getState().isAuthenticated).toBe(false);
    expect(useAuthStore.getState().user).toBeNull();
  });

  it('waits once for a rotation winner and then replays the original request', async () => {
    vi.spyOn(axios, 'post')
      .mockRejectedValueOnce(new AxiosError(
        'Refresh rotation conflict',
        'ERR_BAD_REQUEST',
        undefined,
        undefined,
        {
          data: { code: 'AUTH_REFRESH_ROTATION_CONFLICT', retryable: true },
          status: 409,
          statusText: 'Conflict',
          headers: { 'retry-after': '0.1' },
          config: {} as InternalAxiosRequestConfig,
        },
      ))
      .mockResolvedValueOnce({} as AxiosResponse);
    let requestCount = 0;
    client.defaults.adapter = vi.fn(async (config: InternalAxiosRequestConfig) => {
      requestCount += 1;
      if (requestCount === 1) {
        throw new AxiosError(
          'Access token expired',
          'ERR_BAD_REQUEST',
          config,
          undefined,
          {
            data: { error: 'expired' },
            status: 401,
            statusText: 'Unauthorized',
            headers: {
              [PORTAL_AUTHORIZATION_VERSION_HEADER.toLowerCase()]: '3',
            },
            config,
          },
        );
      }
      return axiosResponse(config, 3);
    }) as AxiosAdapter;

    const request = client.get('/files');
    await vi.waitFor(() => expect(axios.post).toHaveBeenCalledTimes(1));
    publishAuthRefreshSuccess();

    await expect(request).resolves.toMatchObject({ data: { ok: true } });
    expect(axios.post).toHaveBeenCalledTimes(2);
    expect(requestCount).toBe(2);
    expect(useAuthStore.getState().isAuthenticated).toBe(true);
  });

  it('clears local auth after the bounded rotation retry also conflicts', async () => {
    vi.useFakeTimers();
    vi.spyOn(axios, 'post').mockRejectedValue(new AxiosError(
      'Refresh rotation conflict',
      'ERR_BAD_REQUEST',
      undefined,
      undefined,
      {
        data: { code: 'AUTH_REFRESH_ROTATION_CONFLICT', retryable: true },
        status: 409,
        statusText: 'Conflict',
        headers: { 'retry-after': '5' },
        config: {} as InternalAxiosRequestConfig,
      },
    ));
    client.defaults.adapter = vi.fn(async (config: InternalAxiosRequestConfig) => {
      throw new AxiosError(
        'Access token expired',
        'ERR_BAD_REQUEST',
        config,
        undefined,
        {
          data: { error: 'expired' },
          status: 401,
          statusText: 'Unauthorized',
          headers: {
            [PORTAL_AUTHORIZATION_VERSION_HEADER.toLowerCase()]: '3',
          },
          config,
        },
      );
    }) as AxiosAdapter;

    const request = client.get('/files');
    const rejected = expect(request).rejects.toMatchObject({
      response: { status: 401 },
    });
    await vi.advanceTimersByTimeAsync(0);
    expect(axios.post).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(AUTH_REFRESH_CONFLICT_MAX_WAIT_MS);

    await rejected;
    expect(axios.post).toHaveBeenCalledTimes(2);
    expect(useAuthStore.getState()).toMatchObject({
      user: null,
      isAuthenticated: false,
    });
  });

  it('does not create a critical activity error for a silent expected-failure probe', async () => {
    const adapter = vi.fn(async (config: InternalAxiosRequestConfig) => {
      throw new AxiosError(
        'Agent Zero is not connected',
        'ERR_BAD_RESPONSE',
        config,
        undefined,
        {
          data: { error: 'Agent Zero is not connected' },
          status: 503,
          statusText: 'Service Unavailable',
          headers: {
            [PORTAL_AUTHORIZATION_VERSION_HEADER.toLowerCase()]: '3',
          },
          config,
        },
      );
    });
    client.defaults.adapter = adapter as AxiosAdapter;

    await expect(client.get(
      '/projects/alpha/chat/providers/agent-zero/models',
      { _silent: true, _skipNetworkRetry: true } as any,
    )).rejects.toMatchObject({ response: { status: 503 } });

    expect(adapter).toHaveBeenCalledTimes(1);
    expect(adapter.mock.calls.some(
      ([config]) => String(config.url).includes('/activity/report-error'),
    )).toBe(false);
  });
});
