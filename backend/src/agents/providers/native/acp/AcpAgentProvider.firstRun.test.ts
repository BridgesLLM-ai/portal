import fs from 'fs';
import os from 'os';
import path from 'path';

const sessionsRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'portal-acp-first-run-'));
const previousSessionsRoot = process.env.PORTAL_NATIVE_AGENT_SESSIONS_DIR;
const previousHermesHome = process.env.PORTAL_HERMES_HOME;
const previousOpenCodeHome = process.env.PORTAL_OPENCODE_HOME;
process.env.PORTAL_NATIVE_AGENT_SESSIONS_DIR = sessionsRoot;
process.env.PORTAL_HERMES_HOME = path.join(sessionsRoot, 'hermes');
process.env.PORTAL_OPENCODE_HOME = path.join(sessionsRoot, 'opencode');

jest.mock('../../../providerAvailability', () => ({
  getProviderAvailability: jest.fn((name: string) => ({
    name,
    usable: true,
    capabilities: { supportedExecutionScopes: ['HOST_OPERATOR', 'PROJECT_SANDBOX'] },
  })),
}));

jest.mock('../../../nativeProviderReadiness', () => ({
  getNativeProviderReadiness: jest.fn(async (provider: string) => ({
    provider,
    state: 'login_present',
    usable: true,
    message: 'Harness-native login is present.',
  })),
}));

const { createHostOperatorExecutionContext } = require('../../../executionScope') as typeof import('../../../executionScope');
const { AcpAgentProvider } = require('./AcpAgentProvider') as typeof import('./AcpAgentProvider');
const {
  HERMES_ACP_PROFILE,
  HERMES_ACP_VERSION,
  OPENCODE_ACP_PROFILE,
  OPENCODE_ACP_VERSION,
} = require('./AcpHarnessProfiles') as typeof import('./AcpHarnessProfiles');
const {
  __resetAcpModelCatalogForTests,
} = require('./AcpModelCatalog') as typeof import('./AcpModelCatalog');
const { listProviderModels } = require('../../../providerModels') as typeof import('../../../providerModels');
const {
  loadNativeSession,
} = require('../../NativeSessionStore') as typeof import('../../NativeSessionStore');
const { hermesAdapter } = require('../adapters/hermes') as typeof import('../adapters/hermes');
const { openCodeAdapter } = require('../adapters/opencode') as typeof import('../adapters/opencode');
import type { AcpAgentProviderConfig } from './AcpAgentProvider';
import type {
  AcpModelState,
  AcpSessionStartResult,
  AcpStdioBroker,
  AcpStdioBrokerOptions,
  AcpTurnResult,
} from './AcpStdioBroker';

class FirstRunAcpProvider extends AcpAgentProvider {
  constructor(config: AcpAgentProviderConfig) {
    super(config);
  }
}

type Scenario = {
  provider: 'HERMES' | 'OPENCODE';
  profile: typeof HERMES_ACP_PROFILE | typeof OPENCODE_ACP_PROFILE;
  adapter: typeof hermesAdapter | typeof openCodeAdapter;
  agentName: string;
  agentVersion: string;
  nativeSessionId: string;
  defaultModel: string;
  alternateModel: string;
};

function cloneState(state: AcpModelState): AcpModelState {
  return {
    currentModelId: state.currentModelId,
    availableModels: state.availableModels.map((model) => ({ ...model })),
  };
}

