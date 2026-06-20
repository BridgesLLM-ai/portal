import { parseAntigravityModelList } from '../agents/antigravityModels';

describe('Antigravity model parsing', () => {
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
});
