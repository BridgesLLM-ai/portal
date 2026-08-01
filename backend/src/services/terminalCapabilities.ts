import { execFile } from 'child_process';
import { constants as fsConstants } from 'fs';
import { access, mkdtemp, readdir, rm } from 'fs/promises';
import { tmpdir } from 'os';
import path from 'path';
import { promisify } from 'util';

const execFileAsync = promisify(execFile);
const PROBE_TIMEOUT_MS = 2_500;
const CAPABILITY_CACHE_MS = 60_000;
const MAX_HELP_BYTES = 128 * 1024;
const DEFAULT_PATH = '/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin';

export function buildTerminalProbeEnv(
  probeHome: string,
  pathValue = process.env.PATH || DEFAULT_PATH,
): NodeJS.ProcessEnv {
  const locale = process.env.LANG || 'C.UTF-8';
  return {
    PATH: pathValue,
    HOME: probeHome,
    XDG_CONFIG_HOME: path.join(probeHome, '.config'),
    XDG_CACHE_HOME: path.join(probeHome, '.cache'),
    XDG_DATA_HOME: path.join(probeHome, '.local', 'share'),
    XDG_STATE_HOME: path.join(probeHome, '.local', 'state'),
    LANG: locale,
    LC_ALL: process.env.LC_ALL || locale,
    TERM: 'dumb',
    NO_COLOR: '1',
    CI: '1',
    // Prevent a read-only capability probe from triggering Grok Build's
    // self-updater. Portal upgrades CLI tools through its tested pin matrix.
    GROK_DISABLE_AUTOUPDATER: '1',
  };
}

export type TerminalActionRisk = 'read_only' | 'service_change' | 'destructive';

export interface TerminalAction {
  id: string;
  title: string;
  description: string;
  command: string;
  category: string;
  risk: TerminalActionRisk;
  confirmation: 'none' | 'explicit' | 'typed';
  requirements: string[];
  available: boolean;
  unmetRequirements: string[];
}

export type TerminalActionDefinition = Omit<TerminalAction, 'available' | 'unmetRequirements'>;

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

export interface TerminalSuggestion {
  command: string;
  description: string;
  category: string;
  source: 'action' | 'tool-help' | 'path';
  risk: TerminalActionRisk;
  dangerous?: boolean;
  confirmation: 'none' | 'explicit' | 'typed';
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
    supportsRawInput: true;
    executableCount: number;
  };
}

interface TerminalToolSpec {
  id: string;
  label: string;
  category: string;
  versionArgs: string[];
  helpArgs: string[];
  sourceUrl: string;
}

interface TerminalServiceSpec {
  id: string;
  label: string;
  unit: string;
}