describe('ACP Agent Chat first-run model lifecycle', () => {
  afterEach(() => __resetAcpModelCatalogForTests());

  afterAll(() => {
    if (previousSessionsRoot === undefined) delete process.env.PORTAL_NATIVE_AGENT_SESSIONS_DIR;
    else process.env.PORTAL_NATIVE_AGENT_SESSIONS_DIR = previousSessionsRoot;
    if (previousHermesHome === undefined) delete process.env.PORTAL_HERMES_HOME;
    else process.env.PORTAL_HERMES_HOME = previousHermesHome;
    if (previousOpenCodeHome === undefined) delete process.env.PORTAL_OPENCODE_HOME;
    else process.env.PORTAL_OPENCODE_HOME = previousOpenCodeHome;
    fs.rmSync(sessionsRoot, { recursive: true, force: true });
  });

  test.each<Scenario>([
    {
      provider: 'HERMES',
      profile: HERMES_ACP_PROFILE,
      adapter: hermesAdapter,
      agentName: 'hermes-agent',
      agentVersion: HERMES_ACP_VERSION,
      nativeSessionId: 'hermes-first-run-session',
      defaultModel: 'openrouter/default-model',
      alternateModel: 'openrouter/alternate-model',
    },
    {
      provider: 'OPENCODE',
      profile: OPENCODE_ACP_PROFILE,
      adapter: openCodeAdapter,
      agentName: 'OpenCode',
      agentVersion: OPENCODE_ACP_VERSION,
      nativeSessionId: 'opencode-first-run-session',
      defaultModel: 'opencode/default-model',
      alternateModel: 'opencode/alternate-model',
    },
  ])('$provider sends with its attested default, persists the live catalog, then sets and reads back another model', async (scenario) => {
    const availableModels = [
      { id: scenario.defaultModel, name: 'Harness default' },
      { id: scenario.alternateModel, name: 'Alternate model' },
    ];
    const defaultState: AcpModelState = {
      currentModelId: scenario.defaultModel,
      availableModels,
    };
    const selectedState: AcpModelState = {
      currentModelId: scenario.alternateModel,
      availableModels,
    };
    const startResult = (state: AcpModelState): AcpSessionStartResult => ({
      nativeSessionId: scenario.nativeSessionId,
      modelState: cloneState(state),
      initialModelId: scenario.defaultModel,
      agentName: scenario.agentName,
      agentVersion: scenario.agentVersion,
      protocolVersion: 1,
    });
    const brokerOptions: AcpStdioBrokerOptions[] = [];
    const setModel = jest.fn(async (model: string) => {
      expect(model).toBe(scenario.alternateModel);
      return cloneState(selectedState);
    });
    const brokers = [
      {
        start: jest.fn(async () => startResult(defaultState)),
        prompt: jest.fn(async (): Promise<AcpTurnResult> => ({
          ...startResult(defaultState),
          fullText: `${scenario.provider} first response`,
          stopReason: 'end_turn',
        })),
        dispose: jest.fn(async () => undefined),
        abort: jest.fn(() => true),
      },
      {
        start: jest.fn(async () => startResult(defaultState)),
        setModel,
        dispose: jest.fn(async () => undefined),
        abort: jest.fn(() => true),
      },
    ];
    const brokerFactory = jest.fn((options: AcpStdioBrokerOptions) => {
      brokerOptions.push(options);
      const next = brokers.shift();
      if (!next) throw new Error('Unexpected ACP broker construction');
      return next as unknown as AcpStdioBroker;
    });
    const provider = new FirstRunAcpProvider({
      providerName: scenario.provider,
      adapter: scenario.adapter,
      profile: scenario.profile,
      securityTag: 'test-acp-host-operator',
      brokerFactory,
    });

    // Before any Portal session, the ACP catalog is deliberately empty. It is
    // never replaced by a guessed "latest" list; the harness default remains
    // usable because no model override is sent.
    await expect(listProviderModels(scenario.provider)).resolves.toEqual([]);
    const sessionId = await provider.startSession('owner-first-run', {
      executionContext: createHostOperatorExecutionContext('owner-first-run'),
    });
    expect(loadNativeSession(scenario.provider, sessionId)?.model).toBeUndefined();

    const result = await provider.sendMessage(
      sessionId,
      'Use your harness default.',
      undefined,
      undefined,
      undefined,
      { label: 'owner@example.com', userId: 'owner-first-run', role: 'OWNER' },
    );

    expect(brokerOptions[0]).toMatchObject({
      profile: scenario.profile,
      model: undefined,
      nativeSessionId: null,
    });
    expect(result.metadata).toMatchObject({
      agentName: scenario.agentName,
      agentVersion: scenario.agentVersion,
      protocolVersion: 1,
      nativeSessionId: scenario.nativeSessionId,
      model: scenario.defaultModel,
      sessionModelState: defaultState,
    });
    const persistedAfterTurn = loadNativeSession(scenario.provider, sessionId)!;
    expect(persistedAfterTurn.model).toBeUndefined();
    expect(persistedAfterTurn.metadata).toMatchObject({
      nativeSessionId: scenario.nativeSessionId,
      nativeDefaultModelId: scenario.defaultModel,
      acpCurrentModelId: scenario.defaultModel,
      acpAvailableModels: availableModels,
    });

    // Simulate a Portal process restart. The model picker reconstructs only
    // the last harness-attested catalog stored with the session.
    __resetAcpModelCatalogForTests();
    await expect(listProviderModels(scenario.provider)).resolves.toEqual([
      expect.objectContaining({ id: scenario.defaultModel, source: 'dynamic' }),
      expect.objectContaining({ id: scenario.alternateModel, source: 'dynamic' }),
    ]);

    const switched = await provider.setSessionModel(sessionId, scenario.alternateModel);
    expect(brokerOptions[1]).toMatchObject({
      model: null,
      nativeSessionId: scenario.nativeSessionId,
    });
    expect(setModel).toHaveBeenCalledTimes(1);
    expect(switched).toEqual({
      model: scenario.alternateModel,
      metadata: {
        effectiveModel: scenario.alternateModel,
        availableModels,
        sessionModelState: selectedState,
        nativeSessionId: scenario.nativeSessionId,
      },
    });
    expect(loadNativeSession(scenario.provider, sessionId)).toMatchObject({
      model: scenario.alternateModel,
      metadata: {
        nativeDefaultModelId: scenario.defaultModel,
        acpCurrentModelId: scenario.alternateModel,
        acpAvailableModels: availableModels,
      },
    });
  });
});
