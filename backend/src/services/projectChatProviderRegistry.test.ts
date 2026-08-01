import { AgentRegistry } from '../agents';
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
  OPENCLAW_PROJECT_RUNTIME_POLICY_VERSION,
  getProjectChatProviderAdapter,
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
    const adapter = getProjectChatProviderAdapter('AGENT_ZERO');
    expect(adapter).toBeInstanceOf(AgentZeroProjectProvider);
    expect(adapter.displayName).toMatch(/Project Sandbox/);
    expect(globalGet).not.toHaveBeenCalled();
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
    const adapter = getProjectChatProviderAdapter('OLLAMA');
    expect(adapter).toBeInstanceOf(OllamaProjectProvider);
    expect(adapter.displayName).toMatch(/Project Coding Sandbox/);
    expect(globalGet).not.toHaveBeenCalled();
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
