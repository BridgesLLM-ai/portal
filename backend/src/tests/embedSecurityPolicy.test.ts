const mockFindUnique = jest.fn();
const mockUpsert = jest.fn();
const mockActivityCreate = jest.fn();
const mockTransaction = jest.fn();

jest.mock('../config/database', () => ({
  prisma: {
    systemSetting: { findUnique: mockFindUnique },
    $transaction: mockTransaction,
  },
}));

import {
  DEFAULT_EMBED_SECURITY_POLICY_ENTRIES,
  EMBED_SECURITY_POLICY_SETTING_KEY,
  EmbedSecurityPolicyRevisionConflictError,
  EmbedSecurityPolicyValidationError,
  applyAppContentEmbedSecurityHeaders,
  buildAppContentPermissionsPolicy,
  buildPortalContentSecurityPolicyDirectives,
  getRuntimeEmbedSecurityPolicy,
  installRuntimeEmbedSecurityPolicy,
  normalizeEmbedOrigin,
  normalizeEmbedSecurityPolicyEntries,
  parseStoredEmbedSecurityPolicy,
  preserveAppContentSecurityHeadersOnProxy,
  readEmbedSecurityPolicyState,
  serializeEmbedSecurityPolicy,
  updateEmbedSecurityPolicy,
} from '../services/embedSecurityPolicy';

const timestamp = new Date('2026-08-08T21:00:00.000Z');

function entry(origin: string, camera = false, microphone = false) {
  return { origin, camera, microphone };
}

