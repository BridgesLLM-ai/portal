import {
  NativeOllamaBackendBindingState,
} from '@prisma/client';
import {
  OllamaBackendAuthorityError,
  type OllamaBackendAuthority,
  type OllamaBackendAuthorityResponse,
  type ResolvedOllamaBackendAuthority,
} from './ollamaBackendAuthority';
import { LOCAL_OLLAMA_TRANSPORT_POLICY } from './localOllamaTransport';
import {
  getLocalOllamaRestartCapability,
  getOllamaRuntimeStatus,
  restartLocalOllamaService,
  unloadAllOllamaModels,
  type OllamaSystemControlDependencies,
} from './ollamaSystemControl';

function resolvedAuthority(kind: OllamaBackendAuthority['kind']): ResolvedOllamaBackendAuthority {
  const authority: OllamaBackendAuthority = kind === 'TAILNET'
    ? {
      kind: 'TAILNET',
      source: 'tailnet-binding',
      endpoint: null,
      generation: 9,
      version: 4,
      bindingFingerprint: 'tailnet-binding-fingerprint',
      selectedModel: 'qwen3:8b-instruct-q4_K_M',
      selectedModelDigest: `sha256:${'a'.repeat(64)}`,
    }
    : {
      kind: 'LOCAL',
      source: 'local-policy',
      endpoint: 'http://127.0.0.1:11434',
      generation: null,
      version: null,
      bindingFingerprint: 'local-ollama-v1:127.0.0.1:11434',
      selectedModel: null,
      selectedModelDigest: null,
    };
  return {
    authority,
    bindingView: {
      purposeId: 'PRIMARY',
      authority: null,
      candidate: null,
    },
  };
}

function authorityResponse(
  authority: OllamaBackendAuthority,
  value: unknown,
): OllamaBackendAuthorityResponse {
  return {
    authority,
    statusCode: 200,
    headers: Object.freeze({ 'content-type': 'application/json' }),
    body: Buffer.from(JSON.stringify(value)),
    streaming: false,
  };
}

function authorityHarness(
  resolved: ResolvedOllamaBackendAuthority,
  values: unknown[],
): {
  dependencies: OllamaSystemControlDependencies;
  requestResolvedImpl: jest.Mock;
} {
  const requestResolvedImpl = jest.fn(async () => {
    if (!values.length) throw new Error('unexpected authority request');
    return authorityResponse(resolved.authority, values.shift());
  });
  return {
    dependencies: {
      resolveAuthorityImpl: jest.fn(async () => resolved),
      requestResolvedImpl,
      sleep: async () => undefined,
    },
    requestResolvedImpl,
  };
}

