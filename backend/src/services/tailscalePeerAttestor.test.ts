import {
  TAILSCALE_STATUS_MAX_BUFFER_BYTES,
  TAILSCALE_STATUS_TIMEOUT_MS,
  TailscalePeerAttestationError,
  listAttestedTailscalePeers,
  listCurrentAttestedTailscalePeers,
  reattestTailscalePeer,
  type TailscalePeerAttestationErrorCode,
  type TailscaleStatusExecFile,
} from './tailscalePeerAttestor';

const NOW = 1_800_000_000_000;
const TAILNET = 'example.ts.net';
const FUTURE_EXPIRY = '2099-01-01T00:00:00Z';
const EXPIRED = '2020-01-01T00:00:00Z';
const SELF_ID = 'nself000000000001';
const PEER_A_ID = 'npeer000000000001';
const PEER_B_ID = 'npeer000000000002';

function nodeKey(character: string): string {
  return `nodekey:${character.repeat(64)}`;
}

const SELF_KEY = nodeKey('1');
const PEER_A_KEY = nodeKey('a');
const PEER_B_KEY = nodeKey('b');
const REPLACEMENT_KEY = nodeKey('c');

function node(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    ID: PEER_A_ID,
    PublicKey: PEER_A_KEY,
    TailscaleIPs: ['fd7a:115c:a1e0::2', '100.64.0.2'],
    Online: true,
    InNetworkMap: true,
    KeyExpiry: FUTURE_EXPIRY,
    ...overrides,
  };
}

function self(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return node({
    ID: SELF_ID,
    PublicKey: SELF_KEY,
    TailscaleIPs: ['100.64.0.1', 'fd7a:115c:a1e0::1'],
    ...overrides,
  });
}

function status(
  peers: Record<string, unknown>[] = [node()],
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    BackendState: 'Running',
    HaveNodeKey: true,
    CurrentTailnet: { Name: TAILNET },
    Self: self(),
    Peer: Object.fromEntries(peers.map((peer) => [String(peer.PublicKey), peer])),
    ...overrides,
  };
}

function execForRaw(
  stdout: string,
  stderr = '',
): jest.MockedFunction<TailscaleStatusExecFile> {
  return jest.fn<
    ReturnType<TailscaleStatusExecFile>,
    Parameters<TailscaleStatusExecFile>
  >(async (_file, _args, _options) => ({ stdout, stderr }));
}

function execForStatus(
  value: unknown,
): jest.MockedFunction<TailscaleStatusExecFile> {
  return execForRaw(JSON.stringify(value));
}

function dependenciesFor(
  value: unknown,
): {
  execFileImpl: jest.MockedFunction<TailscaleStatusExecFile>;
  now: () => number;
} {
  return { execFileImpl: execForStatus(value), now: () => NOW };
}

async function expectCode(
  promise: Promise<unknown>,
  code: TailscalePeerAttestationErrorCode,
): Promise<TailscalePeerAttestationError> {
  try {
    await promise;
  } catch (error) {
    expect(error).toBeInstanceOf(TailscalePeerAttestationError);
    expect(error).toMatchObject({ code });
    return error as TailscalePeerAttestationError;
  }
  throw new Error(`Expected ${code}`);
}

