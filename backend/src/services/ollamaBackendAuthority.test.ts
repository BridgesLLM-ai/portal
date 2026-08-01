import {
  NativeOllamaBackendBindingState,
  OllamaBackendAddressFamily,
  OllamaBackendBindingState,
} from '@prisma/client';

jest.mock('./legacyOllamaBindingRead', () => {
  process.env.DATABASE_URL ||= 'postgresql://test:test@127.0.0.1:5432/bridgesllm_test';
  const actual = jest.requireActual('./legacyOllamaBindingRead');
  return {
    ...actual,
    readLegacyOllamaBindingPresence: jest.fn(async () => ({
      hasAuthority: false,
      hasCandidate: false,
    })),
    readLegacyOllamaBindingView: jest.fn(async () => ({
      purposeId: 'PRIMARY',
      authority: null,
      candidate: null,
    })),
  };
});

import {
  OllamaBackendAuthorityError,
  requestConfiguredOllama,
  requestConfiguredOllamaJson,
  requestResolvedOllama,
  resolveOllamaBackendAuthority,
  streamConfiguredOllama,
  type OllamaBackendAuthorityDependencies,
} from './ollamaBackendAuthority';
import type { PublicNativeOllamaBindingSnapshot } from './nativeOllamaBinding';
import type { LegacyOllamaBindingSnapshot } from './legacyOllamaBindingRead';
import {
  NATIVE_OLLAMA_STREAM_COMPLETE,
  NativeOllamaTransportError,
} from './nativeOllamaTransport';
import { NativeOllamaBackendError } from './nativeOllamaBackend';

const NOW = new Date('2026-07-26T20:00:00.000Z');
const DIGEST = `sha256:${'a'.repeat(64)}`;

function binding(
  overrides: Partial<PublicNativeOllamaBindingSnapshot> = {},
): PublicNativeOllamaBindingSnapshot {
  return {
    id: 'native-binding-1',
    purposeId: 'PRIMARY',
    generation: 7,
    version: 4,
    state: NativeOllamaBackendBindingState.ACTIVE,
    tailnetName: 'example.ts.net',
    stableNodeId: 'stable_node_0001',
    nodePublicKey: `nodekey:${'1'.repeat(64)}`,
    observedAddress: '100.72.18.9',
    addressFamily: OllamaBackendAddressFamily.IPV4,
    servePort: 11435,
    bindingFingerprint: `native-ollama-binding:v1:sha256:${'b'.repeat(64)}`,
    selectedModel: 'qwen3:8b',
    selectedModelDigest: DIGEST,
    grantPeerAttestationFingerprint: 'c'.repeat(64),
    grantTemplateHash: `sha256:${'d'.repeat(64)}`,
    grantAcknowledgedAt: new Date(NOW.getTime() - 10_000),
    grantAcknowledgedBy: 'owner-user-id',
    legacyHelperRetirementAcknowledgedAt: null,
    legacyHelperRetirementAcknowledgedBy: null,
    legacyHelperRetirementEvidence: null,
    configuredByUserId: 'owner-user-id',
    observedAt: NOW,
    verifiedAt: NOW,
    activatedAt: NOW,
    disconnectedAt: null,
    removedAt: null,
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  };
}

function legacyBinding(
  overrides: Partial<LegacyOllamaBindingSnapshot> = {},
): LegacyOllamaBindingSnapshot {
  return {
    id: 'legacy-binding-1',
    purposeId: 'PRIMARY',
    generation: 5,
    version: 8,
    state: OllamaBackendBindingState.ACTIVE,
    tailnetName: 'example.ts.net',
    stableNodeId: 'stable_node_legacy',
    nodePublicKey: `nodekey:${'2'.repeat(64)}`,
    address: '100.72.18.8',
    addressFamily: OllamaBackendAddressFamily.IPV4,
    helperPort: 11434,
    protocolVersion: 2,
    helperId: 'helper_existing_runtime',
    bindingFingerprint: `legacy-ollama-binding:v2:${'e'.repeat(64)}`,
    selectedModel: 'qwen3:8b',
    selectedModelDigest: DIGEST,
    hasPairingSecret: true,
    attestationVerified: true,
    protocolVerified: true,
    observedAt: NOW,
    verifiedAt: NOW,
    activatedAt: NOW,
    ...overrides,
  };
}

