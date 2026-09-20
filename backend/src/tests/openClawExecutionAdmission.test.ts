import {
  OPENCLAW_HOST_MUTATION_ACTIVE_JOURNAL,
  OPENCLAW_HOST_MUTATION_ACTIVE_JOURNALS,
  OPENCLAW_MUTATION_MAINTENANCE_MARKER,
  OPENCLAW_MUTATION_MAINTENANCE_MARKER_SCHEMA,
  OpenClawExecutionAdmissionError,
  __openClawExecutionAdmissionTest,
  __resetOpenClawExecutionAdmissionForTests,
  assertOpenClawDispatchNotDurablyBlocked,
  bindAdmittedOpenClawDispatch,
  captureAdmittedOpenClawDispatchBinding,
  getCachedOpenClawExecutionAdmission,
  getOpenClawExecutionAdmission,
  type OpenClawDurableEvidence,
  type OpenClawExecutionAdmissionDependencies,
} from '../services/openClawExecutionAdmission';
import fs from 'fs';
import os from 'os';
import path from 'path';
import type { OpenClawSetupReadiness } from '../services/openclawSetupReadiness';
import type { OpenClawQuestionPluginReadiness } from '../services/openClawQuestionRuntimeReadiness';

const absent = (): OpenClawDurableEvidence => ({ state: 'absent' });

function readiness(overrides: Partial<OpenClawSetupReadiness> = {}): OpenClawSetupReadiness {
  return {
    installed: true,
    version: '2026.7.1',
    corePackageVersion: '2026.7.1-2',
    runningVersion: '2026.7.1',
    gatewayRunning: true,
    authenticatedRpc: true,
    gatewayProbeOk: true,
    gatewayProbeError: null,
    gatewayUrl: 'http://127.0.0.1:18789',
    hasToken: true,
    tokenParity: true,
    codexPluginVersion: '2026.7.1-1',
    codexPluginInstallSpec: '@openclaw/codex@2026.7.1-1',
    credentialStoreReady: true,
    credentialStoreWritable: true,
    testedCorePackageVersion: '2026.7.1-2',
    testedRuntimeVersion: '2026.7.1',
    testedCodexPluginVersion: '2026.7.1-1',
    testedRuntimeFamily: 'legacy-2026.7.1',
    testedPairReady: true,
    ready: true,
    blockers: [],
    description: 'ready',
    ...overrides,
  };
}

function questionReadiness(
  overrides: Partial<OpenClawQuestionPluginReadiness> = {},
): OpenClawQuestionPluginReadiness {
  return {
    ready: true,
    questionAuthority: 'legacy-custom',
    expectedPluginVersion: '3.3.0',
    issue: null,
    ...overrides,
  };
}

function dependencies(
  overrides: Partial<OpenClawExecutionAdmissionDependencies> = {},
): OpenClawExecutionAdmissionDependencies {
  return {
    inspectAuthorizationFence: absent,
    inspectMaintenanceMarker: absent,
    inspectHostMutationJournal: absent,
    readMutationEpoch: () => 'epoch-0',
    getReadiness: async () => readiness(),
    getQuestionRuntimeReadiness: async () => questionReadiness(),
    now: () => Date.parse('2026-08-22T21:00:00.000Z'),
    ...overrides,
  };
}