const TOOL_SPECS: TerminalToolSpec[] = [
  { id: 'bash', label: 'Bash', category: 'shell', versionArgs: ['--version'], helpArgs: ['--help'], sourceUrl: 'https://www.gnu.org/software/bash/manual/' },
  { id: 'openclaw', label: 'OpenClaw', category: 'openclaw', versionArgs: ['--version'], helpArgs: ['--help'], sourceUrl: 'https://docs.openclaw.ai/' },
  { id: 'claude', label: 'Claude Code', category: 'agents', versionArgs: ['--version'], helpArgs: ['--help'], sourceUrl: 'https://docs.anthropic.com/en/docs/claude-code/overview' },
  { id: 'codex', label: 'Codex CLI', category: 'agents', versionArgs: ['--version'], helpArgs: ['--help'], sourceUrl: 'https://developers.openai.com/codex/cli/' },
  { id: 'grok', label: 'Grok Build', category: 'agents', versionArgs: ['--version'], helpArgs: ['--help'], sourceUrl: 'https://x.ai/grok-code-fast-1' },
  { id: 'agy', label: 'Antigravity', category: 'agents', versionArgs: ['--version'], helpArgs: ['--help'], sourceUrl: 'https://antigravity.google/' },
  { id: 'ollama', label: 'Ollama', category: 'ollama', versionArgs: ['--version'], helpArgs: ['--help'], sourceUrl: 'https://docs.ollama.com/' },
  { id: 'docker', label: 'Docker', category: 'docker', versionArgs: ['--version'], helpArgs: ['--help'], sourceUrl: 'https://docs.docker.com/reference/cli/docker/' },
  { id: 'git', label: 'Git', category: 'git', versionArgs: ['--version'], helpArgs: ['--help'], sourceUrl: 'https://git-scm.com/docs' },
  { id: 'node', label: 'Node.js', category: 'runtime', versionArgs: ['--version'], helpArgs: ['--help'], sourceUrl: 'https://nodejs.org/docs/latest/api/cli.html' },
  { id: 'npm', label: 'npm', category: 'runtime', versionArgs: ['--version'], helpArgs: ['--help'], sourceUrl: 'https://docs.npmjs.com/cli/' },
  { id: 'python3', label: 'Python', category: 'runtime', versionArgs: ['--version'], helpArgs: ['--help'], sourceUrl: 'https://docs.python.org/3/using/cmdline.html' },
  { id: 'tailscale', label: 'Tailscale', category: 'network', versionArgs: ['version'], helpArgs: ['--help'], sourceUrl: 'https://tailscale.com/kb/1080/cli' },
  { id: 'systemctl', label: 'systemd', category: 'system', versionArgs: ['--version'], helpArgs: ['--help'], sourceUrl: 'https://www.freedesktop.org/software/systemd/man/latest/systemctl.html' },
  { id: 'journalctl', label: 'Journal', category: 'system', versionArgs: ['--version'], helpArgs: ['--help'], sourceUrl: 'https://www.freedesktop.org/software/systemd/man/latest/journalctl.html' },
  { id: 'curl', label: 'curl', category: 'network', versionArgs: ['--version'], helpArgs: ['--help'], sourceUrl: 'https://curl.se/docs/manpage.html' },
  { id: 'psql', label: 'PostgreSQL client', category: 'database', versionArgs: ['--version'], helpArgs: ['--help'], sourceUrl: 'https://www.postgresql.org/docs/current/app-psql.html' },
  { id: 'caddy', label: 'Caddy', category: 'network', versionArgs: ['version'], helpArgs: ['help'], sourceUrl: 'https://caddyserver.com/docs/command-line' },
  { id: 'gh', label: 'GitHub CLI', category: 'git', versionArgs: ['--version'], helpArgs: ['--help'], sourceUrl: 'https://cli.github.com/manual/' },
  { id: 'rg', label: 'ripgrep', category: 'files', versionArgs: ['--version'], helpArgs: ['--help'], sourceUrl: 'https://github.com/BurntSushi/ripgrep/blob/master/GUIDE.md' },
  { id: 'jq', label: 'jq', category: 'text', versionArgs: ['--version'], helpArgs: ['--help'], sourceUrl: 'https://jqlang.org/manual/' },
];

const SERVICE_SPECS: TerminalServiceSpec[] = [
  { id: 'portal', label: 'BridgesLLM Portal', unit: 'bridgesllm-product.service' },
  { id: 'openclaw-gateway', label: 'OpenClaw gateway', unit: 'openclaw-gateway.service' },
  { id: 'postgresql', label: 'PostgreSQL', unit: 'postgresql.service' },
  { id: 'docker', label: 'Docker', unit: 'docker.service' },
  { id: 'ollama', label: 'Ollama', unit: 'ollama.service' },
  { id: 'caddy', label: 'Caddy', unit: 'caddy.service' },
  { id: 'stalwart', label: 'Stalwart Mail', unit: 'stalwart-mail.service' },
];

