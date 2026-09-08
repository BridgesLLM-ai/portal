import { AI_PROVIDER_MAP } from '../config/aiProviders';
import type {
  AgentHarnessId,
  AgentProviderName,
} from './AgentProvider.interface';
import {
  AGENT_HARNESS_CATALOG,
  AGENT_HARNESS_IDS,
  REGISTERED_AGENT_HARNESS_IDS,
  getHarnessDefinition,
  isAgentHarnessId,
  isRegisteredAgentProviderName,
  requireHarnessDefinition,
} from './harnessCatalog';

describe('agent harness catalog', () => {
  test('has one deeply immutable definition for every unique stable id', () => {
    expect(new Set(AGENT_HARNESS_IDS).size).toBe(AGENT_HARNESS_IDS.length);
    expect(AGENT_HARNESS_CATALOG.map((definition) => definition.id)).toEqual(AGENT_HARNESS_IDS);
    expect(Object.isFrozen(AGENT_HARNESS_CATALOG)).toBe(true);
    expect(Object.isFrozen(AGENT_HARNESS_IDS)).toBe(true);

    for (const definition of AGENT_HARNESS_CATALOG) {
      expect(Object.isFrozen(definition)).toBe(true);
      expect(Object.isFrozen(definition.command)).toBe(true);
      expect(Object.isFrozen(definition.command.args)).toBe(true);
      expect(Object.isFrozen(definition.command.versionPolicy)).toBe(true);
      expect(Object.isFrozen(definition.auth)).toBe(true);
      expect(Object.isFrozen(definition.models)).toBe(true);
      expect(Object.isFrozen(definition.capabilities)).toBe(true);
      expect(Object.isFrozen(definition.capabilities.supportedExecutionScopes)).toBe(true);
    }
  });

  test('keeps DeepSeek model-provider auth distinct from DeepSeek Harness', () => {
    expect(AI_PROVIDER_MAP.get('deepseek')).toMatchObject({
      id: 'deepseek',
      name: expect.stringMatching(/DeepSeek/i),
    });

    const harness = requireHarnessDefinition('DEEPSEEK_HARNESS');
    expect(harness).toMatchObject({
      id: 'DEEPSEEK_HARNESS',
      displayName: 'DeepSeek Harness',
      compatibilityProviderId: null,
      implemented: false,
      selectable: false,
      releaseStage: 'developer-preview',
    });
    expect(AGENT_HARNESS_IDS).not.toContain('DEEPSEEK');
    expect(getHarnessDefinition('DEEPSEEK')).toBeNull();
  });

  test('only exact harness ids resolve and model prefixes never route a harness', () => {
    expect(getHarnessDefinition('CODEX')?.displayName).toBe('Codex');
    expect(getHarnessDefinition('openai/gpt-5.6-sol')).toBeNull();
    expect(getHarnessDefinition('codex/gpt-5.6-sol')).toBeNull();
    expect(getHarnessDefinition('deepseek/deepseek-chat')).toBeNull();
    expect(isAgentHarnessId('openai/gpt-5.6-sol')).toBe(false);
  });

  test('restores exact-pinned host-native chats without advertising project sandbox support', () => {
    for (const id of ['GROK', 'GEMINI'] as const) {
      expect(requireHarnessDefinition(id)).toMatchObject({
        implemented: true, selectable: true, releaseStage: 'stable',
        command: { executable: id === 'GROK' ? 'grok' : 'agy', versionPolicy: { kind: 'exact-pin' } },
        capabilities: { implemented: true, supportedExecutionScopes: ['HOST_OPERATOR'],
          supportsLiveToolEvents: true, supportsProcessRestartResume: true },
      });
    }
    expect(requireHarnessDefinition('AGENT_ZERO')).toMatchObject({ implemented: true, selectable: true, releaseStage: 'stable' });
  });

  test('truthfully capability-gates exact-pinned host ACP harnesses and the disabled DeepSeek preview', () => {
    const hermes = requireHarnessDefinition('HERMES');
    expect(hermes).toMatchObject({
      transport: 'acp-stdio',
      implemented: true,
      selectable: true,
      releaseStage: 'stable',
      compatibilityProviderId: 'HERMES',
      command: {
        executable: 'hermes',
        args: ['acp'],
        versionPolicy: { kind: 'exact-pin', testedVersion: '0.20.4' },
      },
      models: {
        selectionMode: 'session',
        canEnumerate: true,
        supportsCustomInput: false,
      },
      capabilities: {
        supportsNewSession: true,
        supportsHistory: true,
        supportsSessionClose: false,
        supportsModelSelection: true,
        supportsModelReadback: true,
        supportsSessionResume: true,
        supportsSessionFork: true,
        supportsLiveText: true,
        supportsReasoning: true,
        supportsAttachments: true,
        supportsCancellation: true,
        cancellationMode: 'protocol',
        supportsExecApproval: true,
        supportsInTurnSteering: false,
        supportsLiveToolEvents: true,
        supportsQueuedFollowUps: true,
        supportsPromptCausalCompletion: true,
        supportsProcessRestartResume: true,
        supportedExecutionScopes: ['HOST_OPERATOR'],
      },
    });

    const deepSeek = requireHarnessDefinition('DEEPSEEK_HARNESS');
    expect(deepSeek).toMatchObject({
      transport: 'json-rpc-stdio',
      implemented: false,
      selectable: false,
      releaseStage: 'developer-preview',
      command: {
        executable: null,
        versionPolicy: { kind: 'blocked-until-pinned' },
      },
      capabilities: {
        supportsNewSession: true,
        supportsHistory: false,
        supportsSessionClose: false,
        supportsModelReadback: false,
        supportsSessionList: false,
        supportsSessionResume: false,
        supportsSessionFork: false,
        supportsLiveText: true,
        supportsReasoning: true,
        supportsAttachments: false,
        supportsCancellation: true,
        cancellationMode: 'process-kill',
        supportsExecApproval: false,
        supportsInTurnSteering: false,
        supportsLiveToolEvents: true,
        supportsPromptCausalCompletion: false,
        supportsProcessRestartResume: false,
        supportedExecutionScopes: ['HOST_OPERATOR'],
      },
    });
    expect(deepSeek.capabilities.supportedExecutionScopes).not.toContain('PROJECT_SANDBOX');
    expect(deepSeek.unavailableReason).toMatch(/no protocol cancel.*close.*restart recovery/i);

    const openCode = requireHarnessDefinition('OPENCODE');
    expect(openCode).toMatchObject({
      transport: 'acp-stdio',
      implemented: true,
      selectable: true,
      releaseStage: 'stable',
      compatibilityProviderId: 'OPENCODE',
      command: {
        executable: 'opencode',
        args: ['acp', '--pure', '--hostname', '127.0.0.1', '--port', '0', '--no-mdns'],
        versionPolicy: { kind: 'exact-pin', testedVersion: '1.18.19' },
      },
      auth: {
        owner: 'harness-local-login',
        requiresSeparateLogin: true,
      },
      capabilities: {
        supportsHistory: true,
        supportsSessionClose: true,
        supportsSessionList: true,
        supportsSessionResume: true,
        supportsSessionFork: true,
        supportsModelReadback: true,
        supportsCancellation: true,
        supportsExecApproval: true,
        supportsPromptCausalCompletion: true,
        supportsProcessRestartResume: true,
        supportedExecutionScopes: ['HOST_OPERATOR'],
      },
    });
    expect(hermes.capabilities.supportedExecutionScopes).not.toContain('PROJECT_SANDBOX');
    expect(openCode.capabilities.supportedExecutionScopes).not.toContain('PROJECT_SANDBOX');
    expect(openCode.command.versionPolicy.reason).toContain('opencode-linux-x64-baseline.tar.gz');
    expect(openCode.command.versionPolicy.reason).toContain('0acea3a0e22d4b6bcf7068580def4e151e413a7a4c3f03eba638568b3fababa5');
    expect(openCode.command.versionPolicy.reason).not.toMatch(/(?:^|\s)opencode-linux-x64\.tar\.gz/u);
  });

  test('preserves the legacy provider alias and ids as the registered subset', () => {
    const legacyProviderIsAHarness = (provider: AgentProviderName): AgentHarnessId => provider;
    const registeredAsHarnessIds = REGISTERED_AGENT_HARNESS_IDS.map(legacyProviderIsAHarness);

    expect(registeredAsHarnessIds).toEqual([
      'OPENCLAW',
      'CLAUDE_CODE',
      'CODEX',
      'GROK',
      'AGENT_ZERO',
      'GEMINI',
      'OLLAMA',
      'HERMES',
      'OPENCODE',
    ]);
    expect(REGISTERED_AGENT_HARNESS_IDS.every(isRegisteredAgentProviderName)).toBe(true);
    expect(isRegisteredAgentProviderName('HERMES')).toBe(true);
    expect(isRegisteredAgentProviderName('OPENCODE')).toBe(true);
    expect(isRegisteredAgentProviderName('DEEPSEEK_HARNESS')).toBe(false);
    expect(REGISTERED_AGENT_HARNESS_IDS.every((id) => (
      requireHarnessDefinition(id).compatibilityProviderId === id
    ))).toBe(true);
  });
});