describe('OpenClaw execution admission', () => {
  afterEach(() => {
    __resetOpenClawExecutionAdmissionForTests();
    jest.restoreAllMocks();
  });

  it('uses the distinct installer-maintenance and HMT journal identities', () => {
    expect(OPENCLAW_MUTATION_MAINTENANCE_MARKER).toBe(
      '/var/lib/bridgesllm-installer/openclaw-mutation-maintenance-v1.json',
    );
    expect(OPENCLAW_MUTATION_MAINTENANCE_MARKER_SCHEMA).toBe(
      'bridgesllm.openclaw-mutation-maintenance.v1',
    );
    expect(OPENCLAW_HOST_MUTATION_ACTIVE_JOURNAL).toBe(
      '/var/lib/bridgesllm-installer/host-mutations/npm-cli-v1/active.json',
    );
    expect(OPENCLAW_HOST_MUTATION_ACTIVE_JOURNALS).toEqual([
      '/var/lib/bridgesllm-installer/host-mutations/active-host-mutation.json',
      '/var/lib/bridgesllm-installer/host-mutations/npm-cli-v1/active.json',
      '/var/lib/bridgesllm-installer/host-mutations/native-binary-v1/active.json',
    ]);
  });

  it('fails the aggregate WAL evidence closed and detects any active mutation family', () => {
    expect(__openClawExecutionAdmissionTest.aggregateDurableEvidence([
      { state: 'absent' },
      { state: 'present' },
      { state: 'absent' },
    ])).toEqual({ state: 'present' });
    expect(__openClawExecutionAdmissionTest.aggregateDurableEvidence([
      { state: 'present' },
      { state: 'unsafe', reason: 'native WAL unsafe' },
    ])).toEqual({ state: 'unsafe', reason: 'native WAL unsafe' });
  });

  it.each(['arming', 'maintenance'] as const)(
    'accepts only the bounded canonical %s maintenance record',
    (phase) => {
      const record = {
        createdAt: '2026-08-22T21:00:00.000Z',
        operationId: 'a'.repeat(32),
        phase,
        schema: OPENCLAW_MUTATION_MAINTENANCE_MARKER_SCHEMA,
        systemDropInSha256: 'b'.repeat(64),
        unit: 'openclaw-gateway.service',
        updatedAt: '2026-08-22T21:00:01.000Z',
      };
      const canonical = `${JSON.stringify(record)}\n`;

      expect(
        __openClawExecutionAdmissionTest.validateCanonicalMaintenanceMarker(canonical),
      ).toBe(true);
      expect(
        __openClawExecutionAdmissionTest.validateCanonicalMaintenanceMarker(
          `${JSON.stringify({ ...record, extra: true })}\n`,
        ),
      ).toBe(false);
      expect(
        __openClawExecutionAdmissionTest.validateCanonicalMaintenanceMarker(
          JSON.stringify(record, null, 2),
        ),
      ).toBe(false);
    },
  );

  it('admits an exact ready runtime and reuses only a bounded cached attestation at final dispatch', async () => {
    const getReadiness = jest.fn(async () => readiness());
    const getQuestionRuntimeReadiness = jest.fn(async () => questionReadiness());
    const input = dependencies({ getReadiness, getQuestionRuntimeReadiness });

    const initial = await getOpenClawExecutionAdmission(input, { useSharedCache: true });
    const final = getCachedOpenClawExecutionAdmission(input);

    expect(initial).toMatchObject({
      state: 'ready',
      ready: true,
      evidence: {
        authorizationFence: 'absent',
        maintenanceMarker: 'absent',
        hostMutationJournal: 'absent',
      },
    });
    expect(final.state).toBe('ready');
    expect(getReadiness).toHaveBeenCalledTimes(1);
    expect(getQuestionRuntimeReadiness).toHaveBeenCalledTimes(1);
  });

  it.each([
    {
      name: 'OpenClaw 2026.9.1 with the retired 3.4 question surface',
      setup: readiness({
        version: '2026.9.1',
        corePackageVersion: '2026.9.1',
        runningVersion: '2026.9.1',
        testedCorePackageVersion: '2026.9.1',
        testedRuntimeVersion: '2026.9.1',
        testedCodexPluginVersion: '2026.9.1',
        testedRuntimeFamily: 'current-2026.9.1',
      }),
      question: questionReadiness({
        ready: false,
        questionAuthority: 'native',
        expectedPluginVersion: '4.0.0',
        issue: 'OpenClaw 2026.9.1 cannot run the retired 3.4 question surface.',
      }),
    },
    {
      name: 'OpenClaw 2026.7.1 with the native-only 4.0 question surface',
      setup: readiness(),
      question: questionReadiness({
        ready: false,
        questionAuthority: 'legacy-custom',
        expectedPluginVersion: '3.3.0',
        issue: 'OpenClaw 2026.7.1 cannot run the native-only 4.0 question surface.',
      }),
    },
  ])('rejects $name before execution admission', async ({ setup, question }) => {
    const result = await getOpenClawExecutionAdmission(dependencies({
      getReadiness: async () => setup,
      getQuestionRuntimeReadiness: async () => question,
    }));

    expect(result).toMatchObject({
      state: 'unavailable',
      ready: false,
      reason: question.issue,
      readinessBlockers: ['ask-user-plugin-mismatch'],
    });
  });

  it('fails closed when exact question-runtime inspection cannot be completed', async () => {
    const result = await getOpenClawExecutionAdmission(dependencies({
      getQuestionRuntimeReadiness: async () => {
        throw new Error('runtime inspection unavailable');
      },
    }));

    expect(result).toMatchObject({
      state: 'unavailable',
      reason: expect.stringMatching(/could not be attested/i),
      readinessBlockers: ['ask-user-plugin-mismatch'],
    });
  });

  it('gives an active HMT journal recovery priority over a maintenance marker', async () => {
    const getReadiness = jest.fn(async () => readiness());
    const result = await getOpenClawExecutionAdmission(dependencies({
      inspectMaintenanceMarker: () => ({ state: 'present' }),
      inspectHostMutationJournal: () => ({ state: 'present' }),
      getReadiness,
    }));

    expect(result).toMatchObject({
      state: 'recovery-required',
      ready: false,
      evidence: {
        maintenanceMarker: 'present',
        hostMutationJournal: 'present',
      },
    });
    expect(getReadiness).not.toHaveBeenCalled();
    expect(new OpenClawExecutionAdmissionError(result)).toMatchObject({
      statusCode: 503,
      code: 'OPENCLAW_EXECUTION_RECOVERY_REQUIRED',
      retryable: false,
      state: 'recovery-required',
    });
  });

  it('projects supervised maintenance separately from authorization retirement', async () => {
    const maintenance = await getOpenClawExecutionAdmission(dependencies({
      inspectMaintenanceMarker: () => ({ state: 'present' }),
    }));
    expect(maintenance.state).toBe('maintenance');
    expect(new OpenClawExecutionAdmissionError(maintenance)).toMatchObject({
      code: 'OPENCLAW_EXECUTION_MAINTENANCE',
      retryable: true,
    });

    const authorization = await getOpenClawExecutionAdmission(dependencies({
      inspectAuthorizationFence: () => ({ state: 'present' }),
    }));
    expect(authorization).toMatchObject({
      state: 'unavailable',
      reason: expect.stringMatching(/authorization transition/i),
    });
  });

  it('fails closed on unsafe durable evidence and on failed tested-runtime readiness', async () => {
    const unsafe = await getOpenClawExecutionAdmission(dependencies({
      inspectMaintenanceMarker: () => ({
        state: 'unsafe',
        reason: 'OpenClaw maintenance marker could not be safely attested.',
      }),
    }));
    expect(unsafe).toMatchObject({
      state: 'unavailable',
      reason: expect.stringMatching(/safely attested/i),
    });

    const getQuestionRuntimeReadiness = jest.fn(async () => questionReadiness());
    const notReady = await getOpenClawExecutionAdmission(dependencies({
      getReadiness: async () => readiness({
        ready: false,
        testedPairReady: false,
        blockers: [{
          code: 'gateway-rpc-unavailable',
          message: 'The OpenClaw gateway did not pass an authenticated RPC probe.',
        }],
      }),
      getQuestionRuntimeReadiness,
    }));
    expect(notReady).toMatchObject({
      state: 'unavailable',
      readinessBlockers: ['gateway-rpc-unavailable'],
      reason: expect.stringMatching(/authenticated RPC probe/i),
    });
    expect(getQuestionRuntimeReadiness).not.toHaveBeenCalled();
  });

  it('rechecks durable evidence after an asynchronous readiness probe settles', async () => {
    const inspectMaintenanceMarker = jest
      .fn<OpenClawDurableEvidence, []>()
      .mockReturnValueOnce({ state: 'absent' })
      .mockReturnValueOnce({ state: 'present' });
    const result = await getOpenClawExecutionAdmission(dependencies({
      inspectMaintenanceMarker,
    }));

    expect(result.state).toBe('maintenance');
    expect(inspectMaintenanceMarker).toHaveBeenCalledTimes(2);
  });

  it('requires a fresh runtime-family attestation after observed maintenance clears inside the cache TTL', async () => {
    let maintenance: OpenClawDurableEvidence = { state: 'absent' };
    let currentReadiness = readiness();
    const getReadiness = jest.fn(async () => currentReadiness);
    const getQuestionRuntimeReadiness = jest.fn(async (setup: OpenClawSetupReadiness) => (
      setup.testedRuntimeFamily === 'current-2026.9.1'
        ? questionReadiness({
            questionAuthority: 'native',
            expectedPluginVersion: '4.0.0',
          })
        : questionReadiness()
    ));
    const input = dependencies({
      inspectMaintenanceMarker: () => maintenance,
      getReadiness,
      getQuestionRuntimeReadiness,
    });

    await expect(getOpenClawExecutionAdmission(input, { useSharedCache: true }))
      .resolves.toMatchObject({ state: 'ready' });
    expect(getReadiness).toHaveBeenCalledTimes(1);

    maintenance = { state: 'present' };
    expect(getCachedOpenClawExecutionAdmission(input)).toMatchObject({
      state: 'maintenance',
    });

    maintenance = { state: 'absent' };
    expect(getCachedOpenClawExecutionAdmission(input)).toMatchObject({
      state: 'unavailable',
      reason: expect.stringMatching(/not cached/i),
    });
    currentReadiness = readiness({
      version: '2026.9.1',
      corePackageVersion: '2026.9.1',
      runningVersion: '2026.9.1',
      codexPluginVersion: '2026.9.1',
      codexPluginInstallSpec: '@openclaw/codex@2026.9.1',
      testedCorePackageVersion: '2026.9.1',
      testedRuntimeVersion: '2026.9.1',
      testedCodexPluginVersion: '2026.9.1',
      testedRuntimeFamily: 'current-2026.9.1',
    });

    await expect(getOpenClawExecutionAdmission(input, { useSharedCache: true }))
      .resolves.toMatchObject({ state: 'ready' });
    expect(getReadiness).toHaveBeenCalledTimes(2);
    expect(getQuestionRuntimeReadiness).toHaveBeenLastCalledWith(
      expect.objectContaining({ testedRuntimeFamily: 'current-2026.9.1' }),
    );
  });

  it('cannot publish or consume an in-flight pre-journal readiness probe after its generation is invalidated', async () => {
    let hostMutationJournal: OpenClawDurableEvidence = { state: 'absent' };
    let resolveLegacyProbe!: (value: OpenClawSetupReadiness) => void;
    const legacyProbe = new Promise<OpenClawSetupReadiness>((resolve) => {
      resolveLegacyProbe = resolve;
    });
    const currentRuntime = readiness({
      version: '2026.9.1',
      corePackageVersion: '2026.9.1',
      runningVersion: '2026.9.1',
      codexPluginVersion: '2026.9.1',
      codexPluginInstallSpec: '@openclaw/codex@2026.9.1',
      testedCorePackageVersion: '2026.9.1',
      testedRuntimeVersion: '2026.9.1',
      testedCodexPluginVersion: '2026.9.1',
      testedRuntimeFamily: 'current-2026.9.1',
    });
    const getReadiness = jest
      .fn<Promise<OpenClawSetupReadiness>, []>()
      .mockImplementationOnce(() => legacyProbe)
      .mockResolvedValue(currentRuntime);
    const getQuestionRuntimeReadiness = jest.fn(async (setup: OpenClawSetupReadiness) => {
      if (setup.testedRuntimeFamily !== 'current-2026.9.1') {
        return questionReadiness({
          ready: false,
          issue: 'A stale legacy question-authority probe was consumed.',
        });
      }
      return questionReadiness({
        questionAuthority: 'native',
        expectedPluginVersion: '4.0.0',
      });
    });
    const input = dependencies({
      inspectHostMutationJournal: () => hostMutationJournal,
      getReadiness,
      getQuestionRuntimeReadiness,
    });

    const preJournalAdmission = getOpenClawExecutionAdmission(
      input,
      { useSharedCache: true },
    );
    expect(getReadiness).toHaveBeenCalledTimes(1);

    hostMutationJournal = { state: 'present' };
    await expect(getOpenClawExecutionAdmission(input, { useSharedCache: true }))
      .resolves.toMatchObject({ state: 'recovery-required' });

    hostMutationJournal = { state: 'absent' };
    const postJournalAdmission = getOpenClawExecutionAdmission(
      input,
      { useSharedCache: true },
    );
    expect(getReadiness).toHaveBeenCalledTimes(2);
    resolveLegacyProbe(readiness());

    await expect(postJournalAdmission).resolves.toMatchObject({ state: 'ready' });
    await expect(preJournalAdmission).resolves.toMatchObject({ state: 'ready' });
    expect(getReadiness).toHaveBeenCalledTimes(2);
    expect(getQuestionRuntimeReadiness).toHaveBeenCalledTimes(1);
    expect(getQuestionRuntimeReadiness).toHaveBeenCalledWith(
      expect.objectContaining({ testedRuntimeFamily: 'current-2026.9.1' }),
    );
    expect(getCachedOpenClawExecutionAdmission(input)).toMatchObject({ state: 'ready' });
  });

  it('never refreshes an expired readiness attestation in the synchronous final seam', async () => {
    let now = Date.parse('2026-08-22T21:00:00.000Z');
    const getReadiness = jest.fn(async () => readiness());
    const input = dependencies({ getReadiness, now: () => now });
    await getOpenClawExecutionAdmission(input, { useSharedCache: true });

    // Stale enough to want revalidation, but the seam must neither probe nor
    // schedule one: it only consumes what route admission established.
    now += __openClawExecutionAdmissionTest.READINESS_ATTESTATION_REFRESH_AFTER_MS;
    expect(getCachedOpenClawExecutionAdmission(input)).toMatchObject({ state: 'ready' });
    expect(getReadiness).toHaveBeenCalledTimes(1);

    now = Date.parse('2026-08-22T21:00:00.000Z')
      + __openClawExecutionAdmissionTest.READINESS_ATTESTATION_MAX_AGE_MS;
    const final = getCachedOpenClawExecutionAdmission(input);

    expect(final).toMatchObject({
      state: 'unavailable',
      reason: expect.stringMatching(/not cached/i),
    });
    expect(getReadiness).toHaveBeenCalledTimes(1);
  });

  it('serves a stale positive attestation immediately and revalidates it off the request path', async () => {
    let now = Date.parse('2026-08-22T21:00:00.000Z');
    let releaseRevalidation!: (value: OpenClawSetupReadiness) => void;
    const getReadiness = jest
      .fn<Promise<OpenClawSetupReadiness>, []>()
      .mockResolvedValueOnce(readiness())
      .mockImplementationOnce(() => new Promise((resolve) => { releaseRevalidation = resolve; }));
    const input = dependencies({ getReadiness, now: () => now });

    await getOpenClawExecutionAdmission(input, { useSharedCache: true });
    now += __openClawExecutionAdmissionTest.READINESS_ATTESTATION_REFRESH_AFTER_MS - 1;
    await getOpenClawExecutionAdmission(input, { useSharedCache: true });
    expect(getReadiness).toHaveBeenCalledTimes(1);

    now += 1;
    // The revalidation probe is still pending, yet admission resolves at once.
    await expect(getOpenClawExecutionAdmission(input, { useSharedCache: true }))
      .resolves.toMatchObject({ state: 'ready' });
    expect(getReadiness).toHaveBeenCalledTimes(2);
    // Concurrent stale readers share that single background probe.
    await getOpenClawExecutionAdmission(input, { useSharedCache: true });
    expect(getReadiness).toHaveBeenCalledTimes(2);

    releaseRevalidation(readiness());
    await new Promise((resolve) => setImmediate(resolve));
    now += __openClawExecutionAdmissionTest.READINESS_ATTESTATION_REFRESH_AFTER_MS - 1;
    await expect(getOpenClawExecutionAdmission(input, { useSharedCache: true }))
      .resolves.toMatchObject({ state: 'ready' });
    expect(getReadiness).toHaveBeenCalledTimes(2);
  });

  it('keeps a valid positive attestation through one contended revalidation but not two', async () => {
    let now = Date.parse('2026-08-22T21:00:00.000Z');
    const busy = readiness({
      ready: false,
      authenticatedRpc: false,
      blockers: [{ code: 'gateway-rpc-unavailable', message: 'The OpenClaw gateway did not pass an authenticated RPC probe.' }],
    });
    const getReadiness = jest
      .fn<Promise<OpenClawSetupReadiness>, []>()
      .mockResolvedValueOnce(readiness())
      .mockResolvedValue(busy);
    const input = dependencies({ getReadiness, now: () => now });
    const settle = () => new Promise((resolve) => setImmediate(resolve));

    await getOpenClawExecutionAdmission(input, { useSharedCache: true });
    now += __openClawExecutionAdmissionTest.READINESS_ATTESTATION_REFRESH_AFTER_MS;
    await expect(getOpenClawExecutionAdmission(input, { useSharedCache: true }))
      .resolves.toMatchObject({ state: 'ready' });
    await settle();
    expect(getReadiness).toHaveBeenCalledTimes(2);
    expect(getCachedOpenClawExecutionAdmission(input)).toMatchObject({ state: 'ready' });

    // Inside the retry interval no further probe is launched.
    now += __openClawExecutionAdmissionTest.READINESS_BACKGROUND_RETRY_MS - 1;
    await expect(getOpenClawExecutionAdmission(input, { useSharedCache: true }))
      .resolves.toMatchObject({ state: 'ready' });
    await settle();
    expect(getReadiness).toHaveBeenCalledTimes(2);

    now += 1;
    await expect(getOpenClawExecutionAdmission(input, { useSharedCache: true }))
      .resolves.toMatchObject({ state: 'ready' });
    await settle();
    expect(getReadiness).toHaveBeenCalledTimes(3);
    // The second consecutive failure is a changed runtime, not contention.
    expect(getCachedOpenClawExecutionAdmission(input)).toMatchObject({
      state: 'unavailable',
      readinessBlockers: ['gateway-rpc-unavailable'],
    });
  });

  it('holds a negative attestation only briefly, then re-collects on the request path', async () => {
    let now = Date.parse('2026-08-22T21:00:00.000Z');
    const getReadiness = jest
      .fn<Promise<OpenClawSetupReadiness>, []>()
      .mockResolvedValueOnce(readiness({
        ready: false,
        blockers: [{ code: 'gateway-rpc-unavailable', message: 'The OpenClaw gateway did not pass an authenticated RPC probe.' }],
      }))
      .mockResolvedValue(readiness());
    const input = dependencies({ getReadiness, now: () => now });

    await expect(getOpenClawExecutionAdmission(input, { useSharedCache: true }))
      .resolves.toMatchObject({ state: 'unavailable' });
    now += __openClawExecutionAdmissionTest.READINESS_NEGATIVE_ATTESTATION_TTL_MS - 1;
    await expect(getOpenClawExecutionAdmission(input, { useSharedCache: true }))
      .resolves.toMatchObject({ state: 'unavailable' });
    expect(getReadiness).toHaveBeenCalledTimes(1);

    now += 1;
    await expect(getOpenClawExecutionAdmission(input, { useSharedCache: true }))
      .resolves.toMatchObject({ state: 'ready' });
    expect(getReadiness).toHaveBeenCalledTimes(2);
  });

  it('blocks on a fresh collection once a positive attestation reaches its maximum age', async () => {
    let now = Date.parse('2026-08-22T21:00:00.000Z');
    const getReadiness = jest
      .fn<Promise<OpenClawSetupReadiness>, []>()
      .mockResolvedValueOnce(readiness())
      .mockResolvedValue(readiness({
        ready: false,
        blockers: [{ code: 'core-package-mismatch', message: 'OpenClaw core must match a supported version.' }],
      }));
    const input = dependencies({ getReadiness, now: () => now });

    await getOpenClawExecutionAdmission(input, { useSharedCache: true });
    now += __openClawExecutionAdmissionTest.READINESS_ATTESTATION_MAX_AGE_MS;
    // Nothing valid is left to serve, so the changed runtime is reported now.
    await expect(getOpenClawExecutionAdmission(input, { useSharedCache: true }))
      .resolves.toMatchObject({ state: 'unavailable', readinessBlockers: ['core-package-mismatch'] });
    expect(getReadiness).toHaveBeenCalledTimes(2);
  });

  it('publishes a forced recheck directly, without the contention debounce', async () => {
    const getReadiness = jest
      .fn<Promise<OpenClawSetupReadiness>, []>()
      .mockResolvedValueOnce(readiness())
      .mockResolvedValue(readiness({
        ready: false,
        blockers: [{ code: 'codex-plugin-mismatch', message: 'The Codex plugin must be the pinned npm install.' }],
      }));
    const input = dependencies({ getReadiness });

    await getOpenClawExecutionAdmission(input, { useSharedCache: true });
    await expect(getOpenClawExecutionAdmission(input, { useSharedCache: true, forceReadiness: true }))
      .resolves.toMatchObject({ state: 'unavailable' });
    expect(getCachedOpenClawExecutionAdmission(input)).toMatchObject({ state: 'unavailable' });
  });

  it('publishes directly when a forced recheck joins a background revalidation', async () => {
    let now = Date.parse('2026-08-22T21:00:00.000Z');
    let releaseRevalidation!: (value: OpenClawSetupReadiness) => void;
    const getReadiness = jest
      .fn<Promise<OpenClawSetupReadiness>, []>()
      .mockResolvedValueOnce(readiness())
      .mockImplementationOnce(() => new Promise((resolve) => { releaseRevalidation = resolve; }));
    const input = dependencies({ getReadiness, now: () => now });

    await getOpenClawExecutionAdmission(input, { useSharedCache: true });
    now += __openClawExecutionAdmissionTest.READINESS_ATTESTATION_REFRESH_AFTER_MS;
    await getOpenClawExecutionAdmission(input, { useSharedCache: true });
    expect(getReadiness).toHaveBeenCalledTimes(2);

    const forced = getOpenClawExecutionAdmission(input, { useSharedCache: true, forceReadiness: true });
    await new Promise((resolve) => setImmediate(resolve));
    // Joined the running probe rather than starting a second one.
    expect(getReadiness).toHaveBeenCalledTimes(2);
    releaseRevalidation(readiness({
      ready: false,
      blockers: [{ code: 'core-package-mismatch', message: 'OpenClaw core must match a supported version.' }],
    }));

    await expect(forced).resolves.toMatchObject({ state: 'unavailable' });
    // The failure the operator was told about is the state everyone now sees:
    // the joined probe did not keep its background debounce.
    expect(getCachedOpenClawExecutionAdmission(input)).toMatchObject({
      state: 'unavailable',
      readinessBlockers: ['core-package-mismatch'],
    });
  });

  it('drops a positive attestation when maintenance began and ended unobserved', async () => {
    let epoch = 'epoch-1';
    const getReadiness = jest.fn<Promise<OpenClawSetupReadiness>, []>().mockResolvedValue(readiness());
    const input = dependencies({ getReadiness, readMutationEpoch: () => epoch });

    await getOpenClawExecutionAdmission(input, { useSharedCache: true });
    expect(getCachedOpenClawExecutionAdmission(input)).toMatchObject({ state: 'ready' });

    // A whole maintenance window passes with no admission looking. The marker
    // is gone again, but its directory is no longer the one that was attested.
    epoch = 'epoch-2';
    expect(getCachedOpenClawExecutionAdmission(input)).toMatchObject({
      state: 'unavailable',
      reason: 'A current OpenClaw tested-runtime readiness attestation is not cached.',
    });
    await expect(getOpenClawExecutionAdmission(input, { useSharedCache: true }))
      .resolves.toMatchObject({ state: 'ready' });
    expect(getReadiness).toHaveBeenCalledTimes(2);
    expect(getCachedOpenClawExecutionAdmission(input)).toMatchObject({ state: 'ready' });
  });

  it('discards a probe that straddled an unobserved maintenance window', async () => {
    let epoch = 'epoch-1';
    let releaseStraddling!: (value: OpenClawSetupReadiness) => void;
    const getReadiness = jest
      .fn<Promise<OpenClawSetupReadiness>, []>()
      .mockImplementationOnce(() => new Promise((resolve) => { releaseStraddling = resolve; }))
      .mockResolvedValue(readiness({ version: '2026.7.2' }));
    const input = dependencies({ getReadiness, readMutationEpoch: () => epoch });

    const pending = getOpenClawExecutionAdmission(input, { useSharedCache: true });
    await new Promise((resolve) => setImmediate(resolve));
    epoch = 'epoch-2';
    releaseStraddling(readiness());

    await expect(pending).resolves.toMatchObject({ state: 'ready' });
    // The pre-boundary answer was not trusted; a post-boundary one was collected.
    expect(getReadiness).toHaveBeenCalledTimes(2);
  });

  it('serves a negative attestation for twice its collection time, within fifteen seconds to a minute', async () => {
    const ttl = __openClawExecutionAdmissionTest.negativeReadinessAttestationTtlMs;
    expect(ttl(0)).toBe(15_000);
    expect(ttl(Number.NaN)).toBe(15_000);
    expect(ttl(5_000)).toBe(15_000);
    expect(ttl(27_000)).toBe(54_000);
    expect(ttl(45_000)).toBe(60_000);

    let now = Date.parse('2026-08-22T21:00:00.000Z');
    const getReadiness = jest.fn<Promise<OpenClawSetupReadiness>, []>().mockImplementation(async () => {
      now += 27_000;
      return readiness({
        ready: false,
        blockers: [{ code: 'gateway-rpc-unavailable', message: 'The OpenClaw gateway did not pass an authenticated RPC probe.' }],
      });
    });
    const input = dependencies({ getReadiness, now: () => now });

    await expect(getOpenClawExecutionAdmission(input, { useSharedCache: true }))
      .resolves.toMatchObject({ state: 'unavailable' });
    // A caller that asks again and again cannot start the 27 s chain more
    // often than once per 54 s of rest: about a third of one core, at most.
    now += 54_000 - 1;
    await getOpenClawExecutionAdmission(input, { useSharedCache: true });
    expect(getReadiness).toHaveBeenCalledTimes(1);
    now += 1;
    await getOpenClawExecutionAdmission(input, { useSharedCache: true });
    expect(getReadiness).toHaveBeenCalledTimes(2);
  });

  it('refuses dispatch on durable evidence alone and never consults the attestation cache', () => {
    const present = (): OpenClawDurableEvidence => ({ state: 'present' });
    const refusal = (overrides: Partial<OpenClawExecutionAdmissionDependencies>) => {
      try {
        assertOpenClawDispatchNotDurablyBlocked(dependencies(overrides));
      } catch (error) {
        return error;
      }
      return null;
    };

    // Nothing is cached in this test, and an open road is still an open road.
    expect(refusal({})).toBeNull();
    expect(refusal({ inspectMaintenanceMarker: present })).toMatchObject({
      name: 'OpenClawExecutionAdmissionError', code: 'OPENCLAW_EXECUTION_MAINTENANCE', retryable: true, statusCode: 503,
    });
    expect(refusal({ inspectHostMutationJournal: present })).toMatchObject({
      code: 'OPENCLAW_EXECUTION_RECOVERY_REQUIRED',
    });
    expect(refusal({ inspectAuthorizationFence: present })).toMatchObject({
      code: 'OPENCLAW_EXECUTION_UNAVAILABLE',
    });
    expect(refusal({ inspectMaintenanceMarker: () => ({ state: 'unsafe', reason: 'unsafe marker' }) }))
      .toBeInstanceOf(OpenClawExecutionAdmissionError);
  });

  it('refuses a turn that was admitted before a maintenance window it never saw', async () => {
    let epoch = 'epoch-1';
    const input = dependencies({ readMutationEpoch: () => epoch });
    const shared = { useSharedCache: true } as const;
    await getOpenClawExecutionAdmission(input, shared);

    expect(getCachedOpenClawExecutionAdmission(input)).toMatchObject({ state: 'ready' });
    const refusalAtTheSocket = await bindAdmittedOpenClawDispatch(async () => {
      // Host-run journaling, a reconnect wait: the turn is on its way.
      await new Promise((resolve) => setImmediate(resolve));
      expect(() => assertOpenClawDispatchNotDurablyBlocked(input, shared)).not.toThrow();

      // Maintenance opens and closes entirely inside that wait. No marker is
      // left; only the lock directories remember.
      epoch = 'epoch-2';
      await new Promise((resolve) => setImmediate(resolve));
      try {
        assertOpenClawDispatchNotDurablyBlocked(input, shared);
      } catch (error) {
        return error;
      }
      return null;
    });

    expect(refusalAtTheSocket).toMatchObject({
      name: 'OpenClawExecutionAdmissionError',
      code: 'OPENCLAW_EXECUTION_MAINTENANCE',
      retryable: true,
    });
    // A dispatch that never went through the seam is judged on evidence alone,
    // and the retry is admitted against the post-maintenance runtime.
    expect(() => assertOpenClawDispatchNotDurablyBlocked(input, shared)).not.toThrow();
    await getOpenClawExecutionAdmission(input, shared);
    await bindAdmittedOpenClawDispatch(async () => {
      expect(() => assertOpenClawDispatchNotDurablyBlocked(input, shared)).not.toThrow();
    });
  });

  it('judges an explicitly captured binding exactly like the ambient one', async () => {
    let epoch = 'epoch-1';
    const input = dependencies({ readMutationEpoch: () => epoch });
    const shared = { useSharedCache: true } as const;
    await getOpenClawExecutionAdmission(input, shared);
    // A transport that writes from a socket callback captures the binding on
    // entry and hands it back, instead of trusting context propagation.
    const captured = bindAdmittedOpenClawDispatch(() => captureAdmittedOpenClawDispatchBinding());
    expect(captured).toEqual({ generation: expect.any(Number) });
    expect(captureAdmittedOpenClawDispatchBinding()).toBeUndefined();

    expect(() => assertOpenClawDispatchNotDurablyBlocked(input, { ...shared, binding: captured })).not.toThrow();
    epoch = 'epoch-2';
    expect(() => assertOpenClawDispatchNotDurablyBlocked(input, { ...shared, binding: captured }))
      .toThrow(/OPENCLAW_EXECUTION_MAINTENANCE/);
    // An unbound call is judged on evidence alone, even inside a bound context.
    bindAdmittedOpenClawDispatch(() => {
      expect(() => assertOpenClawDispatchNotDurablyBlocked(input, { ...shared, binding: null })).not.toThrow();
    });
  });

  it('derives a mutation epoch that outlives the entry that changed it', async () => {
    const read = __openClawExecutionAdmissionTest.readMutationEvidenceEpoch;
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'portal-mutation-epoch-'));
    try {
      const watched = [path.join(root, 'installer'), path.join(root, 'installer', 'journals')];
      expect(read(watched)).toBe('absent|absent');
      fs.mkdirSync(watched[1], { recursive: true });
      const quiet = read(watched);
      expect(quiet).not.toContain('absent');
      expect(read(watched)).toBe(quiet);

      // Coarse kernel timestamps: let the clock tick past the mkdir above.
      await new Promise((resolve) => setTimeout(resolve, 30));
      const marker = path.join(watched[0], 'maintenance.json');
      fs.writeFileSync(marker, '{}');
      const during = read(watched);
      expect(during).not.toBe(quiet);
      await new Promise((resolve) => setTimeout(resolve, 30));
      fs.rmSync(marker);
      const after = read(watched);
      // The marker is gone and the directory still says something happened.
      expect(after).not.toBe(quiet);
      expect(after).not.toBe(during);
      // A change confined to a journal directory is seen as well.
      await new Promise((resolve) => setTimeout(resolve, 30));
      fs.writeFileSync(path.join(watched[1], 'active.json'), '{}');
      expect(read(watched)).not.toBe(after);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
