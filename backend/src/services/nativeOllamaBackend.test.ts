import {
  NativeOllamaBackendBindingState,
  OllamaBackendAddressFamily,
} from '@prisma/client';
import {
  NATIVE_OLLAMA_MODEL_SELECTION_TIMEOUT_MS,
  NativeOllamaBackendError,
  clearNativeOllamaBackendModel,
  connectNativeOllamaBackend,
  diagnoseNativeOllamaBackend,
  listNativeOllamaInstalledModels,
  probeNativeOllamaPeer,
  reverifyNativeOllamaBackend,
  selectNativeOllamaBackendModel,
  testNativeOllamaBackendModel,
  hashNativeOllamaGrantTemplate,
  renderNativeOllamaGrantTemplate,
  type NativeOllamaBackendDependencies,
} from './nativeOllamaBackend';
import {
  NATIVE_OLLAMA_SERVE_PORT,
  type PublicNativeOllamaBindingSnapshot,
  type PublicNativeOllamaBindingView,
} from './nativeOllamaBinding';
import { NativeOllamaTransportError } from './nativeOllamaTransport';
import type {
  TailscalePeerAttestation,
  TailscalePeerInventory,
} from './tailscalePeerAttestor';

const OBSERVED_AT = '2026-07-26T18:00:00.000Z';
const NOW = new Date('2026-07-26T18:01:00.000Z');
const MODEL_DIGEST = `sha256:${'a'.repeat(64)}` as const;
const OTHER_DIGEST = `sha256:${'b'.repeat(64)}` as const;
const PORTAL_TAILNET_IP = '100.64.10.20';

const ATTESTED_PEER: TailscalePeerAttestation = Object.freeze({
  tailnetName: 'example-tailnet.ts.net',
  stableNodeId: 'stable_node_0001',
  nodePublicKey: `nodekey:${'1'.repeat(64)}`,
  address: '100.72.18.9',
  addressFamily: 'IPV4',
  displayName: 'trusted-gpu',
  operatingSystem: 'windows',
  observedAt: OBSERVED_AT,
  fingerprint: 'd'.repeat(64),
});
const GRANT_TEMPLATE_HASH = hashNativeOllamaGrantTemplate(
  renderNativeOllamaGrantTemplate(PORTAL_TAILNET_IP, ATTESTED_PEER.address),
);

function serverNetworkStatus() {
  return {
    installed: true,
    version: '1.98.9',
    daemonActive: true,
    backendState: 'Running',
    running: true,
    tailnetName: ATTESTED_PEER.tailnetName,
    hostName: 'bridgesllm-portal',
    tailnetIp: PORTAL_TAILNET_IP,
    loginUrl: null,
  };
}

function inventory(
  peers: readonly TailscalePeerAttestation[] = [ATTESTED_PEER],
): TailscalePeerInventory {
  return Object.freeze({
    tailnetName: 'example-tailnet.ts.net',
    observedAt: OBSERVED_AT,
    peers: Object.freeze([...peers]),
  });
}

function binding(
  overrides: Partial<PublicNativeOllamaBindingSnapshot> = {},
): PublicNativeOllamaBindingSnapshot {
  return {
    id: 'native-binding-1',
    purposeId: 'PRIMARY',
    generation: 1,
    version: 1,
    state: NativeOllamaBackendBindingState.ACTIVE,
    tailnetName: ATTESTED_PEER.tailnetName,
    stableNodeId: ATTESTED_PEER.stableNodeId,
    nodePublicKey: ATTESTED_PEER.nodePublicKey,
    observedAddress: ATTESTED_PEER.address,
    addressFamily: OllamaBackendAddressFamily.IPV4,
    servePort: NATIVE_OLLAMA_SERVE_PORT,
    bindingFingerprint: `native-ollama-binding:v1:sha256:${'c'.repeat(64)}`,
    selectedModel: null,
    selectedModelDigest: null,
    grantPeerAttestationFingerprint: ATTESTED_PEER.fingerprint,
    grantTemplateHash: GRANT_TEMPLATE_HASH,
    grantAcknowledgedAt: new Date('2026-07-26T17:59:00.000Z'),
    grantAcknowledgedBy: 'owner-user-id',
    legacyHelperRetirementAcknowledgedAt: null,
    legacyHelperRetirementAcknowledgedBy: null,
    legacyHelperRetirementEvidence: null,
    configuredByUserId: 'owner-user-id',
    observedAt: new Date(OBSERVED_AT),
    verifiedAt: new Date('2026-07-26T18:00:05.000Z'),
    activatedAt: new Date('2026-07-26T18:00:05.000Z'),
    disconnectedAt: null,
    removedAt: null,
    createdAt: new Date('2026-07-26T18:00:05.000Z'),
    updatedAt: new Date('2026-07-26T18:00:05.000Z'),
    ...overrides,
  };
}

