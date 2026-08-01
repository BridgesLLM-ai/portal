import fs from 'fs';
import os from 'os';
import path from 'path';
import { retireLegacyOpenClawProjectRuntime } from './projectChatLegacyRuntimeCleanup';
import {
  assertLegacyOpenClawProjectMigrationInactive,
  assertNoLegacyOpenClawProjectEvidence,
} from './legacyOpenClawProjectRetirement';

jest.mock('./legacyOpenClawProjectRetirement', () => ({
  assertLegacyOpenClawProjectMigrationInactive: jest.fn(async () => undefined),
  assertNoLegacyOpenClawProjectEvidence: jest.fn(async () => undefined),
}));

const assertMigrationInactive = jest.mocked(assertLegacyOpenClawProjectMigrationInactive);
const assertNoLegacyEvidence = jest.mocked(assertNoLegacyOpenClawProjectEvidence);

beforeEach(() => {
  assertMigrationInactive.mockReset();
  assertMigrationInactive.mockResolvedValue(undefined);
  assertNoLegacyEvidence.mockReset();
  assertNoLegacyEvidence.mockResolvedValue(undefined);
});

const ACTOR = '12345678-1234-4abc-8def-1234567890ab';
const TARGET = 'immutable-target';
const LEGACY_NAME = 'legacy-name';
const TARGET_ROOT = `/portal/projects/${ACTOR}/${LEGACY_NAME}`;
const OPENCLAW_HOME = '/srv/openclaw';
const SESSION_ID = `portal-${ACTOR}-shared_slug`;
const AGENT_ID = `portal-${ACTOR.slice(0, 8)}-shared_slug`.slice(0, 64);
const SESSION_KEY = `agent:${AGENT_ID}:${SESSION_ID}`;
const VERSIONED_SESSION_KEY = `${SESSION_KEY}-v1`;
const CURRENT_KEY = 'agent:p4oc-current-project:portal-project';

function configuredAgent(overrides: Record<string, any> = {}) {
  return {
    id: AGENT_ID,
    workspace: `${OPENCLAW_HOME}/sandboxes/${AGENT_ID}-workspace`,
    sandbox: {
      mode: 'all',
      scope: 'session',
      workspaceAccess: 'rw',
      docker: {
        image: 'openclaw-sandbox:bookworm-slim',
        network: 'bridge',
        workdir: '/workspace',
        dangerouslyAllowExternalBindSources: true,
        dangerouslyAllowReservedContainerTargets: true,
        binds: [`${TARGET_ROOT}:/workspace/project:rw`],
      },
    },
    ...overrides,
  };
}