function attested(
  source = binding(),
  overrides: Record<string, unknown> = {},
) {
  return Object.freeze({
    state: 'ATTESTED' as const,
    requiresBindingGenerationAdvance: false as const,
    attestation: Object.freeze({
      tailnetName: source.tailnetName,
      stableNodeId: source.stableNodeId,
      nodePublicKey: source.nodePublicKey,
      address: source.observedAddress,
      addressFamily: source.addressFamily,
      observedAt: new Date(NOW.getTime() + 1_000).toISOString(),
      fingerprint: 'attestation-fingerprint',
      ...overrides,
    }),
  });
}

function dependencies(
  authority: PublicNativeOllamaBindingSnapshot | null,
  overrides: Partial<OllamaBackendAuthorityDependencies> = {},
): OllamaBackendAuthorityDependencies {
  return {
    readNativeBinding: jest.fn(async () => ({
      purposeId: 'PRIMARY' as const,
      authority,
    })),
    readLegacyView: jest.fn(async () => ({
      purposeId: 'PRIMARY' as const,
      authority: null,
      candidate: null,
    })),
    getLocalRuntime: jest.fn(async () => ({
      enabled: true,
      endpoint: 'http://127.0.0.1:11434' as const,
    })),
    reattestPeer: jest.fn(async () => attested(authority ?? binding())),
    assertGrantSnapshot: jest.fn(async () => undefined),
    requestNative: jest.fn(async () => ({
      statusCode: 200,
      headers: Object.freeze({ 'content-type': 'application/json' }),
      body: Buffer.from('{"models":[]}'),
    })),
    ...overrides,
  };
}

test('uses fixed loopback only when no native or legacy authority exists', async () => {
  const deps = dependencies(null);

  await expect(requestConfiguredOllamaJson<{ models: unknown[] }>({
    path: '/api/tags',
    method: 'GET',
  }, deps)).resolves.toEqual({
    authority: expect.objectContaining({
      kind: 'LOCAL',
      endpoint: 'http://127.0.0.1:11434',
      generation: null,
    }),
    value: { models: [] },
  });
  expect(deps.requestNative).toHaveBeenCalledWith(expect.objectContaining({
    endpoint: { address: '127.0.0.1', family: 4, port: 11434 },
    path: '/api/tags',
    method: 'GET',
  }));
});

test('disabled local policy fails without dispatch', async () => {
  const requestNative = jest.fn();
  const deps = dependencies(null, {
    getLocalRuntime: jest.fn(async () => ({
      enabled: false,
      endpoint: 'http://127.0.0.1:11434',
    })),
    requestNative,
  });

  await expect(requestConfiguredOllama({
    path: '/api/tags',
    method: 'GET',
  }, deps)).rejects.toMatchObject({ code: 'LOCAL_DISABLED', statusCode: 409 });
  expect(requestNative).not.toHaveBeenCalled();
});

