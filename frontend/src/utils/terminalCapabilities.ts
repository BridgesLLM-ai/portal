export type TerminalActionRisk = 'read_only' | 'service_change' | 'destructive';
export type TerminalConfirmation = 'none' | 'explicit' | 'typed';

export interface TerminalSuggestion {
  command: string;
  description: string;
  category: string;
  dangerous?: boolean;
  risk?: TerminalActionRisk;
  confirmation?: TerminalConfirmation;
  source?: 'action' | 'tool-help' | 'path';
}

export interface TerminalAction {
  id: string;
  title: string;
  description: string;
  command: string;
  category: string;
  risk: TerminalActionRisk;
  confirmation: TerminalConfirmation;
  requirements: string[];
  available: boolean;
  unmetRequirements: string[];
}

export interface TerminalToolCapability {
  id: string;
  label: string;
  category: string;
  installed: boolean;
  executable: string | null;
  version: string | null;
  helpCommand: string;
  sourceUrl: string;
  commands: string[];
  probeError?: string;
}

export interface TerminalServiceCapability {
  id: string;
  label: string;
  unit: string;
  installed: boolean;
  status: 'active' | 'inactive' | 'failed' | 'activating' | 'deactivating' | 'unknown' | 'not-installed';
  activeState: string | null;
  subState: string | null;
  detail?: string;
}

export interface TerminalCapabilities {
  generatedAt: string;
  scope: 'HOST_OPERATOR';
  notice: string;
  tools: TerminalToolCapability[];
  services: TerminalServiceCapability[];
  actions: TerminalAction[];
  shell: {
    name: string;
    executable: string;
    supportsRawInput: boolean;
    executableCount: number;
  };
}

export function buildTerminalCatalog(capabilities: TerminalCapabilities | null): TerminalSuggestion[] {
  if (!capabilities) return [];
  const catalog = new Map<string, TerminalSuggestion>();
  for (const action of capabilities.actions) {
    // Treat the field as true when talking to a briefly older backend during
    // an updater handoff; the 4.0 backend always sends an explicit boolean.
    if (action.available === false) continue;
    catalog.set(action.command, {
      command: action.command,
      description: action.description,
      category: action.category,
      source: 'action',
      risk: action.risk,
      confirmation: action.confirmation,
      dangerous: action.risk !== 'read_only',
    });
  }
  for (const tool of capabilities.tools) {
    if (!tool.installed) continue;
    catalog.set(tool.helpCommand, {
      command: tool.helpCommand,
      description: `${tool.label} help from the installed CLI`,
      category: tool.category,
      source: 'tool-help',
      risk: 'read_only',
      confirmation: 'none',
    });
    for (const command of tool.commands) {
      catalog.set(command, {
        command,
        description: `Discovered from ${tool.label} help`,
        category: tool.category,
        source: 'tool-help',
        risk: 'read_only',
        confirmation: 'none',
      });
    }
  }
  return [...catalog.values()];
}

export function rankTerminalCatalog(
  query: string,
  contextKeywords: string[],
  catalog: TerminalSuggestion[],
  limit = 20,
): TerminalSuggestion[] {
  const normalized = query.toLowerCase().trim();
  const words = normalized ? normalized.split(/\s+/).filter(Boolean) : [];
  const boundedLimit = Math.max(1, Math.min(50, limit));

  return catalog
    .map((suggestion) => {
      const command = suggestion.command.toLowerCase();
      const description = suggestion.description.toLowerCase();
      const category = suggestion.category.toLowerCase();
      const haystack = `${command} ${description} ${category}`;
      if (normalized && !command.startsWith(normalized) && !words.every((word) => haystack.includes(word))) {
        return { suggestion, score: 0 };
      }

      let score = !normalized && suggestion.source === 'action' ? 100 : 0;
      if (normalized && command === normalized) score += 500;
      if (normalized && command.startsWith(normalized)) score += 300;
      if (normalized && category === normalized) score += 100;
      for (const word of words) {
        if (command.startsWith(word)) score += 70;
        else if (command.includes(word)) score += 40;
        if (description.includes(word)) score += 20;
        if (category.includes(word)) score += 15;
      }
      for (const keyword of contextKeywords) {
        if (category === keyword) score += 25;
        else if (category.includes(keyword)) score += 15;
        if (command.includes(keyword)) score += 10;
      }
      return { suggestion, score };
    })
    .filter((entry) => entry.score > 0)
    .sort((left, right) => right.score - left.score || left.suggestion.command.localeCompare(right.suggestion.command))
    .slice(0, boundedLimit)
    .map((entry) => entry.suggestion);
}