function fixture(options: {
  collision?: boolean;
  configuredAgents?: Record<string, any>[];
  persistedLegacy?: boolean;
  listedSessionKeys?: string[];
  invalidPagination?: boolean;
  listFailure?: boolean;
  appearOnSecondInspect?: boolean;
  failGlobalMigrationProofAt?: number;
  failGlobalEvidenceProofAt?: number;
  evidenceAppearsAfterFinalScan?: boolean;
} = {}) {
  let bindingCalls = 0;
  let sessionCalls = 0;
  let inspectAgentCalls = 0;
  let configuredAgents = options.configuredAgents || [configuredAgent()];
  const listedSessionKeys = new Set(options.listedSessionKeys || []);
  const database = {
    projectChatProviderBinding: {
      findMany: jest.fn(async () => {
        bindingCalls += 1;
        if (bindingCalls === 1) {
          return options.persistedLegacy === false ? [] : [{
            id: 'legacy-binding',
            projectId: LEGACY_NAME,
            sessionKey: SESSION_KEY,
            externalSessionId: SESSION_KEY,
          }];
        }
        return options.collision ? [{ id: 'other-binding' }] : [];
      }),
    },
    projectChatSession: {
      findMany: jest.fn(async () => {
        sessionCalls += 1;
        if (sessionCalls === 1) {
          return options.persistedLegacy === false ? [] : [{
            id: 'legacy-session-row',
            projectId: LEGACY_NAME,
            sessionKey: SESSION_ID,
            activeProvider: 'OPENCLAW',
          }];
        }
        return options.collision ? [{ id: 'other-session' }] : [];
      }),
    },
  };
  const abort = jest.fn(async (_sessionKey: string) => ({ ok: true }));
  const deleteSession = jest.fn(async (
    sessionKey: string,
    _options?: { deleteTranscript: boolean },
  ) => {
    listedSessionKeys.delete(sessionKey);
    return { ok: true };
  });
  const inspect = jest.fn(async (_sessionKey: string) => ({ ok: false, error: 'Session not found' }));
  const deleteAgent = jest.fn(async (
    agentId: string,
    _options?: { deleteFiles: boolean },
  ) => {
    configuredAgents = configuredAgents.filter((agent) => agent.id !== agentId);
    return { ok: true };
  });
  const inspectAgents = jest.fn(async () => {
    inspectAgentCalls += 1;
    if (options.appearOnSecondInspect && inspectAgentCalls === 2) {
      configuredAgents = [configuredAgent()];
    }
    return {
      ok: true,
      data: { config: { agents: { list: configuredAgents } } },
    };
  });
  const listAgentSessions = jest.fn(async (input: {
    agentId: string;
    archived: boolean;
    offset: number;
  }) => ({
    ok: options.listFailure !== true,
    data: {
      sessions: input.archived || input.offset > 0
        ? []
        : Array.from(listedSessionKeys).map((key) => ({ key })),
      hasMore: options.invalidPagination === true && !input.archived && input.offset === 0,
      ...(options.invalidPagination === true ? { nextOffset: input.offset } : {}),
    },
  }));
  const attestAgentWorkspace = jest.fn();
  if (options.failGlobalMigrationProofAt) {
    let globalMigrationProofCalls = 0;
    assertMigrationInactive.mockImplementation(async () => {
      globalMigrationProofCalls += 1;
      if (globalMigrationProofCalls === options.failGlobalMigrationProofAt) {
        throw new Error('sticky DISCOVERING migration gate');
      }
    });
  }
  if (options.failGlobalEvidenceProofAt || options.evidenceAppearsAfterFinalScan) {
    let globalEvidenceProofCalls = 0;
    assertNoLegacyEvidence.mockImplementation(async () => {
      globalEvidenceProofCalls += 1;
      if (globalEvidenceProofCalls === options.failGlobalEvidenceProofAt) {
        throw new Error('late global legacy evidence');
      }
      if (options.evidenceAppearsAfterFinalScan && globalEvidenceProofCalls === 2) {
        listedSessionKeys.add(VERSIONED_SESSION_KEY);
      }
    });
  }
  return {
    assertMigrationInactive,
    assertNoLegacyEvidence,
    database,
    abort,
    deleteSession,
    inspect,
    deleteAgent,
    inspectAgents,
    listAgentSessions,
    attestAgentWorkspace,
    listedSessionKeys,
  };
}

test('Clear remains pending and preserves every actor-attested 3.x session form', async () => {
  const dependencies = fixture();
  await expect(retireLegacyOpenClawProjectRuntime({
    actorUserId: ACTOR,
    targetProjectIds: [TARGET, LEGACY_NAME],
    targetCanonicalRoot: TARGET_ROOT,
    exactServerOwnedSessionKeys: [CURRENT_KEY],
    adapterOwnedSessionKeys: [CURRENT_KEY],
    openClawHome: OPENCLAW_HOME,
  }, {
    database: dependencies.database as any,
    abort: dependencies.abort,
    delete: dependencies.deleteSession,
    inspect: dependencies.inspect,
    deleteAgent: dependencies.deleteAgent,
    inspectAgents: dependencies.inspectAgents,
    listAgentSessions: dependencies.listAgentSessions,
    attestAgentWorkspace: dependencies.attestAgentWorkspace,
  })).rejects.toThrow(/destructive retirement is unavailable/i);
  expect(dependencies.abort).not.toHaveBeenCalled();
  expect(dependencies.deleteSession).not.toHaveBeenCalled();
  expect(dependencies.inspect).not.toHaveBeenCalled();
  expect(dependencies.deleteAgent).not.toHaveBeenCalled();
  expect(dependencies.inspectAgents).toHaveBeenCalledTimes(2);
  expect(dependencies.listAgentSessions.mock.calls.length).toBeGreaterThanOrEqual(2);
});

