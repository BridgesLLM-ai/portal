import { execFileSync } from 'child_process';

jest.mock('child_process', () => ({
  ...jest.requireActual('child_process'),
  execFileSync: jest.fn(),
}));

import {
  invalidateAntigravityModelCache,
  listAntigravityModelsFromCli,
  parseAntigravityModelList,
} from '../agents/antigravityModels';

const mockedExecFileSync = jest.mocked(execFileSync);

describe('Antigravity model parsing', () => {
  beforeEach(() => {
    invalidateAntigravityModelCache();
    mockedExecFileSync.mockReset();
  });

  test('parses agy models output into runtime ids', () => {
    expect(parseAntigravityModelList([
      'Gemini 3.5 Flash (Medium)',
      'Gemini 3.5 Flash (High)',
      'Gemini 3.5 Flash (Low)',
      'Gemini 3.1 Pro (Low)',
      'Gemini 3.1 Pro (High)',
      'Claude Sonnet 4.6 (Thinking)',
    ].join('\n'))).toEqual([
      { id: 'gemini-3.5-flash', displayName: 'Gemini 3.5 Flash (Medium)' },
      { id: 'gemini-3.5-flash-high', displayName: 'Gemini 3.5 Flash (High)' },
      { id: 'gemini-3.5-flash-low', displayName: 'Gemini 3.5 Flash (Low)' },
      { id: 'gemini-3.1-pro-low', displayName: 'Gemini 3.1 Pro (Low)' },
      { id: 'gemini-3.1-pro-high', displayName: 'Gemini 3.1 Pro (High)' },
    ]);
  });

  test('isolates model discovery from stdin/auto-update and supports explicit cache invalidation', () => {
    mockedExecFileSync.mockReturnValue('Gemini 3.5 Flash (Medium)\n' as any);

    expect(listAntigravityModelsFromCli()).toEqual([
      { id: 'gemini-3.5-flash', displayName: 'Gemini 3.5 Flash (Medium)' },
    ]);
    expect(listAntigravityModelsFromCli()).toHaveLength(1);
    expect(mockedExecFileSync).toHaveBeenCalledTimes(1);
    expect(mockedExecFileSync).toHaveBeenCalledWith('agy', ['models'], expect.objectContaining({
      stdio: ['ignore', 'pipe', 'pipe'],
      env: expect.objectContaining({ AGY_CLI_DISABLE_AUTO_UPDATE: '1' }),
    }));

    invalidateAntigravityModelCache();
    expect(listAntigravityModelsFromCli()).toHaveLength(1);
    expect(mockedExecFileSync).toHaveBeenCalledTimes(2);
  });
});
