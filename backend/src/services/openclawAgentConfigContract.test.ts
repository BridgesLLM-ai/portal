import {
  buildOpenClawAgentRemovalPatch,
  exactOpenClawAgent,
  materializeOpenClawAgentList,
  openClawAgentRostersEqual,
  readOpenClawAgentConfigContract,
} from './openclawAgentConfigContract';

const legacyAgent = (id: string, extra: Record<string, unknown> = {}) => ({ id, ...extra });

describe('OpenClaw agent config contract', () => {
  test('accepts the exact 2026.7.1 list contract and emits a whole-array removal', () => {
    const main = legacyAgent('main', { default: true });
    const project = legacyAgent('p4oc-1234', { tools: { deny: ['browser'] } });
    const contract = readOpenClawAgentConfigContract({ agents: { defaults: {}, list: [main, project] } });

    expect(contract.family).toBe('2026.7.1');
    expect(materializeOpenClawAgentList(contract)).toEqual([main, project]);
    expect(exactOpenClawAgent(contract, 'p4oc-1234')).toEqual(project);

    const removal = buildOpenClawAgentRemovalPatch(contract, 'p4oc-1234');
    expect(JSON.parse(removal.raw)).toEqual({ agents: { list: [main] } });
    expect(removal.replacePaths).toEqual(['agents.list']);
    expect(openClawAgentRostersEqual(
      removal.expected,
      readOpenClawAgentConfigContract({ agents: { list: [main] } }),
    )).toBe(true);
  });

  test('accepts the exact 2026.9.1 entries contract and emits a keyed removal', () => {
    const contract = readOpenClawAgentConfigContract({
      agents: {
        ownership: 'explicit',
        entries: {
          main: {},
          'p4oc-1234': { tools: { deny: ['browser'] } },
        },
      },
    });

    expect(contract.family).toBe('2026.9.1');
    expect(materializeOpenClawAgentList(contract)).toEqual([
      { id: 'main' },
      { tools: { deny: ['browser'] }, id: 'p4oc-1234' },
    ]);

    const removal = buildOpenClawAgentRemovalPatch(contract, 'p4oc-1234');
    expect(JSON.parse(removal.raw)).toEqual({
      agents: { entries: { 'p4oc-1234': null } },
    });
    expect(removal.replacePaths).toEqual(['agents.entries.p4oc-1234.tools.deny']);
    expect(openClawAgentRostersEqual(
      removal.expected,
      readOpenClawAgentConfigContract({
        agents: { ownership: 'explicit', entries: { main: {} } },
      }),
    )).toBe(true);
  });

  test('accepts only an exact non-enumerable 2026.9.1 list compatibility projection', () => {
    const agents: Record<string, unknown> = {
      ownership: 'explicit',
      entries: {
        main: { name: 'Main' },
        'p4oc-1234': { tools: { deny: ['browser'] } },
      },
    };
    Object.defineProperty(agents, 'list', {
      configurable: true,
      enumerable: false,
      value: [
        { name: 'Main', id: 'main' },
        { tools: { deny: ['browser'] }, id: 'p4oc-1234' },
      ],
      writable: false,
    });

    expect(readOpenClawAgentConfigContract({ agents }).family).toBe('2026.9.1');

    Object.defineProperty(agents, 'list', {
      configurable: true,
      enumerable: false,
      value: [{ name: 'Wrong', id: 'main' }],
      writable: false,
    });
    expect(() => readOpenClawAgentConfigContract({ agents })).toThrow(/projection/);
  });

  test('rejects a hidden entries object beside a persisted 2026.7.1 list', () => {
    const agents: Record<string, unknown> = { list: [{ id: 'main' }] };
    Object.defineProperty(agents, 'entries', {
      enumerable: false,
      value: { main: {} },
    });
    expect(() => readOpenClawAgentConfigContract({ agents })).toThrow(/mixed/);
  });

  test.each([
    ['missing roster', { agents: { defaults: {} } }],
    ['mixed roster', { agents: { list: [{ id: 'main' }], entries: { main: {} } } }],
    ['malformed list', { agents: { list: [{ workspace: '/tmp' }] } }],
    ['embedded entries id', { agents: { entries: { main: { id: 'main' } } } }],
    ['case-folded duplicate list ids', { agents: { list: [{ id: 'MAIN' }, { id: 'main' }] } }],
    ['case-folded duplicate entry ids', { agents: { entries: { MAIN: {}, main: {} } } }],
  ])('rejects %s rather than guessing a runtime contract', (_label, config) => {
    expect(() => readOpenClawAgentConfigContract(config)).toThrow(/OpenClaw/);
  });

  test('rejects case-drift when looking up a server-owned id', () => {
    const contract = readOpenClawAgentConfigContract({ agents: { entries: { Main: {} } } });
    expect(() => exactOpenClawAgent(contract, 'main')).toThrow(/exact server-owned id/);
  });
});
