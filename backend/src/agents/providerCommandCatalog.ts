import { existsSync, readdirSync, statSync } from 'fs';
import path from 'path';
import type { AgentProviderName } from './AgentProvider.interface';
import { listProviderModels, type ProviderModelDescriptor } from './providerModels';
import { AgentRegistry } from './AgentRegistry';

export interface ProviderCommandOption {
  value: string;
  description?: string;
}

export interface ProviderCommandArgument {
  name: string;
  required?: boolean;
  repeatable?: boolean;
  values?: ProviderCommandOption[];
}

export interface ProviderSlashCommandDescriptor {
  command: string;
  description: string;
  argsHint?: string;
  example?: string;
  keywords?: string[];
  category?: string;
  arguments?: ProviderCommandArgument[];
}

const OPENCLAW_STATIC_COMMANDS: ProviderSlashCommandDescriptor[] = [
  { command: '/new', description: 'Start a new session.', argsHint: '[note]', category: 'Session', keywords: ['create', 'fresh'] },
  { command: '/reset', description: 'Reset the current session.', argsHint: '[note]', category: 'Session', keywords: ['clear'] },
  { command: '/compact', description: 'Compact session context.', argsHint: '[instructions]', category: 'Session', keywords: ['compress', 'shrink'] },
  { command: '/stop', description: 'Stop the current run.', category: 'Session', keywords: ['cancel', 'abort', 'halt'] },
  { command: '/session', description: 'Manage session-level settings (idle, max-age).', argsHint: '<idle|max-age> <duration|off>', category: 'Session', arguments: [{ name: 'key', required: true, values: [{ value: 'idle' }, { value: 'max-age' }] }, { name: 'value', required: true }] },
  { command: '/export-session', description: 'Export current session to an HTML file.', argsHint: '[path]', category: 'Session', keywords: ['export', 'save', 'html'] },

  { command: '/agent', description: 'Show or switch the active agent/provider.', argsHint: '[agent-id]', category: 'Agents', keywords: ['provider', 'switch'], arguments: [{ name: 'agent-id' }] },
  { command: '/model', description: 'Show or set the active model.', argsHint: '[model-id]', category: 'Model', keywords: ['switch', 'llm'], arguments: [{ name: 'model-id' }] },
  { command: '/models', description: 'List providers or provider models.', argsHint: '[provider]', category: 'Model', keywords: ['list', 'catalog'], arguments: [{ name: 'provider' }] },
  { command: '/think', description: 'Set thinking level.', argsHint: '<off|minimal|low|medium|high|xhigh>', category: 'Model', keywords: ['thinking', 'budget'], arguments: [{ name: 'level', required: true, values: ['off', 'minimal', 'low', 'medium', 'high', 'xhigh'].map((value) => ({ value })) }] },
  { command: '/reasoning', description: 'Toggle reasoning visibility.', argsHint: '<on|off|stream>', category: 'Model', keywords: ['chain-of-thought'], arguments: [{ name: 'mode', required: true, values: ['on', 'off', 'stream'].map((value) => ({ value })) }] },

  { command: '/verbose', description: 'Toggle verbose mode.', argsHint: '<on|off>', category: 'Runtime', keywords: ['debug', 'logging'], arguments: [{ name: 'mode', required: true, values: ['on', 'off'].map((value) => ({ value })) }] },
  { command: '/elevated', description: 'Toggle elevated mode.', argsHint: '<on|off|ask|full>', category: 'Runtime', keywords: ['sudo', 'root', 'admin'], arguments: [{ name: 'mode', required: true, values: ['on', 'off', 'ask', 'full'].map((value) => ({ value })) }] },
  { command: '/exec', description: 'Set exec defaults for this session.', argsHint: '<host> <security> <ask> [node]', category: 'Runtime', keywords: ['execute', 'shell'], arguments: [
    { name: 'host', required: true, values: ['sandbox', 'gateway', 'node'].map((value) => ({ value })) },
    { name: 'security', required: true, values: ['deny', 'allowlist', 'full'].map((value) => ({ value })) },
    { name: 'ask', required: true, values: ['off', 'on-miss', 'always'].map((value) => ({ value })) },
    { name: 'node' },
  ] },
  { command: '/queue', description: 'Adjust message queue settings.', argsHint: '<mode> [debounce] [cap] [drop]', category: 'Runtime', arguments: [{ name: 'mode', required: true, values: ['auto', 'on', 'off'].map((value) => ({ value })) }] },
  { command: '/activation', description: 'Set group activation mode.', argsHint: '<mention|always>', category: 'Runtime', arguments: [{ name: 'mode', required: true, values: ['mention', 'always'].map((value) => ({ value })) }] },
  { command: '/send', description: 'Set send policy.', argsHint: '<on|off|inherit>', category: 'Runtime', arguments: [{ name: 'mode', required: true, values: ['on', 'off', 'inherit'].map((value) => ({ value })) }] },
  { command: '/usage', description: 'Show usage or cost summary.', argsHint: '[off|tokens|full|cost]', category: 'Runtime', keywords: ['cost', 'tokens'], arguments: [{ name: 'mode', values: ['off', 'tokens', 'full', 'cost'].map((value) => ({ value })) }] },
  { command: '/config', description: 'Show or set config values.', argsHint: '<get|set> <path> [value]', category: 'Runtime', keywords: ['settings', 'preference'], arguments: [{ name: 'action', required: true, values: ['get', 'set'].map((value) => ({ value })) }, { name: 'path', required: true }, { name: 'value' }] },
  { command: '/debug', description: 'Set runtime debug overrides.', argsHint: '<action> <path> [value]', category: 'Runtime' },

  { command: '/subagents', description: 'List, kill, log, spawn, or steer subagent runs.', argsHint: '<list|spawn|send|steer|kill|log|info> ...', category: 'Agents', keywords: ['sub', 'child'], arguments: [{ name: 'action', required: true, values: ['list', 'spawn', 'send', 'steer', 'kill', 'log', 'info'].map((value) => ({ value })) }] },
  { command: '/agents', description: 'List thread-bound agents for this session.', category: 'Agents' },
  { command: '/kill', description: 'Kill a running subagent (or all).', argsHint: '<target|all>', category: 'Agents', keywords: ['terminate'] },
  { command: '/steer', description: 'Send guidance to a running subagent.', argsHint: '<target> <message...>', category: 'Agents' },
  { command: '/focus', description: 'Bind the conversation to a session target.', argsHint: '<target>', category: 'Agents' },
  { command: '/unfocus', description: 'Remove the current conversation binding.', category: 'Agents' },
  { command: '/acp', description: 'Manage ACP sessions and runtime options.', argsHint: '<action> [args...]', category: 'Agents', keywords: ['protocol'] },

  { command: '/help', description: 'Show available commands.', category: 'Info', keywords: ['?'] },
  { command: '/commands', description: 'List all slash commands.', category: 'Info', keywords: ['list'] },
  { command: '/status', description: 'Show current status.', category: 'Info', keywords: ['info', 'state'] },
  { command: '/context', description: 'Explain how context is built and used.', category: 'Info', keywords: ['prompt', 'system'] },
  { command: '/whoami', description: 'Show your sender id.', category: 'Info', keywords: ['id', 'identity'] },
  { command: '/tts', description: 'Control text-to-speech.', argsHint: '<on|off|status|provider|limit|summary|audio|help> [value]', category: 'Info', keywords: ['voice', 'speech', 'audio'], arguments: [{ name: 'action', required: true, values: ['on', 'off', 'status', 'provider', 'limit', 'summary', 'audio', 'help'].map((value) => ({ value })) }, { name: 'value' }] },
  { command: '/skill', description: 'Run a skill by name.', argsHint: '<name> [input]', category: 'Info', keywords: ['skills'] },
  { command: '/approve', description: 'Approve or deny exec requests.', category: 'Info', keywords: ['exec', 'permission'] },
  { command: '/restart', description: 'Restart OpenClaw.', category: 'Info', keywords: ['reboot'] },
];