function bindingView(
  authority: PublicNativeOllamaBindingSnapshot | null,
): PublicNativeOllamaBindingView {
  return { purposeId: 'PRIMARY', authority };
}

function jsonResponse(value: unknown, statusCode = 200) {
  return Object.freeze({
    statusCode,
    headers: Object.freeze({ 'content-type': 'application/json' }),
    body: Buffer.from(JSON.stringify(value), 'utf8'),
  });
}

function mutationFence() {
  return jest.fn(async (operation: () => unknown) => operation());
}

function runLease() {
  return jest.fn(async (operation: () => unknown) => operation());
}

function attestedResult(peer: TailscalePeerAttestation = ATTESTED_PEER) {
  return Object.freeze({
    state: 'ATTESTED' as const,
    requiresBindingGenerationAdvance: false as const,
    attestation: peer,
  });
}

test('connect trusts only stableNodeId, probes server-attested address:11435, and allows zero models', async () => {
  const request = jest.fn(async (input: any) => {
    if (input.path === '/api/version') return jsonResponse({ version: '0.11.7' });
    if (input.path === '/api/tags') return jsonResponse({ models: [] });
    throw new Error(`unexpected path ${input.path}`);
  });
  const created = binding();
  const createBinding = jest.fn(async () => created);
  const withMutationFence = mutationFence();
  const dependencies: NativeOllamaBackendDependencies = {
    listPeers: jest.fn(async () => inventory()),
    readBinding: jest.fn(async () => bindingView(null)),
    request: request as any,
    createBinding: createBinding as any,
    withMutationFence: withMutationFence as any,
    readServerNetworkStatus: jest.fn(async () => serverNetworkStatus()),
    now: () => new Date(NOW),
  };

  const result = await connectNativeOllamaBackend({
    stableNodeId: ATTESTED_PEER.stableNodeId,
    expectedAuthorityGeneration: null,
    expectedAuthorityVersion: null,
    expectedPeerAttestationFingerprint: ATTESTED_PEER.fingerprint,
    expectedGrantTemplateHash: GRANT_TEMPLATE_HASH,
    grantAcknowledged: true,
    configuredByUserId: 'owner-user-id',
    // Runtime callers can submit extra JSON keys, but none are part of the
    // accepted contract and none can influence the server-derived endpoint.
    address: '169.254.169.254',
    nodePublicKey: `nodekey:${'9'.repeat(64)}`,
    tailnetName: 'attacker.example',
  } as any, dependencies);

  expect(result.probe).toMatchObject({
    ollamaVersion: '0.11.7',
    models: [],
    peer: {
      stableNodeId: ATTESTED_PEER.stableNodeId,
      nodePublicKey: ATTESTED_PEER.nodePublicKey,
      observedAddress: ATTESTED_PEER.address,
    },
  });
  expect(request).toHaveBeenCalledTimes(2);
  for (const [transportInput] of request.mock.calls) {
    expect(transportInput.endpoint).toEqual({
      address: ATTESTED_PEER.address,
      family: 4,
      port: 11435,
    });
    expect(JSON.stringify(transportInput)).not.toContain('169.254.169.254');
    expect(JSON.stringify(transportInput)).not.toContain('attacker.example');
  }
  expect(request.mock.calls.map(([input]) => [input.path, input.method])).toEqual([
    ['/api/version', 'GET'],
    ['/api/tags', 'GET'],
  ]);
  expect(createBinding).toHaveBeenCalledWith(expect.objectContaining({
    expectedAuthorityGeneration: null,
    expectedAuthorityVersion: null,
    tailnetName: ATTESTED_PEER.tailnetName,
    stableNodeId: ATTESTED_PEER.stableNodeId,
    nodePublicKey: ATTESTED_PEER.nodePublicKey,
    observedAddress: ATTESTED_PEER.address,
    servePort: 11435,
    selectedModel: null,
    selectedModelDigest: null,
    grantPeerAttestationFingerprint: ATTESTED_PEER.fingerprint,
    grantTemplateHash: GRANT_TEMPLATE_HASH,
    grantAcknowledgedBy: 'owner-user-id',
    configuredByUserId: 'owner-user-id',
  }));
  expect(withMutationFence).toHaveBeenCalledTimes(1);
});

test('connect rejects a missing Grant acknowledgement before attestation or mutation', async () => {
  const listPeers = jest.fn(async () => inventory());
  const createBinding = jest.fn();
  const withMutationFence = mutationFence();

  await expect(connectNativeOllamaBackend({
    stableNodeId: ATTESTED_PEER.stableNodeId,
    expectedAuthorityGeneration: null,
    expectedAuthorityVersion: null,
    expectedPeerAttestationFingerprint: ATTESTED_PEER.fingerprint,
    expectedGrantTemplateHash: GRANT_TEMPLATE_HASH,
    grantAcknowledged: false,
    configuredByUserId: 'owner-user-id',
  }, {
    listPeers,
    createBinding: createBinding as any,
    withMutationFence: withMutationFence as any,
  })).rejects.toEqual(new NativeOllamaBackendError(
    'GRANT_ACKNOWLEDGEMENT_REQUIRED',
    400,
  ));
  expect(withMutationFence).not.toHaveBeenCalled();
  expect(listPeers).not.toHaveBeenCalled();
  expect(createBinding).not.toHaveBeenCalled();
});