test('an existing legacy helper authority serves inventory, Agent Chat, and buffered pull streaming until native activation', async () => {
  const legacy = legacyBinding();
  const requestNative = jest.fn();
  const requestLegacy = jest.fn(async (
    _binding: unknown,
    request: { path: string },
  ) => ({
    protocolVersion: 2 as const,
    status: 200,
    body: Buffer.from(request.path === '/api/tags'
      ? JSON.stringify({
        models: [{
          name: legacy.selectedModel,
          digest: DIGEST.slice('sha256:'.length),
        }],
      })
      : request.path === '/api/chat'
        ? '{"message":{"role":"assistant","content":"legacy ok"},"done":true}\n'
        : '{"status":"success"}\n'),
    streaming: false as const,
  }));
  const withLegacySecret = jest.fn(async (_input, callback) => {
    const secret = Buffer.alloc(32, 7);
    try {
      return await callback(secret);
    } finally {
      secret.fill(0);
    }
  });
  const deps = dependencies(null, {
    readLegacyView: jest.fn(async () => ({
      purposeId: 'PRIMARY' as const,
      authority: legacy,
      candidate: null,
    })),
    reattestPeer: jest.fn(async () => ({
      state: 'ATTESTED' as const,
      requiresBindingGenerationAdvance: false as const,
      attestation: {
        tailnetName: legacy.tailnetName,
        stableNodeId: legacy.stableNodeId,
        nodePublicKey: legacy.nodePublicKey,
        address: legacy.address,
        addressFamily: legacy.addressFamily,
        observedAt: NOW.toISOString(),
        fingerprint: 'legacy-attestation',
      },
    })),
    withLegacySecret: withLegacySecret as NonNullable<
      OllamaBackendAuthorityDependencies['withLegacySecret']
    >,
    requestLegacy: requestLegacy as NonNullable<
      OllamaBackendAuthorityDependencies['requestLegacy']
    >,
    requestNative,
  });

  await expect(requestConfiguredOllamaJson<{ models: unknown[] }>({
    path: '/api/tags',
    method: 'GET',
  }, deps)).resolves.toMatchObject({
    authority: {
      kind: 'TAILNET',
      generation: legacy.generation,
      version: legacy.version,
      bindingFingerprint: legacy.bindingFingerprint,
    },
    value: { models: expect.any(Array) },
  });

  const chatChunks: string[] = [];
  await expect(streamConfiguredOllama({
    path: '/api/chat',
    method: 'POST',
    json: {
      model: legacy.selectedModel,
      messages: [{ role: 'user', content: 'continue' }],
      stream: true,
    },
    expectedModelDigest: DIGEST,
  }, (chunk) => {
    chatChunks.push(chunk.toString('utf8'));
    return NATIVE_OLLAMA_STREAM_COMPLETE;
  }, deps)).resolves.toMatchObject({
    authority: { bindingFingerprint: legacy.bindingFingerprint },
    streaming: true,
  });
  expect(chatChunks.join('')).toContain('legacy ok');

  const pullChunks: string[] = [];
  await streamConfiguredOllama({
    path: '/api/pull',
    method: 'POST',
    json: { model: 'qwen3.5:9b', stream: true },
  }, (chunk) => {
    pullChunks.push(chunk.toString('utf8'));
    return NATIVE_OLLAMA_STREAM_COMPLETE;
  }, deps);
  expect(pullChunks.join('')).toContain('"status":"success"');
  expect(requestLegacy.mock.calls.map(([, request]) => request.path))
    .toEqual(['/api/tags', '/api/tags', '/api/chat', '/api/pull']);
  expect(withLegacySecret).toHaveBeenCalledTimes(4);
  expect(requestNative).not.toHaveBeenCalled();
});

test('native authority outranks a still-retained active legacy helper row', async () => {
  const remote = binding();
  const readLegacyView = jest.fn(async () => ({
    purposeId: 'PRIMARY' as const,
    authority: legacyBinding(),
    candidate: null,
  }));
  const deps = dependencies(remote, { readLegacyView });

  await expect(resolveOllamaBackendAuthority(deps)).resolves.toMatchObject({
    authority: {
      kind: 'TAILNET',
      generation: remote.generation,
      bindingFingerprint: remote.bindingFingerprint,
    },
  });
  expect(readLegacyView).not.toHaveBeenCalled();
});

test('disconnected native authority also outranks an active legacy helper and local fallback', async () => {
  const readLegacyView = jest.fn(async () => ({
    purposeId: 'PRIMARY' as const,
    authority: legacyBinding(),
    candidate: null,
  }));
  const getLocalRuntime = jest.fn(async () => ({
    enabled: true,
    endpoint: 'http://127.0.0.1:11434' as const,
  }));
  const deps = dependencies(binding({
    state: NativeOllamaBackendBindingState.DISCONNECTED,
  }), {
    readLegacyView,
    getLocalRuntime,
  });

  await expect(resolveOllamaBackendAuthority(deps)).rejects.toMatchObject({
    code: 'REMOTE_DISCONNECTED',
    statusCode: 409,
  });
  expect(readLegacyView).not.toHaveBeenCalled();
  expect(getLocalRuntime).not.toHaveBeenCalled();
});

