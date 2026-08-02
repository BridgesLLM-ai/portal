// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useAuthStore } from '../contexts/AuthContext';
import {
  PORTAL_AUTHORIZATION_VERSION_HEADER,
  StaleWorkspaceAuthorizationResponseError,
  announceWorkspaceAuthorizationVersion,
  resetWorkspaceAuthorizationForTests,
} from './workspaceAuthorization';
import {
  bindWorkspaceAuthorizationToXhr,
  workspaceAuthorizedFetch,
} from './workspaceAuthorizedFetch';

function actor(id: string, authorizationVersion: number) {
  return {
    id,
    email: `${id}@example.com`,
    username: id,
    role: 'SUB_ADMIN' as const,
    authorizationVersion,
  };
}

function response(version: number): Response {
  return {
    headers: new Headers({
      [PORTAL_AUTHORIZATION_VERSION_HEADER]: String(version),
    }),
    ok: true,
    status: 200,
  } as Response;
}

describe('workspaceAuthorizedFetch', () => {
  const fetchMock = vi.fn();

  beforeEach(() => {
    resetWorkspaceAuthorizationForTests();
    fetchMock.mockReset();
    vi.stubGlobal('fetch', fetchMock);
    useAuthStore.setState({
      user: actor('user-1', 3),
      isAuthenticated: true,
      sessionRestoreError: false,
    });
  });

  it('stamps the admitted actor generation and accepts a matching response', async () => {
    fetchMock.mockResolvedValue(response(3));

    await expect(workspaceAuthorizedFetch('/api/files')).resolves.toMatchObject({ ok: true });

    const init = fetchMock.mock.calls[0][1] as RequestInit;
    expect(new Headers(init.headers).get(PORTAL_AUTHORIZATION_VERSION_HEADER)).toBe('3');
    expect(init.signal?.aborted).toBe(false);
  });

  it('refreshes and retries an authenticated request after an expired access cookie', async () => {
    fetchMock
      .mockResolvedValueOnce({ ...response(3), ok: false, status: 401 })
      .mockResolvedValueOnce({ ok: true, status: 200, headers: new Headers() } as Response)
      .mockResolvedValueOnce(response(3));

    await expect(workspaceAuthorizedFetch('/api/gateway/sessions')).resolves.toMatchObject({
      ok: true,
      status: 200,
    });

    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(fetchMock.mock.calls[0][0]).toBe('/api/gateway/sessions');
    expect(fetchMock.mock.calls[1][0]).toBe('/api/auth/refresh');
    expect(fetchMock.mock.calls[2][0]).toBe('/api/gateway/sessions');
  });

  it('rejects a delayed response after the signed-in actor changes', async () => {
    let resolveFetch!: (value: Response) => void;
    fetchMock.mockImplementation(() => new Promise<Response>((resolve) => {
      resolveFetch = resolve;
    }));
    const request = workspaceAuthorizedFetch('/api/projects');
    useAuthStore.setState({ user: actor('user-2', 1) });
    resolveFetch(response(3));

    await expect(request).rejects.toBeInstanceOf(StaleWorkspaceAuthorizationResponseError);
  });

  it('announces and rejects a response from a newer generation', async () => {
    fetchMock.mockResolvedValue(response(4));

    await expect(workspaceAuthorizedFetch('/api/files')).rejects
      .toBeInstanceOf(StaleWorkspaceAuthorizationResponseError);
  });

  it('aborts an in-flight fetch and its response stream when the generation advances', async () => {
    let requestSignal: AbortSignal | undefined;
    fetchMock.mockImplementation((_input, init: RequestInit) => {
      requestSignal = init.signal || undefined;
      return new Promise<Response>((_resolve, reject) => {
        requestSignal?.addEventListener('abort', () => {
          reject(new DOMException('Authorization changed', 'AbortError'));
        }, { once: true });
      });
    });
    const request = workspaceAuthorizedFetch('/api/projects/owner/install-deps');

    announceWorkspaceAuthorizationVersion('user-1', 4, 'socket');

    expect(requestSignal?.aborted).toBe(true);
    await expect(request).rejects.toMatchObject({ name: 'AbortError' });
  });

  it('keeps the generation signal attached after headers resolve for streaming bodies', async () => {
    let requestSignal: AbortSignal | undefined;
    fetchMock.mockImplementation((_input, init: RequestInit) => {
      requestSignal = init.signal || undefined;
      return Promise.resolve(response(3));
    });

    await workspaceAuthorizedFetch('/api/projects/owner/install-deps');
    expect(requestSignal?.aborted).toBe(false);

    announceWorkspaceAuthorizationVersion('user-1', 4, 'socket');
    expect(requestSignal?.aborted).toBe(true);
  });

  it('stamps and aborts upload-progress XHR requests on generation change', () => {
    const xhr = {
      abort: vi.fn(),
      getResponseHeader: vi.fn(() => '3'),
      setRequestHeader: vi.fn(),
    } as unknown as XMLHttpRequest;
    const binding = bindWorkspaceAuthorizationToXhr(xhr);

    expect(xhr.setRequestHeader).toHaveBeenCalledWith(
      PORTAL_AUTHORIZATION_VERSION_HEADER,
      '3',
    );
    expect(() => binding.validateResponse()).not.toThrow();

    announceWorkspaceAuthorizationVersion('user-1', 4, 'socket');
    expect(xhr.abort).toHaveBeenCalledTimes(1);
    binding.dispose();
  });
});