test('Clear remains pending on a persisted legacy key after its config agent disappeared', async () => {
  const dependencies = fixture({ configuredAgents: [] });
  await expect(retireLegacyOpenClawProjectRuntime({
    actorUserId: ACTOR,
    targetProjectIds: [TARGET, LEGACY_NAME],
    targetCanonicalRoot: TARGET_ROOT,
    exactServerOwnedSessionKeys: [CURRENT_KEY],
    adapterOwnedSessionKeys: [CURRENT_KEY],
    openClawHome: OPENCLAW_HOME,
  }, {
    database: dependencies.database as any,
    abort: dependencies.abort,
    delete: dependencies.deleteSession,
    inspect: dependencies.inspect,
    deleteAgent: dependencies.deleteAgent,
    inspectAgents: dependencies.inspectAgents,
    listAgentSessions: dependencies.listAgentSessions,
    attestAgentWorkspace: dependencies.attestAgentWorkspace,
  })).rejects.toThrow(/destructive retirement is unavailable/i);
  expect(dependencies.abort).not.toHaveBeenCalled();
  expect(dependencies.deleteSession).not.toHaveBeenCalled();
  expect(dependencies.deleteAgent).not.toHaveBeenCalled();
});

test('rename remains pending without deleting transcript or agent files', async () => {
  const dependencies = fixture();
  await expect(retireLegacyOpenClawProjectRuntime({
    actorUserId: ACTOR,
    targetProjectIds: [TARGET, LEGACY_NAME],
    targetCanonicalRoot: TARGET_ROOT,
    exactServerOwnedSessionKeys: [CURRENT_KEY],
    adapterOwnedSessionKeys: [CURRENT_KEY],
    preserveTranscriptFiles: true,
    openClawHome: OPENCLAW_HOME,
  }, {
    database: dependencies.database as any,
    abort: dependencies.abort,
    delete: dependencies.deleteSession,
    inspect: dependencies.inspect,
    deleteAgent: dependencies.deleteAgent,
    inspectAgents: dependencies.inspectAgents,
    listAgentSessions: dependencies.listAgentSessions,
    attestAgentWorkspace: dependencies.attestAgentWorkspace,
  })).rejects.toThrow(/destructive retirement is unavailable/i);

  expect(dependencies.abort).not.toHaveBeenCalled();
  expect(dependencies.deleteSession).not.toHaveBeenCalled();
  expect(dependencies.deleteAgent).not.toHaveBeenCalled();
});

test('a duplicated v3 stable slug fails closed before touching the shared Gateway session', async () => {
  const dependencies = fixture({ collision: true });
  await expect(retireLegacyOpenClawProjectRuntime({
    actorUserId: ACTOR,
    targetProjectIds: [TARGET, LEGACY_NAME],
    targetCanonicalRoot: TARGET_ROOT,
    exactServerOwnedSessionKeys: [CURRENT_KEY],
    adapterOwnedSessionKeys: [CURRENT_KEY],
    openClawHome: OPENCLAW_HOME,
  }, {
    database: dependencies.database as any,
    abort: dependencies.abort,
    delete: dependencies.deleteSession,
    inspect: dependencies.inspect,
    deleteAgent: dependencies.deleteAgent,
    inspectAgents: dependencies.inspectAgents,
    listAgentSessions: dependencies.listAgentSessions,
    attestAgentWorkspace: dependencies.attestAgentWorkspace,
  })).rejects.toThrow(/shared with another Project/i);
  expect(dependencies.abort).not.toHaveBeenCalled();
  expect(dependencies.deleteSession).not.toHaveBeenCalled();
  expect(dependencies.inspect).not.toHaveBeenCalled();
  expect(dependencies.deleteAgent).not.toHaveBeenCalled();
  expect(dependencies.inspectAgents).toHaveBeenCalledTimes(1);
  expect(dependencies.listAgentSessions.mock.calls.length).toBeGreaterThanOrEqual(2);
});