test('a disconnected legacy helper authority blocks local fallback', async () => {
  const requestNative = jest.fn();
  const deps = dependencies(null, {
    readLegacyView: jest.fn(async () => ({
      purposeId: 'PRIMARY' as const,
      authority: legacyBinding({
        state: OllamaBackendBindingState.DISCONNECTED,
      }),
      candidate: null,
    })),
    requestNative,
  });

  await expect(resolveOllamaBackendAuthority(deps)).rejects.toMatchObject({
    code: 'REMOTE_DISCONNECTED',
    statusCode: 409,
  });
  expect(requestNative).not.toHaveBeenCalled();
});

test('an active zero-model remote can manage inventory but cannot infer', async () => {
  const remote = binding({
    selectedModel: null,
    selectedModelDigest: null,
  });
  const requestNative = jest.fn(async () => ({
    statusCode: 200,
    headers: Object.freeze({}),
    body: Buffer.from('{"models":[]}'),
  }));
  const deps = dependencies(remote, { requestNative });

  await expect(requestConfiguredOllamaJson<{ models: unknown[] }>({
    path: '/api/tags',
    method: 'GET',
  }, deps)).resolves.toMatchObject({
    authority: { kind: 'TAILNET', selectedModel: null },
    value: { models: [] },
  });
  expect(requestNative).toHaveBeenCalledWith(expect.objectContaining({
    endpoint: { address: remote.observedAddress, family: 4, port: 11435 },
  }));

  await expect(requestConfiguredOllama({
    path: '/api/chat',
    method: 'POST',
    json: { model: 'qwen3:8b', messages: [], stream: true },
  }, deps)).rejects.toMatchObject({ code: 'MODEL_MISMATCH' });
  expect(requestNative).toHaveBeenCalledTimes(1);
});

test('address rotation persists the observation and dispatches the current literal', async () => {
  const remote = binding();
  const rotated = binding({
    version: remote.version + 1,
    observedAddress: '100.72.18.10',
    observedAt: new Date(NOW.getTime() + 1_000),
  });
  const updateNativeObservation = jest.fn(async () => rotated);
  const requestNative = jest.fn(async () => ({
    statusCode: 200,
    headers: Object.freeze({}),
    body: Buffer.from('{"models":[]}'),
  }));
  const deps = dependencies(remote, {
    reattestPeer: jest.fn(async () => attested(remote, {
      address: rotated.observedAddress,
      observedAt: rotated.observedAt.toISOString(),
    })),
    updateNativeObservation,
    requestNative,
  });

  const response = await requestConfiguredOllama({
    path: '/api/tags',
    method: 'GET',
  }, deps);
  expect(updateNativeObservation).toHaveBeenCalledWith(expect.objectContaining({
    generation: remote.generation,
    expectedVersion: remote.version,
    observedAddress: rotated.observedAddress,
    servePort: 11435,
  }));
  expect(requestNative).toHaveBeenCalledWith(expect.objectContaining({
    endpoint: { address: rotated.observedAddress, family: 4, port: 11435 },
  }));
  expect(response.authority).toMatchObject({
    generation: remote.generation,
    version: rotated.version,
    bindingFingerprint: remote.bindingFingerprint,
  });
});