test('connect enforces the exact current native authority CAS before probing', async () => {
  const current = binding({ generation: 7, version: 3 });
  const listPeers = jest.fn(async () => inventory());
  const request = jest.fn();
  const createBinding = jest.fn();

  await expect(connectNativeOllamaBackend({
    stableNodeId: ATTESTED_PEER.stableNodeId,
    expectedAuthorityGeneration: 7,
    expectedAuthorityVersion: 2,
    expectedPeerAttestationFingerprint: ATTESTED_PEER.fingerprint,
    expectedGrantTemplateHash: GRANT_TEMPLATE_HASH,
    grantAcknowledged: true,
    configuredByUserId: 'owner-user-id',
  }, {
    readBinding: jest.fn(async () => bindingView(current)),
    listPeers,
    request: request as any,
    createBinding: createBinding as any,
    withMutationFence: mutationFence() as any,
    now: () => new Date(NOW),
  })).rejects.toMatchObject({ code: 'AUTHORITY_CHANGED', statusCode: 409 });
  expect(listPeers).not.toHaveBeenCalled();
  expect(request).not.toHaveBeenCalled();
  expect(createBinding).not.toHaveBeenCalled();
});

test.each([
  {
    label: 'peer attestation',
    peers: [Object.freeze({
      ...ATTESTED_PEER,
      address: '100.72.18.10',
      fingerprint: 'e'.repeat(64),
    })],
    network: serverNetworkStatus(),
  },
  {
    label: 'Portal source address and exact Grant template',
    peers: [ATTESTED_PEER],
    network: {
      ...serverNetworkStatus(),
      tailnetIp: '100.64.10.21',
    },
  },
])('connect rejects a stale acknowledged $label inside the mutation fence', async ({
  peers,
  network,
}) => {
  const request = jest.fn();
  const createBinding = jest.fn();
  const withMutationFence = mutationFence();

  await expect(connectNativeOllamaBackend({
    stableNodeId: ATTESTED_PEER.stableNodeId,
    expectedAuthorityGeneration: null,
    expectedAuthorityVersion: null,
    expectedPeerAttestationFingerprint: ATTESTED_PEER.fingerprint,
    expectedGrantTemplateHash: GRANT_TEMPLATE_HASH,
    grantAcknowledged: true,
    configuredByUserId: 'owner-user-id',
  }, {
    readBinding: jest.fn(async () => bindingView(null)),
    listPeers: jest.fn(async () => inventory(peers)),
    readServerNetworkStatus: jest.fn(async () => network),
    request: request as any,
    createBinding: createBinding as any,
    withMutationFence: withMutationFence as any,
    now: () => new Date(NOW),
  })).rejects.toMatchObject({
    code: 'GRANT_SNAPSHOT_CHANGED',
    statusCode: 409,
  });
  expect(withMutationFence).toHaveBeenCalledTimes(1);
  expect(request).not.toHaveBeenCalled();
  expect(createBinding).not.toHaveBeenCalled();
});

test('standalone probe selects exactly one current peer by stableNodeId', async () => {
  const request = jest.fn(async (input: any) => (
    input.path === '/api/version'
      ? jsonResponse({ version: '0.11.7' })
      : jsonResponse({ models: [] })
  ));

  await expect(probeNativeOllamaPeer({
    stableNodeId: 'missing_node_001',
  }, {
    listPeers: jest.fn(async () => inventory()),
    request: request as any,
    now: () => new Date(NOW),
  })).rejects.toMatchObject({ code: 'PEER_NOT_FOUND' });
  expect(request).not.toHaveBeenCalled();
});

test('reverify requires a fresh Grant acknowledgement after peer address rotation', async () => {
  const current = binding({ version: 4 });
  const rotatedPeer = Object.freeze({
    ...ATTESTED_PEER,
    address: '100.72.18.44',
    observedAt: '2026-07-26T18:02:00.000Z',
    fingerprint: 'e'.repeat(64),
  });
  const request = jest.fn();
  const reverifyBinding = jest.fn();

  await expect(reverifyNativeOllamaBackend({
    generation: current.generation,
    expectedVersion: current.version,
  }, {
    readBinding: jest.fn(async () => bindingView(current)),
    reattestPeer: jest.fn(async () => attestedResult(rotatedPeer)) as any,
    readServerNetworkStatus: jest.fn(async () => serverNetworkStatus()),
    request: request as any,
    reverifyBinding: reverifyBinding as any,
    withMutationFence: mutationFence() as any,
    now: () => new Date('2026-07-26T18:03:00.000Z'),
  })).rejects.toMatchObject({
    code: 'GRANT_SNAPSHOT_CHANGED',
    statusCode: 409,
  });
  expect(request).not.toHaveBeenCalled();
  expect(reverifyBinding).not.toHaveBeenCalled();
});

