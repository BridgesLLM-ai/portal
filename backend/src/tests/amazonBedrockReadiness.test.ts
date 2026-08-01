import {
  getAmazonBedrockReadiness,
  invalidateAmazonBedrockReadinessCache,
  probeAmazonBedrockReadiness,
  type ReadOnlyOpenClawResult,
  type ReadOnlyOpenClawRunner,
} from '../services/amazonBedrockReadiness';

function cliResult(overrides: Partial<ReadOnlyOpenClawResult> = {}): ReadOnlyOpenClawResult {
  return {
    ok: true,
    stdout: '',
    stderr: '',
    timedOut: false,
    ...overrides,
  };
}

function runnerFor(options: {
  plugin?: ReadOnlyOpenClawResult;
  models?: ReadOnlyOpenClawResult;
}): jest.MockedFunction<ReadOnlyOpenClawRunner> {
  return jest.fn(async (args, _timeoutMs) => (
    args[0] === 'plugins'
      ? (options.plugin || cliResult())
      : (options.models || cliResult())
  ));
}

const loadedPlugin = cliResult({
  stdout: JSON.stringify({
    plugin: { id: 'amazon-bedrock', enabled: true, status: 'loaded' },
  }),
});

describe('Amazon Bedrock read-only readiness', () => {
  afterEach(() => {
    invalidateAmazonBedrockReadinessCache();
  });

  test('distinguishes a missing provider plugin without surfacing raw command output', async () => {
    const runner = runnerFor({
      plugin: cliResult({
        ok: false,
        stderr: 'Plugin not found: amazon-bedrock. Run openclaw plugins list.',
      }),
      models: cliResult({ stdout: 'No models found.\n' }),
    });

    const readiness = await probeAmazonBedrockReadiness(runner, Date.parse('2026-07-20T23:00:00Z'));
    expect(readiness).toMatchObject({
      state: 'missing_plugin',
      cached: false,
      availableModelCount: 0,
      message: expect.stringMatching(/plugin is not installed/i),
    });
    expect(readiness.message).not.toContain('Run openclaw plugins list');
    expect(runner).toHaveBeenCalledTimes(2);
    expect(runner).toHaveBeenCalledWith(
      ['plugins', 'info', 'amazon-bedrock', '--json'],
      9_000,
    );
    expect(runner).toHaveBeenCalledWith(
      ['models', 'list', '--provider', 'amazon-bedrock', '--json'],
      9_000,
    );
  });

  test('distinguishes loaded plugin with missing AWS setup or no models', async () => {
    const runner = runnerFor({
      plugin: loadedPlugin,
      models: cliResult({ stdout: 'No models found.\n' }),
    });

    await expect(probeAmazonBedrockReadiness(runner)).resolves.toMatchObject({
      state: 'needs_setup',
      availableModelCount: 0,
      message: expect.stringMatching(/credentials, region, model access, and IAM/i),
    });
  });

  test('reports ready only when OpenClaw returns usable Bedrock models', async () => {
    const runner = runnerFor({
      plugin: loadedPlugin,
      models: cliResult({
        stdout: JSON.stringify({
          count: 4,
          models: [
            { key: 'amazon-bedrock/us.ready-one', available: true, missing: false },
            { key: 'amazon-bedrock/us.ready-two', available: true, missing: false },
            { key: 'amazon-bedrock/us.missing', available: false, missing: true },
            { key: 'anthropic/not-bedrock', available: true, missing: false },
          ],
        }),
      }),
    });

    await expect(probeAmazonBedrockReadiness(runner)).resolves.toMatchObject({
      state: 'ready',
      availableModelCount: 2,
      message: 'Read-only discovery found 2 usable Bedrock models.',
    });
  });

  test('turns a bounded discovery timeout into an explicit probe error', async () => {
    const runner = runnerFor({
      plugin: loadedPlugin,
      models: cliResult({ ok: false, timedOut: true }),
    });

    await expect(probeAmazonBedrockReadiness(runner)).resolves.toMatchObject({
      state: 'probe_error',
      message: expect.stringMatching(/timed out/i),
    });
  });

  test('caches the two-command probe and supports an explicit forced refresh', async () => {
    let nowMs = Date.parse('2026-07-20T23:00:00Z');
    const runner = runnerFor({
      plugin: loadedPlugin,
      models: cliResult({
        stdout: JSON.stringify({
          count: 1,
          models: [{ key: 'amazon-bedrock/us.ready', available: true, missing: false }],
        }),
      }),
    });

    const first = await getAmazonBedrockReadiness({ runner, now: () => nowMs });
    const cached = await getAmazonBedrockReadiness({ runner, now: () => nowMs });
    expect(first.cached).toBe(false);
    expect(cached.cached).toBe(true);
    expect(runner).toHaveBeenCalledTimes(2);

    nowMs += 1_000;
    const refreshed = await getAmazonBedrockReadiness({ force: true, runner, now: () => nowMs });
    expect(refreshed.cached).toBe(false);
    expect(refreshed.checkedAt).toBe(new Date(nowMs).toISOString());
    expect(runner).toHaveBeenCalledTimes(4);
  });
});
