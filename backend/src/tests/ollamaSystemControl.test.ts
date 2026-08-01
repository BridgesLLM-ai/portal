import {
  OllamaSystemControlError,
  restartLocalOllamaService,
} from '../services/ollamaSystemControl';

function jsonResponse(value: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(value), {
    status: 200,
    headers: { 'content-type': 'application/json' },
    ...init,
  });
}

async function noNativeRemoteBinding() {
  return {
    purposeId: 'PRIMARY' as const,
    authority: null,
  };
}

async function noLegacyRemoteBinding() {
  return {
    hasAuthority: false,
    hasCandidate: false,
  };
}

describe('local Ollama recovery control', () => {
  test('restarts only the fixed installer-managed unit and verifies the direct local API', async () => {
    const execFileImpl = jest.fn().mockResolvedValue(undefined);
    const requestLocalImpl = jest.fn().mockResolvedValue({ version: '0.32.0' });
    const resolveAuthorityImpl = jest.fn(async () => {
      throw new Error('configured Tailnet authority is unavailable');
    });

    await expect(restartLocalOllamaService({
      execFileImpl,
      requestLocalImpl,
      resolveAuthorityImpl,
      readNativeBindingImpl: noNativeRemoteBinding,
      readLegacyBindingPresenceImpl: noLegacyRemoteBinding,
    })).resolves.toEqual({ active: true, version: '0.32.0' });

    expect(execFileImpl).toHaveBeenNthCalledWith(
      1,
      '/usr/bin/systemctl',
      ['restart', 'ollama.service'],
      expect.any(Object),
    );
    expect(execFileImpl).toHaveBeenNthCalledWith(
      2,
      '/usr/bin/systemctl',
      ['is-active', '--quiet', 'ollama.service'],
      expect.any(Object),
    );
    expect(requestLocalImpl).toHaveBeenCalledWith({
      path: '/api/version',
      method: 'GET',
      timeoutMs: 3_000,
    });
    expect(resolveAuthorityImpl).not.toHaveBeenCalled();
  });

  test('keeps the injected fetch seam local-only and disables redirects', async () => {
    const execFileImpl = jest.fn().mockResolvedValue(undefined);
    const fetchImpl = jest.fn().mockResolvedValue(jsonResponse({ version: '0.32.0' }));

    await expect(restartLocalOllamaService({
      execFileImpl,
      fetchImpl: fetchImpl as typeof fetch,
      localOllamaBaseUrl: 'http://localhost:11434',
      readNativeBindingImpl: noNativeRemoteBinding,
      readLegacyBindingPresenceImpl: noLegacyRemoteBinding,
    })).resolves.toEqual({ active: true, version: '0.32.0' });

    expect(fetchImpl).toHaveBeenCalledWith(
      'http://127.0.0.1:11434/api/version',
      expect.objectContaining({
        method: 'GET',
        redirect: 'manual',
        signal: expect.any(AbortSignal),
      }),
    );
  });

  test('waits for both systemd and the direct local API before declaring recovery', async () => {
    const execFileImpl = jest.fn()
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(new Error('inactive'))
      .mockResolvedValue(undefined);
    const requestLocalImpl = jest.fn()
      .mockRejectedValueOnce(new Error('connection refused'))
      .mockResolvedValueOnce({ version: '0.32.0' });
    const sleep = jest.fn().mockResolvedValue(undefined);

    await expect(restartLocalOllamaService({
      execFileImpl,
      requestLocalImpl,
      sleep,
      readNativeBindingImpl: noNativeRemoteBinding,
      readLegacyBindingPresenceImpl: noLegacyRemoteBinding,
    })).resolves.toEqual({ active: true, version: '0.32.0' });

    expect(sleep).toHaveBeenCalledTimes(2);
    expect(execFileImpl).toHaveBeenCalledTimes(4);
    expect(requestLocalImpl).toHaveBeenCalledTimes(2);
  });

  test('fails closed with a bounded message when systemd rejects the restart', async () => {
    const execFileImpl = jest.fn().mockRejectedValue(new Error('sudo token and host trace'));

    const promise = restartLocalOllamaService({
      execFileImpl,
      readNativeBindingImpl: noNativeRemoteBinding,
      readLegacyBindingPresenceImpl: noLegacyRemoteBinding,
    });
    await expect(promise).rejects.toMatchObject({
      code: 'OLLAMA_RESTART_FAILED',
      message: 'Portal could not restart the local Ollama service. Check the server service log and retry.',
    });
    await promise.catch((error: OllamaSystemControlError) => {
      expect(error.message).not.toContain('token');
      expect(error.message).not.toContain('trace');
    });
  });
});
