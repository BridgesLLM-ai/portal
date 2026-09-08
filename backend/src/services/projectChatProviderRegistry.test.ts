import { AgentRegistry } from '../agents';
import { AGENT_HARNESS_CATALOG } from '../agents/harnessCatalog';
import { AgentZeroProjectProvider } from '../agents/providers/agentZero/AgentZeroProjectProvider';
import {
  AGENT_ZERO_PROJECT_POLICY_VERSION,
  AGENT_ZERO_PROJECT_RUNTIME,
} from '../agents/providers/agentZero/AgentZeroProjectSandbox';
import { AGENT_ZERO_PROJECT_UPSTREAM_IMAGE_DIGESTS } from '../agents/providers/agentZero/AgentZeroProjectImage';
import { OllamaProjectProvider } from '../agents/providers/ollama/OllamaProjectProvider';
import {
  OLLAMA_PROJECT_RUNTIME,
  OLLAMA_PROJECT_RUNTIME_POLICY_VERSION,
} from '../agents/providers/ollama/OllamaProjectToolRuntime';
import {
  CODEX_PROJECT_RUNTIME,
  CODEX_PROJECT_RUNTIME_POLICY_VERSION,
} from '../agents/providers/native/projectSandbox/CodexProjectEgressRuntime';
import { config } from '../config/env';
import {
  QUALIFIABLE_PROJECT_PROVIDERS,
  POSITIVE_PROJECT_EXECUTION_PROVIDERS,
  OPENCLAW_PROJECT_RUNTIME_POLICY_VERSION,
  getProjectChatProviderAdapter,
  getProjectChatProviderCleanupController,
  getProjectChatProviderRuntimeDescriptor,
  resetProjectChatProviderSession,
  terminateProjectChatProviderSession,
} from './projectChatProviderRegistry';
import * as openClawSandbox from './openclawProjectSandbox';
import { CLAUDE_CODE_PROJECT_RUNTIME_PROFILE } from '../agents/providers/native/projectSandbox/ClaudeCodeProjectSandbox';
import { ANTIGRAVITY_PROJECT_RUNTIME_PROFILE } from '../agents/providers/native/projectSandbox/AntigravityProjectSandbox';

const DERIVED_AGENT_ZERO_IMAGE_ID = `sha256:${'7'.repeat(64)}`;
const originalAgentZeroProjectImageId = config.agentZeroProjectSandboxImageId;
const originalOllamaProjectImageId = config.ollamaProjectSandboxImageId;

beforeEach(() => {
  config.agentZeroProjectSandboxImageId = DERIVED_AGENT_ZERO_IMAGE_ID;
  config.ollamaProjectSandboxImageId = `sha256:${'8'.repeat(64)}`;
});

afterEach(() => {
  config.agentZeroProjectSandboxImageId = originalAgentZeroProjectImageId;
  config.ollamaProjectSandboxImageId = originalOllamaProjectImageId;
  jest.restoreAllMocks();
});