test('refuses a config agent bound to another Project before any Gateway mutation', async () => {
  const drifted = configuredAgent({
    sandbox: {
      ...configuredAgent().sandbox,
      docker: {
        ...configuredAgent().sandbox.docker,
        binds: ['/portal/projects/another-owner/another-project:/workspace/project:rw'],
      },
    },
  });
  const dependencies = fixture({ configuredAgents: [drifted] });
  await expect(retireLegacyOpenClawProjectRuntime({
    actorUserId: ACTOR,
    targetProjectIds: [TARGET, LEGACY_NAME],
    targetCanonicalRoot: TARGET_ROOT,
    exactServerOwnedSessionKeys: [CURRENT_KEY],
    adapterOwnedSessionKeys: [CURRENT_KEY],
    openClawHome: OPENCLAW_HOME,
  }, {
    database: dependencies.database as any,
    abort: dependencies.abort,
    delete: dependencies.deleteSession,
    inspect: dependencies.inspect,
    deleteAgent: dependencies.deleteAgent,
    inspectAgents: dependencies.inspectAgents,
    listAgentSessions: dependencies.listAgentSessions,
    attestAgentWorkspace: dependencies.attestAgentWorkspace,
  })).rejects.toThrow(/exact target workspace and bind/i);
  expect(dependencies.abort).not.toHaveBeenCalled();
  expect(dependencies.deleteSession).not.toHaveBeenCalled();
  expect(dependencies.deleteAgent).not.toHaveBeenCalled();
});

test('refuses a duplicated config agent identity before any Gateway mutation', async () => {
  const driftedDuplicate = configuredAgent({
    sandbox: {
      ...configuredAgent().sandbox,
      docker: {
        ...configuredAgent().sandbox.docker,
        binds: ['/portal/projects/another-owner/another-project:/workspace/project:rw'],
      },
    },
  });
  const dependencies = fixture({ configuredAgents: [configuredAgent(), driftedDuplicate] });
  await expect(retireLegacyOpenClawProjectRuntime({
    actorUserId: ACTOR,
    targetProjectIds: [TARGET, LEGACY_NAME],
    targetCanonicalRoot: TARGET_ROOT,
    exactServerOwnedSessionKeys: [CURRENT_KEY],
    adapterOwnedSessionKeys: [CURRENT_KEY],
    openClawHome: OPENCLAW_HOME,
  }, {
    database: dependencies.database as any,
    abort: dependencies.abort,
    delete: dependencies.deleteSession,
    inspect: dependencies.inspect,
    deleteAgent: dependencies.deleteAgent,
    inspectAgents: dependencies.inspectAgents,
    listAgentSessions: dependencies.listAgentSessions,
    attestAgentWorkspace: dependencies.attestAgentWorkspace,
  })).rejects.toThrow(/duplicated/i);
  expect(dependencies.abort).not.toHaveBeenCalled();
  expect(dependencies.deleteSession).not.toHaveBeenCalled();
  expect(dependencies.deleteAgent).not.toHaveBeenCalled();
});

test('preserves a config-only 3.x orphan and every bounded listed session', async () => {
  const dependencies = fixture({
    persistedLegacy: false,
    listedSessionKeys: [VERSIONED_SESSION_KEY],
  });
  await expect(retireLegacyOpenClawProjectRuntime({
    actorUserId: ACTOR,
    targetProjectIds: [TARGET, LEGACY_NAME],
    targetCanonicalRoot: TARGET_ROOT,
    exactServerOwnedSessionKeys: [CURRENT_KEY],
    adapterOwnedSessionKeys: [CURRENT_KEY],
    openClawHome: OPENCLAW_HOME,
  }, {
    database: dependencies.database as any,
    abort: dependencies.abort,
    delete: dependencies.deleteSession,
    inspect: dependencies.inspect,
    deleteAgent: dependencies.deleteAgent,
    inspectAgents: dependencies.inspectAgents,
    listAgentSessions: dependencies.listAgentSessions,
    attestAgentWorkspace: dependencies.attestAgentWorkspace,
  })).rejects.toThrow(/destructive retirement is unavailable/i);
  expect(dependencies.abort).not.toHaveBeenCalled();
  expect(dependencies.deleteSession).not.toHaveBeenCalled();
  expect(dependencies.deleteAgent).not.toHaveBeenCalled();
});