test('verifies the exact selected digest immediately before remote inference', async () => {
  const remote = binding();
  const requestNative = jest.fn(async (request: { path: string }) => ({
    statusCode: 200,
    headers: Object.freeze({ 'content-type': 'application/json' }),
    body: Buffer.from(JSON.stringify(
      request.path === '/api/tags'
        ? {
          models: [{
            name: remote.selectedModel,
            digest: DIGEST.slice('sha256:'.length),
          }],
        }
        : { done: true, message: { role: 'assistant', content: 'ok' } },
    )),
  }));
  const deps = dependencies(remote, { requestNative });

  await expect(requestConfiguredOllama({
    path: '/api/chat',
    method: 'POST',
    json: {
      model: remote.selectedModel,
      messages: [{ role: 'user', content: 'hello' }],
      stream: false,
    },
  }, deps)).resolves.toMatchObject({ authority: { kind: 'TAILNET' } });
  expect(requestNative.mock.calls.map(([request]) => request.path))
    .toEqual(['/api/tags', '/api/chat']);

  requestNative.mockClear();
  requestNative.mockResolvedValueOnce({
    statusCode: 200,
    headers: Object.freeze({ 'content-type': 'application/json' }),
    body: Buffer.from(JSON.stringify({
      models: [{
        name: remote.selectedModel,
        digest: 'f'.repeat(64),
      }],
    })),
  });
  await expect(requestConfiguredOllama({
    path: '/api/chat',
    method: 'POST',
    json: {
      model: remote.selectedModel,
      messages: [{ role: 'user', content: 'hello again' }],
      stream: false,
    },
  }, deps)).rejects.toMatchObject({
    code: 'MODEL_MISMATCH',
    statusCode: 409,
  });
  expect(requestNative).toHaveBeenCalledTimes(1);
});

test('performs the same digest gate before streamed remote inference', async () => {
  const remote = binding();
  const deferAuthorityMutation = jest.fn();
  const requestNative = jest.fn(async () => ({
    statusCode: 200,
    headers: Object.freeze({ 'content-type': 'application/json' }),
    body: Buffer.from(JSON.stringify({
      models: [{
        name: remote.selectedModel,
        digest: DIGEST.slice('sha256:'.length),
      }],
    })),
  }));
  const streamNative = jest.fn(async (_request, consumer) => {
    expect(await consumer(Buffer.from(
      '{"message":{"role":"assistant","content":"ok"},"done":true}\n',
    ))).toBe(NATIVE_OLLAMA_STREAM_COMPLETE);
    return {
      statusCode: 200,
      headers: Object.freeze({
        'content-type': 'application/x-ndjson',
      }),
      responseBytes: 58,
    };
  });
  const chunks: string[] = [];

  await expect(streamConfiguredOllama({
    path: '/api/chat',
    method: 'POST',
    json: {
      model: remote.selectedModel,
      messages: [{ role: 'user', content: 'stream' }],
      stream: true,
    },
  }, (chunk) => {
    chunks.push(chunk.toString('utf8'));
    return NATIVE_OLLAMA_STREAM_COMPLETE;
  }, dependencies(remote, {
    requestNative,
    streamNative,
    deferAuthorityMutation,
  }))).resolves.toMatchObject({
    authority: { kind: 'TAILNET' },
    streaming: true,
  });
  expect(requestNative).toHaveBeenCalledWith(expect.objectContaining({
    path: '/api/tags',
    method: 'GET',
  }));
  expect(streamNative).toHaveBeenCalledWith(
    expect.objectContaining({
      path: '/api/chat',
      method: 'POST',
    }),
    expect.any(Function),
  );
  expect(chunks.join('')).toContain('"done":true');
  expect(deferAuthorityMutation).not.toHaveBeenCalled();
});