export const TERMINAL_ACTIONS: TerminalActionDefinition[] = [
  {
    id: 'portal-health',
    title: 'Portal health',
    description: 'Check the Portal service and its loopback health endpoint.',
    command: 'systemctl is-active bridgesllm-product.service && curl -fsS http://127.0.0.1:4001/health',
    category: 'portal', risk: 'read_only', confirmation: 'none', requirements: ['systemctl', 'curl', 'service:portal'],
  },
  {
    id: 'portal-logs',
    title: 'Portal logs',
    description: 'Show the latest Portal service logs without following the stream.',
    command: 'journalctl -u bridgesllm-product.service -n 100 --no-pager',
    category: 'portal', risk: 'read_only', confirmation: 'none', requirements: ['journalctl', 'service:portal'],
  },
  {
    id: 'openclaw-status',
    title: 'OpenClaw status',
    description: 'Ask the installed OpenClaw CLI for current gateway and channel state.',
    command: 'openclaw status',
    category: 'openclaw', risk: 'read_only', confirmation: 'none', requirements: ['openclaw'],
  },
  {
    id: 'openclaw-gateway',
    title: 'Gateway status',
    description: 'Check OpenClaw gateway service reachability.',
    command: 'openclaw gateway status --require-rpc --timeout 10000',
    category: 'openclaw', risk: 'read_only', confirmation: 'none', requirements: ['openclaw'],
  },
  {
    id: 'resource-pressure',
    title: 'Resource pressure',
    description: 'Inspect filesystem, memory, load, and the busiest processes.',
    command: 'df -h && free -h && uptime && ps -eo pid,comm,%cpu,%mem --sort=-%cpu | head -15',
    category: 'system', risk: 'read_only', confirmation: 'none', requirements: ['df', 'free', 'uptime', 'ps', 'head'],
  },
  {
    id: 'listening-services',
    title: 'Listening services',
    description: 'List listening TCP and UDP sockets with owning processes.',
    command: 'ss -lntup',
    category: 'network', risk: 'read_only', confirmation: 'none', requirements: ['ss'],
  },
  {
    id: 'docker-runtime',
    title: 'Docker runtime',
    description: 'Show running containers and their resource usage.',
    command: 'docker ps --format "table {{.Names}}\\t{{.Image}}\\t{{.Status}}\\t{{.Ports}}" && docker stats --no-stream',
    category: 'docker', risk: 'read_only', confirmation: 'none', requirements: ['docker'],
  },
  {
    id: 'ollama-runtime',
    title: 'Local Ollama runtime',
    description: 'Show the Portal host loopback Ollama daemon version and locally loaded models.',
    command: 'curl -fsS --noproxy "*" --max-time 5 --max-redirs 0 http://127.0.0.1:11434/api/version && printf "\\n" && env OLLAMA_HOST=http://127.0.0.1:11434 timeout 5s ollama ps',
    category: 'ollama', risk: 'read_only', confirmation: 'none', requirements: ['ollama', 'curl', 'env', 'timeout'],
  },
  {
    id: 'restart-openclaw',
    title: 'Restart gateway',
    description: 'Restart OpenClaw. Active agent turns may be interrupted.',
    command: 'systemctl restart openclaw-gateway.service',
    category: 'openclaw', risk: 'service_change', confirmation: 'explicit', requirements: ['systemctl', 'service:openclaw-gateway'],
  },
  {
    id: 'restart-portal',
    title: 'Restart Portal',
    description: 'Restart the Portal service. This Terminal connection will close.',
    command: 'systemctl restart bridgesllm-product.service',
    category: 'portal', risk: 'service_change', confirmation: 'explicit', requirements: ['systemctl', 'service:portal'],
  },
];

const COMMAND_BOUNDARY = '(?:^|[;&|`(]\\s*)';

const DESTRUCTIVE_PATTERNS: Array<{ pattern: RegExp; message: string }> = [
  { pattern: new RegExp(`${COMMAND_BOUNDARY}rm\\s+[^\\n]*(?:-[a-z]*[rf][a-z]*|--recursive|--force)`, 'i'), message: 'Recursive or forced deletion can permanently remove host data.' },
  { pattern: new RegExp(`${COMMAND_BOUNDARY}(?:rm|rmdir|unlink|truncate)\\b`, 'i'), message: 'This permanently removes or truncates host data.' },
  { pattern: new RegExp(`${COMMAND_BOUNDARY}(?:mkfs(?:\\.[a-z0-9]+)?|wipefs|shred|fdisk|parted)\\b`, 'i'), message: 'This can destroy or rewrite disk data.' },
  { pattern: new RegExp(`${COMMAND_BOUNDARY}dd\\s+[^\\n]*(?:of=\\/dev\\/|if=\\/dev\\/)`, 'i'), message: 'Raw device I/O can overwrite an entire disk.' },
  { pattern: new RegExp(`${COMMAND_BOUNDARY}git(?:\\s+(?:(?:-C|-c|--git-dir|--work-tree|--namespace|--config-env)\\s+\\S+|(?:--git-dir|--work-tree|--namespace)=\\S+))*\\s+(?:reset\\s+--hard|clean\\s+-[^\\n]*f|push\\s+[^\\n]*(?:--force(?:-with-lease)?|-f)(?:\\s|$))`, 'i'), message: 'This can permanently discard or overwrite Git history or files.' },
  { pattern: new RegExp(`${COMMAND_BOUNDARY}docker\\s+(?:system\\s+prune|volume\\s+prune|compose\\s+down\\s+[^\\n]*-v)\\b`, 'i'), message: 'This can remove container data or volumes.' },
  { pattern: new RegExp(`${COMMAND_BOUNDARY}docker\\s+volume\\s+rm\\b`, 'i'), message: 'This permanently removes Docker volume data.' },
  { pattern: new RegExp(`${COMMAND_BOUNDARY}(?:dropdb|userdel|groupdel)\\b`, 'i'), message: 'This removes persistent system or database state.' },
  { pattern: new RegExp(`${COMMAND_BOUNDARY}(?:shutdown|reboot|poweroff|halt)\\b`, 'i'), message: 'This interrupts the host and every running service.' },
  { pattern: new RegExp(`${COMMAND_BOUNDARY}openclaw\\s+(?:reset|uninstall)\\b`, 'i'), message: 'This can remove OpenClaw configuration, state, or services.' },
  { pattern: new RegExp(`${COMMAND_BOUNDARY}crontab\\s+-r\\b`, 'i'), message: 'This removes the current user\'s scheduled jobs.' },
  { pattern: new RegExp(`${COMMAND_BOUNDARY}find\\b[^\\n]*(?:-delete|-exec\\s+(?:rm|shred|truncate)\\b)`, 'i'), message: 'This can recursively remove files selected by find.' },
  { pattern: new RegExp(`${COMMAND_BOUNDARY}xargs\\b[^\\n]*(?:rm|shred|truncate)\\b`, 'i'), message: 'This can remove every path received from the command pipeline.' },
];