test('reverify blocks NodeKey change before any Ollama request or binding write', async () => {
  const current = binding({ state: NativeOllamaBackendBindingState.DISCONNECTED });
  const request = jest.fn();
  const reverifyBinding = jest.fn();

  await expect(reverifyNativeOllamaBackend({
    generation: current.generation,
    expectedVersion: current.version,
  }, {
    readBinding: jest.fn(async () => bindingView(current)),
    reattestPeer: jest.fn(async () => Object.freeze({
      state: 'BINDING_GENERATION_ADVANCE_REQUIRED' as const,
      requiresBindingGenerationAdvance: true as const,
      changes: Object.freeze(['NODE_PUBLIC_KEY'] as const),
      candidate: Object.freeze({
        ...ATTESTED_PEER,
        nodePublicKey: `nodekey:${'2'.repeat(64)}`,
      }),
    })) as any,
    request: request as any,
    reverifyBinding: reverifyBinding as any,
    withMutationFence: mutationFence() as any,
  })).rejects.toMatchObject({ code: 'PEER_IDENTITY_CHANGED' });
  expect(request).not.toHaveBeenCalled();
  expect(reverifyBinding).not.toHaveBeenCalled();
});

test('lists bounded installed models under a run lease and normalizes exact digests', async () => {
  const current = binding();
  const request = jest.fn(async () => jsonResponse({
    models: [
      {
        name: 'zeta:latest',
        model: 'zeta:latest',
        digest: 'b'.repeat(64),
        size: 200,
        modified_at: '2026-07-25T12:00:00Z',
      },
      {
        name: 'alpha:latest',
        digest: MODEL_DIGEST,
        size: 100,
      },
    ],
  }));
  const withRunLease = runLease();

  const result = await listNativeOllamaInstalledModels({
    generation: 1,
    expectedVersion: 1,
  }, {
    readBinding: jest.fn(async () => bindingView(current)),
    reattestPeer: jest.fn(async () => attestedResult()) as any,
    readServerNetworkStatus: jest.fn(async () => serverNetworkStatus()),
    request: request as any,
    withRunLease: withRunLease as any,
  });

  expect(result.models).toEqual([
    {
      name: 'alpha:latest',
      digest: MODEL_DIGEST,
      sizeBytes: 100,
      modifiedAt: null,
    },
    {
      name: 'zeta:latest',
      digest: OTHER_DIGEST,
      sizeBytes: 200,
      modifiedAt: '2026-07-25T12:00:00.000Z',
    },
  ]);
  expect(request).toHaveBeenCalledWith(expect.objectContaining({
    endpoint: {
      address: ATTESTED_PEER.address,
      family: 4,
      port: 11435,
    },
    path: '/api/tags',
    method: 'GET',
  }));
  expect(withRunLease).toHaveBeenCalledTimes(1);
});

test('selects a model from an unselected ACTIVE authority after digest and bounded show checks', async () => {
  const current = binding({ selectedModel: null, selectedModelDigest: null });
  const request = jest.fn(async (input: any) => {
    if (input.path === '/api/tags') {
      return jsonResponse({
        models: [{ name: 'qwen3:8b', digest: MODEL_DIGEST, size: 1024 }],
      });
    }
    if (input.path === '/api/show') {
      return jsonResponse({
        capabilities: ['completion', 'tools', 'tools'],
        details: {
          format: 'gguf',
          family: 'qwen3',
          parameter_size: '8B',
          quantization_level: 'Q4_K_M',
        },
        model_info: { 'general.architecture': 'qwen3' },
      });
    }
    if (input.path === '/api/generate') {
      return jsonResponse({
        model: 'qwen3:8b',
        response: 'A',
        done: true,
        eval_count: 1,
      });
    }
    throw new Error(`unexpected path ${input.path}`);
  });
  const selectedBinding = binding({
    version: 2,
    selectedModel: 'qwen3:8b',
    selectedModelDigest: MODEL_DIGEST,
  });
  const selectModel = jest.fn(async () => selectedBinding);

  const result = await selectNativeOllamaBackendModel({
    generation: 1,
    expectedVersion: 1,
    model: 'qwen3:8b',
    expectedDigest: MODEL_DIGEST,
  }, {
    readBinding: jest.fn(async () => bindingView(current)),
    reattestPeer: jest.fn(async () => attestedResult()) as any,
    readServerNetworkStatus: jest.fn(async () => serverNetworkStatus()),
    request: request as any,
    selectModel: selectModel as any,
    withMutationFence: mutationFence() as any,
    now: () => new Date(NOW),
  });

  expect(request.mock.calls.map(([input]) => input.path)).toEqual([
    '/api/tags',
    '/api/show',
    '/api/generate',
    '/api/tags',
  ]);
  expect(JSON.parse(request.mock.calls[1][0].body)).toEqual({
    model: 'qwen3:8b',
    verbose: false,
  });
  expect(result.inspection).toEqual({
    capabilities: ['completion', 'tools'],
    format: 'gguf',
    family: 'qwen3',
    parameterSize: '8B',
    quantizationLevel: 'Q4_K_M',
  });
  expect(JSON.parse(request.mock.calls[2][0].body)).toEqual({
    model: 'qwen3:8b',
    prompt: 'Reply with one character.',
    stream: false,
    think: false,
    options: {
      num_predict: 1,
      temperature: 0,
    },
  });
  expect(selectModel).toHaveBeenCalledWith({
    generation: 1,
    expectedVersion: 1,
    selectedModel: 'qwen3:8b',
    selectedModelDigest: MODEL_DIGEST,
    verifiedAt: NOW,
  });
});