describe('hosted-app embed security policy', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    installRuntimeEmbedSecurityPolicy([]);
    mockTransaction.mockImplementation(async (operation: (transaction: any) => Promise<unknown>) => (
      operation({
        systemSetting: {
          findUnique: mockFindUnique,
          upsert: mockUpsert,
        },
        activityLog: { create: mockActivityCreate },
      })
    ));
    mockActivityCreate.mockResolvedValue({ id: 'activity-1' });
  });

  test.each([
    ['https://Video.Example.com/', 'https://video.example.com'],
    ['https://video.example.com:443', 'https://video.example.com'],
  ])('canonicalizes exact HTTPS origin %s', (raw, expected) => {
    expect(normalizeEmbedOrigin(raw)).toBe(expected);
  });

  test.each([
    'http://video.example.com',
    'https://user:secret@video.example.com',
    'https://*.example.com',
    'https://video.example.com/path',
    'https://video.example.com?mode=embed',
    'https://video.example.com#embed',
    'https://video.example.com:8443',
    'https://127.0.0.1',
    'https://localhost',
    'https://video.internal',
    'https://camera.example',
    'https://device.home.arpa',
    'https://thing.alt',
    'https://router.localdomain',
    'https://video.example.com.',
    'https://video.example.com\n.evil.example',
    'https://evil.example\\@trusted.example',
    'not a URL',
  ])('rejects unsafe or non-origin value %s', (raw) => {
    expect(() => normalizeEmbedOrigin(raw)).toThrow(EmbedSecurityPolicyValidationError);
  });

  test('normalizes, sorts, accepts removable defaults, and rejects duplicates', () => {
    expect(normalizeEmbedSecurityPolicyEntries([
      entry('https://z.example.com'),
      entry('https://A.example.com', true, false),
    ])).toEqual([
      entry('https://a.example.com', true, false),
      entry('https://z.example.com'),
    ]);
    expect(() => normalizeEmbedSecurityPolicyEntries([
      entry('https://a.example.com'),
      entry('https://A.example.com/'),
    ])).toThrow(/more than once/);
    expect(normalizeEmbedSecurityPolicyEntries([
      entry(DEFAULT_EMBED_SECURITY_POLICY_ENTRIES[0].origin),
    ])).toEqual([
      entry(DEFAULT_EMBED_SECURITY_POLICY_ENTRIES[0].origin),
    ]);
  });

  test('seeds removable defaults only while the policy row is absent', async () => {
    const absent = await readEmbedSecurityPolicyState({
      systemSetting: { findUnique: jest.fn().mockResolvedValue(null) },
    } as any);
    expect(absent.status).toBe('ready');
    expect(absent.updatedAt).toBeNull();
    expect(absent.entries).toEqual(DEFAULT_EMBED_SECURITY_POLICY_ENTRIES);
    expect(absent.defaultOrigins).toEqual(
      DEFAULT_EMBED_SECURITY_POLICY_ENTRIES.map((candidate) => candidate.origin),
    );
    expect(absent.builtInOrigins).toEqual([]);

    const savedEmpty = await readEmbedSecurityPolicyState({
      systemSetting: {
        findUnique: jest.fn().mockResolvedValue({
          value: serializeEmbedSecurityPolicy([]),
          updatedAt: timestamp,
        }),
      },
    } as any);
    expect(savedEmpty.status).toBe('ready');
    expect(savedEmpty.updatedAt).toBe(timestamp.toISOString());
    expect(savedEmpty.entries).toEqual([]);
  });

  test('rejects Portal-owned origins and policies above the total header budget', () => {
    const priorPortalOrigin = process.env.PORTAL_PUBLIC_ORIGIN;
    const priorAppOrigin = process.env.APP_CONTENT_ORIGIN;
    process.env.PORTAL_PUBLIC_ORIGIN = 'https://portal.example.com';
    process.env.APP_CONTENT_ORIGIN = 'https://content.example.net';
    try {
      expect(() => normalizeEmbedOrigin('https://portal.example.com')).toThrow(/Portal-owned origins/);
      expect(() => normalizeEmbedOrigin('https://content.example.net')).toThrow(/Portal-owned origins/);
    } finally {
      if (priorPortalOrigin === undefined) delete process.env.PORTAL_PUBLIC_ORIGIN;
      else process.env.PORTAL_PUBLIC_ORIGIN = priorPortalOrigin;
      if (priorAppOrigin === undefined) delete process.env.APP_CONTENT_ORIGIN;
      else process.env.APP_CONTENT_ORIGIN = priorAppOrigin;
    }

    const longEntries = Array.from({ length: 32 }, (_, index) => entry(
      `https://${'a'.repeat(60)}.${'b'.repeat(60)}.${'c'.repeat(60)}.${'d'.repeat(50)}.${String(index).padStart(2, '0')}.com`,
    ));
    expect(() => serializeEmbedSecurityPolicy(longEntries)).toThrow(/complete embed-origin policy/);
  });

  test('rejects unknown persisted fields and corrupt storage', () => {
    expect(() => normalizeEmbedSecurityPolicyEntries([
      { ...entry('https://a.example.com'), enabled: true },
    ])).toThrow(/unsupported fields/);
    expect(() => parseStoredEmbedSecurityPolicy('{bad json')).toThrow(/not valid JSON/);
    expect(() => parseStoredEmbedSecurityPolicy(JSON.stringify({ version: 2, entries: [] })))
      .toThrow(/version is unsupported/);
  });

  test('fails closed when the stored row is invalid without returning raw data', async () => {
    const database = {
      systemSetting: {
        findUnique: jest.fn().mockResolvedValue({
          value: '{"version":1,"entries":[{"origin":"https://*.evil.example"}]}',
          updatedAt: timestamp,
        }),
      },
    };

    const state = await readEmbedSecurityPolicyState(database as any);
    expect(state.status).toBe('invalid');
    expect(state.entries).toEqual([]);
    expect(state.warning).toMatch(/third-party origins are disabled/i);
    expect(JSON.stringify(state)).not.toContain('evil.example');
  });

  test('keeps every third-party origin out of the Portal CSP and adds only requested origins to app-content CSP', () => {
    const portal = buildPortalContentSecurityPolicyDirectives();
    const appContentOrigins = [
      ...DEFAULT_EMBED_SECURITY_POLICY_ENTRIES.map((candidate) => candidate.origin),
      'https://video.example.com',
    ];
    const appContent = buildPortalContentSecurityPolicyDirectives(appContentOrigins);
    expect(portal.frameSrc).toEqual([
      "'self'",
      'blob:',
      'data:',
    ]);
    for (const candidate of appContentOrigins) expect(portal.frameSrc).not.toContain(candidate);
    expect(portal.frameSrc).not.toContain('https://video.example.com');
    expect(appContent.frameSrc).toEqual([
      "'self'",
      'blob:',
      'data:',
      ...appContentOrigins,
    ]);
    expect(appContent.scriptSrc).toEqual(portal.scriptSrc);
    expect(appContent.connectSrc).toEqual(portal.connectSrc);
  });

  test('delegates camera and microphone only to origins explicitly granted', () => {
    expect(buildAppContentPermissionsPolicy([
      entry('https://camera.example.com', true, false),
      entry('https://audio.example.com', false, true),
      entry('https://frame-only.example.com'),
    ])).toBe(
      'camera=("https://camera.example.com"), '
      + 'microphone=("https://audio.example.com"), '
      + 'geolocation=(), payment=(), usb=()',
    );
  });

  test('applies the current app-content policy and preserves stricter upstream CSP on proxies', () => {
    installRuntimeEmbedSecurityPolicy([
      entry('https://video.example.com', true, true),
    ]);
    const headers = new Map<string, string | string[]>();
    const res = {
      setHeader(name: string, value: string | string[]) {
        headers.set(name, value);
      },
      getHeader(name: string) {
        return headers.get(name);
      },
    };
    const next = jest.fn();
    applyAppContentEmbedSecurityHeaders({} as any, res as any, next);
    expect(next).toHaveBeenCalledWith();
    expect(String(headers.get('Content-Security-Policy'))).toContain('frame-src');
    expect(String(headers.get('Content-Security-Policy'))).toContain('https://video.example.com');
    expect(headers.get('Permissions-Policy')).toBe(
      'camera=("https://video.example.com"), microphone=("https://video.example.com"), '
      + 'geolocation=(), payment=(), usb=()',
    );

    const upstream: Record<string, string | string[] | number | undefined> = {
      'content-security-policy': "default-src 'none'",
      'permissions-policy': 'camera=*',
    };
    preserveAppContentSecurityHeadersOnProxy(upstream, res as any);
    expect(upstream['content-security-policy']).toEqual([
      headers.get('Content-Security-Policy'),
      "default-src 'none'",
    ]);
    expect(upstream['permissions-policy']).toBe(headers.get('Permissions-Policy'));
  });

  test('updates policy, audit, and runtime cache only after a serializable commit', async () => {
    mockFindUnique.mockResolvedValue(null);
    const initial = await readEmbedSecurityPolicyState();
    const savedValue = serializeEmbedSecurityPolicy([
      entry('https://video.example.com', true, false),
    ]);
    mockUpsert.mockResolvedValue({ value: savedValue, updatedAt: timestamp });

    const state = await updateEmbedSecurityPolicy({
      expectedRevision: initial.revision,
      entries: [entry('https://Video.Example.com/', true, false)],
      actorUserId: 'owner-1',
      ipAddress: '203.0.113.5',
      userAgent: 'test-agent',
    });

    expect(state.status).toBe('ready');
    expect(state.entries).toEqual([entry('https://video.example.com', true, false)]);
    expect(mockTransaction).toHaveBeenCalledWith(expect.any(Function), { isolationLevel: 'Serializable' });
    expect(mockUpsert).toHaveBeenCalledWith({
      where: { key: EMBED_SECURITY_POLICY_SETTING_KEY },
      update: { value: savedValue },
      create: { key: EMBED_SECURITY_POLICY_SETTING_KEY, value: savedValue },
      select: { value: true, updatedAt: true },
    });
    expect(mockActivityCreate).toHaveBeenCalledWith({
      data: expect.objectContaining({
        userId: 'owner-1',
        action: 'EMBED_SECURITY_POLICY_UPDATED',
        metadata: expect.objectContaining({
          added: [entry('https://video.example.com', true, false)],
        }),
      }),
    });
    expect(getRuntimeEmbedSecurityPolicy()).toEqual([
      entry('https://video.example.com', true, false),
    ]);
  });

  test('saving an empty policy removes every starter origin and records the removal', async () => {
    mockFindUnique.mockResolvedValue(null);
    const initial = await readEmbedSecurityPolicyState();
    const savedValue = serializeEmbedSecurityPolicy([]);
    mockUpsert.mockResolvedValue({ value: savedValue, updatedAt: timestamp });

    const state = await updateEmbedSecurityPolicy({
      expectedRevision: initial.revision,
      entries: [],
      actorUserId: 'owner-1',
    });

    expect(state.entries).toEqual([]);
    expect(state.updatedAt).toBe(timestamp.toISOString());
    expect(mockUpsert).toHaveBeenCalledWith({
      where: { key: EMBED_SECURITY_POLICY_SETTING_KEY },
      update: { value: savedValue },
      create: { key: EMBED_SECURITY_POLICY_SETTING_KEY, value: savedValue },
      select: { value: true, updatedAt: true },
    });
    expect(mockActivityCreate).toHaveBeenCalledWith({
      data: expect.objectContaining({
        action: 'EMBED_SECURITY_POLICY_UPDATED',
        metadata: expect.objectContaining({
          removed: DEFAULT_EMBED_SECURITY_POLICY_ENTRIES,
        }),
      }),
    });
    expect(getRuntimeEmbedSecurityPolicy()).toEqual([]);
  });

  test('rejects stale revisions and does not change runtime or write an audit', async () => {
    const stored = serializeEmbedSecurityPolicy([entry('https://old.example.com')]);
    mockFindUnique.mockResolvedValue({ value: stored, updatedAt: timestamp });
    installRuntimeEmbedSecurityPolicy([entry('https://old.example.com')]);

    await expect(updateEmbedSecurityPolicy({
      expectedRevision: '0'.repeat(64),
      entries: [entry('https://new.example.com')],
      actorUserId: 'owner-1',
    })).rejects.toBeInstanceOf(EmbedSecurityPolicyRevisionConflictError);

    expect(mockUpsert).not.toHaveBeenCalled();
    expect(mockActivityCreate).not.toHaveBeenCalled();
    expect(getRuntimeEmbedSecurityPolicy()).toEqual([entry('https://old.example.com')]);
  });

  test('does not republish runtime state if the database transaction fails', async () => {
    const before = entry('https://old.example.com');
    installRuntimeEmbedSecurityPolicy([before]);
    mockTransaction.mockRejectedValueOnce(new Error('database unavailable'));

    await expect(updateEmbedSecurityPolicy({
      expectedRevision: '0'.repeat(64),
      entries: [entry('https://new.example.com')],
      actorUserId: 'owner-1',
    })).rejects.toThrow('database unavailable');
    expect(getRuntimeEmbedSecurityPolicy()).toEqual([before]);
  });

  test('serializes transaction completion and cache publication across concurrent saves', async () => {
    const oldEntry = entry('https://old.example.com');
    const newEntry = entry('https://new.example.com', true, true);
    const oldValue = serializeEmbedSecurityPolicy([oldEntry]);
    const oldRow = { value: oldValue, updatedAt: timestamp };
    const oldState = await readEmbedSecurityPolicyState({
      systemSetting: { findUnique: jest.fn().mockResolvedValue(oldRow) },
    } as any);
    const newRow = {
      value: serializeEmbedSecurityPolicy([newEntry]),
      updatedAt: new Date(timestamp.getTime() + 1_000),
    };
    installRuntimeEmbedSecurityPolicy([oldEntry]);
    mockFindUnique.mockResolvedValue(oldRow);
    mockUpsert.mockResolvedValue(newRow);

    let releaseFirst!: () => void;
    let markFirstEntered!: () => void;
    const firstGate = new Promise<void>((resolve) => { releaseFirst = resolve; });
    const firstEntered = new Promise<void>((resolve) => { markFirstEntered = resolve; });
    const transaction = {
      systemSetting: { findUnique: mockFindUnique, upsert: mockUpsert },
      activityLog: { create: mockActivityCreate },
    };
    mockTransaction
      .mockImplementationOnce(async (operation: (tx: any) => Promise<unknown>) => {
        const outcome = await operation(transaction);
        markFirstEntered();
        await firstGate;
        return outcome;
      })
      .mockImplementationOnce(async (operation: (tx: any) => Promise<unknown>) => operation(transaction));

    const olderNoop = updateEmbedSecurityPolicy({
      expectedRevision: oldState.revision,
      entries: [oldEntry],
      actorUserId: 'owner-1',
    });
    await firstEntered;
    const newerSave = updateEmbedSecurityPolicy({
      expectedRevision: oldState.revision,
      entries: [newEntry],
      actorUserId: 'owner-1',
    });
    await Promise.resolve();
    expect(mockTransaction).toHaveBeenCalledTimes(1);

    releaseFirst();
    await expect(olderNoop).resolves.toEqual(oldState);
    await expect(newerSave).resolves.toEqual(expect.objectContaining({ entries: [newEntry] }));
    expect(mockTransaction).toHaveBeenCalledTimes(2);
    expect(getRuntimeEmbedSecurityPolicy()).toEqual([newEntry]);
  });

  test.each(['P2002', 'P2034'])('maps database race %s to a revision conflict', async (code) => {
    mockTransaction.mockRejectedValueOnce(Object.assign(new Error('race'), { code }));
    await expect(updateEmbedSecurityPolicy({
      expectedRevision: '0'.repeat(64),
      entries: [],
      actorUserId: 'owner-1',
    })).rejects.toBeInstanceOf(EmbedSecurityPolicyRevisionConflictError);
  });
});
