import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const settingsSource = readFileSync(new URL('./SettingsPage.tsx', import.meta.url), 'utf8');
const setupSource = readFileSync(new URL('../components/settings/AgentZeroSetupPanel.tsx', import.meta.url), 'utf8');
const chatSource = readFileSync(new URL('../components/chat/ChatInterface.tsx', import.meta.url), 'utf8');

describe('Agent Zero model-account settings placement', () => {
  it('mounts OAuth accounts in the model-provider route while keeping runtime controls under harnesses', () => {
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
    expect(setupSource).toContain('OAuth connections and model discovery live in the canonical Model Providers settings.');
  });

  it('labels the three settings concepts without renaming their compatibility route ids', () => {
    expect(settingsSource).toContain("{ id: 'agents', label: 'Harnesses'");
    expect(settingsSource).toContain("{ id: 'ai-providers', label: 'Model Providers'");
    expect(settingsSource).toContain('<SectionCard title="Model Accounts & Auth">');
    expect(settingsSource).toContain('<SectionCard title="Harnesses & Runtime Ownership">');
    expect(settingsSource).toContain('These accounts supply models; they are separate from the harness that runs the agent session.');
  });

  it('also exposes the owner OAuth surface in the Agent Chat settings drawer', () => {
    expect(chatSource).toContain('<LazyAgentZeroSetupPanel');
    expect(chatSource).toContain('onProviderConnectionsChanged={onAiProviderSetupComplete}');
  });
});