test('model selection enforces one aggregate deadline and never persists after it', async () => {
  jest.useFakeTimers();
  try {
    const current = binding({ selectedModel: null, selectedModelDigest: null });
    let markGenerateStarted!: () => void;
    const generateStarted = new Promise<void>((resolve) => {
      markGenerateStarted = resolve;
    });
    const request = jest.fn(async (input: any) => {
      if (input.path === '/api/tags') {
        return jsonResponse({
          models: [{ name: 'qwen3:8b', digest: MODEL_DIGEST }],
        });
      }
      if (input.path === '/api/show') {
        return jsonResponse({
          capabilities: ['completion'],
          details: { format: 'gguf' },
        });
      }
      if (input.path === '/api/generate') {
        markGenerateStarted();
        return new Promise((_resolve, reject) => {
          const rejectAborted = () => reject(
            new NativeOllamaTransportError(
              'ABORTED',
              'The aggregate selection request was aborted',
            ),
          );
          if (input.signal.aborted) {
            rejectAborted();
          } else {
            input.signal.addEventListener('abort', rejectAborted, {
              once: true,
            });
          }
        });
      }
      throw new Error(`unexpected path ${input.path}`);
    });
    const selectModel = jest.fn();

    const selection = selectNativeOllamaBackendModel({
      generation: 1,
      expectedVersion: 1,
      model: 'qwen3:8b',
      expectedDigest: MODEL_DIGEST,
    }, {
      readBinding: jest.fn(async () => bindingView(current)),
      reattestPeer: jest.fn(async () => attestedResult()) as any,
      readServerNetworkStatus: jest.fn(async () => serverNetworkStatus()),
      request: request as any,
      selectModel: selectModel as any,
      withMutationFence: mutationFence() as any,
    });
    const rejection = expect(selection).rejects.toMatchObject({
      code: 'MODEL_SELECTION_TIMEOUT',
      httpStatus: 504,
    });
    await generateStarted;
    await jest.advanceTimersByTimeAsync(
      NATIVE_OLLAMA_MODEL_SELECTION_TIMEOUT_MS,
    );
    await rejection;

    expect(selectModel).not.toHaveBeenCalled();
  } finally {
    jest.useRealTimers();
  }
});

test('model selection returns the authoritative CAS after entering its commit point', async () => {
  jest.useFakeTimers();
  try {
    const current = binding({ selectedModel: null, selectedModelDigest: null });
    const selectedBinding = binding({
      version: 2,
      selectedModel: 'qwen3:8b',
      selectedModelDigest: MODEL_DIGEST,
    });
    const request = jest.fn(async (input: any) => {
      if (input.path === '/api/tags') {
        return jsonResponse({
          models: [{ name: 'qwen3:8b', digest: MODEL_DIGEST }],
        });
      }
      if (input.path === '/api/show') {
        return jsonResponse({
          capabilities: ['completion'],
          details: { format: 'gguf' },
        });
      }
      if (input.path === '/api/generate') {
        return jsonResponse({
          model: 'qwen3:8b',
          response: 'A',
          done: true,
          eval_count: 1,
        });
      }
      throw new Error(`unexpected path ${input.path}`);
    });
    let resolveCommit!: (
      value: PublicNativeOllamaBindingSnapshot,
    ) => void;
    const commitResult = new Promise<PublicNativeOllamaBindingSnapshot>(
      (resolve) => {
        resolveCommit = resolve;
      },
    );
    let markCommitStarted!: () => void;
    const commitStarted = new Promise<void>((resolve) => {
      markCommitStarted = resolve;
    });
    const selectModel = jest.fn(async () => {
      markCommitStarted();
      return commitResult;
    });

    const selection = selectNativeOllamaBackendModel({
      generation: 1,
      expectedVersion: 1,
      model: 'qwen3:8b',
      expectedDigest: MODEL_DIGEST,
    }, {
      readBinding: jest.fn(async () => bindingView(current)),
      reattestPeer: jest.fn(async () => attestedResult()) as any,
      readServerNetworkStatus: jest.fn(async () => serverNetworkStatus()),
      request: request as any,
      selectModel: selectModel as any,
      withMutationFence: mutationFence() as any,
      now: () => new Date(NOW),
    });
    await commitStarted;
    await jest.advanceTimersByTimeAsync(
      NATIVE_OLLAMA_MODEL_SELECTION_TIMEOUT_MS,
    );
    resolveCommit(selectedBinding);

    await expect(selection).resolves.toMatchObject({
      binding: selectedBinding,
      model: {
        name: 'qwen3:8b',
        digest: MODEL_DIGEST,
      },
    });
    expect(selectModel).toHaveBeenCalledTimes(1);
  } finally {
    jest.useRealTimers();
  }
});

