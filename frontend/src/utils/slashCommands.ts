export interface SlashCommand {
  command: string;
  aliases?: string[];
  description: string;
  category: 'Session' | 'Model' | 'Export' | 'Debug';
  argsHint?: string;
  executeLocal: boolean;
}

export function findSlashCommand(input: string): SlashCommand | null {
  const trimmed = input.trim();
  if (!trimmed.startsWith('/')) return null;
  const [cmdStr] = trimmed.split(/\s+/);
  const lower = cmdStr.toLowerCase();
  return SLASH_COMMANDS.find((command) => command.command === lower || command.aliases?.includes(lower)) || null;
}

export const SLASH_COMMANDS: SlashCommand[] = [
  { command: '/new', aliases: ['/reset'], description: 'Start a new session', category: 'Session', executeLocal: true },
  { command: '/stop', aliases: ['/cancel'], description: 'Cancel the current stream', category: 'Session', executeLocal: true },
  { command: '/model', description: 'Switch model', category: 'Model', argsHint: '<model-id>', executeLocal: true },
  { command: '/models', description: 'List available models', category: 'Model', executeLocal: true },
  { command: '/export', description: 'Export chat as markdown', category: 'Export', executeLocal: true },
  { command: '/help', description: 'Show available commands', category: 'Debug', executeLocal: true },
  { command: '/status', description: 'Show session status', category: 'Debug', executeLocal: true },
  { command: '/clear', description: 'Clear chat display', category: 'Session', executeLocal: true },
];

export function matchSlashCommands(input: string): SlashCommand[] {
  const lower = input.toLowerCase().trim();
  if (!lower.startsWith('/')) return [];
  return SLASH_COMMANDS.filter(cmd =>
    cmd.command.startsWith(lower) ||
    cmd.aliases?.some(a => a.startsWith(lower))
  );
}

export function parseSlashCommand(input: string): { command: SlashCommand; args: string } | null {
  const trimmed = input.trim();
  if (!trimmed.startsWith('/')) return null;
  const [, ...rest] = trimmed.split(/\s+/);
  const cmd = findSlashCommand(trimmed);
  if (!cmd) return null;
  return { command: cmd, args: rest.join(' ') };
}