test('Clear remains pending on a root-attested config-only agent with no listed session', async () => {
  const dependencies = fixture({ persistedLegacy: false, listedSessionKeys: [] });
  await expect(retireLegacyOpenClawProjectRuntime({
    actorUserId: ACTOR,
    targetProjectIds: [TARGET, LEGACY_NAME],
    targetCanonicalRoot: TARGET_ROOT,
    exactServerOwnedSessionKeys: [CURRENT_KEY],
    adapterOwnedSessionKeys: [CURRENT_KEY],
    openClawHome: OPENCLAW_HOME,
  }, {
    database: dependencies.database as any,
    abort: dependencies.abort,
    delete: dependencies.deleteSession,
    inspect: dependencies.inspect,
    deleteAgent: dependencies.deleteAgent,
    inspectAgents: dependencies.inspectAgents,
    listAgentSessions: dependencies.listAgentSessions,
    attestAgentWorkspace: dependencies.attestAgentWorkspace,
  })).rejects.toThrow(/destructive retirement is unavailable/i);
  expect(dependencies.abort).not.toHaveBeenCalled();
  expect(dependencies.deleteSession).not.toHaveBeenCalled();
  expect(dependencies.deleteAgent).not.toHaveBeenCalled();
});

test('project-wide lifecycle fails pending on an exact root-attested config-only orphan', async () => {
  const dependencies = fixture({ persistedLegacy: false, listedSessionKeys: [] });
  await expect(retireLegacyOpenClawProjectRuntime({
    actorUserId: ACTOR,
    targetProjectIds: [TARGET, LEGACY_NAME],
    targetCanonicalRoot: TARGET_ROOT,
    exactServerOwnedSessionKeys: [CURRENT_KEY],
    adapterOwnedSessionKeys: [CURRENT_KEY],
    retireRootAttestedConfigOnlyAgents: true,
    openClawHome: OPENCLAW_HOME,
  }, {
    database: dependencies.database as any,
    abort: dependencies.abort,
    delete: dependencies.deleteSession,
    inspect: dependencies.inspect,
    deleteAgent: dependencies.deleteAgent,
    inspectAgents: dependencies.inspectAgents,
    listAgentSessions: dependencies.listAgentSessions,
    attestAgentWorkspace: dependencies.attestAgentWorkspace,
  })).rejects.toThrow(/destructive retirement is unavailable/i);
  expect(dependencies.abort).not.toHaveBeenCalled();
  expect(dependencies.deleteAgent).not.toHaveBeenCalled();
});

test('project-wide lifecycle remains release-disabled even when every exact identity is absent', async () => {
  const dependencies = fixture({ persistedLegacy: false, configuredAgents: [] });
  await expect(retireLegacyOpenClawProjectRuntime({
    actorUserId: ACTOR,
    targetProjectIds: [TARGET, LEGACY_NAME],
    targetCanonicalRoot: TARGET_ROOT,
    exactServerOwnedSessionKeys: [CURRENT_KEY],
    adapterOwnedSessionKeys: [CURRENT_KEY],
    retireRootAttestedConfigOnlyAgents: true,
    openClawHome: OPENCLAW_HOME,
  }, {
    database: dependencies.database as any,
    abort: dependencies.abort,
    delete: dependencies.deleteSession,
    inspect: dependencies.inspect,
    deleteAgent: dependencies.deleteAgent,
    inspectAgents: dependencies.inspectAgents,
    listAgentSessions: dependencies.listAgentSessions,
    attestAgentWorkspace: dependencies.attestAgentWorkspace,
  })).rejects.toThrow(/destructive retirement is unavailable/i);
  expect(dependencies.abort).not.toHaveBeenCalled();
  expect(dependencies.deleteSession).not.toHaveBeenCalled();
  expect(dependencies.deleteAgent).not.toHaveBeenCalled();
});

test('a legacy agent appearing at the final read-only boundary blocks without mutation', async () => {
  const dependencies = fixture({
    persistedLegacy: false,
    configuredAgents: [],
    appearOnSecondInspect: true,
  });
  await expect(retireLegacyOpenClawProjectRuntime({
    actorUserId: ACTOR,
    targetProjectIds: [TARGET, LEGACY_NAME],
    targetCanonicalRoot: TARGET_ROOT,
    exactServerOwnedSessionKeys: [CURRENT_KEY],
    adapterOwnedSessionKeys: [CURRENT_KEY],
    openClawHome: OPENCLAW_HOME,
  }, {
    database: dependencies.database as any,
    abort: dependencies.abort,
    delete: dependencies.deleteSession,
    inspect: dependencies.inspect,
    deleteAgent: dependencies.deleteAgent,
    inspectAgents: dependencies.inspectAgents,
    listAgentSessions: dependencies.listAgentSessions,
    attestAgentWorkspace: dependencies.attestAgentWorkspace,
  })).rejects.toThrow(/agent set changed during cleanup/i);
  expect(dependencies.abort).not.toHaveBeenCalled();
  expect(dependencies.deleteSession).not.toHaveBeenCalled();
  expect(dependencies.deleteAgent).not.toHaveBeenCalled();
});