test('selection stops on an exact digest mismatch without calling show or mutating', async () => {
  const current = binding();
  const request = jest.fn(async () => jsonResponse({
    models: [{ name: 'qwen3:8b', digest: OTHER_DIGEST }],
  }));
  const selectModel = jest.fn();

  await expect(selectNativeOllamaBackendModel({
    generation: 1,
    expectedVersion: 1,
    model: 'qwen3:8b',
    expectedDigest: MODEL_DIGEST,
  }, {
    readBinding: jest.fn(async () => bindingView(current)),
    reattestPeer: jest.fn(async () => attestedResult()) as any,
    readServerNetworkStatus: jest.fn(async () => serverNetworkStatus()),
    request: request as any,
    selectModel: selectModel as any,
    withMutationFence: mutationFence() as any,
  })).rejects.toMatchObject({ code: 'MODEL_DIGEST_MISMATCH' });
  expect(request).toHaveBeenCalledTimes(1);
  expect(selectModel).not.toHaveBeenCalled();
});

test('selection keeps the current model when bounded one-token inference fails', async () => {
  const current = binding({
    selectedModel: 'llama3.2:latest',
    selectedModelDigest: OTHER_DIGEST,
  });
  const request = jest.fn(async (input: any) => {
    if (input.path === '/api/tags') {
      return jsonResponse({
        models: [{ name: 'qwen3:8b', digest: MODEL_DIGEST }],
      });
    }
    if (input.path === '/api/show') {
      return jsonResponse({
        capabilities: ['completion'],
        details: { format: 'gguf' },
      });
    }
    if (input.path === '/api/generate') {
      return jsonResponse({
        model: 'qwen3:8b',
        response: '',
        done: false,
      });
    }
    throw new Error(`unexpected path ${input.path}`);
  });
  const selectModel = jest.fn();

  await expect(selectNativeOllamaBackendModel({
    generation: 1,
    expectedVersion: 1,
    model: 'qwen3:8b',
    expectedDigest: MODEL_DIGEST,
  }, {
    readBinding: jest.fn(async () => bindingView(current)),
    reattestPeer: jest.fn(async () => attestedResult()) as any,
    readServerNetworkStatus: jest.fn(async () => serverNetworkStatus()),
    request: request as any,
    selectModel: selectModel as any,
    withMutationFence: mutationFence() as any,
  })).rejects.toMatchObject({ code: 'MODEL_TEST_FAILED' });

  expect(request.mock.calls.map(([input]) => input.path)).toEqual([
    '/api/tags',
    '/api/show',
    '/api/generate',
  ]);
  expect(selectModel).not.toHaveBeenCalled();
});

test('selection rechecks the digest after inference and retains the current model on retag', async () => {
  const current = binding({
    selectedModel: 'llama3.2:latest',
    selectedModelDigest: OTHER_DIGEST,
  });
  let tagReads = 0;
  const request = jest.fn(async (input: any) => {
    if (input.path === '/api/tags') {
      tagReads += 1;
      return jsonResponse({
        models: [{
          name: 'qwen3:8b',
          digest: tagReads === 1 ? MODEL_DIGEST : OTHER_DIGEST,
        }],
      });
    }
    if (input.path === '/api/show') {
      return jsonResponse({
        capabilities: ['completion'],
        details: { format: 'gguf' },
      });
    }
    if (input.path === '/api/generate') {
      return jsonResponse({
        model: 'qwen3:8b',
        response: 'A',
        done: true,
        eval_count: 1,
      });
    }
    throw new Error(`unexpected path ${input.path}`);
  });
  const selectModel = jest.fn();

  await expect(selectNativeOllamaBackendModel({
    generation: 1,
    expectedVersion: 1,
    model: 'qwen3:8b',
    expectedDigest: MODEL_DIGEST,
  }, {
    readBinding: jest.fn(async () => bindingView(current)),
    reattestPeer: jest.fn(async () => attestedResult()) as any,
    readServerNetworkStatus: jest.fn(async () => serverNetworkStatus()),
    request: request as any,
    selectModel: selectModel as any,
    withMutationFence: mutationFence() as any,
  })).rejects.toMatchObject({ code: 'MODEL_DIGEST_MISMATCH' });

  expect(request.mock.calls.map(([input]) => input.path)).toEqual([
    '/api/tags',
    '/api/show',
    '/api/generate',
    '/api/tags',
  ]);
  expect(selectModel).not.toHaveBeenCalled();
});

