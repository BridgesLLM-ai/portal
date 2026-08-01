import { describe, expect, test } from 'vitest';
import {
  buildTerminalCatalog,
  rankTerminalCatalog,
  type TerminalCapabilities,
} from './terminalCapabilities';

function capabilitiesFixture(): TerminalCapabilities {
  return {
    generatedAt: '2026-07-18T00:00:00.000Z',
    scope: 'HOST_OPERATOR',
    notice: 'Host operator',
    shell: { name: 'bash', executable: '/bin/bash', supportsRawInput: true, executableCount: 2 },
    services: [],
    actions: [
      {
        id: 'health', title: 'Portal health', description: 'Inspect Portal health', command: 'portal-health',
        category: 'portal', risk: 'read_only', confirmation: 'none', requirements: [], available: true,
        unmetRequirements: [],
      },
      {
        id: 'docker', title: 'Docker status', description: 'Inspect Docker', command: 'docker ps',
        category: 'docker', risk: 'read_only', confirmation: 'none', requirements: ['docker'], available: false,
        unmetRequirements: ['docker'],
      },
    ],
    tools: [
      {
        id: 'openclaw', label: 'OpenClaw', category: 'openclaw', installed: true,
        executable: '/usr/bin/openclaw', version: '2026.7.1', helpCommand: 'openclaw --help',
        sourceUrl: 'https://docs.openclaw.ai/', commands: ['openclaw gateway'],
      },
      {
        id: 'docker', label: 'Docker', category: 'docker', installed: false,
        executable: null, version: null, helpCommand: 'docker --help',
        sourceUrl: 'https://docs.docker.com/', commands: [],
      },
    ],
  };
}

describe('terminal capability catalog', () => {
  test('maps only live tools and available actions', () => {
    const catalog = buildTerminalCatalog(capabilitiesFixture());
    expect(catalog.map((entry) => entry.command)).toEqual([
      'portal-health',
      'openclaw --help',
      'openclaw gateway',
    ]);
  });

  test('keeps the empty state bounded to curated actions', () => {
    const catalog = buildTerminalCatalog(capabilitiesFixture());
    expect(rankTerminalCatalog('', [], catalog)).toEqual([
      expect.objectContaining({ command: 'portal-health', source: 'action' }),
    ]);
  });

  test('searches descriptions and uses context only as a ranking boost', () => {
    const catalog = buildTerminalCatalog(capabilitiesFixture());
    expect(rankTerminalCatalog('gateway', [], catalog)[0]).toMatchObject({ command: 'openclaw gateway' });
    expect(rankTerminalCatalog('openclaw', ['openclaw'], catalog, 1)[0]).toMatchObject({ command: 'openclaw --help' });
  });
});