test('a sticky global DISCOVERING gate blocks before inventory or Gateway mutation', async () => {
  const dependencies = fixture({
    persistedLegacy: false,
    configuredAgents: [],
    failGlobalMigrationProofAt: 1,
  });
  await expect(retireLegacyOpenClawProjectRuntime({
    actorUserId: ACTOR,
    targetProjectIds: [TARGET, LEGACY_NAME],
    targetCanonicalRoot: TARGET_ROOT,
    exactServerOwnedSessionKeys: [CURRENT_KEY],
    adapterOwnedSessionKeys: [CURRENT_KEY],
    openClawHome: OPENCLAW_HOME,
  }, {
    database: dependencies.database as any,
    abort: dependencies.abort,
    delete: dependencies.deleteSession,
    inspect: dependencies.inspect,
    deleteAgent: dependencies.deleteAgent,
    inspectAgents: dependencies.inspectAgents,
    listAgentSessions: dependencies.listAgentSessions,
    attestAgentWorkspace: dependencies.attestAgentWorkspace,
  })).rejects.toThrow(/sticky DISCOVERING migration gate/i);
  expect(dependencies.assertMigrationInactive).toHaveBeenCalledTimes(1);
  expect(dependencies.assertNoLegacyEvidence).not.toHaveBeenCalled();
  expect(dependencies.database.projectChatProviderBinding.findMany).not.toHaveBeenCalled();
  expect(dependencies.database.projectChatSession.findMany).not.toHaveBeenCalled();
  expect(dependencies.inspectAgents).not.toHaveBeenCalled();
  expect(dependencies.abort).not.toHaveBeenCalled();
  expect(dependencies.deleteSession).not.toHaveBeenCalled();
  expect(dependencies.inspect).not.toHaveBeenCalled();
  expect(dependencies.deleteAgent).not.toHaveBeenCalled();
});

test('a sticky global DISCOVERING gate appearing at the final boundary preserves all state', async () => {
  const dependencies = fixture({
    persistedLegacy: false,
    configuredAgents: [],
    failGlobalMigrationProofAt: 2,
  });
  await expect(retireLegacyOpenClawProjectRuntime({
    actorUserId: ACTOR,
    targetProjectIds: [TARGET, LEGACY_NAME],
    targetCanonicalRoot: TARGET_ROOT,
    exactServerOwnedSessionKeys: [CURRENT_KEY],
    adapterOwnedSessionKeys: [CURRENT_KEY],
    openClawHome: OPENCLAW_HOME,
  }, {
    database: dependencies.database as any,
    abort: dependencies.abort,
    delete: dependencies.deleteSession,
    inspect: dependencies.inspect,
    deleteAgent: dependencies.deleteAgent,
    inspectAgents: dependencies.inspectAgents,
    listAgentSessions: dependencies.listAgentSessions,
    attestAgentWorkspace: dependencies.attestAgentWorkspace,
  })).rejects.toThrow(/sticky DISCOVERING migration gate/i);
  expect(dependencies.assertMigrationInactive).toHaveBeenCalledTimes(2);
  expect(dependencies.abort).not.toHaveBeenCalled();
  expect(dependencies.deleteSession).not.toHaveBeenCalled();
  expect(dependencies.inspect).not.toHaveBeenCalled();
  expect(dependencies.deleteAgent).not.toHaveBeenCalled();
});

