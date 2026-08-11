// @vitest-environment jsdom
import '../test/setup';
import axios, {
  AxiosError,
  type AxiosAdapter,
  type InternalAxiosRequestConfig,
} from 'axios';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import client from '../api/client';
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
});
