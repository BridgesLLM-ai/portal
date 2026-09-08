import {
  OPENCLAW_HOST_MUTATION_ACTIVE_JOURNAL,
  OPENCLAW_HOST_MUTATION_ACTIVE_JOURNALS,
  OPENCLAW_MUTATION_MAINTENANCE_MARKER,
  OPENCLAW_MUTATION_MAINTENANCE_MARKER_SCHEMA,
  OpenClawExecutionAdmissionError,
  __openClawExecutionAdmissionTest,
  __resetOpenClawExecutionAdmissionForTests,
  getCachedOpenClawExecutionAdmission,
  getOpenClawExecutionAdmission,
  type OpenClawDurableEvidence,
  type OpenClawExecutionAdmissionDependencies,
} from '../services/openClawExecutionAdmission';
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

    now += __openClawExecutionAdmissionTest.READINESS_ATTESTATION_TTL_MS;
    const final = getCachedOpenClawExecutionAdmission(input);

    expect(final).toMatchObject({
      state: 'unavailable',
      reason: expect.stringMatching(/not cached/i),
    });
    expect(getReadiness).toHaveBeenCalledTimes(1);
  });
});