const SERVICE_CHANGE_PATTERNS: Array<{ pattern: RegExp; message: string }> = [
  { pattern: /(^|[;&|]\s*)systemctl(?:\s+(?:--user|--system|--global|--runtime|--now|--no-block|--no-reload|--force|-q))*\s+(?:start|stop|restart|try-restart|reload|reload-or-restart|daemon-reload|daemon-reexec|enable|disable|mask|unmask|edit|set-property)\b/i, message: 'This changes a host service and may interrupt active work.' },
  { pattern: /(^|[;&|]\s*)service\s+\S+\s+(?:start|stop|restart|reload|force-reload)\b/i, message: 'This changes a host service and may interrupt active work.' },
  { pattern: /(^|[;&|]\s*)openclaw\s+(?:gateway\s+(?:start|stop|restart|install|uninstall)|update|configure|onboard)\b/i, message: 'This changes OpenClaw host state and may interrupt agent turns.' },
  { pattern: /(^|[;&|]\s*)(?:apt|apt-get|dnf|yum|zypper|apk)\s+(?:update|install|remove|purge|upgrade|dist-upgrade|full-upgrade|add|del)\b/i, message: 'This changes host packages and can alter runtime compatibility.' },
  { pattern: /(^|[;&|]\s*)(?:dpkg\s+(?:-i|-r|--install|--remove|--purge)|snap\s+(?:install|remove|refresh)|(?:pip|pip3|gem|cargo)\s+(?:install|uninstall)|python3?\s+-m\s+pip\s+(?:install|uninstall)|pacman\s+(?:-[SUR]|--sync|--remove|--upgrade))\b/i, message: 'This changes host packages and can alter runtime compatibility.' },
  { pattern: /(^|[;&|]\s*)git(?:\s+(?:(?:-C|-c|--git-dir|--work-tree|--namespace|--config-env)\s+\S+|(?:--git-dir|--work-tree|--namespace)=\S+))*\s+(?:init|clone|add|pull|fetch|checkout|switch|commit|push|merge|rebase|cherry-pick|revert|restore|stash|tag|remote|worktree|submodule)\b/i, message: 'This changes a Git checkout, refs, or remote repository.' },
  { pattern: /(^|[;&|]\s*)(?:docker|podman)\s+(?:run|create|start|pull|build|exec|cp|rm|rmi|restart|stop|kill|compose\s+(?:up|down|restart|build|pull|run|exec|create|start|stop|kill|rm)|(?:network|volume)\s+(?:create|rm|connect|disconnect|prune)|(?:image|builder)\s+(?:rm|prune))\b/i, message: 'This changes container runtime state.' },
  { pattern: /(^|[;&|]\s*)kubectl\s+(?:apply|create|delete|edit|patch|replace|scale|set|rollout)\b/i, message: 'This changes cluster runtime state.' },
  { pattern: /(^|[;&|]\s*)(?:kill|killall|pkill)\b/i, message: 'This sends signals to running host processes.' },
  { pattern: /(^|[;&|]\s*)(?:chmod|chown|chgrp)\b/i, message: 'This changes host filesystem ownership or permissions.' },
  { pattern: /(^|[;&|]\s*)(?:npm|pnpm|yarn)\s+(?:install|ci|remove|uninstall|update|upgrade|link|unlink|publish)\b/i, message: 'This changes installed dependencies or publishes package state and can run lifecycle scripts.' },
  { pattern: /(^|[;&|]\s*)tailscale\s+(?:up|down|logout|serve|funnel)\b/i, message: 'This changes host network connectivity or exposure.' },
  { pattern: /(^|[;&|]\s*)(?:ufw|iptables|nft)\b/i, message: 'This can change host firewall policy and network exposure.' },
  { pattern: /(^|[;&|]\s*)openclaw\s+(?:config\s+(?:set|unset)|plugins?\s+(?:install|uninstall|enable|disable))\b/i, message: 'This changes OpenClaw configuration or installed plugins.' },
  { pattern: /(?:curl|wget)\b[^\n|]*(?:\||\>)[^\n]*(?:sh|bash)\b/i, message: 'This executes downloaded code directly on the host.' },
];

