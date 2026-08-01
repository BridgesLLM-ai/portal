import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  ollamaTailnetAPI,
  ollamaTailnetCas,
  ollamaTailnetHasDefinitiveHttpResponse,
} from './ollamaTailnet';

const mocks = vi.hoisted(() => ({
  get: vi.fn(),
  post: vi.fn(),
  put: vi.fn(),
  delete: vi.fn(),
}));

vi.mock('./client', () => ({
  default: {
    get: mocks.get,
    post: mocks.post,
    put: mocks.put,
    delete: mocks.delete,
  },
}));

const timestamp = '2026-07-26T16:00:00.000Z';
const digest = `sha256:${'a'.repeat(64)}`;
const peerFingerprint = 'b'.repeat(64);
const grantTemplateHash = `sha256:${'c'.repeat(64)}`;
const pullOperationId = '123e4567-e89b-42d3-a456-426614174000';
const exactGrantTemplate = JSON.stringify({
  grants: [{
    src: ['100.64.10.20'],
    dst: ['100.64.0.7'],
    ip: ['tcp:11435'],
  }],
}, null, 2);

function binding(overrides: Record<string, unknown> = {}) {
  return {
    id: 'binding-1',
    purposeId: 'PRIMARY',
    generation: 7,
    version: 3,
    state: 'ACTIVE',
    tailnetName: 'example.ts.net',
    stableNodeId: 'stable-node-windows',
    nodePublicKey: `nodekey:${'b'.repeat(64)}`,
    address: '100.64.0.7',
    addressFamily: 'IPV4',
    servePort: 11435,
    bindingFingerprint: 'binding-fingerprint-7',
    selectedModel: 'qwen3.5:4b',
    selectedModelDigest: digest,
    displayName: 'GPU workstation',
    observedAt: timestamp,
    verifiedAt: timestamp,
    activatedAt: timestamp,
    grantAcknowledgedAt: timestamp,
    grantSnapshotState: 'CURRENT',
    legacyHelperRetirementAcknowledgedAt: null,
    legacyHelperRetirementEvidence: null,
    updatedAt: timestamp,
    removedAt: null,
    ...overrides,
  };
}

function statusResponse() {
  return {
    binding: {
      purposeId: 'PRIMARY',
      authority: binding(),
    },
    tailscale: {
      available: true,
      inventory: {
        tailnetName: 'example.ts.net',
        observedAt: timestamp,
        peers: [{
          tailnetName: 'example.ts.net',
          stableNodeId: 'stable-node-windows',
          nodePublicKey: `nodekey:${'b'.repeat(64)}`,
          address: '100.64.0.7',
          addressFamily: 'IPV4',
          displayName: 'GPU workstation',
          operatingSystem: 'windows',
          observedAt: timestamp,
          fingerprint: peerFingerprint,
          grantTemplate: exactGrantTemplate,
          grantTemplateHash,
          online: true,
        }],
      },
      error: null,
    },
    setup: {
      servePort: 11435,
      windowsBundle: '/api/ollama/tailnet/setup-bundle.zip',
      serveCommand: 'tailscale serve --bg --tcp=11435 tcp://127.0.0.1:11434',
      removeCommand: 'tailscale serve --tcp=11435 off',
      legacyHelperRetireCommand: 'Start-Here.cmd --retire-legacy-helper',
      grantTemplate: '{\n  "src": ["tag:portal"],\n  "dst": ["__BRIDGESLLM_GPU_TAILSCALE_IP__:11435"]\n}',
      grantWarning: 'Apply this exact narrow grant; do not allow the whole tailnet.',
    },
    legacyRemoteAuthorityPresent: false,
    legacyHelperRetirement: {
      required: false,
      acknowledgedAt: null,
      evidence: null,
    },
  };
}

function evidence() {
  return {
    ollamaVersion: '0.11.5',
    selectedModel: 'qwen3.5:4b',
    selectedModelDigest: digest,
    inventoryVerified: true,
    modelToolsVerified: true,
    inferenceVerified: true,
    verifiedAt: timestamp,
    checks: [{
      id: 'identity',
      label: 'Stable Tailnet identity',
      state: 'pass',
      detail: 'Exact node identity matched.',
    }],
  };
}