test('fails closed when the acknowledged Grant snapshot no longer matches', async () => {
  const remote = binding();
  const requestNative = jest.fn();
  const markNativeDisconnected = jest.fn(async () => binding({
    version: remote.version + 1,
    state: NativeOllamaBackendBindingState.DISCONNECTED,
    disconnectedAt: new Date(NOW.getTime() + 1_000),
  }));
  const deferAuthorityMutation = jest.fn(async (
    operation: () => Promise<unknown>,
  ) => operation());
  const assertGrantSnapshot = jest.fn(async () => {
    throw new NativeOllamaBackendError('GRANT_SNAPSHOT_CHANGED', 409);
  });
  const deps = dependencies(remote, {
    assertGrantSnapshot,
    markNativeDisconnected,
    deferAuthorityMutation: deferAuthorityMutation as unknown as NonNullable<
      OllamaBackendAuthorityDependencies['deferAuthorityMutation']
    >,
    requestNative,
  });

  await expect(requestConfiguredOllama({
    path: '/api/tags',
    method: 'GET',
  }, deps)).rejects.toMatchObject({
    code: 'GRANT_SNAPSHOT_CHANGED',
    statusCode: 409,
  });
  expect(assertGrantSnapshot).toHaveBeenCalledWith(
    remote,
    expect.objectContaining({
      stableNodeId: remote.stableNodeId,
      nodePublicKey: remote.nodePublicKey,
    }),
  );
  await Promise.resolve();
  expect(deferAuthorityMutation).toHaveBeenCalledTimes(1);
  expect(markNativeDisconnected).toHaveBeenCalledWith(expect.objectContaining({
    generation: remote.generation,
    expectedVersion: remote.version,
  }));
  expect(requestNative).not.toHaveBeenCalled();
});

test('a disconnected remote blocks without local fallback', async () => {
  const remote = binding({
    state: NativeOllamaBackendBindingState.DISCONNECTED,
    disconnectedAt: new Date(NOW.getTime() + 1_000),
  });
  const requestNative = jest.fn();
  const deps = dependencies(remote, { requestNative });

  await expect(requestConfiguredOllama({
    path: '/api/tags',
    method: 'GET',
  }, deps)).rejects.toMatchObject({ code: 'REMOTE_DISCONNECTED' });
  expect(requestNative).not.toHaveBeenCalled();
});

test('identity change schedules exact disconnection and never dispatches or falls back', async () => {
  const remote = binding();
  const markNativeDisconnected = jest.fn(async () => binding({
    version: remote.version + 1,
    state: NativeOllamaBackendBindingState.DISCONNECTED,
    disconnectedAt: new Date(NOW.getTime() + 1_000),
  }));
  const deferAuthorityMutation = jest.fn(async (
    operation: () => Promise<unknown>,
  ) => operation());
  const requestNative = jest.fn();
  const deps = dependencies(remote, {
    reattestPeer: jest.fn(async () => ({
      state: 'BINDING_GENERATION_ADVANCE_REQUIRED' as const,
      requiresBindingGenerationAdvance: true as const,
      changes: Object.freeze(['NODE_PUBLIC_KEY'] as const),
      candidate: attested(remote, {
        nodePublicKey: `nodekey:${'9'.repeat(64)}`,
      }).attestation,
    })),
    markNativeDisconnected,
    deferAuthorityMutation: deferAuthorityMutation as unknown as NonNullable<
      OllamaBackendAuthorityDependencies['deferAuthorityMutation']
    >,
    requestNative,
  });

  await expect(requestConfiguredOllama({
    path: '/api/tags',
    method: 'GET',
  }, deps)).rejects.toMatchObject({ code: 'REMOTE_IDENTITY_CHANGED' });
  await Promise.resolve();
  expect(deferAuthorityMutation).toHaveBeenCalledTimes(1);
  expect(markNativeDisconnected).toHaveBeenCalledWith(expect.objectContaining({
    generation: remote.generation,
    expectedVersion: remote.version,
  }));
  expect(requestNative).not.toHaveBeenCalled();
});