describe('Tailscale peer attestation command boundary', () => {
  test('uses only fixed execFile arguments, a fixed timeout, no shell, and a sanitized environment', async () => {
    process.env.ATTESTOR_TEST_SECRET = 'must-not-reach-child';
    const execFileImpl = execForStatus(status());
    try {
      await listAttestedTailscalePeers(TAILNET, { execFileImpl, now: () => NOW });
    } finally {
      delete process.env.ATTESTOR_TEST_SECRET;
    }

    expect(execFileImpl).toHaveBeenCalledTimes(1);
    const [file, args, options] = execFileImpl.mock.calls[0];
    expect(file).toBe('/usr/bin/tailscale');
    expect(args).toEqual(['status', '--json']);
    expect(options).toMatchObject({
      encoding: 'utf8',
      timeout: TAILSCALE_STATUS_TIMEOUT_MS,
      maxBuffer: TAILSCALE_STATUS_MAX_BUFFER_BYTES,
      shell: false,
      windowsHide: true,
    });
    expect(options.maxBuffer).toBeLessThanOrEqual(2 * 1024 * 1024);
    expect(options.env).toEqual({
      PATH: '/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin',
      LANG: 'C',
      LC_ALL: 'C',
    });
    expect(options.env).not.toHaveProperty('ATTESTOR_TEST_SECRET');
  });

  test('rejects shell-shaped request values before running the fixed command', async () => {
    const execFileImpl = execForStatus(status());
    await expectCode(
      listAttestedTailscalePeers('example.ts.net; touch /tmp/pwned', {
        execFileImpl,
        now: () => NOW,
      }),
      'REQUEST_INVALID',
    );
    await expectCode(
      reattestTailscalePeer({
        tailnetName: TAILNET,
        stableNodeId: 'npeer;$(touch-pwned)',
        nodePublicKey: PEER_A_KEY,
        boundAddress: '100.64.0.2',
      }, { execFileImpl, now: () => NOW }),
      'REQUEST_INVALID',
    );
    await expectCode(
      listAttestedTailscalePeers(TAILNET, {
        execFileImpl,
        now: () => NOW,
        tailscaleBinaryPath: '/tmp/tailscale;touch-pwned',
      }),
      'REQUEST_INVALID',
    );
    expect(execFileImpl).not.toHaveBeenCalled();
  });

  test('accepts only the second fixed absolute binary location when explicitly selected', async () => {
    const execFileImpl = execForStatus(status());
    await listAttestedTailscalePeers(TAILNET, {
      execFileImpl,
      now: () => NOW,
      tailscaleBinaryPath: '/usr/local/bin/tailscale',
    });
    expect(execFileImpl).toHaveBeenCalledWith(
      '/usr/local/bin/tailscale',
      ['status', '--json'],
      expect.objectContaining({ shell: false }),
    );
  });

  test('fails closed on oversized stdout and max-buffer command failures', async () => {
    await expectCode(
      listAttestedTailscalePeers(TAILNET, {
        execFileImpl: execForRaw('x'.repeat(TAILSCALE_STATUS_MAX_BUFFER_BYTES + 1)),
        now: () => NOW,
      }),
      'STATUS_TOO_LARGE',
    );

    const maxBufferFailure = Object.assign(new Error('private status bytes'), {
      code: 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER',
    });
    const execFileImpl = jest.fn<
      ReturnType<TailscaleStatusExecFile>,
      Parameters<TailscaleStatusExecFile>
    >(async (_file, _args, _options) => {
        throw maxBufferFailure;
      });
    await expectCode(
      listAttestedTailscalePeers(TAILNET, { execFileImpl, now: () => NOW }),
      'STATUS_TOO_LARGE',
    );
  });

  test('reports a missing Tailscale binary as an admin-actionable TAILSCALE_NOT_INSTALLED', async () => {
    const error = await expectCode(
      listAttestedTailscalePeers(TAILNET, {
        execFileImpl: execForRaw('{}'),
        accessImpl: async () => { throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' }); },
        now: () => NOW,
      }),
      'TAILSCALE_NOT_INSTALLED',
    );
    expect(error.message).toContain('not installed on the Portal server');
    expect(error.message).toContain('same tailnet');
  });

  test('maps malformed JSON, timeout, and command failures to bounded redacted errors', async () => {
    const secret = `${PEER_A_KEY}:100.64.0.2:private-tailnet`;
    const malformed = await expectCode(
      listAttestedTailscalePeers(TAILNET, {
        execFileImpl: execForRaw(`{"leaked":"${secret}"`),
        now: () => NOW,
      }),
      'STATUS_MALFORMED',
    );

    const timeoutImpl = jest.fn<
      ReturnType<TailscaleStatusExecFile>,
      Parameters<TailscaleStatusExecFile>
    >(async (_file, _args, _options) => {
        throw Object.assign(new Error(secret), { killed: true, signal: 'SIGTERM' });
      });
    const timeout = await expectCode(
      listAttestedTailscalePeers(TAILNET, { execFileImpl: timeoutImpl, now: () => NOW }),
      'STATUS_COMMAND_TIMEOUT',
    );

    const commandFailureImpl = jest.fn<
      ReturnType<TailscaleStatusExecFile>,
      Parameters<TailscaleStatusExecFile>
    >(async (_file, _args, _options) => {
        throw Object.assign(new Error(secret), { code: 1, stdout: secret, stderr: secret });
      });
    const commandFailure = await expectCode(
      listAttestedTailscalePeers(TAILNET, {
        execFileImpl: commandFailureImpl,
        now: () => NOW,
      }),
      'STATUS_COMMAND_FAILED',
    );

    for (const error of [malformed, timeout, commandFailure]) {
      const callableJson = JSON.stringify(error);
      expect(callableJson.length).toBeLessThan(300);
      expect(callableJson).not.toContain(secret);
      expect(callableJson).not.toContain(PEER_A_KEY);
      expect(callableJson).not.toContain('100.64.0.2');
    }
  });
});

describe('Tailscale status identity and address validation', () => {
  test('derives the initial Tailnet from one validated snapshot without weakening bound flows', async () => {
    const currentTailnetName = 'first-run@example.com';
    const currentStatus = status([node()], {
      CurrentTailnet: { Name: currentTailnetName },
    });
    const discoveryExec = execForStatus(currentStatus);
    const inventory = await listCurrentAttestedTailscalePeers({
      execFileImpl: discoveryExec,
      now: () => NOW,
    });

    expect(discoveryExec).toHaveBeenCalledTimes(1);
    expect(inventory).toMatchObject({
      tailnetName: currentTailnetName,
      peers: [{ tailnetName: currentTailnetName, stableNodeId: PEER_A_ID }],
    });

    await expectCode(
      listAttestedTailscalePeers(TAILNET, dependenciesFor(currentStatus)),
      'TAILNET_MISMATCH',
    );
    await expectCode(
      reattestTailscalePeer({
        tailnetName: TAILNET,
        stableNodeId: PEER_A_ID,
        nodePublicKey: PEER_A_KEY,
        boundAddress: '100.64.0.2',
      }, dependenciesFor(currentStatus)),
      'TAILNET_MISMATCH',
    );
    await expect(
      listAttestedTailscalePeers(currentTailnetName, dependenciesFor(currentStatus)),
    ).resolves.toMatchObject({ tailnetName: currentTailnetName });
  });

  test('selects the unique IPv4 deterministically and falls back to a unique IPv6', async () => {
    const ipv6Only = node({
      ID: PEER_B_ID,
      PublicKey: PEER_B_KEY,
      TailscaleIPs: ['FD7A:115C:A1E0:0:0:0:0:3'],
    });
    const inventory = await listAttestedTailscalePeers(
      TAILNET,
      dependenciesFor(status([ipv6Only, node()])),
    );

    expect(inventory).toMatchObject({
      tailnetName: TAILNET,
      observedAt: new Date(NOW).toISOString(),
      peers: [
        {
          stableNodeId: PEER_A_ID,
          nodePublicKey: PEER_A_KEY,
          address: '100.64.0.2',
          addressFamily: 'IPV4',
        },
        {
          stableNodeId: PEER_B_ID,
          nodePublicKey: PEER_B_KEY,
          address: 'fd7a:115c:a1e0::3',
          addressFamily: 'IPV6',
        },
      ],
    });
    expect(inventory.peers[0].fingerprint).toMatch(/^[a-f0-9]{64}$/u);
    expect(Object.isFrozen(inventory)).toBe(true);
    expect(Object.isFrozen(inventory.peers)).toBe(true);
    expect(inventory.peers.every(Object.isFrozen)).toBe(true);
  });

  test('exposes bounded HostName/OS metadata with a DNS-label fallback', async () => {
    const inventory = await listAttestedTailscalePeers(TAILNET, dependenciesFor(status([
      node({
        HostName: 'gpu-worker-a',
        DNSName: 'ignored-name.example.ts.net.',
        OS: 'linux',
      }),
      node({
        ID: PEER_B_ID,
        PublicKey: PEER_B_KEY,
        TailscaleIPs: ['100.64.0.3', 'fd7a:115c:a1e0::3'],
        HostName: undefined,
        DNSName: 'gpu-worker-b.example.ts.net.',
        OS: 'windows',
      }),
    ])));

    expect(inventory.peers).toMatchObject([
      {
        stableNodeId: PEER_A_ID,
        displayName: 'gpu-worker-a',
        operatingSystem: 'linux',
        address: '100.64.0.2',
      },
      {
        stableNodeId: PEER_B_ID,
        displayName: 'gpu-worker-b',
        operatingSystem: 'windows',
        address: '100.64.0.3',
      },
    ]);
  });

  test('keeps peers with the same presentation name distinct by authoritative identity', async () => {
    const inventory = await listAttestedTailscalePeers(TAILNET, dependenciesFor(status([
      node({ HostName: 'shared-worker' }),
      node({
        ID: PEER_B_ID,
        PublicKey: PEER_B_KEY,
        TailscaleIPs: ['100.64.0.3', 'fd7a:115c:a1e0::3'],
        HostName: 'shared-worker',
      }),
    ])));

    expect(inventory.peers.map((peer) => peer.displayName)).toEqual([
      'shared-worker',
      'shared-worker',
    ]);
    expect(new Set(inventory.peers.map((peer) => peer.stableNodeId)).size).toBe(2);
    expect(new Set(inventory.peers.map((peer) => peer.nodePublicKey)).size).toBe(2);
    expect(new Set(inventory.peers.map((peer) => peer.address)).size).toBe(2);
  });

  test('omits hostile presentation labels without changing identity proof or fingerprint', async () => {
    const clean = await listAttestedTailscalePeers(TAILNET, dependenciesFor(status([
      node({ HostName: 'worker-a', DNSName: 'worker-a.example.ts.net.', OS: 'linux' }),
    ])));
    const hostile = await listAttestedTailscalePeers(TAILNET, dependenciesFor(status([
      node({
        HostName: 'worker-a\u202Etxt.exe',
        DNSName: '<script>.example.ts.net.',
        OS: 'x'.repeat(65),
      }),
    ])));

    expect(clean.peers[0]).toMatchObject({
      displayName: 'worker-a',
      operatingSystem: 'linux',
    });
    expect(hostile.peers).toHaveLength(1);
    expect(hostile.peers[0]).not.toHaveProperty('displayName');
    expect(hostile.peers[0]).not.toHaveProperty('operatingSystem');
    expect(hostile.peers[0]).toMatchObject({
      stableNodeId: clean.peers[0].stableNodeId,
      nodePublicKey: clean.peers[0].nodePublicKey,
      address: clean.peers[0].address,
      fingerprint: clean.peers[0].fingerprint,
    });
  });

  test('allows alternate IPv6 addresses when the chosen IPv4 remains unique', async () => {
    const inventory = await listAttestedTailscalePeers(TAILNET, dependenciesFor(status([
      node({
        TailscaleIPs: [
          'fd7a:115c:a1e0::2',
          '100.64.0.2',
          'fd7a:115c:a1e0::20',
        ],
      }),
    ])));
    expect(inventory.peers).toHaveLength(1);
    expect(inventory.peers[0]).toMatchObject({ address: '100.64.0.2', addressFamily: 'IPV4' });
  });

  test('requires Running backend state, the exact Tailnet, and a valid online self identity', async () => {
    await expectCode(
      listAttestedTailscalePeers(TAILNET, dependenciesFor(status([], {
        BackendState: 'Stopped',
      }))),
      'BACKEND_NOT_RUNNING',
    );
    await expectCode(
      listAttestedTailscalePeers('other.ts.net', dependenciesFor(status())),
      'TAILNET_MISMATCH',
    );
    await expectCode(
      listAttestedTailscalePeers(TAILNET, dependenciesFor(status([], {
        Self: self({ Online: false }),
      }))),
      'SELF_IDENTITY_INVALID',
    );
    await expectCode(
      listAttestedTailscalePeers(TAILNET, dependenciesFor(status([], {
        Self: self({ PublicKey: 'machinekey:not-a-node-key' }),
      }))),
      'SELF_IDENTITY_INVALID',
    );
    await expectCode(
      listAttestedTailscalePeers(TAILNET, dependenciesFor(status([], {
        Self: self({ Expired: true, KeyExpiry: FUTURE_EXPIRY }),
      }))),
      'SELF_IDENTITY_INVALID',
    );
    await expectCode(
      listAttestedTailscalePeers(TAILNET, dependenciesFor(status([], {
        Self: self({ Expired: 'true' }),
      }))),
      'SELF_IDENTITY_INVALID',
    );
  });

  test('does not expose offline, authoritatively expired, date-expired, or out-of-map peers', async () => {
    const offline = node({ Online: false });
    const dateExpired = node({
      ID: PEER_B_ID,
      PublicKey: PEER_B_KEY,
      TailscaleIPs: ['100.64.0.3', 'fd7a:115c:a1e0::3'],
      Expired: false,
      KeyExpiry: EXPIRED,
    });
    const authoritativelyExpired = node({
      ID: 'npeer000000000003',
      PublicKey: REPLACEMENT_KEY,
      TailscaleIPs: ['100.64.0.4', 'fd7a:115c:a1e0::4'],
      Expired: true,
      KeyExpiry: undefined,
    });
    const conflictingExpiry = node({
      ID: 'npeer000000000004',
      PublicKey: nodeKey('d'),
      TailscaleIPs: ['100.64.0.5', 'fd7a:115c:a1e0::5'],
      Expired: true,
      KeyExpiry: FUTURE_EXPIRY,
    });
    const outsideMap = node({
      ID: 'npeer000000000005',
      PublicKey: nodeKey('e'),
      TailscaleIPs: ['100.64.0.6', 'fd7a:115c:a1e0::6'],
      InNetworkMap: false,
    });
    const inventory = await listAttestedTailscalePeers(
      TAILNET,
      dependenciesFor(status([
        offline,
        dateExpired,
        authoritativelyExpired,
        conflictingExpiry,
        outsideMap,
      ])),
    );
    expect(inventory.peers).toEqual([]);

    await expect(reattestTailscalePeer({
      tailnetName: TAILNET,
      stableNodeId: PEER_A_ID,
      nodePublicKey: PEER_A_KEY,
      boundAddress: '100.64.0.2',
    }, dependenciesFor(status([offline])))).resolves.toMatchObject({
      state: 'UNAVAILABLE',
      reason: 'PEER_OFFLINE',
    });
    await expect(reattestTailscalePeer({
      tailnetName: TAILNET,
      stableNodeId: PEER_B_ID,
      nodePublicKey: PEER_B_KEY,
      boundAddress: '100.64.0.3',
    }, dependenciesFor(status([dateExpired])))).resolves.toMatchObject({
      state: 'UNAVAILABLE',
      reason: 'PEER_KEY_EXPIRED',
    });
    await expect(reattestTailscalePeer({
      tailnetName: TAILNET,
      stableNodeId: 'npeer000000000003',
      nodePublicKey: REPLACEMENT_KEY,
      boundAddress: '100.64.0.4',
    }, dependenciesFor(status([authoritativelyExpired])))).resolves.toMatchObject({
      state: 'UNAVAILABLE',
      reason: 'PEER_KEY_EXPIRED',
    });
  });

  test.each([
    ['stable ID', node({ ID: SELF_ID })],
    ['node key', node({ PublicKey: SELF_KEY })],
    ['address', node({ TailscaleIPs: ['100.64.0.1', 'fd7a:115c:a1e0::22'] })],
  ])('rejects a peer colliding with the self %s', async (_label, peer) => {
    await expectCode(
      listAttestedTailscalePeers(TAILNET, dependenciesFor(status([peer]))),
      'PEER_COLLISION',
    );
  });

  test('rejects duplicate stable IDs, public keys, and any cross-peer address collision', async () => {
    const second = node({
      ID: PEER_B_ID,
      PublicKey: PEER_B_KEY,
      TailscaleIPs: ['100.64.0.3', 'fd7a:115c:a1e0::3'],
    });
    await expectCode(
      listAttestedTailscalePeers(TAILNET, dependenciesFor(status([
        node(),
        { ...second, ID: PEER_A_ID },
      ]))),
      'PEER_COLLISION',
    );

    const duplicatePublicKeyStatus = status([], {
      Peer: {
        [PEER_A_KEY]: node(),
        [PEER_B_KEY]: { ...second, PublicKey: PEER_A_KEY },
      },
    });
    await expectCode(
      listAttestedTailscalePeers(TAILNET, dependenciesFor(duplicatePublicKeyStatus)),
      'PEER_COLLISION',
    );

    await expectCode(
      listAttestedTailscalePeers(TAILNET, dependenciesFor(status([
        node(),
        { ...second, TailscaleIPs: ['100.64.0.3', 'fd7a:115c:a1e0::2'] },
      ]))),
      'PEER_COLLISION',
    );
  });

  test.each([
    ['whitespace in stable ID', status([node({ ID: 'npeer bad identity' })])],
    ['wrong public-key format', status([node({ PublicKey: `nodekey:${'A'.repeat(64)}` })])],
    ['non-boolean Online state', status([node({ Online: 'true' })])],
    ['missing network-map state', status([node({ InNetworkMap: undefined })])],
    ['non-boolean authoritative expiry state', status([node({ Expired: 'true' })])],
    ['map key that disagrees with current public key', status([], {
      Peer: { [PEER_A_KEY]: node({ PublicKey: REPLACEMENT_KEY }) },
    })],
  ])('rejects peer identity with %s', async (_label, malformedStatus) => {
    await expectCode(
      listAttestedTailscalePeers(TAILNET, dependenciesFor(malformedStatus)),
      'PEER_IDENTITY_INVALID',
    );
  });

  test.each([
    ['mapped IPv6', ['::ffff:100.64.0.2']],
    ['private IPv4', ['10.0.0.2']],
    ['link-local IPv6', ['fe80::2']],
    ['DNS hostname', ['ollama.example.ts.net']],
    ['bracketed literal', ['[fd7a:115c:a1e0::2]']],
    ['scoped literal', ['fd7a:115c:a1e0::2%tailscale0']],
    ['invalid alternate', ['100.64.0.2', '10.0.0.2']],
  ])('rejects %s rather than falling back to DNS or another address', async (_label, addresses) => {
    await expectCode(
      listAttestedTailscalePeers(TAILNET, dependenciesFor(status([
        node({ TailscaleIPs: addresses }),
      ]))),
      'PEER_ADDRESS_INVALID',
    );
  });

  test.each([
    ['multiple IPv4 candidates', ['100.64.0.2', '100.64.0.20', 'fd7a:115c:a1e0::2']],
    ['multiple IPv6-only candidates', ['fd7a:115c:a1e0::2', 'fd7a:115c:a1e0::20']],
    ['duplicate candidates', ['100.64.0.2', '100.64.0.2']],
  ])('rejects %s', async (_label, addresses) => {
    await expectCode(
      listAttestedTailscalePeers(TAILNET, dependenciesFor(status([
        node({ TailscaleIPs: addresses }),
      ]))),
      'PEER_ADDRESS_AMBIGUOUS',
    );
  });
});

describe('Tailscale peer re-attestation', () => {
  test('returns an immutable exact attestation with a time-independent fingerprint', async () => {
    const request = {
      tailnetName: TAILNET,
      stableNodeId: PEER_A_ID,
      nodePublicKey: PEER_A_KEY,
      boundAddress: '100.64.0.2',
    };
    const first = await reattestTailscalePeer(request, dependenciesFor(status()));
    const second = await reattestTailscalePeer(request, {
      execFileImpl: execForStatus(status()),
      now: () => NOW + 60_000,
    });

    expect(first).toMatchObject({
      state: 'ATTESTED',
      requiresBindingGenerationAdvance: false,
      attestation: {
        tailnetName: TAILNET,
        stableNodeId: PEER_A_ID,
        nodePublicKey: PEER_A_KEY,
        address: '100.64.0.2',
        addressFamily: 'IPV4',
      },
    });
    expect(Object.isFrozen(first)).toBe(true);
    if (first.state !== 'ATTESTED' || second.state !== 'ATTESTED') {
      throw new Error('Expected stable attestations');
    }
    expect(Object.isFrozen(first.attestation)).toBe(true);
    expect(second.attestation.observedAt).not.toBe(first.attestation.observedAt);
    expect(second.attestation.fingerprint).toBe(first.attestation.fingerprint);
  });

  test('accepts address rotation for the same stable node and key', async () => {
    const result = await reattestTailscalePeer({
      tailnetName: TAILNET,
      stableNodeId: PEER_A_ID,
      nodePublicKey: PEER_A_KEY,
      boundAddress: '100.64.0.2',
    }, dependenciesFor(status([
      node({ TailscaleIPs: ['100.64.0.22', 'fd7a:115c:a1e0::22'] }),
    ])));

    expect(result).toMatchObject({
      state: 'ATTESTED',
      requiresBindingGenerationAdvance: false,
      attestation: {
        stableNodeId: PEER_A_ID,
        nodePublicKey: PEER_A_KEY,
        address: '100.64.0.22',
      },
    });
  });

  test('reports node-key replacement explicitly instead of accepting it', async () => {
    const result = await reattestTailscalePeer({
      tailnetName: TAILNET,
      stableNodeId: PEER_A_ID,
      nodePublicKey: PEER_A_KEY,
      boundAddress: '100.64.0.2',
    }, dependenciesFor(status([
      node({ PublicKey: REPLACEMENT_KEY }),
    ])));

    expect(result).toMatchObject({
      state: 'BINDING_GENERATION_ADVANCE_REQUIRED',
      requiresBindingGenerationAdvance: true,
      changes: ['NODE_PUBLIC_KEY'],
      candidate: {
        stableNodeId: PEER_A_ID,
        nodePublicKey: REPLACEMENT_KEY,
        address: '100.64.0.2',
      },
    });
  });

  test('does not substitute a different stable node when the bound peer disappears', async () => {
    const result = await reattestTailscalePeer({
      tailnetName: TAILNET,
      stableNodeId: PEER_A_ID,
      nodePublicKey: PEER_A_KEY,
      boundAddress: '100.64.0.2',
    }, dependenciesFor(status([
      node({
        ID: PEER_B_ID,
        PublicKey: PEER_B_KEY,
        TailscaleIPs: ['100.64.0.3', 'fd7a:115c:a1e0::3'],
      }),
    ])));
    expect(result).toEqual({
      state: 'UNAVAILABLE',
      reason: 'PEER_NOT_FOUND',
      observedAt: new Date(NOW).toISOString(),
    });
  });
});
