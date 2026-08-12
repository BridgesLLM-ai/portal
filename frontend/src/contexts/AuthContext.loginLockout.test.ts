// @vitest-environment jsdom
import '../test/setup';
import axios, {
  AxiosError,
  type AxiosAdapter,
  type InternalAxiosRequestConfig,
} from 'axios';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import client from '../api/client';
import { publishAuthRefreshSuccess } from '../utils/authRefreshConvergence';
import { useAuthStore } from './AuthContext';

const originalAdapter = client.defaults.adapter;

function unauthorized(
  config: InternalAxiosRequestConfig,
  message: string,
): AxiosError {
  return new AxiosError(
    message,
    'ERR_BAD_REQUEST',
    config,
    undefined,
    {
      data: { error: message },
      status: 401,
      statusText: 'Unauthorized',
      headers: {},
      config,
    },
  );
}

describe('first-visit session restoration', () => {
  beforeEach(() => {
    localStorage.clear();
    sessionStorage.clear();
    useAuthStore.getState().silentLogout();
    useAuthStore.setState({
      user: null,
      isAuthenticated: false,
      isLoading: false,
      error: null,
      sessionRestoreError: false,
      sessionRestoreRetryable: false,
      lastSessionRestoreAt: null,
    });
  });

  afterEach(() => {
    client.defaults.adapter = originalAdapter;
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it('releases the login form when its own missing-session recovery invalidates the restore', async () => {
    const meAdapter = vi.fn(async (config: InternalAxiosRequestConfig) => {
      expect(config.url).toBe('/auth/me');
      throw unauthorized(config, 'Access token required');
    });
    client.defaults.adapter = meAdapter as AxiosAdapter;

    vi.spyOn(axios, 'post').mockRejectedValueOnce(unauthorized(
      {
        headers: {},
        method: 'post',
        url: '/api/auth/refresh',
      } as InternalAxiosRequestConfig,
      'Refresh token required',
    ));

    await expect(useAuthStore.getState().restoreSession()).resolves.toBe(false);

    expect(meAdapter).toHaveBeenCalledTimes(1);
    expect(axios.post).toHaveBeenCalledWith(
      '/api/auth/refresh',
      {},
      expect.objectContaining({ withCredentials: true, timeout: 10000 }),
    );
    expect(useAuthStore.getState()).toMatchObject({
      user: null,
      isAuthenticated: false,
      isLoading: false,
    });
  });

  it('keeps manual refresh authenticated across one rotation conflict', async () => {
    useAuthStore.setState({
      user: {
        id: 'user-1',
        email: 'user@example.com',
        username: 'user',
        role: 'USER',
        authorizationVersion: 1,
      },
      isAuthenticated: true,
    });
    let attempts = 0;
    client.defaults.adapter = vi.fn(async (config: InternalAxiosRequestConfig) => {
      attempts += 1;
      if (attempts === 1) {
        throw new AxiosError(
          'Refresh rotation conflict',
          'ERR_BAD_REQUEST',
          config,
          undefined,
          {
            data: { code: 'AUTH_REFRESH_ROTATION_CONFLICT', retryable: true },
            status: 409,
            statusText: 'Conflict',
            headers: { 'retry-after': '0.1' },
            config,
          },
        );
      }
      return {
        data: { accessToken: 'rotated' },
        status: 200,
        statusText: 'OK',
        headers: {},
        config,
      };
    }) as AxiosAdapter;

    const refresh = useAuthStore.getState().refreshSession();
    await vi.waitFor(() => expect(attempts).toBe(1));
    publishAuthRefreshSuccess();

    await expect(refresh).resolves.toBe(true);
    expect(attempts).toBe(2);
    expect(useAuthStore.getState().isAuthenticated).toBe(true);
  });

  it('signs out locally after a repeated rotation conflict has no winner', async () => {
    useAuthStore.setState({
      user: {
        id: 'user-1',
        email: 'user@example.com',
        username: 'user',
        role: 'USER',
        authorizationVersion: 1,
      },
      isAuthenticated: true,
    });
    let attempts = 0;
    client.defaults.adapter = vi.fn(async (config: InternalAxiosRequestConfig) => {
      attempts += 1;
      throw new AxiosError(
        'Refresh rotation conflict',
        'ERR_BAD_REQUEST',
        config,
        undefined,
        {
          data: { code: 'AUTH_REFRESH_ROTATION_CONFLICT', retryable: true },
          status: 409,
          statusText: 'Conflict',
          headers: { 'retry-after': '0.1' },
          config,
        },
      );
    }) as AxiosAdapter;

    const refresh = useAuthStore.getState().refreshSession();
    await vi.waitFor(() => expect(attempts).toBe(1));

    await expect(refresh).resolves.toBe(false);
    expect(attempts).toBe(2);
    expect(useAuthStore.getState()).toMatchObject({
      user: null,
      isAuthenticated: false,
    });
  });

  it.each([401, 403])('signs out locally after a terminal refresh %s', async (status) => {
    useAuthStore.setState({
      user: {
        id: 'user-1',
        email: 'user@example.com',
        username: 'user',
        role: 'USER',
        authorizationVersion: 1,
      },
      isAuthenticated: true,
    });
    client.defaults.adapter = vi.fn(async (config: InternalAxiosRequestConfig) => {
      throw new AxiosError(
        'Terminal refresh failure',
        'ERR_BAD_REQUEST',
        config,
        undefined,
        {
          data: { error: 'Terminal refresh failure' },
          status,
          statusText: status === 401 ? 'Unauthorized' : 'Forbidden',
          headers: {},
          config,
        },
      );
    }) as AxiosAdapter;

    await expect(useAuthStore.getState().refreshSession()).resolves.toBe(false);
    expect(useAuthStore.getState()).toMatchObject({
      user: null,
      isAuthenticated: false,
    });
  });
});
