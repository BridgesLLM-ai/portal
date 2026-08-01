import { requestConfiguredOllamaJson } from './ollamaBackendAuthority';
import { detectDependencyVersions } from './telemetryService';

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
    })).resolves.toEqual({ ollama: '0.32.1' });

    expect(requestConfiguredImpl).toHaveBeenCalledWith({
      path: '/api/version',
      method: 'GET',
      timeoutMs: 3_000,
      maxResponseBytes: 64 * 1024,
    });
    expect(detectCommandVersionImpl.mock.calls.some(([command]) => (
      String(command).includes('ollama')
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
    })).resolves.toEqual({});

    expect(requestConfiguredImpl).toHaveBeenCalledTimes(1);
    expect(detectCommandVersionImpl.mock.calls.some(([command]) => (
      String(command).includes('ollama')
    ))).toBe(false);
  });
});