test('late global legacy evidence blocks the final boundary with zero Gateway mutation', async () => {
  const dependencies = fixture({
    persistedLegacy: false,
    configuredAgents: [],
    failGlobalEvidenceProofAt: 2,
  });
  await expect(retireLegacyOpenClawProjectRuntime({
    actorUserId: ACTOR,
    targetProjectIds: [TARGET, LEGACY_NAME],
    targetCanonicalRoot: TARGET_ROOT,
    exactServerOwnedSessionKeys: [CURRENT_KEY],
    adapterOwnedSessionKeys: [CURRENT_KEY],
    openClawHome: OPENCLAW_HOME,
  }, {
    database: dependencies.database as any,
    abort: dependencies.abort,
    delete: dependencies.deleteSession,
    inspect: dependencies.inspect,
    deleteAgent: dependencies.deleteAgent,
    inspectAgents: dependencies.inspectAgents,
    listAgentSessions: dependencies.listAgentSessions,
    attestAgentWorkspace: dependencies.attestAgentWorkspace,
  })).rejects.toThrow(/late global legacy evidence/i);
  expect(dependencies.assertNoLegacyEvidence).toHaveBeenCalledTimes(2);
  expect(dependencies.abort).not.toHaveBeenCalled();
  expect(dependencies.deleteSession).not.toHaveBeenCalled();
  expect(dependencies.inspect).not.toHaveBeenCalled();
  expect(dependencies.deleteAgent).not.toHaveBeenCalled();
});

test('evidence created after the final scan still cannot cross the literal release gate', async () => {
  const dependencies = fixture({
    persistedLegacy: false,
    configuredAgents: [],
    evidenceAppearsAfterFinalScan: true,
  });
  await expect(retireLegacyOpenClawProjectRuntime({
    actorUserId: ACTOR,
    targetProjectIds: [TARGET, LEGACY_NAME],
    targetCanonicalRoot: TARGET_ROOT,
    exactServerOwnedSessionKeys: [CURRENT_KEY],
    adapterOwnedSessionKeys: [CURRENT_KEY],
    openClawHome: OPENCLAW_HOME,
  }, {
    database: dependencies.database as any,
    abort: dependencies.abort,
    delete: dependencies.deleteSession,
    inspect: dependencies.inspect,
    deleteAgent: dependencies.deleteAgent,
    inspectAgents: dependencies.inspectAgents,
    listAgentSessions: dependencies.listAgentSessions,
    attestAgentWorkspace: dependencies.attestAgentWorkspace,
  })).rejects.toThrow(/destructive retirement is unavailable/i);
  expect(dependencies.assertNoLegacyEvidence).toHaveBeenCalledTimes(2);
  expect(dependencies.listedSessionKeys.has(VERSIONED_SESSION_KEY)).toBe(true);
  expect(dependencies.abort).not.toHaveBeenCalled();
  expect(dependencies.deleteSession).not.toHaveBeenCalled();
  expect(dependencies.inspect).not.toHaveBeenCalled();
  expect(dependencies.deleteAgent).not.toHaveBeenCalled();
});

test('fails closed when config-only session enumeration is unavailable', async () => {
  const dependencies = fixture({ persistedLegacy: false, listFailure: true });
  await expect(retireLegacyOpenClawProjectRuntime({
    actorUserId: ACTOR,
    targetProjectIds: [TARGET, LEGACY_NAME],
    targetCanonicalRoot: TARGET_ROOT,
    exactServerOwnedSessionKeys: [CURRENT_KEY],
    adapterOwnedSessionKeys: [CURRENT_KEY],
    openClawHome: OPENCLAW_HOME,
  }, {
    database: dependencies.database as any,
    abort: dependencies.abort,
    delete: dependencies.deleteSession,
    inspect: dependencies.inspect,
    deleteAgent: dependencies.deleteAgent,
    inspectAgents: dependencies.inspectAgents,
    listAgentSessions: dependencies.listAgentSessions,
    attestAgentWorkspace: dependencies.attestAgentWorkspace,
  })).rejects.toThrow(/authoritatively enumerated/i);
  expect(dependencies.abort).not.toHaveBeenCalled();
  expect(dependencies.deleteAgent).not.toHaveBeenCalled();
});