function pull(overrides: Record<string, unknown> = {}) {
  return {
    id: 'pull/id with space',
    operationId: pullOperationId,
    model: 'qwen3.5:4b',
    state: 'running',
    phase: 'downloading',
    status: 'pulling layer',
    digest,
    totalBytes: 1_000,
    completedBytes: 250,
    percent: 25,
    speedBytesPerSecond: 100,
    etaSeconds: 8,
    eventSeq: 4,
    updatedAt: timestamp,
    canCancel: true,
    error: null,
    authority: {
      kind: 'TAILNET',
      generation: 7,
      version: 3,
      fingerprint: 'binding-fingerprint-7',
    },
    ...overrides,
  };
}

function serverNetwork(overrides: Record<string, unknown> = {}) {
  return {
    installed: true,
    version: '1.98.9',
    daemonActive: true,
    backendState: 'Running',
    running: true,
    tailnetName: 'example.ts.net',
    hostName: 'portal-server',
    tailnetIp: '100.64.10.20',
    loginUrl: null,
    ...overrides,
  };
}

describe('ollamaTailnetAPI native Remote GPU contract', () => {
  beforeEach(() => {
    Object.values(mocks).forEach((mock) => mock.mockReset());
  });

  it('loads the bounded native status snapshot and strips private fields', async () => {
    const response = statusResponse();
    (response.binding.authority as Record<string, unknown>).pairingSecret =
      'must-not-escape';
    (response.tailscale.inventory.peers[0] as Record<string, unknown>).apiUrl =
      'http://100.64.0.7:11434';
    mocks.get.mockResolvedValue({ data: response });

    const status = await ollamaTailnetAPI.status();

    expect(mocks.get).toHaveBeenCalledWith('/ollama/tailnet/status', {
      timeout: 15_000,
    });
    expect(status.binding.authority?.servePort).toBe(11435);
    expect(status.binding.authority).not.toHaveProperty('pairingSecret');
    expect(status.tailscale.available && status.tailscale.inventory.peers[0])
      .not.toHaveProperty('apiUrl');
    expect(status.setup.windowsBundle)
      .toBe('/api/ollama/tailnet/setup-bundle.zip');
    expect(status.setup.legacyHelperRetireCommand)
      .toBe('Start-Here.cmd --retire-legacy-helper');
    expect(status.binding.authority?.grantSnapshotState).toBe('CURRENT');
    expect(status.legacyHelperRetirement.required).toBe(false);
  });

  it('reads, installs, and joins the Portal server tailnet with bounded timeouts', async () => {
    const network = {
      ...serverNetwork(),
      privateDaemonSocket: '/run/tailscale/tailscaled.sock',
    };
    mocks.get.mockResolvedValue({ data: network });
    mocks.post.mockResolvedValue({ data: network });

    const read = await ollamaTailnetAPI.serverNetwork();
    const installed = await ollamaTailnetAPI.installServerTailscale();
    const connected = await ollamaTailnetAPI.connectServerNetwork({
      authKey: 'tskey-auth-once',
    });

    expect(mocks.get).toHaveBeenCalledWith(
      '/ollama/tailnet/server-network',
      { timeout: 20_000 },
    );
    expect(mocks.post).toHaveBeenNthCalledWith(
      1,
      '/ollama/tailnet/server-network/install',
      {},
      {
        timeout: 300_000,
        _skipNetworkRetry: true,
      },
    );
    expect(mocks.post).toHaveBeenNthCalledWith(
      2,
      '/ollama/tailnet/server-network/connect',
      { authKey: 'tskey-auth-once' },
      {
        timeout: 120_000,
        _skipNetworkRetry: true,
      },
    );
    expect(read).not.toHaveProperty('privateDaemonSocket');
    expect(installed.running).toBe(true);
    expect(connected.tailnetIp).toBe('100.64.10.20');
  });

  it('rejects an unbound or malformed peer Grant snapshot', async () => {
    const response = statusResponse();
    response.tailscale.inventory.peers[0].grantTemplateHash = null as never;
    mocks.get.mockResolvedValue({ data: response });

    await expect(ollamaTailnetAPI.status()).rejects.toThrow();

    response.tailscale.inventory.peers[0].grantTemplateHash =
      'sha256:not-a-digest';
    mocks.get.mockResolvedValue({ data: response });
    await expect(ollamaTailnetAPI.status()).rejects.toThrow();
  });

  it('connects an exact stable node with a null CAS pair and grant acknowledgement', async () => {
    mocks.post.mockResolvedValue({ data: { binding: binding() } });

    await ollamaTailnetAPI.connect({
      stableNodeId: 'stable-node-windows',
      expectedGeneration: null,
      expectedVersion: null,
      expectedPeerAttestationFingerprint: peerFingerprint,
      expectedGrantTemplateHash: grantTemplateHash,
      grantAcknowledged: true,
    });

    expect(mocks.post).toHaveBeenCalledWith('/ollama/tailnet/connect', {
      stableNodeId: 'stable-node-windows',
      expectedGeneration: null,
      expectedVersion: null,
      expectedPeerAttestationFingerprint: peerFingerprint,
      expectedGrantTemplateHash: grantTemplateHash,
      grantAcknowledged: true,
    }, {
      timeout: 60_000,
      _skipNetworkRetry: true,
    });
  });

  it('rejects incomplete CAS and malformed Grant snapshot identifiers before POST', async () => {
    await expect(ollamaTailnetAPI.connect({
      stableNodeId: 'stable-node-windows',
      expectedGeneration: 7,
      expectedVersion: null,
      expectedPeerAttestationFingerprint: 'not-a-fingerprint',
      expectedGrantTemplateHash: 'sha256:not-a-hash',
      grantAcknowledged: true,
    })).rejects.toThrow();
    expect(mocks.post).not.toHaveBeenCalled();
  });

  it('uses exact CAS values for reverify, verify, model test, and removal', async () => {
    mocks.post
      .mockResolvedValueOnce({ data: { binding: binding({ version: 4 }) } })
      .mockResolvedValueOnce({
        data: { binding: binding({ version: 5 }), evidence: evidence() },
      })
      .mockResolvedValueOnce({
        data: { binding: binding({ version: 6 }), evidence: evidence() },
      });
    mocks.delete.mockResolvedValue({
      data: { binding: binding({ state: 'REMOVED', removedAt: timestamp }) },
    });

    await ollamaTailnetAPI.reverifyAuthority({
      generation: 7,
      expectedVersion: 3,
    });
    const verified = await ollamaTailnetAPI.verifyAuthority({
      generation: 7,
      expectedVersion: 4,
    });
    await ollamaTailnetAPI.testModel({
      generation: 7,
      expectedVersion: 5,
    });
    await ollamaTailnetAPI.removeAuthority({
      generation: 7,
      expectedVersion: 6,
    });

    expect(mocks.post).toHaveBeenNthCalledWith(
      1,
      '/ollama/tailnet/reverify',
      { generation: 7, expectedVersion: 3 },
      {
        timeout: 60_000,
        _skipNetworkRetry: true,
      },
    );
    expect(mocks.post).toHaveBeenNthCalledWith(
      2,
      '/ollama/tailnet/verify',
      { generation: 7, expectedVersion: 4 },
      { timeout: 60_000 },
    );
    expect(mocks.post).toHaveBeenNthCalledWith(
      3,
      '/ollama/model/test',
      { generation: 7, expectedVersion: 5 },
      {
        timeout: 150_000,
        _skipNetworkRetry: true,
      },
    );
    expect(mocks.delete).toHaveBeenCalledWith(
      '/ollama/tailnet/authority',
      {
        data: { generation: 7, expectedVersion: 6 },
        timeout: 30_000,
        _skipNetworkRetry: true,
      },
    );
    expect(verified.evidence.checks?.[0].state).toBe('pass');
  });

  it('records exact post-activation legacy cleanup with bounded CAS evidence', async () => {
    const retirementEvidence =
      `legacy-helper-retirement:v1:sha256:${'e'.repeat(64)}`;
    mocks.post.mockResolvedValue({
      data: {
        binding: binding({
          version: 4,
          legacyHelperRetirementAcknowledgedAt: timestamp,
          legacyHelperRetirementEvidence: retirementEvidence,
        }),
      },
    });

    const acknowledged =
      await ollamaTailnetAPI.acknowledgeLegacyHelperRetirement({
        generation: 7,
        expectedVersion: 3,
        cleanupConfirmed: true,
      });

    expect(mocks.post).toHaveBeenCalledWith(
      '/ollama/tailnet/legacy-helper-retirement',
      {
        generation: 7,
        expectedVersion: 3,
        cleanupConfirmed: true,
      },
      {
        timeout: 30_000,
        _skipNetworkRetry: true,
      },
    );
    expect(acknowledged.legacyHelperRetirementEvidence).toBe(
      retirementEvidence,
    );
  });

  it('loads installed models and catalog, then switches model without rebuilding the connection', async () => {
    mocks.get
      .mockResolvedValueOnce({
        data: {
          source: 'tailnet',
          models: [{
            name: 'qwen3.5:4b',
            digest,
            size: 3_400_000_000,
            modifiedAt: timestamp,
            details: {},
            privatePath: 'must-not-escape',
          }],
          authority: {
            kind: 'TAILNET',
            generation: 7,
            version: 3,
            fingerprint: 'binding-fingerprint-7',
          },
        },
      })
      .mockResolvedValueOnce({
        data: {
          warning: null,
          models: [{
            name: 'qwen3.5:9b',
            description: 'Workstation general model.',
            size: '6.6GB',
            sizeBytes: 6_600_000_000,
            useCase: 'general',
            contextWindow: '256K',
            sourceUrl: 'https://ollama.com/library/qwen3.5',
          }],
        },
      });
    mocks.put.mockResolvedValue({
      data: {
        binding: binding({
          version: 4,
          selectedModel: 'qwen3.5:9b',
          selectedModelDigest: digest,
        }),
      },
    });

    const inventory = await ollamaTailnetAPI.models();
    const catalog = await ollamaTailnetAPI.catalog();
    await ollamaTailnetAPI.setActiveModel({
      model: 'qwen3.5:9b',
      expectedDigest: digest,
      generation: 7,
      expectedVersion: 3,
    });

    expect(inventory.models[0]).not.toHaveProperty('privatePath');
    expect(catalog.models[0].useCase).toBe('general');
    expect(mocks.put).toHaveBeenCalledWith('/ollama/active-model', {
      model: 'qwen3.5:9b',
      expectedDigest: digest,
      generation: 7,
      expectedVersion: 3,
    }, {
      timeout: 240_000,
      _skipNetworkRetry: true,
    });
  });

  it('starts, polls, and exactly cancels a progress-bearing pull', async () => {
    mocks.post.mockResolvedValue({ data: { pull: pull() } });
    mocks.get.mockResolvedValue({
      data: {
        pulls: [
          pull(),
          pull({
            id: 'terminal',
            state: 'failed',
            phase: 'complete',
            status: 'failed',
            totalBytes: null,
            completedBytes: null,
            percent: null,
            speedBytesPerSecond: null,
            etaSeconds: null,
            canCancel: false,
            error: {
              code: 'PULL_FAILED',
              message: 'The remote GPU ran out of space.',
              retryable: true,
            },
          }),
        ],
      },
    });
    mocks.delete.mockResolvedValue({
      data: {
        ...pull({
          state: 'cancelling',
          status: 'cancelling',
          canCancel: false,
        }),
      },
    });

    const started = await ollamaTailnetAPI.startPull({
      operationId: pullOperationId,
      model: 'qwen3.5:4b',
      expectedAuthority: {
        kind: 'TAILNET',
        generation: 7,
        version: 3,
        fingerprint: 'binding-fingerprint-7',
      },
    });
    const pulls = await ollamaTailnetAPI.pulls();
    const cancelled = await ollamaTailnetAPI.cancelPull('pull/id with space');

    expect(started.percent).toBe(25);
    expect(started.operationId).toBe(pullOperationId);
    expect(started.authority).toEqual({
      kind: 'TAILNET',
      generation: 7,
      version: 3,
      fingerprint: 'binding-fingerprint-7',
    });
    expect(pulls[1].error).toBe('The remote GPU ran out of space.');
    expect(cancelled.state).toBe('cancelling');
    expect(mocks.post).toHaveBeenCalledWith('/ollama/pull', {
      operationId: pullOperationId,
      model: 'qwen3.5:4b',
      expectedAuthority: {
        kind: 'TAILNET',
        generation: 7,
        version: 3,
        fingerprint: 'binding-fingerprint-7',
      },
    }, {
      timeout: 30_000,
      _skipNetworkRetry: true,
    });
    expect(mocks.delete).toHaveBeenCalledWith(
      '/ollama/pull/pull%2Fid%20with%20space',
      {
        timeout: 30_000,
        _skipNetworkRetry: true,
      },
    );
  });

  it('rejects unsafe setup commands and invalid progress rather than widening the UI contract', async () => {
    mocks.get.mockResolvedValueOnce({
      data: {
        ...statusResponse(),
        setup: {
          ...statusResponse().setup,
          serveCommand: 'safe command\nunsafe command',
        },
      },
    });
    await expect(ollamaTailnetAPI.status()).rejects.toBeTruthy();

    mocks.get.mockResolvedValueOnce({
      data: {
        pulls: [pull({ percent: 101 })],
      },
    });
    await expect(ollamaTailnetAPI.pulls()).rejects.toBeTruthy();

    await expect(ollamaTailnetAPI.startPull({
      operationId: pullOperationId,
      model: 'qwen3.5:4b',
      expectedAuthority: {
        kind: 'TAILNET',
        generation: 0,
        version: 3,
        fingerprint: 'binding-fingerprint-7',
      },
    })).rejects.toBeTruthy();
  });

  it('rejects a pull response for a different operation key', async () => {
    mocks.post.mockResolvedValue({
      data: {
        pull: pull({
          operationId: '123e4567-e89b-42d3-a456-426614174001',
        }),
      },
    });

    await expect(ollamaTailnetAPI.startPull({
      operationId: pullOperationId,
      model: 'qwen3.5:4b',
      expectedAuthority: {
        kind: 'TAILNET',
        generation: 7,
        version: 3,
        fingerprint: 'binding-fingerprint-7',
      },
    })).rejects.toThrow(
      'Ollama pull response did not match the requested operation',
    );
  });

  it('derives explicit null-or-exact authority CAS pairs', () => {
    expect(ollamaTailnetCas(null)).toEqual({
      generation: null,
      version: null,
    });
    expect(ollamaTailnetCas(binding() as never)).toEqual({
      generation: 7,
      version: 3,
    });
  });

  it('distinguishes rejected HTTP outcomes from outcome-unknown transport failures', () => {
    expect(ollamaTailnetHasDefinitiveHttpResponse({
      response: { status: 409 },
    })).toBe(true);
    expect(ollamaTailnetHasDefinitiveHttpResponse({
      response: { status: 503 },
    })).toBe(false);
    for (const status of [408, 425, 429, 499]) {
      expect(ollamaTailnetHasDefinitiveHttpResponse({
        response: { status },
      })).toBe(false);
    }
    expect(ollamaTailnetHasDefinitiveHttpResponse({
      code: 'ECONNABORTED',
      message: 'timeout',
    })).toBe(false);
    expect(ollamaTailnetHasDefinitiveHttpResponse(
      new Error('response schema rejected'),
    )).toBe(false);
  });
});