function providerOptions() {
  return AgentRegistry.listProviders()
    .filter((provider) => provider.usable)
    .map((provider) => ({ value: provider.name, description: provider.displayName }));
}

function modelOptions(models: ProviderModelDescriptor[]) {
  return models.map((model) => ({ value: model.id, description: model.alias || model.displayName }));
}

async function openClawAgentOptions() {
  const seen = new Set<string>();
  const options: ProviderCommandOption[] = [];

  try {
    const agentsBase = path.join(process.env.HOME || '/root', '.openclaw/agents');
    if (existsSync(agentsBase)) {
      for (const entry of readdirSync(agentsBase)) {
        if (!entry || entry.startsWith('portal-')) continue;
        const fullPath = path.join(agentsBase, entry);
        if (!statSync(fullPath).isDirectory() || seen.has(entry)) continue;
        seen.add(entry);
        options.push({ value: entry, description: entry === 'main' ? 'Main agent' : `${entry} sub-agent` });
      }
    }
  } catch {}

  try {
    const provider = AgentRegistry.get('OPENCLAW');
    const sessions = await provider.listSessions('system');
    for (const session of sessions) {
      const agentId = String(session.metadata?.agentId || session.metadata?.agent || '').trim();
      if (!agentId || seen.has(agentId)) continue;
      seen.add(agentId);
      options.push({ value: agentId, description: session.title || session.preview || undefined });
    }
  } catch {}

  if (!seen.has('main')) options.unshift({ value: 'main', description: 'Main agent' });
  return options.length > 0 ? options.sort((a, b) => (a.value === 'main' ? -1 : b.value === 'main' ? 1 : a.value.localeCompare(b.value))) : [{ value: 'main', description: 'Main agent' }];
}