test('selection rejects an over-wide show response before persistence', async () => {
  const current = binding();
  const request = jest.fn(async (input: any) => (
    input.path === '/api/tags'
      ? jsonResponse({ models: [{ name: 'qwen3:8b', digest: MODEL_DIGEST }] })
      : jsonResponse({
        capabilities: Array.from({ length: 65 }, (_, index) => `cap-${index}`),
      })
  ));
  const selectModel = jest.fn();

  await expect(selectNativeOllamaBackendModel({
    generation: 1,
    expectedVersion: 1,
    model: 'qwen3:8b',
    expectedDigest: MODEL_DIGEST,
  }, {
    readBinding: jest.fn(async () => bindingView(current)),
    reattestPeer: jest.fn(async () => attestedResult()) as any,
    readServerNetworkStatus: jest.fn(async () => serverNetworkStatus()),
    request: request as any,
    selectModel: selectModel as any,
    withMutationFence: mutationFence() as any,
  })).rejects.toMatchObject({ code: 'OLLAMA_RESPONSE_INVALID' });
  expect(request.mock.calls.map(([input]) => input.path)).toEqual([
    '/api/tags',
    '/api/show',
  ]);
  expect(selectModel).not.toHaveBeenCalled();
});

test('clear model is an exact fenced CAS and requires no peer secret or network call', async () => {
  const current = binding({
    selectedModel: 'qwen3:8b',
    selectedModelDigest: MODEL_DIGEST,
  });
  const cleared = binding({ version: 2 });
  const clearModel = jest.fn(async () => cleared);
  const request = jest.fn();
  const withMutationFence = mutationFence();

  const result = await clearNativeOllamaBackendModel({
    generation: 1,
    expectedVersion: 1,
  }, {
    readBinding: jest.fn(async () => bindingView(current)),
    clearModel: clearModel as any,
    request: request as any,
    withMutationFence: withMutationFence as any,
  });

  expect(result.selectedModel).toBeNull();
  expect(clearModel).toHaveBeenCalledWith({ generation: 1, expectedVersion: 1 });
  expect(request).not.toHaveBeenCalled();
  expect(withMutationFence).toHaveBeenCalledTimes(1);
});

test('runs one selected-model token with fixed body, timeout, response cap, and run lease', async () => {
  const current = binding({
    selectedModel: 'qwen3:8b',
    selectedModelDigest: MODEL_DIGEST,
  });
  const request = jest.fn(async (input: any) => {
    if (input.path === '/api/tags') {
      return jsonResponse({
        models: [{ name: 'qwen3:8b', digest: MODEL_DIGEST }],
      });
    }
    if (input.path === '/api/generate') {
      return jsonResponse({
        model: 'qwen3:8b',
        response: 'A',
        done: true,
        eval_count: 1,
        total_duration: 1234,
      });
    }
    throw new Error(`unexpected path ${input.path}`);
  });
  const withRunLease = runLease();

  const result = await testNativeOllamaBackendModel({
    generation: 1,
    expectedVersion: 1,
  }, {
    readBinding: jest.fn(async () => bindingView(current)),
    reattestPeer: jest.fn(async () => attestedResult()) as any,
    readServerNetworkStatus: jest.fn(async () => serverNetworkStatus()),
    request: request as any,
    withRunLease: withRunLease as any,
  });

  expect(result).toEqual({
    model: 'qwen3:8b',
    digest: MODEL_DIGEST,
    response: 'A',
    thinking: null,
    evalCount: 1,
    totalDurationNs: 1234,
  });
  const generate = request.mock.calls.find(([input]) => input.path === '/api/generate')![0];
  expect(generate).toMatchObject({
    endpoint: {
      address: ATTESTED_PEER.address,
      family: 4,
      port: 11435,
    },
    timeoutMs: 120_000,
    maxResponseBytes: 64 * 1024,
  });
  expect(JSON.parse(generate.body)).toEqual({
    model: 'qwen3:8b',
    prompt: 'Reply with one character.',
    stream: false,
    think: false,
    options: {
      num_predict: 1,
      temperature: 0,
    },
  });
  expect(withRunLease).toHaveBeenCalledTimes(1);
});