function tokenizeShellSegment(segment: string): string[] {
  return segment.match(/(?:[^\s"'\\]+|\\.|"(?:\\.|[^"\\])*"|'[^']*')+/g) || [];
}

function shellTokenValue(token: string): string {
  if (token.length >= 2 && ((token.startsWith('"') && token.endsWith('"')) || (token.startsWith("'") && token.endsWith("'")))) {
    return token.slice(1, -1);
  }
  return token.replace(/\\(.)/g, '$1');
}

function consumesFollowingWrapperArgument(option: string, wrapper: 'sudo' | 'doas' | 'env'): boolean {
  if (option.includes('=')) return false;
  if (wrapper === 'env') {
    return ['-u', '--unset', '-C', '--chdir', '-S', '--split-string', '--argv0'].includes(option);
  }
  if (wrapper === 'doas') return option === '-u';
  return ['-u', '--user', '-g', '--group', '-h', '--host', '-p', '--prompt', '-C', '--close-from', '-T', '--command-timeout', '-D', '--chdir'].includes(option);
}

function unwrapShellSegment(segment: string): string {
  const tokens = tokenizeShellSegment(segment);
  let index = 0;

  while (index < tokens.length) {
    const token = shellTokenValue(tokens[index]);
    if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(token)) {
      index += 1;
      continue;
    }

    if (token === 'sudo' || token === 'doas' || token === 'env') {
      const wrapper = token;
      index += 1;
      while (index < tokens.length) {
        const option = shellTokenValue(tokens[index]);
        if (option === '--') {
          index += 1;
          break;
        }
        if (wrapper === 'env' && /^[A-Za-z_][A-Za-z0-9_]*=/.test(option)) {
          index += 1;
          continue;
        }
        if (!option.startsWith('-') || option === '-') break;
        index += 1;
        if (consumesFollowingWrapperArgument(option, wrapper) && index < tokens.length) index += 1;
      }
      continue;
    }

    if (token === 'command') {
      const next = index + 1 < tokens.length ? shellTokenValue(tokens[index + 1]) : '';
      if (!next || (next.startsWith('-') && next !== '--')) break;
      index += next === '--' ? 2 : 1;
      continue;
    }
    break;
  }

  const remaining = tokens.slice(index).map(shellTokenValue);
  const executable = path.basename(remaining[0] || '');
  if (['bash', 'dash', 'ksh', 'sh', 'zsh'].includes(executable)) {
    const commandIndex = remaining.findIndex((token, tokenIndex) => tokenIndex > 0 && (token === '-c' || token === '--command'));
    if (commandIndex >= 0 && remaining[commandIndex + 1]) return remaining.slice(commandIndex + 1).join(' ');
  }
  if (executable === 'eval' && remaining[1]) return remaining.slice(1).join(' ');
  return remaining.join(' ');
}

export function unwrapTerminalCommand(command: string): string {
  return command
    .split(/(\s*(?:&&|\|\||[;|\n])\s*)/)
    .map((segment, index) => {
      if (index % 2 === 1) return segment.includes('\n') ? '; ' : segment;
      return unwrapShellSegment(segment);
    })
    .join('');
}

export function classifyTerminalCommand(command: string): {
  risk: TerminalActionRisk;
  confirmation: 'none' | 'explicit' | 'typed';
  message: string | null;
} {
  // Command substitutions and legacy backticks create nested execution
  // boundaries. Split those before unwrapping sudo/env/shell launchers so a
  // mutation hidden inside `echo $(sudo systemctl restart ...)` is classified.
  const normalized = unwrapTerminalCommand(
    command.trim().replace(/\$\(/g, '; ').replace(/`/g, '; '),
  );
  for (const rule of DESTRUCTIVE_PATTERNS) {
    if (rule.pattern.test(normalized)) return { risk: 'destructive', confirmation: 'typed', message: rule.message };
  }
  for (const rule of SERVICE_CHANGE_PATTERNS) {
    if (rule.pattern.test(normalized)) return { risk: 'service_change', confirmation: 'explicit', message: rule.message };
  }
  return { risk: 'read_only', confirmation: 'none', message: null };
}

export function parseToolHelpCommands(tool: string, rawOutput: string): string[] {
  const output = rawOutput.replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, '');
  const commands = new Set<string>();
  let inCommandsSection = false;
  for (const line of output.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (/^(commands?|available commands?|subcommands?|available subcommands?)\s*:?$/i.test(trimmed)) {
      inCommandsSection = true;
      continue;
    }
    if (inCommandsSection && /^(options?|flags?|arguments?|examples?|usage)\s*:?$/i.test(trimmed)) {
      inCommandsSection = false;
      continue;
    }
    if (!inCommandsSection || !/^\s{2,}\S/.test(line)) continue;
    const match = trimmed.match(/^([a-z][a-z0-9:_-]*)(?:[ ,]|\s{2,}|$)/i);
    if (!match || match[1].startsWith('-')) continue;
    const candidate = match[1].toLowerCase();
    if (['command', 'commands', 'help', 'usage', 'options', 'flags'].includes(candidate)) continue;
    commands.add(`${tool} ${match[1]}`);
    if (commands.size >= 30) break;
  }
  return [...commands];
}

export function rankTerminalSuggestions(
  query: string,
  tools: TerminalToolCapability[],
  executableNames: string[],
  limit = 20,
  actions: Array<TerminalAction | TerminalActionDefinition> = TERMINAL_ACTIONS,
): TerminalSuggestion[] {
  const normalized = query.trim().toLowerCase();
  const availableActions = actions.filter((action) => !('available' in action) || action.available);
  if (!normalized) return availableActions.slice(0, limit).map(actionToSuggestion);

  const candidates = new Map<string, TerminalSuggestion>();
  for (const action of availableActions) candidates.set(action.command, actionToSuggestion(action));
  for (const tool of tools.filter((entry) => entry.installed)) {
    candidates.set(tool.helpCommand, {
      command: tool.helpCommand,
      description: `${tool.label} help from the installed CLI`,
      category: tool.category,
      source: 'tool-help',
      risk: 'read_only',
      confirmation: 'none',
    });
    for (const command of tool.commands) {
      const classification = classifyTerminalCommand(command);
      candidates.set(command, {
        command,
        description: `Discovered from ${tool.label} --help`,
        category: tool.category,
        source: 'tool-help',
        risk: classification.risk,
        dangerous: classification.risk !== 'read_only',
        confirmation: classification.confirmation,
      });
    }
  }
  for (const executable of executableNames) {
    if (!candidates.has(executable)) {
      candidates.set(executable, {
        command: executable,
        description: 'Installed executable discovered in PATH',
        category: 'shell',
        source: 'path',
        risk: 'read_only',
        confirmation: 'none',
      });
    }
  }

  const words = normalized.split(/\s+/).filter(Boolean);
  return [...candidates.values()]
    .map((suggestion) => {
      const command = suggestion.command.toLowerCase();
      const haystack = `${command} ${suggestion.description.toLowerCase()} ${suggestion.category}`;
      let score = 0;
      const allWordsMatch = words.every((word) => haystack.includes(word));
      if (!command.startsWith(normalized) && !allWordsMatch) return { suggestion, score };
      if (command === normalized) score += 500;
      if (command.startsWith(normalized)) score += 300;
      if (suggestion.category.startsWith(normalized)) score += 80;
      for (const word of words) {
        if (command.startsWith(word)) score += 70;
        else if (command.includes(word)) score += 40;
        if (haystack.includes(word)) score += 15;
      }
      return { suggestion, score };
    })
    .filter((entry) => entry.score > 0)
    .sort((a, b) => b.score - a.score || a.suggestion.command.localeCompare(b.suggestion.command))
    .slice(0, Math.max(1, Math.min(50, limit)))
    .map((entry) => entry.suggestion);
}

function actionToSuggestion(action: TerminalAction | TerminalActionDefinition): TerminalSuggestion {
  return {
    command: action.command,
    description: action.description,
    category: action.category,
    source: 'action',
    risk: action.risk,
    dangerous: action.risk !== 'read_only',
    confirmation: action.confirmation,
  };
}

async function resolveExecutable(name: string, pathValue = process.env.PATH || DEFAULT_PATH): Promise<string | null> {
  if (!/^[a-z0-9._+-]+$/i.test(name)) return null;
  for (const directory of pathValue.split(path.delimiter).filter(Boolean)) {
    const candidate = path.join(directory, name);
    try {
      await access(candidate, 1);
      return candidate;
    } catch {
      // Continue searching PATH.
    }
  }
  return null;
}

async function readPathExecutables(): Promise<string[]> {
  const names = new Set<string>();
  const directories = (process.env.PATH || DEFAULT_PATH)
    .split(path.delimiter)
    .filter(Boolean);
  await Promise.all(directories.map(async (directory) => {
    try {
      const entries = await readdir(directory, { withFileTypes: true });
      await Promise.all(entries.map(async (entry) => {
        if (!(entry.isFile() || entry.isSymbolicLink()) || !/^[a-z0-9._+-]+$/i.test(entry.name)) return;
        try {
          await access(path.join(directory, entry.name), fsConstants.X_OK);
          names.add(entry.name);
        } catch {
          // PATH directories can also contain non-executable support files.
        }
      }));
    } catch {
      // PATH entries can disappear or be unreadable; omit them.
    }
  }));
  return [...names].sort().slice(0, 10_000);
}

export function parseSystemdServiceCapability(
  spec: { id: string; label: string; unit: string },
  output: string,
  detail?: string,
): TerminalServiceCapability {
  const values = new Map<string, string>();
  for (const line of output.split(/\r?\n/)) {
    const separator = line.indexOf('=');
    if (separator <= 0) continue;
    values.set(line.slice(0, separator).trim(), line.slice(separator + 1).trim());
  }
  const loadState = values.get('LoadState') || '';
  const activeState = values.get('ActiveState') || null;
  const subState = values.get('SubState') || null;
  const installed = Boolean(loadState && loadState !== 'not-found' && loadState !== 'masked');
  const status: TerminalServiceCapability['status'] = !installed
    ? 'not-installed'
    : activeState === 'active'
      ? 'active'
      : activeState === 'failed'
        ? 'failed'
        : activeState === 'activating'
          ? 'activating'
          : activeState === 'deactivating'
            ? 'deactivating'
            : activeState === 'inactive'
              ? 'inactive'
              : 'unknown';
  return {
    ...spec,
    installed,
    status,
    activeState,
    subState,
    ...(detail ? { detail: detail.slice(0, 240) } : {}),
  };
}

async function probeService(
  spec: TerminalServiceSpec,
  systemctlExecutable: string | null,
  probeEnv: NodeJS.ProcessEnv,
): Promise<TerminalServiceCapability> {
  if (!systemctlExecutable) {
    return {
      ...spec,
      installed: false,
      status: 'unknown',
      activeState: null,
      subState: null,
      detail: 'systemctl is unavailable',
    };
  }
  const args = [
    'show', spec.unit, '--no-page',
    '--property=LoadState', '--property=ActiveState', '--property=SubState',
  ];
  try {
    const result = await execFileAsync(systemctlExecutable, args, {
      cwd: probeEnv.HOME,
      timeout: PROBE_TIMEOUT_MS,
      maxBuffer: MAX_HELP_BYTES,
      env: probeEnv,
    });
    return parseSystemdServiceCapability(spec, String(result.stdout || ''));
  } catch (error: any) {
    const stdout = String(error?.stdout || '');
    if (stdout.includes('LoadState=')) return parseSystemdServiceCapability(spec, stdout);
    return {
      ...spec,
      installed: false,
      status: 'unknown',
      activeState: null,
      subState: null,
      detail: error?.killed ? 'Service probe timed out' : 'Service status unavailable',
    };
  }
}

export function resolveTerminalActions(
  definitions: TerminalActionDefinition[],
  tools: TerminalToolCapability[],
  services: TerminalServiceCapability[],
  executableNames: string[],
): TerminalAction[] {
  const available = new Set(executableNames);
  for (const tool of tools) {
    if (tool.installed) available.add(tool.id);
  }
  for (const service of services) {
    if (service.installed) available.add(`service:${service.id}`);
  }
  return definitions.map((definition) => {
    const unmetRequirements = definition.requirements.filter((requirement) => !available.has(requirement));
    return {
      ...definition,
      available: unmetRequirements.length === 0,
      unmetRequirements,
    };
  });
}

function compactProbeOutput(stdout: string, stderr: string): string | null {
  const firstLine = `${stdout || ''}\n${stderr || ''}`
    .replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, '')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find(Boolean);
  return firstLine ? firstLine.slice(0, 240) : null;
}

async function probeTool(spec: TerminalToolSpec, probeEnv: NodeJS.ProcessEnv): Promise<TerminalToolCapability> {
  const executable = await resolveExecutable(spec.id);
  const base: TerminalToolCapability = {
    id: spec.id,
    label: spec.label,
    category: spec.category,
    installed: Boolean(executable),
    executable,
    version: null,
    helpCommand: `${spec.id} --help`,
    sourceUrl: spec.sourceUrl,
    commands: [],
  };
  if (!executable) return base;

  const [versionResult, helpResult] = await Promise.allSettled([
    execFileAsync(executable, spec.versionArgs, { cwd: probeEnv.HOME, timeout: PROBE_TIMEOUT_MS, maxBuffer: MAX_HELP_BYTES, env: probeEnv }),
    execFileAsync(executable, spec.helpArgs, { cwd: probeEnv.HOME, timeout: PROBE_TIMEOUT_MS, maxBuffer: MAX_HELP_BYTES, env: probeEnv }),
  ]);
  if (versionResult.status === 'fulfilled') {
    base.version = compactProbeOutput(String(versionResult.value.stdout || ''), String(versionResult.value.stderr || ''));
  }
  if (helpResult.status === 'fulfilled') {
    base.commands = parseToolHelpCommands(spec.id, `${String(helpResult.value.stdout || '')}\n${String(helpResult.value.stderr || '')}`);
  }
  if (versionResult.status === 'rejected' || helpResult.status === 'rejected') {
    const failure: any = versionResult.status === 'rejected' ? versionResult.reason : helpResult.status === 'rejected' ? helpResult.reason : null;
    base.probeError = failure?.killed ? 'Probe timed out' : 'Installed; one runtime probe failed';
  }
  return base;
}

let cached: { expiresAt: number; capabilities: TerminalCapabilities; executableNames: string[] } | null = null;
let inFlight: Promise<{ capabilities: TerminalCapabilities; executableNames: string[] }> | null = null;

async function collectTerminalCapabilities(): Promise<{ capabilities: TerminalCapabilities; executableNames: string[] }> {
  const probeHome = await mkdtemp(path.join(tmpdir(), 'bridges-terminal-probe-'));
  try {
    const probeEnv = buildTerminalProbeEnv(probeHome);
    const [tools, executableNames] = await Promise.all([
      Promise.all(TOOL_SPECS.map((spec) => probeTool(spec, probeEnv))),
      readPathExecutables(),
    ]);
    const systemctlExecutable = tools.find((tool) => tool.id === 'systemctl')?.executable || null;
    const services = await Promise.all(SERVICE_SPECS.map((spec) => probeService(spec, systemctlExecutable, probeEnv)));
    const actions = resolveTerminalActions(TERMINAL_ACTIONS, tools, services, executableNames);
    const shellExecutable = tools.find((tool) => tool.id === 'bash')?.executable || '/bin/bash';
    return {
      capabilities: {
        generatedAt: new Date().toISOString(),
        scope: 'HOST_OPERATOR',
        notice: 'Owner and Sub-Admin Terminal sessions run on the host with full server access. Suggested actions are conveniences, not a complete shell command catalog.',
        tools,
        services,
        actions,
        shell: { name: 'bash', executable: shellExecutable, supportsRawInput: true, executableCount: executableNames.length },
      },
      executableNames,
    };
  } finally {
    await rm(probeHome, { recursive: true, force: true }).catch(() => undefined);
  }
}

export async function getTerminalCapabilities(forceRefresh = false): Promise<TerminalCapabilities> {
  const now = Date.now();
  if (!forceRefresh && cached && cached.expiresAt > now) return cached.capabilities;
  if (!inFlight) {
    inFlight = collectTerminalCapabilities().then((result) => {
      cached = { ...result, expiresAt: Date.now() + CAPABILITY_CACHE_MS };
      return result;
    }).finally(() => {
      inFlight = null;
    });
  }
  return (await inFlight).capabilities;
}

export async function getTerminalSuggestions(query: string, limit = 20): Promise<TerminalSuggestion[]> {
  await getTerminalCapabilities(false);
  return rankTerminalSuggestions(
    query,
    cached?.capabilities.tools || [],
    cached?.executableNames || [],
    limit,
    cached?.capabilities.actions || [],
  );
}

export function resetTerminalCapabilityCacheForTests(): void {
  cached = null;
  inFlight = null;
}
