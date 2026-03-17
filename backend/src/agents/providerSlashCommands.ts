import type { AgentProviderName } from './AgentProvider.interface';

export interface ProviderSlashCommand {
  command: string;
  description: string;
  argsHint?: string;
  example?: string;
  keywords?: string[];
  category?: string;
}

/* ────────────────────────────────────────────────────────────────────────────
 *  OpenClaw slash commands — sourced from the real commands-registry.
 *
 *  Category values drive grouping in the autocomplete palette.
 *  Only commands that genuinely work via the portal Agent Chats surface
 *  are listed.  Dock commands are excluded (they switch reply targets to
 *  external channels, which doesn't apply inside the portal).
 * ──────────────────────────────────────────────────────────────────────── */

const OPENCLAW_SLASH_COMMANDS: ProviderSlashCommand[] = [
  // ── Session ──────────────────────────────────────────────────────────
  { command: '/new',            description: 'Start a new session.',                          argsHint: '[note]',              category: 'Session',    keywords: ['create', 'fresh'] },
  { command: '/reset',          description: 'Reset the current session.',                    argsHint: '[note]',              category: 'Session',    keywords: ['clear'] },
  { command: '/compact',        description: 'Compact session context.',                      argsHint: '[instructions]',      category: 'Session',    keywords: ['compress', 'shrink'] },
  { command: '/stop',           description: 'Stop the current run.',                                                          category: 'Session',    keywords: ['cancel', 'abort', 'halt'] },
  { command: '/session',        description: 'Manage session-level settings (idle, max-age).', argsHint: '<idle|max-age> <duration|off>', category: 'Session' },
  { command: '/export-session', description: 'Export current session to an HTML file.',        argsHint: '[path]',             category: 'Session',    keywords: ['export', 'save', 'html'] },

  // ── Model & Thinking ─────────────────────────────────────────────────
  { command: '/model',     description: 'Show or set the active model.',    argsHint: '[model-id]',                              category: 'Model',  keywords: ['switch', 'llm'] },
  { command: '/models',    description: 'List providers or provider models.', argsHint: '[provider]',                             category: 'Model',  keywords: ['list', 'catalog'] },
  { command: '/think',     description: 'Set thinking level.',              argsHint: '<off|minimal|low|medium|high|xhigh>',     category: 'Model',  keywords: ['thinking', 'budget'] },
  { command: '/reasoning', description: 'Toggle reasoning visibility.',     argsHint: '<on|off|stream>',                         category: 'Model',  keywords: ['chain-of-thought'] },

  // ── Runtime ──────────────────────────────────────────────────────────
  { command: '/verbose',   description: 'Toggle verbose mode.',             argsHint: '<on|off>',                                category: 'Runtime', keywords: ['debug', 'logging'] },
  { command: '/elevated',  description: 'Toggle elevated mode.',            argsHint: '<on|off|ask|full>',                       category: 'Runtime', keywords: ['sudo', 'root', 'admin'] },
  { command: '/exec',      description: 'Set exec defaults for this session.', argsHint: '<host> <security> <ask> [node]',       category: 'Runtime', keywords: ['execute', 'shell'] },
  { command: '/queue',     description: 'Adjust message queue settings.',   argsHint: '<mode> [debounce] [cap] [drop]',          category: 'Runtime' },
  { command: '/activation',description: 'Set group activation mode.',       argsHint: '<mention|always>',                        category: 'Runtime' },
  { command: '/send',      description: 'Set send policy.',                 argsHint: '<on|off|inherit>',                        category: 'Runtime' },
  { command: '/usage',     description: 'Show usage or cost summary.',      argsHint: '[off|tokens|full|cost]',                  category: 'Runtime', keywords: ['cost', 'tokens'] },
  { command: '/config',    description: 'Show or set config values.',       argsHint: '<get|set> <path> [value]',                category: 'Runtime', keywords: ['settings', 'preference'] },
  { command: '/debug',     description: 'Set runtime debug overrides.',     argsHint: '<action> <path> [value]',                 category: 'Runtime' },

  // ── Subagents ────────────────────────────────────────────────────────
  { command: '/subagents', description: 'List, kill, log, spawn, or steer subagent runs.', argsHint: '<list|spawn|send|steer|kill|log|info> ...', category: 'Agents', keywords: ['sub', 'child'] },
  { command: '/agents',    description: 'List thread-bound agents for this session.',                                            category: 'Agents' },
  { command: '/kill',      description: 'Kill a running subagent (or all).',               argsHint: '<target|all>',             category: 'Agents', keywords: ['terminate'] },
  { command: '/steer',     description: 'Send guidance to a running subagent.',            argsHint: '<target> <message...>',     category: 'Agents' },
  { command: '/focus',     description: 'Bind the conversation to a session target.',      argsHint: '<target>',                  category: 'Agents' },
  { command: '/unfocus',   description: 'Remove the current conversation binding.',                                               category: 'Agents' },
  { command: '/acp',       description: 'Manage ACP sessions and runtime options.',        argsHint: '<action> [args...]',        category: 'Agents', keywords: ['protocol'] },

  // ── Info & TTS ───────────────────────────────────────────────────────
  { command: '/help',      description: 'Show available commands.',                                                               category: 'Info',   keywords: ['?'] },
  { command: '/commands',  description: 'List all slash commands.',                                                               category: 'Info',   keywords: ['list'] },
  { command: '/status',    description: 'Show current status.',                                                                   category: 'Info',   keywords: ['info', 'state'] },
  { command: '/context',   description: 'Explain how context is built and used.',                                                 category: 'Info',   keywords: ['prompt', 'system'] },
  { command: '/whoami',    description: 'Show your sender id.',                                                                   category: 'Info',   keywords: ['id', 'identity'] },
  { command: '/tts',       description: 'Control text-to-speech.',                         argsHint: '<on|off|status|provider|limit|summary|audio|help> [value]', category: 'Info', keywords: ['voice', 'speech', 'audio'] },
  { command: '/skill',     description: 'Run a skill by name.',                            argsHint: '<name> [input]',            category: 'Info',   keywords: ['skills'] },
  { command: '/approve',   description: 'Approve or deny exec requests.',                                                        category: 'Info',   keywords: ['exec', 'permission'] },
  { command: '/restart',   description: 'Restart OpenClaw.',                                                                      category: 'Info',   keywords: ['reboot'] },
];

const PROVIDER_COMMANDS: Record<AgentProviderName, ProviderSlashCommand[]> = {
  OPENCLAW: OPENCLAW_SLASH_COMMANDS,
  CLAUDE_CODE: [],
  CODEX: [],
  AGENT_ZERO: [],
  GEMINI: [],
  OLLAMA: [],
};

export function getProviderSlashCommands(provider: AgentProviderName): ProviderSlashCommand[] {
  return PROVIDER_COMMANDS[provider] || [];
}