test('accepts one bounded thinking token when a reasoning model returns no response text', async () => {
  const current = binding({
    selectedModel: 'deepseek-r1:8b',
    selectedModelDigest: MODEL_DIGEST,
  });
  const request = jest.fn(async (input: any) => {
    if (input.path === '/api/tags') {
      return jsonResponse({
        models: [{
          name: 'deepseek-r1:8b',
          digest: MODEL_DIGEST,
        }],
      });
    }
    if (input.path === '/api/generate') {
      return jsonResponse({
        model: 'deepseek-r1:8b',
        response: '',
        thinking: 'A',
        done: true,
        eval_count: 1,
      });
    }
    throw new Error(`unexpected path ${input.path}`);
  });

  await expect(testNativeOllamaBackendModel({
    generation: 1,
    expectedVersion: 1,
  }, {
    readBinding: jest.fn(async () => bindingView(current)),
    reattestPeer: jest.fn(async () => attestedResult()) as any,
    readServerNetworkStatus: jest.fn(async () => serverNetworkStatus()),
    request: request as any,
    withRunLease: runLease() as any,
  })).resolves.toEqual({
    model: 'deepseek-r1:8b',
    digest: MODEL_DIGEST,
    response: '',
    thinking: 'A',
    evalCount: 1,
    totalDurationNs: null,
  });
});

test('rejects malformed or over-wide combined response and thinking evidence', async () => {
  const current = binding({
    selectedModel: 'deepseek-r1:8b',
    selectedModelDigest: MODEL_DIGEST,
  });
  const responses = [{
    model: 'deepseek-r1:8b',
    response: '',
    thinking: 7,
    done: true,
    eval_count: 1,
  }, {
    model: 'deepseek-r1:8b',
    response: 'a'.repeat(2_500),
    thinking: 'b'.repeat(2_500),
    done: true,
    eval_count: 1,
  }];

  for (const generated of responses) {
    const request = jest.fn(async (input: any) => (
      input.path === '/api/tags'
        ? jsonResponse({
          models: [{
            name: 'deepseek-r1:8b',
            digest: MODEL_DIGEST,
          }],
        })
        : jsonResponse(generated)
    ));
    await expect(testNativeOllamaBackendModel({
      generation: 1,
      expectedVersion: 1,
    }, {
      readBinding: jest.fn(async () => bindingView(current)),
      reattestPeer: jest.fn(async () => attestedResult()) as any,
      readServerNetworkStatus: jest.fn(async () => serverNetworkStatus()),
      request: request as any,
      withRunLease: runLease() as any,
    })).rejects.toMatchObject({ code: 'MODEL_TEST_FAILED' });
  }
});

test('one-token test requires a selected model but not a pairing secret', async () => {
  const request = jest.fn();
  await expect(testNativeOllamaBackendModel({
    generation: 1,
    expectedVersion: 1,
  }, {
    readBinding: jest.fn(async () => bindingView(binding())),
    request: request as any,
    withRunLease: runLease() as any,
  })).rejects.toMatchObject({ code: 'MODEL_NOT_SELECTED' });
  expect(request).not.toHaveBeenCalled();
});

test('returns a bounded /api/ps runtime diagnostic from the exact reattested peer', async () => {
  const current = binding();
  const request = jest.fn(async () => jsonResponse({
    models: [{
      name: 'qwen3:8b',
      digest: MODEL_DIGEST,
      size: 1_000,
      size_vram: 900,
      expires_at: '2026-07-26T19:00:00Z',
    }],
  }));
  const withRunLease = runLease();

  const result = await diagnoseNativeOllamaBackend({
    generation: 1,
    expectedVersion: 1,
  }, {
    readBinding: jest.fn(async () => bindingView(current)),
    reattestPeer: jest.fn(async () => attestedResult()) as any,
    readServerNetworkStatus: jest.fn(async () => serverNetworkStatus()),
    request: request as any,
    withRunLease: withRunLease as any,
  });

  expect(result.runningModels).toEqual([{
    name: 'qwen3:8b',
    digest: MODEL_DIGEST,
    sizeBytes: 1_000,
    sizeVramBytes: 900,
    expiresAt: '2026-07-26T19:00:00.000Z',
  }]);
  expect(request).toHaveBeenCalledWith(expect.objectContaining({
    endpoint: {
      address: ATTESTED_PEER.address,
      family: 4,
      port: 11435,
    },
    path: '/api/ps',
    method: 'GET',
  }));
  expect(withRunLease).toHaveBeenCalledTimes(1);
});

test('maps a single literal transport failure without DNS, retry, proxy, redirect, or fallback', async () => {
  const request = jest.fn(async (_input: any) => {
    throw new NativeOllamaTransportError(
      'CONNECTION_FAILED',
      'Ollama connection failed',
    );
  });

  await expect(probeNativeOllamaPeer({
    stableNodeId: ATTESTED_PEER.stableNodeId,
  }, {
    listPeers: jest.fn(async () => inventory()),
    request: request as any,
    now: () => new Date(NOW),
  })).rejects.toMatchObject({
    code: 'OLLAMA_UNAVAILABLE',
    statusCode: 503,
  });
  expect(request).toHaveBeenCalledTimes(1);
  expect(request.mock.calls[0][0].endpoint).toEqual({
    address: ATTESTED_PEER.address,
    family: 4,
    port: 11435,
  });
});
