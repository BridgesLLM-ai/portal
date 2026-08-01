import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const settingsSource = readFileSync(new URL('./SettingsPage.tsx', import.meta.url), 'utf8');
const setupSource = readFileSync(new URL('../components/settings/AgentZeroSetupPanel.tsx', import.meta.url), 'utf8');
const chatSource = readFileSync(new URL('../components/chat/ChatInterface.tsx', import.meta.url), 'utf8');

describe('Agent Zero provider settings placement', () => {
  it('mounts OAuth accounts in canonical AI Providers while keeping runtime controls in Agents', () => {
    const agentsBranch = settingsSource.slice(
      settingsSource.indexOf("activeTab === 'agents'"),
      settingsSource.indexOf("activeTab === 'system'"),
    );
    const providersBranch = settingsSource.slice(
      settingsSource.indexOf("activeTab === 'ai-providers'"),
      settingsSource.indexOf("activeTab === 'readiness'"),
    );

    expect(agentsBranch).toContain('<AgentsTab');
    expect(providersBranch).toContain('view="providers"');
    expect(setupSource).toContain("if (view === 'providers')");
    expect(setupSource).toContain('OAuth connections and model discovery live in the canonical AI Providers settings.');
  });

  it('also exposes the owner OAuth surface in the Agent Chat settings drawer', () => {
    expect(chatSource).toContain('<LazyAgentZeroSetupPanel');
    expect(chatSource).toContain('onProviderConnectionsChanged={onAiProviderSetupComplete}');
  });
});