describe('Project Chat provider runtime registry', () => {
  test('cross-attests the exact Project-capable harness set', () => {
    const advertised = AGENT_HARNESS_CATALOG
      .filter((definition) => definition.capabilities.supportedExecutionScopes.includes('PROJECT_SANDBOX'))
      .map((definition) => definition.id)
      .sort();

    expect(advertised).toEqual([...POSITIVE_PROJECT_EXECUTION_PROVIDERS].sort());
    expect(advertised).toEqual([
      'AGENT_ZERO',
      'CLAUDE_CODE',
      'CODEX',
      'OLLAMA',
      'OPENCLAW',
    ]);
    expect(QUALIFIABLE_PROJECT_PROVIDERS).toEqual([
      'OPENCLAW',
      'CODEX',
      'CLAUDE_CODE',
      'AGENT_ZERO',
      'GEMINI',
      'OLLAMA',
    ]);
  });

  test.each([
    'OPENCLAW',
    'CODEX',
    'CLAUDE_CODE',
  ] as const)('routes %s Project Chat through its dual-scope registered adapter', (provider) => {
    const scopedGet = jest.spyOn(AgentRegistry, 'getSharedProjectSandboxProvider');
    const adapter = getProjectChatProviderAdapter(provider);
    expect(scopedGet).toHaveBeenCalledWith(provider);
    expect(adapter).toBe(scopedGet.mock.results[0]?.value);
  });

  test('keeps detection-only Antigravity out of positive adapters but available for cleanup', () => {
    expect(() => getProjectChatProviderAdapter('GEMINI'))
      .toThrow(/no shared Project Sandbox adapter/i);

    const cleanup = getProjectChatProviderCleanupController('GEMINI');
    expect(Object.isFrozen(cleanup)).toBe(true);
    expect(cleanup.providerName).toBe('GEMINI');
    expect(typeof cleanup.abortActiveRun).toBe('function');
    expect(typeof cleanup.terminateSession).toBe('function');
    expect((cleanup as any).startSession).toBeUndefined();
    expect((cleanup as any).sendMessage).toBeUndefined();
    expect((cleanup as any).getHistory).toBeUndefined();
  });

  test('does not consult the host-package gate for independently pinned Project adapters', () => {
    const hostGet = jest.spyOn(AgentRegistry, 'getProvider')
      .mockImplementation(() => { throw new Error('host package is absent'); });

    expect(getProjectChatProviderAdapter('CODEX')).toMatchObject({ providerName: 'CODEX' });
    expect(getProjectChatProviderAdapter('CLAUDE_CODE')).toMatchObject({ providerName: 'CLAUDE_CODE' });
    expect(hostGet).not.toHaveBeenCalled();
  });

  test('pins the sandbox-local kernel runtime mirrors to the registry constants', () => {
    // openclawProjectSandbox and the native CLI profiles reconstruct the
    // kernel context policy fingerprint locally (registry imports would
    // cycle). Their runtime strings must track these registry constants.
    expect(openClawSandbox.OPENCLAW_PROJECT_KERNEL_RUNTIME)
      .toBe(getProjectChatProviderRuntimeDescriptor('OPENCLAW').runtime);
    expect(CLAUDE_CODE_PROJECT_RUNTIME_PROFILE.runtime)
      .toBe(getProjectChatProviderRuntimeDescriptor('CLAUDE_CODE').runtime);
    expect(ANTIGRAVITY_PROJECT_RUNTIME_PROFILE.runtime)
      .toBe(getProjectChatProviderRuntimeDescriptor('GEMINI').runtime);
  });

  test('bumps only the Codex runtime descriptor to the dedicated-confinement v3 policy', () => {
    expect(getProjectChatProviderRuntimeDescriptor('CODEX')).toMatchObject({
      provider: 'CODEX',
      runtime: CODEX_PROJECT_RUNTIME,
      runtimePolicyVersion: CODEX_PROJECT_RUNTIME_POLICY_VERSION,
    });
    expect(CODEX_PROJECT_RUNTIME_POLICY_VERSION).toBe('portal-project-sandbox-v3');
    expect(getProjectChatProviderRuntimeDescriptor('OPENCLAW').runtimePolicyVersion)
      .toBe(OPENCLAW_PROJECT_RUNTIME_POLICY_VERSION);
    expect(OPENCLAW_PROJECT_RUNTIME_POLICY_VERSION).toBe('portal-project-sandbox-v2');
  });

  test('publishes Agent Zero with its exact immutable Project runtime contract', () => {
    expect(QUALIFIABLE_PROJECT_PROVIDERS).toEqual([
      'OPENCLAW',
      'CODEX',
      'CLAUDE_CODE',
      'AGENT_ZERO',
      'GEMINI',
      'OLLAMA',
    ]);
    expect(getProjectChatProviderRuntimeDescriptor('AGENT_ZERO')).toMatchObject({
      provider: 'AGENT_ZERO',
      runtime: AGENT_ZERO_PROJECT_RUNTIME,
      runtimePolicyVersion: AGENT_ZERO_PROJECT_POLICY_VERSION,
      nativeSession: true,
    });
    expect(getProjectChatProviderRuntimeDescriptor('AGENT_ZERO').runtimeImageDigest())
      .toBe(DERIVED_AGENT_ZERO_IMAGE_ID);
  });

  test('never substitutes the privileged upstream manifest for the installer-attested image', () => {
    config.agentZeroProjectSandboxImageId = AGENT_ZERO_PROJECT_UPSTREAM_IMAGE_DIGESTS.amd64;
    expect(() => getProjectChatProviderRuntimeDescriptor('AGENT_ZERO').runtimeImageDigest())
      .toThrow(/installer-attested derived image ID/i);

    config.agentZeroProjectSandboxImageId = '';
    expect(() => getProjectChatProviderRuntimeDescriptor('AGENT_ZERO').runtimeImageDigest())
      .toThrow(/installer-attested derived image ID/i);
  });

  test('never resolves Agent Zero Project Chat through the global host-provider registry', () => {
    const globalGet = jest.spyOn(AgentRegistry, 'get');
    const sharedProjectGet = jest.spyOn(AgentRegistry, 'getSharedProjectSandboxProvider');
    const adapter = getProjectChatProviderAdapter('AGENT_ZERO');
    expect(adapter).toBeInstanceOf(AgentZeroProjectProvider);
    expect(adapter.displayName).toMatch(/Project Sandbox/);
    expect(globalGet).not.toHaveBeenCalled();
    expect(sharedProjectGet).not.toHaveBeenCalled();
  });

  test('publishes Ollama through its dedicated networkless Project adapter', () => {
    expect(getProjectChatProviderRuntimeDescriptor('OLLAMA')).toMatchObject({
      provider: 'OLLAMA',
      runtime: OLLAMA_PROJECT_RUNTIME,
      runtimePolicyVersion: OLLAMA_PROJECT_RUNTIME_POLICY_VERSION,
      nativeSession: true,
    });
    expect(getProjectChatProviderRuntimeDescriptor('OLLAMA').runtimeImageDigest())
      .toBe(config.ollamaProjectSandboxImageId);
    const globalGet = jest.spyOn(AgentRegistry, 'get');
    const sharedProjectGet = jest.spyOn(AgentRegistry, 'getSharedProjectSandboxProvider');
    const adapter = getProjectChatProviderAdapter('OLLAMA');
    expect(adapter).toBeInstanceOf(OllamaProjectProvider);
    expect(adapter.displayName).toMatch(/Project Coding Sandbox/);
    expect(globalGet).not.toHaveBeenCalled();
    expect(sharedProjectGet).not.toHaveBeenCalled();
  });

  test('uses the same dedicated adapter for reset and termination lifecycle calls', async () => {
    const adapter = getProjectChatProviderAdapter('AGENT_ZERO') as AgentZeroProjectProvider;
    const reset = jest.spyOn(adapter, 'resetSession').mockResolvedValue(undefined);
    const terminate = jest.spyOn(adapter, 'terminateSession').mockResolvedValue(undefined);
    await resetProjectChatProviderSession({ provider: 'AGENT_ZERO', sessionId: 'a0-context-1' });
    await terminateProjectChatProviderSession({ provider: 'AGENT_ZERO', sessionId: 'a0-context-1' });
    expect(reset).toHaveBeenCalledWith('a0-context-1');
    expect(terminate).toHaveBeenCalledWith('a0-context-1');
  });

  test('uses the dedicated Ollama Project adapter for lifecycle calls', async () => {
    const adapter = getProjectChatProviderAdapter('OLLAMA') as OllamaProjectProvider;
    const reset = jest.spyOn(adapter, 'resetSession').mockResolvedValue(undefined);
    const terminate = jest.spyOn(adapter, 'terminateSession').mockResolvedValue(undefined);
    await resetProjectChatProviderSession({ provider: 'OLLAMA', sessionId: 'ollama-project-1' });
    await terminateProjectChatProviderSession({ provider: 'OLLAMA', sessionId: 'ollama-project-1' });
    expect(reset).toHaveBeenCalledWith('ollama-project-1');
    expect(terminate).toHaveBeenCalledWith('ollama-project-1');
  });

});
