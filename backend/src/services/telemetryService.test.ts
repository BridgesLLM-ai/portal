import { requestConfiguredOllamaJson } from './ollamaBackendAuthority';
import { detectDependencyVersions } from './telemetryService';
import type { NativeHostCliStatusTool } from './nativeHostCliStatus';

const absentNativeHostStatus = async (toolId: NativeHostCliStatusTool) => ({
  toolId,
  executablePath: toolId === 'codex'
    ? '/usr/bin/codex'
    : toolId === 'claude-code' ? '/usr/bin/claude' : '/usr/bin/clawhub',
  state: 'absent' as const,
  installed: false,
  executionEligible: false,
  observedVersion: null,
  checkedAt: '2026-08-21T00:00:00.000Z',
  fingerprint: null,
  reasonCode: 'ABSENT',
});

describe('telemetry dependency detection', () => {
  test('reads the Ollama version through the configured Tailnet authority', async () => {
    const requestConfiguredImpl = jest.fn().mockResolvedValue({
      authority: {
        kind: 'TAILNET',
        source: 'tailnet-binding',
        endpoint: null,
        generation: 12,
        version: 5,
        bindingFingerprint: 'tailnet-binding-fingerprint',
        selectedModel: 'qwen3:8b',
        selectedModelDigest: `sha256:${'a'.repeat(64)}`,
      },
      value: { version: ' 0.32.1 ' },
    });
    const detectCommandVersionImpl = jest.fn(
      (_command: string, _regex: RegExp): string | undefined => undefined,
    );

    await expect(detectDependencyVersions({
      requestConfiguredImpl: requestConfiguredImpl as unknown as typeof requestConfiguredOllamaJson,
      detectCommandVersionImpl,
      getNativeHostCliStatusImpl: absentNativeHostStatus,
    })).resolves.toEqual({ ollama: '0.32.1' });

    expect(requestConfiguredImpl).toHaveBeenCalledWith({
      path: '/api/version',
      method: 'GET',
      timeoutMs: 3_000,
      maxResponseBytes: 64 * 1024,
    });
    expect(detectCommandVersionImpl.mock.calls.some(([command]) => (
      /ollama|codex|claude/i.test(String(command))
    ))).toBe(false);
  });

  test('does not fall back to an Ollama CLI when configured authority rejects admission', async () => {
    const requestConfiguredImpl = jest.fn().mockRejectedValue(new Error('local disabled'));
    const detectCommandVersionImpl = jest.fn(
      (command: string, _regex: RegExp): string | undefined => (
        command.includes('ollama') ? '99.99.99' : undefined
      ),
    );

    await expect(detectDependencyVersions({
      requestConfiguredImpl: requestConfiguredImpl as unknown as typeof requestConfiguredOllamaJson,
      detectCommandVersionImpl,
      getNativeHostCliStatusImpl: absentNativeHostStatus,
    })).resolves.toEqual({});

    expect(requestConfiguredImpl).toHaveBeenCalledTimes(1);
    expect(detectCommandVersionImpl.mock.calls.some(([command]) => (
      /ollama|codex|claude/i.test(String(command))
    ))).toBe(false);
  });

  test('uses only native host admission evidence for Codex and Claude versions', async () => {
    const detectCommandVersionImpl = jest.fn(() => undefined);
    const getNativeHostCliStatusImpl = jest.fn(async (toolId: NativeHostCliStatusTool) => ({
      ...(await absentNativeHostStatus(toolId)),
      state: 'verified' as const,
      installed: true,
      executionEligible: true,
      observedVersion: toolId === 'codex'
        ? '0.153.2'
        : toolId === 'claude-code' ? '2.1.260' : '0.23.3',
      fingerprint: 'a'.repeat(64),
      reasonCode: null,
    }));

    await expect(detectDependencyVersions({
      requestConfiguredImpl: jest.fn().mockRejectedValue(new Error('disabled')),
      detectCommandVersionImpl,
      getNativeHostCliStatusImpl,
    })).resolves.toMatchObject({ codexCli: '0.153.2', claudeCode: '2.1.260' });
    expect(detectCommandVersionImpl.mock.calls.flat().join('\n')).not.toMatch(/codex|claude/i);
  });
});
