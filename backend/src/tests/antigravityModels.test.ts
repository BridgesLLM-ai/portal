const mockExecFile = jest.fn();
jest.mock('child_process', () => ({ ...jest.requireActual('child_process'), execFile: mockExecFile }));
import { invalidateAntigravityModelCache, listAntigravityModelsFromCli, parseAntigravityModelList } from '../agents/antigravityModels';

describe('Antigravity live model catalog', () => {
  beforeEach(() => { mockExecFile.mockReset(); invalidateAntigravityModelCache(); });
  test('preserves exact native ids including medium tiers and non-Gemini models', () => {
    expect(parseAntigravityModelList([
      'gemini-3.8-flash-medium\tGemini 3.8 Flash (Medium)',
      'claude-opus-4-6-thinking\tClaude Opus 4.6 (Thinking)',
      'gpt-oss-120b-medium\tGPT-OSS 120B (Medium)',
      'Fetching available models...', 'Gemini 3.5 Flash (High)',
    ].join('\n'))).toEqual([
      { id: 'gemini-3.8-flash-medium', displayName: 'Gemini 3.8 Flash (Medium)' },
      { id: 'claude-opus-4-6-thinking', displayName: 'Claude Opus 4.6 (Thinking)' },
      { id: 'gpt-oss-120b-medium', displayName: 'GPT-OSS 120B (Medium)' },
    ]);
  });
  test('coalesces live probes and invalidates after account changes', async () => {
    let callback: any;
    mockExecFile.mockImplementation((_command, _args, _options, cb) => { callback = cb; });
    const first = listAntigravityModelsFromCli();
    const second = listAntigravityModelsFromCli();
    expect(mockExecFile).toHaveBeenCalledTimes(1);
    callback(null, 'gemini-3.8-flash-medium\tGemini 3.8 Flash (Medium)\n');
    expect(await first).toEqual(await second);
    await listAntigravityModelsFromCli();
    expect(mockExecFile).toHaveBeenCalledTimes(1);
    invalidateAntigravityModelCache();
    const refreshed = listAntigravityModelsFromCli();
    callback(new Error('not signed in'), '');
    expect(await refreshed).toEqual([]);
    expect(mockExecFile).toHaveBeenLastCalledWith('agy', ['models'], expect.objectContaining({ timeout: 12000, maxBuffer: 524288 }), expect.any(Function));
  });
});
