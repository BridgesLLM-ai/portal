import type { AgentProvider, AgentProviderName } from './AgentProvider.interface';
import { OpenClawProvider } from './providers/OpenClawProvider';
import { ClaudeCodeProvider } from './providers/ClaudeCodeProvider';
import { CodexProvider } from './providers/CodexProvider';
import { AgentZeroProvider } from './providers/AgentZeroProvider';
import { GeminiProvider } from './providers/GeminiProvider';
import { OllamaProvider } from './providers/OllamaProvider';
import { getProviderAvailability, type ProviderCapabilitySummary } from './providerAvailability';

export interface RegisteredProviderInfo {
  name: AgentProviderName;
  displayName: string;
  installed: boolean;
  implemented: boolean;
  usable: boolean;
  command?: string;
  version?: string;
  native: boolean;
  reason?: string;
  capabilities: ProviderCapabilitySummary;
}

const providerConstructors: Record<AgentProviderName, new () => AgentProvider> = {
  OPENCLAW: OpenClawProvider,
  CLAUDE_CODE: ClaudeCodeProvider,
  CODEX: CodexProvider,
  AGENT_ZERO: AgentZeroProvider,
  GEMINI: GeminiProvider,
  OLLAMA: OllamaProvider,
};

const providerDisplayNames: Record<AgentProviderName, string> = {
  OPENCLAW: 'OpenClaw',
  CLAUDE_CODE: 'Claude Code',
  CODEX: 'Codex',
  AGENT_ZERO: 'Agent Zero',
  GEMINI: 'Gemini CLI',
  OLLAMA: 'Ollama',
};

export class AgentRegistry {
  private static providers = new Map<AgentProviderName, AgentProvider>();
  private static defaultProvider: AgentProviderName = 'OPENCLAW';

  static getProvider(name: AgentProviderName): AgentProvider {
    const availability = getProviderAvailability(name);
    if (!availability.implemented) {
      throw new Error(`${providerDisplayNames[name]} is not implemented yet`);
    }
    if (!availability.installed) {
      throw new Error(`${providerDisplayNames[name]} is not installed on this machine`);
    }

    if (!this.providers.has(name)) {
      const ProviderCtor = providerConstructors[name];
      this.providers.set(name, new ProviderCtor());
    }
    return this.providers.get(name)!;
  }

  static get(name: AgentProviderName): AgentProvider {
    return this.getProvider(name);
  }

  static getDefault(): AgentProvider {
    const preferred = getProviderAvailability(this.defaultProvider);
    if (preferred.usable) return this.getProvider(this.defaultProvider);

    const fallback = this.listProviders().find((provider) => provider.usable);
    if (!fallback) {
      throw new Error('No usable agent providers are available');
    }
    return this.getProvider(fallback.name);
  }

  static setDefault(name: AgentProviderName): void {
    this.defaultProvider = name;
  }

  static listProviders(): RegisteredProviderInfo[] {
    return (Object.keys(providerConstructors) as AgentProviderName[]).map((name) => {
      const availability = getProviderAvailability(name);
      return {
        name,
        displayName: providerDisplayNames[name],
        installed: availability.installed,
        implemented: availability.implemented,
        usable: availability.usable,
        command: availability.command,
        version: availability.version,
        native: availability.native,
        reason: availability.reason,
        capabilities: availability.capabilities,
      };
    });
  }
}
