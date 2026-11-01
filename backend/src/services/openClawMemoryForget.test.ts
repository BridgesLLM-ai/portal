import {
  forgetOpenClawSessionMemory,
  type OpenClawCliRunResult,
} from './openClawMemoryForget';

const target = {
  agentId: 'main',
  sessionId: 'transcript-1',
  sessionKey: 'agent:main:portal-chat',
};

function report(dryRun: boolean, artifacts: Record<string, number>): OpenClawCliRunResult {
  return {
    exitCode: 0,
    // 9.9 can print state-store lines on stdout before the JSON report.
    stdout: `[state/agent-db] ready\n${JSON.stringify({ agentId: 'main', dryRun, sessionIds: ['transcript-1'], artifacts })}`,
    stderr: '',
  };
}

function scripted(...results: OpenClawCliRunResult[]) {
  const calls: Array<readonly string[]> = [];
  const run = jest.fn(async (args: readonly string[]) => {
    calls.push(args);
    const next = results.shift();
    if (!next) throw new Error('unexpected extra CLI call');
    return next;
  });
  return { run, calls };
}

describe('OpenClaw memory forget for retired sessions', () => {
  test('previews, applies, and re-previews with exact documented selectors', async () => {
    const { run, calls } = scripted(
      report(true, { indexChunks: 4, originRows: 2, embeddingCacheRows: 90 }),
      report(false, { indexChunks: 4, originRows: 2, embeddingCacheRows: 90 }),
      report(true, { indexChunks: 0, originRows: 0, embeddingCacheRows: 12 }),
    );
    await expect(forgetOpenClawSessionMemory(target, run)).resolves.toEqual({
      status: 'forgotten',
      previewArtifacts: 6,
      remainingArtifacts: 0,
    });
    const selectors = ['memory', 'forget', '--agent', 'main', '--session', 'transcript-1', '--session', 'agent:main:portal-chat'];
    expect(calls).toEqual([
      [...selectors, '--dry-run', '--json'],
      [...selectors, '--json'],
      [...selectors, '--dry-run', '--json'],
    ]);
  });

  test('reports residue instead of claiming the memory is gone', async () => {
    const { run } = scripted(
      report(true, { memoryEntries: 2 }),
      report(false, { memoryEntries: 2 }),
      report(true, { memoryEntries: 1 }),
    );
    await expect(forgetOpenClawSessionMemory(target, run)).resolves.toMatchObject({
      status: 'forgotten-residual',
      remainingArtifacts: 1,
    });
  });

  test('a missing subcommand is unavailable, other failures name the failed step', async () => {
    const missing = scripted({ exitCode: 1, stdout: '', stderr: "error: unknown command 'forget'" });
    await expect(forgetOpenClawSessionMemory(target, missing.run)).resolves.toMatchObject({
      status: 'unavailable',
    });
    expect(missing.calls).toHaveLength(1);

    const applyFails = scripted(
      report(true, { indexChunks: 1 }),
      { exitCode: 1, stdout: '', stderr: 'memory index is busy; retry' },
    );
    await expect(forgetOpenClawSessionMemory(target, applyFails.run)).resolves.toEqual({
      status: 'failed',
      failedStep: 'apply',
      previewArtifacts: 1,
      detail: 'memory index is busy; retry',
    });

    const maintenance = scripted({
      exitCode: null,
      stdout: '',
      stderr: '',
      error: 'OpenClaw diagnostics are paused during maintenance or recovery.',
    });
    await expect(forgetOpenClawSessionMemory(target, maintenance.run)).resolves.toMatchObject({
      status: 'failed',
      failedStep: 'preview',
      detail: 'OpenClaw diagnostics are paused during maintenance or recovery.',
    });

    const wrongStore = scripted({
      exitCode: 0,
      stdout: JSON.stringify({ agentId: 'other', dryRun: true, artifacts: {} }),
      stderr: '',
    });
    await expect(forgetOpenClawSessionMemory(target, wrongStore.run)).resolves.toMatchObject({
      status: 'failed',
      failedStep: 'preview',
    });

    const verifyFails = scripted(
      report(true, { indexChunks: 1 }),
      report(false, { indexChunks: 1 }),
      { exitCode: null, stdout: '', stderr: '', error: 'Command failed: timed out' },
    );
    await expect(forgetOpenClawSessionMemory(target, verifyFails.run)).resolves.toMatchObject({
      status: 'failed',
      failedStep: 'verify',
    });
  });

  test('refuses identities that could be read as CLI options', async () => {
    const { run } = scripted();
    for (const bad of [
      { ...target, sessionId: '--dry-run' },
      { ...target, sessionKey: '--agent=other' },
      { ...target, agentId: '../main' },
      { ...target, sessionKey: 'agent:main:a b' },
    ]) {
      await expect(forgetOpenClawSessionMemory(bad, run)).resolves.toMatchObject({
        status: 'failed',
        detail: 'invalid session identity',
      });
    }
    expect(run).not.toHaveBeenCalled();
  });
});