test('does not delete an unrelated actor-prefix agent while the release gate remains closed', async () => {
  const unrelatedAgentId = 'portal-deadbeef-unrelated_project';
  const unrelatedAgent = configuredAgent({
    id: unrelatedAgentId,
    workspace: `${OPENCLAW_HOME}/sandboxes/${unrelatedAgentId}-workspace`,
  });
  const dependencies = fixture({
    persistedLegacy: false,
    configuredAgents: [unrelatedAgent],
  });
  await expect(retireLegacyOpenClawProjectRuntime({
    actorUserId: ACTOR,
    targetProjectIds: [TARGET, LEGACY_NAME],
    targetCanonicalRoot: TARGET_ROOT,
    exactServerOwnedSessionKeys: [CURRENT_KEY],
    adapterOwnedSessionKeys: [CURRENT_KEY],
    openClawHome: OPENCLAW_HOME,
  }, {
    database: dependencies.database as any,
    abort: dependencies.abort,
    delete: dependencies.deleteSession,
    inspect: dependencies.inspect,
    deleteAgent: dependencies.deleteAgent,
    inspectAgents: dependencies.inspectAgents,
    listAgentSessions: dependencies.listAgentSessions,
    attestAgentWorkspace: dependencies.attestAgentWorkspace,
  })).rejects.toThrow(/destructive retirement is unavailable/i);
  expect(dependencies.abort).not.toHaveBeenCalled();
  expect(dependencies.deleteSession).not.toHaveBeenCalled();
  expect(dependencies.deleteAgent).not.toHaveBeenCalled();
  expect(dependencies.listAgentSessions).not.toHaveBeenCalled();
});

test('rejects malformed session pagination before the first Gateway mutation', async () => {
  const dependencies = fixture({ invalidPagination: true });
  await expect(retireLegacyOpenClawProjectRuntime({
    actorUserId: ACTOR,
    targetProjectIds: [TARGET, LEGACY_NAME],
    targetCanonicalRoot: TARGET_ROOT,
    exactServerOwnedSessionKeys: [CURRENT_KEY],
    adapterOwnedSessionKeys: [CURRENT_KEY],
    openClawHome: OPENCLAW_HOME,
  }, {
    database: dependencies.database as any,
    abort: dependencies.abort,
    delete: dependencies.deleteSession,
    inspect: dependencies.inspect,
    deleteAgent: dependencies.deleteAgent,
    inspectAgents: dependencies.inspectAgents,
    listAgentSessions: dependencies.listAgentSessions,
    attestAgentWorkspace: dependencies.attestAgentWorkspace,
  })).rejects.toThrow(/invalid pagination/i);
  expect(dependencies.abort).not.toHaveBeenCalled();
  expect(dependencies.deleteSession).not.toHaveBeenCalled();
  expect(dependencies.deleteAgent).not.toHaveBeenCalled();
});

test('refuses a symlinked legacy agent workspace before any Gateway mutation', async () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'project-chat-legacy-workspace-'));
  try {
    const openClawHome = path.join(tempRoot, 'openclaw');
    const sandboxesRoot = path.join(openClawHome, 'sandboxes');
    const outside = path.join(tempRoot, 'outside');
    fs.mkdirSync(sandboxesRoot, { recursive: true });
    fs.mkdirSync(outside);
    fs.symlinkSync(outside, path.join(sandboxesRoot, `${AGENT_ID}-workspace`), 'dir');
    const dependencies = fixture({
      configuredAgents: [configuredAgent({
        workspace: path.join(sandboxesRoot, `${AGENT_ID}-workspace`),
      })],
    });

    await expect(retireLegacyOpenClawProjectRuntime({
      actorUserId: ACTOR,
      targetProjectIds: [TARGET, LEGACY_NAME],
      targetCanonicalRoot: TARGET_ROOT,
      exactServerOwnedSessionKeys: [CURRENT_KEY],
      adapterOwnedSessionKeys: [CURRENT_KEY],
      openClawHome,
    }, {
    database: dependencies.database as any,
    abort: dependencies.abort,
      delete: dependencies.deleteSession,
      inspect: dependencies.inspect,
      deleteAgent: dependencies.deleteAgent,
      inspectAgents: dependencies.inspectAgents,
      listAgentSessions: dependencies.listAgentSessions,
    })).rejects.toThrow(/legacy agent workspace was not an exact directory/i);
    expect(dependencies.abort).not.toHaveBeenCalled();
    expect(dependencies.deleteSession).not.toHaveBeenCalled();
    expect(dependencies.deleteAgent).not.toHaveBeenCalled();
  } finally {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
});