describe('Ollama system controls', () => {
  test('unloads every running Tailnet model against one immutable authority snapshot', async () => {
    const resolved = resolvedAuthority('TAILNET');
    const { dependencies, requestResolvedImpl } = authorityHarness(resolved, [
      { models: [{ name: 'qwen3:8b-instruct-q4_K_M' }, { model: 'llama3.2:3b' }] },
      { done: true },
      { done: true },
      { models: [] },
    ]);
    const requestLocalImpl = jest.fn();

    await expect(unloadAllOllamaModels({
      ...dependencies,
      requestLocalImpl,
    })).resolves.toEqual({
      unloadedModels: ['qwen3:8b-instruct-q4_K_M', 'llama3.2:3b'],
      alreadyIdle: false,
    });

    expect(requestResolvedImpl).toHaveBeenCalledTimes(4);
    for (const [admitted] of requestResolvedImpl.mock.calls) {
      expect(admitted).toBe(resolved);
    }
    expect(requestResolvedImpl).toHaveBeenNthCalledWith(
      2,
      resolved,
      expect.objectContaining({
        path: '/api/generate',
        method: 'POST',
        json: { model: 'qwen3:8b-instruct-q4_K_M', keep_alive: 0, stream: false },
      }),
    );
    expect(requestResolvedImpl).toHaveBeenNthCalledWith(
      3,
      resolved,
      expect.objectContaining({
        path: '/api/generate',
        method: 'POST',
        json: { model: 'llama3.2:3b', keep_alive: 0, stream: false },
      }),
    );
    expect(requestLocalImpl).not.toHaveBeenCalled();
  });

  test('unloads every exact running tag from an admitted local authority', async () => {
    const resolved = resolvedAuthority('LOCAL');
    const { dependencies, requestResolvedImpl } = authorityHarness(resolved, [
      { models: [{ name: 'alpha:latest' }, { model: 'beta:q4' }] },
      { done: true },
      { done: true },
      { models: [] },
    ]);

    await expect(unloadAllOllamaModels(dependencies)).resolves.toEqual({
      unloadedModels: ['alpha:latest', 'beta:q4'],
      alreadyIdle: false,
    });
    expect(requestResolvedImpl).toHaveBeenCalledTimes(4);
  });

  test('treats an idle configured authority as a successful no-op', async () => {
    const resolved = resolvedAuthority('LOCAL');
    const { dependencies, requestResolvedImpl } = authorityHarness(resolved, [{ models: [] }]);

    await expect(unloadAllOllamaModels(dependencies)).resolves.toEqual({
      unloadedModels: [],
      alreadyIdle: true,
    });
    expect(requestResolvedImpl).toHaveBeenCalledTimes(1);
  });

  test('reports Tailnet authority metadata without trusting an upstream header', async () => {
    const resolved = resolvedAuthority('TAILNET');
    const { dependencies, requestResolvedImpl } = authorityHarness(resolved, [
      { version: '0.32.0' },
      {
        models: [{
          name: 'qwen3:8b-instruct-q4_K_M',
          details: { parameter_size: '8.2B', family: 'qwen3' },
        }, {
          name: 'unbound:latest',
          details: { parameter_size: '70B', family: 'other' },
        }],
      },
      { models: [{ name: 'qwen3:8b-instruct-q4_K_M' }, { name: 'unbound:latest' }] },
    ]);

    await expect(getOllamaRuntimeStatus(dependencies)).resolves.toEqual({
      available: true,
      backend: 'tailnet',
      version: '0.32.0',
      models: [
        { name: 'qwen3:8b-instruct-q4_K_M', size: '8.2B', family: 'qwen3' },
        { name: 'unbound:latest', size: '70B', family: 'other' },
      ],
      runningModels: ['qwen3:8b-instruct-q4_K_M', 'unbound:latest'],
      isGpu: true,
      authority: {
        kind: 'TAILNET',
        generation: 9,
        version: 4,
        bindingFingerprint: 'tailnet-binding-fingerprint',
        displayName: null,
        selectedModel: 'qwen3:8b-instruct-q4_K_M',
      },
    });
    expect(requestResolvedImpl).toHaveBeenCalledTimes(3);
  });

  test('reports a healthy empty Tailnet catalog without inventing a local/default model', async () => {
    const resolved = resolvedAuthority('TAILNET');
    const { dependencies, requestResolvedImpl } = authorityHarness(resolved, [
      { version: '0.32.0' },
      { models: [] },
      { models: [] },
    ]);

    await expect(getOllamaRuntimeStatus(dependencies)).resolves.toMatchObject({
      available: true,
      backend: 'tailnet',
      models: [],
      runningModels: [],
      authority: {
        kind: 'TAILNET',
        selectedModel: 'qwen3:8b-instruct-q4_K_M',
      },
    });
    expect(requestResolvedImpl).toHaveBeenCalledTimes(3);
  });

  test('runtime status leaves response budgets to the transport path policies', async () => {
    // Regression for the "healthy Ollama reports offline" defect: the status
    // path once sent a blanket 4 MiB response cap that /api/version's 64 KiB
    // transport policy rejected as REQUEST_INVALID, which then surfaced as
    // BACKEND_UNAVAILABLE and collapsed every status surface to "Off". The
    // transport now clamps larger budgets, and the status path additionally
    // sends none at all: the per-path policy is the single budget owner.
    const resolved = resolvedAuthority('LOCAL');
    const payloads: Record<string, unknown> = {
      '/api/version': { version: '0.32.3' },
      '/api/tags': { models: [{ name: 'qwen3.5:2b', details: { parameter_size: '2B', family: 'qwen3' } }] },
      '/api/ps': { models: [] },
    };
    const requestResolvedImpl = jest.fn(async (
      _admitted: ResolvedOllamaBackendAuthority,
      request: { path: keyof typeof LOCAL_OLLAMA_TRANSPORT_POLICY; maxResponseBytes?: number },
    ) => {
      if (!LOCAL_OLLAMA_TRANSPORT_POLICY[request.path]) {
        throw new OllamaBackendAuthorityError('REQUEST_INVALID', 400);
      }
      expect(request.maxResponseBytes).toBeUndefined();
      return authorityResponse(resolved.authority, payloads[request.path]);
    });

    const status = await getOllamaRuntimeStatus({
      resolveAuthorityImpl: jest.fn(async () => resolved),
      requestResolvedImpl: requestResolvedImpl as unknown as OllamaSystemControlDependencies['requestResolvedImpl'],
      sleep: async () => undefined,
    });

    expect(status.available).toBe(true);
    expect(status.backend).toBe('local');
    expect(status.version).toBe('0.32.3');
    expect(status.models).toEqual([{ name: 'qwen3.5:2b', size: '2B', family: 'qwen3' }]);
    expect(requestResolvedImpl.mock.calls.map(([, request]) => request.path).sort()).toEqual(
      ['/api/ps', '/api/tags', '/api/version'],
    );
  });

  test('fails closed when configured authority admission rejects local-disabled policy', async () => {
    const requestResolvedImpl = jest.fn();
    const requestLocalImpl = jest.fn();
    const resolveAuthorityImpl = jest.fn(async () => {
      throw new OllamaBackendAuthorityError('LOCAL_DISABLED', 409);
    });

    await expect(getOllamaRuntimeStatus({
      resolveAuthorityImpl,
      requestResolvedImpl,
      requestLocalImpl,
    })).resolves.toEqual({
      available: false,
      backend: 'offline',
      version: null,
      models: [],
      runningModels: [],
      isGpu: false,
      authority: null,
    });
    await expect(unloadAllOllamaModels({
      resolveAuthorityImpl,
      requestResolvedImpl,
      requestLocalImpl,
    })).rejects.toMatchObject({
      code: 'OLLAMA_UNAVAILABLE',
      message: 'The configured Ollama backend is unavailable.',
      statusCode: 503,
    });
    expect(requestResolvedImpl).not.toHaveBeenCalled();
    expect(requestLocalImpl).not.toHaveBeenCalled();
  });

  test('does not leak authority failure details or fall back to direct local transport', async () => {
    const resolved = resolvedAuthority('TAILNET');
    const requestResolvedImpl = jest.fn(async () => {
      throw new OllamaBackendAuthorityError('HTTP_STATUS', 502, 500);
    });
    const requestLocalImpl = jest.fn();

    await expect(unloadAllOllamaModels({
      resolveAuthorityImpl: jest.fn(async () => resolved),
      requestResolvedImpl,
      requestLocalImpl,
    })).rejects.toMatchObject({
      code: 'OLLAMA_REJECTED',
      message: 'Ollama rejected the control request. Check its service status and retry.',
    });
    expect(requestLocalImpl).not.toHaveBeenCalled();
  });

  test.each([
    NativeOllamaBackendBindingState.ACTIVE,
    NativeOllamaBackendBindingState.DISCONNECTED,
  ])('blocks Portal-host restart while native authority state is %s', async (state) => {
    const execFileImpl = jest.fn();
    const requestLocalImpl = jest.fn();
    const readNativeBindingImpl = jest.fn(async () => ({
      purposeId: 'PRIMARY',
      authority: { state },
    } as any));

    await expect(getLocalOllamaRestartCapability({
      readNativeBindingImpl,
    })).resolves.toMatchObject({
      available: false,
      code: 'OLLAMA_REJECTED',
      statusCode: 409,
    });
    await expect(restartLocalOllamaService({
      readNativeBindingImpl,
      execFileImpl,
      requestLocalImpl: requestLocalImpl as unknown as NonNullable<
        OllamaSystemControlDependencies['requestLocalImpl']
      >,
      localOllamaBaseUrl: 'http://127.0.0.1:11434',
    })).rejects.toMatchObject({
      code: 'OLLAMA_REJECTED',
      statusCode: 409,
      message: expect.stringContaining('Portal host'),
    });
    expect(execFileImpl).not.toHaveBeenCalled();
    expect(requestLocalImpl).not.toHaveBeenCalled();
  });

  test('fails closed before systemd when native restart authority cannot be read', async () => {
    const execFileImpl = jest.fn();
    const requestLocalImpl = jest.fn();
    const readNativeBindingImpl = jest.fn(async () => {
      throw new Error('database unavailable');
    });

    await expect(getLocalOllamaRestartCapability({
      readNativeBindingImpl,
    })).resolves.toMatchObject({
      available: false,
      code: 'OLLAMA_UNAVAILABLE',
      statusCode: 503,
    });
    await expect(restartLocalOllamaService({
      readNativeBindingImpl,
      execFileImpl,
      requestLocalImpl,
      localOllamaBaseUrl: 'http://127.0.0.1:11434',
    })).rejects.toMatchObject({
      code: 'OLLAMA_UNAVAILABLE',
      statusCode: 503,
    });
    expect(execFileImpl).not.toHaveBeenCalled();
    expect(requestLocalImpl).not.toHaveBeenCalled();
  });

  test('blocks Portal-host restart while a legacy helper authority exists', async () => {
    const execFileImpl = jest.fn();
    const requestLocalImpl = jest.fn();
    const readNativeBindingImpl = jest.fn(async () => ({
      purposeId: 'PRIMARY',
      authority: null,
    } as any));
    const readLegacyBindingPresenceImpl = jest.fn(async () => ({
      hasAuthority: true,
      hasCandidate: false,
    }));

    await expect(restartLocalOllamaService({
      readNativeBindingImpl,
      readLegacyBindingPresenceImpl,
      execFileImpl,
      requestLocalImpl,
      localOllamaBaseUrl: 'http://127.0.0.1:11434',
    })).rejects.toMatchObject({
      code: 'OLLAMA_REJECTED',
      statusCode: 409,
      message: expect.stringContaining('Portal host'),
    });
    expect(execFileImpl).not.toHaveBeenCalled();
    expect(requestLocalImpl).not.toHaveBeenCalled();
  });

  test('restarts and verifies host Ollama only when no remote authority exists', async () => {
    const readNativeBindingImpl = jest.fn(async () => ({
      purposeId: 'PRIMARY',
      authority: null,
    } as any));
    const readLegacyBindingPresenceImpl = jest.fn(async () => ({
      hasAuthority: false,
      hasCandidate: false,
    }));
    const execFileImpl = jest.fn(async () => undefined);
    const requestLocalImpl = jest.fn(async () => ({ version: '0.32.3' }));

    await expect(restartLocalOllamaService({
      readNativeBindingImpl,
      readLegacyBindingPresenceImpl,
      execFileImpl,
      requestLocalImpl: requestLocalImpl as unknown as NonNullable<
        OllamaSystemControlDependencies['requestLocalImpl']
      >,
      localOllamaBaseUrl: 'http://127.0.0.1:11434',
      sleep: async () => undefined,
    })).resolves.toEqual({
      active: true,
      version: '0.32.3',
    });

    expect(execFileImpl).toHaveBeenNthCalledWith(
      1,
      '/usr/bin/systemctl',
      ['restart', 'ollama.service'],
      expect.objectContaining({ timeout: 45_000 }),
    );
    expect(execFileImpl).toHaveBeenNthCalledWith(
      2,
      '/usr/bin/systemctl',
      ['is-active', '--quiet', 'ollama.service'],
      expect.objectContaining({ timeout: 5_000 }),
    );
    expect(requestLocalImpl).toHaveBeenCalledWith(expect.objectContaining({
      path: '/api/version',
      method: 'GET',
    }));
  });
});