test('abort, timeout, HTTP, and consumer failures do not poison a valid binding', async () => {
  const remote = binding();
  const deferAuthorityMutation = jest.fn();
  const cases = [
    new NativeOllamaTransportError('ABORTED', 'aborted'),
    new NativeOllamaTransportError('TIMEOUT', 'timed out'),
    new NativeOllamaTransportError('HTTP_STATUS', 'bad request', 404),
    new NativeOllamaTransportError('RESPONSE_INVALID', 'bad response'),
  ];

  for (const error of cases) {
    const deps = dependencies(remote, {
      requestNative: jest.fn(async () => {
        throw error;
      }),
      deferAuthorityMutation,
    });
    await expect(requestConfiguredOllama({
      path: '/api/tags',
      method: 'GET',
    }, deps)).rejects.toBeInstanceOf(OllamaBackendAuthorityError);
  }
  expect(deferAuthorityMutation).not.toHaveBeenCalled();

  const consumerError = new Error('malformed bounded NDJSON');
  const streamDeps = dependencies(remote, {
    streamNative: jest.fn(async (_request, consumer) => {
      await consumer(Buffer.from('{}\n'));
      throw new Error('unreachable');
    }),
    deferAuthorityMutation: deferAuthorityMutation as unknown as NonNullable<
      OllamaBackendAuthorityDependencies['deferAuthorityMutation']
    >,
  });
  await expect(streamConfiguredOllama({
    path: '/api/pull',
    method: 'POST',
    json: { model: 'qwen3:8b', stream: true },
  }, () => {
    throw consumerError;
  }, streamDeps)).rejects.toBe(consumerError);
  expect(deferAuthorityMutation).not.toHaveBeenCalled();
});

test('only a connection failure schedules disconnection after admission', async () => {
  const remote = binding();
  const disconnected = binding({
    version: remote.version + 1,
    state: NativeOllamaBackendBindingState.DISCONNECTED,
    disconnectedAt: new Date(NOW.getTime() + 1_000),
  });
  const markNativeDisconnected = jest.fn(async () => disconnected);
  const deferAuthorityMutation = jest.fn(async (
    operation: () => Promise<unknown>,
  ) => operation());
  const deps = dependencies(remote, {
    requestNative: jest.fn(async () => {
      throw new NativeOllamaTransportError(
        'CONNECTION_FAILED',
        'socket failed',
      );
    }),
    markNativeDisconnected,
    deferAuthorityMutation: deferAuthorityMutation as unknown as NonNullable<
      OllamaBackendAuthorityDependencies['deferAuthorityMutation']
    >,
  });

  await expect(requestConfiguredOllama({
    path: '/api/tags',
    method: 'GET',
  }, deps)).rejects.toMatchObject({ code: 'BACKEND_UNAVAILABLE' });
  await Promise.resolve();
  expect(deferAuthorityMutation).toHaveBeenCalledTimes(1);
  expect(markNativeDisconnected).toHaveBeenCalledTimes(1);
});

test('supplied authority survives address-only version advancement but not a model switch', async () => {
  const original = binding();
  const resolved = await resolveOllamaBackendAuthority(dependencies(original));
  const addressOnly = binding({
    version: original.version + 1,
    observedAddress: '100.72.18.10',
  });
  const addressDeps = dependencies(addressOnly, {
    reattestPeer: jest.fn(async () => attested(addressOnly)),
  });

  await expect(requestResolvedOllama(resolved, {
    path: '/api/tags',
    method: 'GET',
  }, addressDeps)).resolves.toMatchObject({
    authority: {
      generation: original.generation,
      bindingFingerprint: original.bindingFingerprint,
    },
  });

  const switched = binding({
    version: original.version + 1,
    selectedModel: 'qwen3.5:9b',
    selectedModelDigest: `sha256:${'c'.repeat(64)}`,
  });
  await expect(requestResolvedOllama(resolved, {
    path: '/api/tags',
    method: 'GET',
  }, dependencies(switched))).rejects.toMatchObject({
    code: 'BINDING_CHANGED',
  });
});

test('authority errors expose bounded codes and never upstream response bodies', () => {
  const error = new OllamaBackendAuthorityError('HTTP_STATUS', 502, 418);
  expect(error.toJSON()).toEqual({
    name: 'OllamaBackendAuthorityError',
    code: 'HTTP_STATUS',
    message: 'Ollama returned a non-success status.',
    statusCode: 502,
  });
  expect(JSON.stringify(error)).not.toContain('418');
  expect(JSON.stringify(error)).not.toContain('upstream');
});