function withArgumentValues(command: ProviderSlashCommandDescriptor, name: string, values: ProviderCommandOption[]) {
  return {
    ...command,
    arguments: (command.arguments || []).map((argument) => argument.name === name ? { ...argument, values } : argument),
  };
}

export async function getProviderCommandCatalog(provider: AgentProviderName): Promise<ProviderSlashCommandDescriptor[]> {
  if (provider === 'OPENCLAW') {
    const [models, agents] = await Promise.all([
      listProviderModels('OPENCLAW'),
      openClawAgentOptions(),
    ]);
    return OPENCLAW_STATIC_COMMANDS.map((command) => {
      if (command.command === '/model') return withArgumentValues(command, 'model-id', modelOptions(models));
      if (command.command === '/models') return withArgumentValues(command, 'provider', providerOptions());
      if (command.command === '/agent') {
        return {
          ...command,
          arguments: [{ name: 'agent-id', values: agents }],
        };
      }
      return command;
    });
  }

  const nativeProviderInfo = AgentRegistry.listProviders().find((entry) => entry.name === provider);
  if (nativeProviderInfo?.usable) {
    const models = await listProviderModels(provider);
    const modelArgumentValues = modelOptions(models);
    const supportsCatalog = nativeProviderInfo.capabilities.canEnumerateModels || models.length > 0;
    return [
      { command: '/new', description: `Start a new ${nativeProviderInfo.displayName} portal session.`, example: '/new', category: 'Session', keywords: ['fresh', 'reset'] },
      { command: '/reset', description: `Reset by starting a fresh ${nativeProviderInfo.displayName} portal session.`, example: '/reset', category: 'Session', keywords: ['clear', 'fresh'] },
      { command: '/status', description: 'Show provider/session/model status for this chat.', example: '/status', category: 'Info', keywords: ['info', 'state'] },
      { command: '/help', description: 'Show available portal slash commands for this provider.', example: '/help', category: 'Info', keywords: ['commands', '?'] },
      { command: '/commands', description: 'List available portal slash commands for this provider.', example: '/commands', category: 'Info', keywords: ['help', 'list'] },
      {
        command: '/model',
        description: `Show or set the ${nativeProviderInfo.displayName} model for this session.`,
        argsHint: provider === 'CLAUDE_CODE' ? '[sonnet|opus|claude-sonnet-4-6|…]' : '[model-id]',
        category: 'Model',
        keywords: ['switch', 'llm'],
        example: provider === 'CLAUDE_CODE' ? '/model sonnet' : provider === 'GEMINI' ? '/model gemini-2.5-pro' : '/model llama3.2',
        arguments: [{ name: 'model', values: modelArgumentValues.length ? modelArgumentValues : undefined }],
      },
      {
        command: '/models',
        description: supportsCatalog
          ? `List known ${nativeProviderInfo.displayName} models.`
          : `Explain ${nativeProviderInfo.displayName} model selection and custom model entry.`,
        argsHint: '[provider]',
        category: 'Model',
        keywords: ['catalog', 'list'],
        example: '/models',
        arguments: [{ name: 'provider', values: providerOptions() }],
      },
    ];
  }

  return [];
}
