export type ToolVisualKind =
  | 'read'
  | 'write'
  | 'edit'
  | 'exec'
  | 'process'
  | 'search'
  | 'fetch'
  | 'gateway'
  | 'memory'
  | 'message'
  | 'media'
  | 'voice'
  | 'session'
  | 'browser'
  | 'weather'
  | 'generic';

export interface ToolPresentation {
  key: ToolVisualKind;
  label: string;
  surfaceClass: string;
  iconBadgeClass: string;
  iconClass: string;
}

const TOOL_PRESENTATIONS: Record<ToolVisualKind, ToolPresentation> = {
  read: {
    key: 'read',
    label: 'Read',
    surfaceClass: 'bg-[rgba(59,130,246,0.08)] border-[rgba(59,130,246,0.18)] hover:bg-[rgba(59,130,246,0.12)]',
    iconBadgeClass: 'border-sky-400/20 bg-sky-400/10',
    iconClass: 'text-sky-300',
  },
  write: {
    key: 'write',
    label: 'Write',
    surfaceClass: 'bg-[rgba(16,185,129,0.08)] border-[rgba(16,185,129,0.18)] hover:bg-[rgba(16,185,129,0.12)]',
    iconBadgeClass: 'border-emerald-400/20 bg-emerald-400/10',
    iconClass: 'text-emerald-300',
  },
  edit: {
    key: 'edit',
    label: 'Edit',
    surfaceClass: 'bg-[rgba(245,158,11,0.08)] border-[rgba(245,158,11,0.18)] hover:bg-[rgba(245,158,11,0.12)]',
    iconBadgeClass: 'border-amber-400/20 bg-amber-400/10',
    iconClass: 'text-amber-300',
  },
  exec: {
    key: 'exec',
    label: 'Exec',
    surfaceClass: 'bg-[rgba(168,85,247,0.08)] border-[rgba(168,85,247,0.18)] hover:bg-[rgba(168,85,247,0.12)]',
    iconBadgeClass: 'border-violet-400/20 bg-violet-400/10',
    iconClass: 'text-violet-300',
  },
  process: {
    key: 'process',
    label: 'Process',
    surfaceClass: 'bg-[rgba(129,140,248,0.08)] border-[rgba(129,140,248,0.18)] hover:bg-[rgba(129,140,248,0.12)]',
    iconBadgeClass: 'border-indigo-400/20 bg-indigo-400/10',
    iconClass: 'text-indigo-300',
  },
  search: {
    key: 'search',
    label: 'Search',
    surfaceClass: 'bg-[rgba(34,211,238,0.08)] border-[rgba(34,211,238,0.18)] hover:bg-[rgba(34,211,238,0.12)]',
    iconBadgeClass: 'border-cyan-400/20 bg-cyan-400/10',
    iconClass: 'text-cyan-300',
  },
  fetch: {
    key: 'fetch',
    label: 'Fetch',
    surfaceClass: 'bg-[rgba(56,189,248,0.08)] border-[rgba(56,189,248,0.18)] hover:bg-[rgba(56,189,248,0.12)]',
    iconBadgeClass: 'border-sky-400/20 bg-sky-400/10',
    iconClass: 'text-sky-300',
  },
  gateway: {
    key: 'gateway',
    label: 'Gateway',
    surfaceClass: 'bg-[rgba(99,102,241,0.08)] border-[rgba(99,102,241,0.18)] hover:bg-[rgba(99,102,241,0.12)]',
    iconBadgeClass: 'border-indigo-400/20 bg-indigo-400/10',
    iconClass: 'text-indigo-300',
  },
  memory: {
    key: 'memory',
    label: 'Memory',
    surfaceClass: 'bg-[rgba(192,132,252,0.08)] border-[rgba(192,132,252,0.18)] hover:bg-[rgba(192,132,252,0.12)]',
    iconBadgeClass: 'border-fuchsia-400/20 bg-fuchsia-400/10',
    iconClass: 'text-fuchsia-300',
  },
  message: {
    key: 'message',
    label: 'Message',
    surfaceClass: 'bg-[rgba(244,114,182,0.08)] border-[rgba(244,114,182,0.18)] hover:bg-[rgba(244,114,182,0.12)]',
    iconBadgeClass: 'border-pink-400/20 bg-pink-400/10',
    iconClass: 'text-pink-300',
  },
  media: {
    key: 'media',
    label: 'Media',
    surfaceClass: 'bg-[rgba(236,72,153,0.08)] border-[rgba(236,72,153,0.18)] hover:bg-[rgba(236,72,153,0.12)]',
    iconBadgeClass: 'border-rose-400/20 bg-rose-400/10',
    iconClass: 'text-rose-300',
  },
  voice: {
    key: 'voice',
    label: 'Voice',
    surfaceClass: 'bg-[rgba(249,115,22,0.08)] border-[rgba(249,115,22,0.18)] hover:bg-[rgba(249,115,22,0.12)]',
    iconBadgeClass: 'border-orange-400/20 bg-orange-400/10',
    iconClass: 'text-orange-300',
  },
  session: {
    key: 'session',
    label: 'Agent',
    surfaceClass: 'bg-[rgba(20,184,166,0.08)] border-[rgba(20,184,166,0.18)] hover:bg-[rgba(20,184,166,0.12)]',
    iconBadgeClass: 'border-teal-400/20 bg-teal-400/10',
    iconClass: 'text-teal-300',
  },
  browser: {
    key: 'browser',
    label: 'Browser',
    surfaceClass: 'bg-[rgba(14,165,233,0.08)] border-[rgba(14,165,233,0.18)] hover:bg-[rgba(14,165,233,0.12)]',
    iconBadgeClass: 'border-sky-400/20 bg-sky-400/10',
    iconClass: 'text-sky-300',
  },
  weather: {
    key: 'weather',
    label: 'Weather',
    surfaceClass: 'bg-[rgba(250,204,21,0.08)] border-[rgba(250,204,21,0.18)] hover:bg-[rgba(250,204,21,0.12)]',
    iconBadgeClass: 'border-yellow-400/20 bg-yellow-400/10',
    iconClass: 'text-yellow-300',
  },
  generic: {
    key: 'generic',
    label: 'Tool',
    surfaceClass: 'bg-white/[0.04] border-white/[0.08] hover:bg-white/[0.07]',
    iconBadgeClass: 'border-white/[0.12] bg-white/[0.06]',
    iconClass: 'text-slate-300',
  },
};

function parseToolArgs(raw: unknown): Record<string, any> | undefined {
  if (!raw) return undefined;
  if (typeof raw === 'string') {
    const trimmed = raw.trim();
    if (!trimmed) return undefined;
    if ((trimmed.startsWith('{') && trimmed.endsWith('}')) || (trimmed.startsWith('[') && trimmed.endsWith(']'))) {
      try {
        const parsed = JSON.parse(trimmed);
        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed as Record<string, any>;
      } catch {
        return undefined;
      }
    }
    return undefined;
  }
  if (typeof raw === 'object' && !Array.isArray(raw)) {
    return raw as Record<string, any>;
  }
  return undefined;
}

function canonicalToolName(name: string): string {
  const trimmed = normalizeToolName(name).toLowerCase().replace(/-/g, '_');
  if (!trimmed) return 'tool';
  const parts = trimmed.split('.').filter(Boolean);
  return parts[parts.length - 1] || trimmed;
}

function humanizeCanonicalToolName(name: string): string {
  if (!name || name === 'tool') return 'tool';
  if (name === 'tts') return 'TTS';
  if (name === 'pdf') return 'PDF';
  return name.replace(/_/g, ' ');
}

export function getToolDisplayName(name: string): string {
  return humanizeCanonicalToolName(canonicalToolName(name));
}

export function isGenericToolStatusText(statusText?: string | null): boolean {
  const raw = typeof statusText === 'string' ? statusText.trim() : '';
  if (!raw) return true;
  return /^(using tool(?::)?(?:\s*(?:…|\.\.\.))?|tool call in progress\.?|tool in progress\.?|running tool\.?|working with tool\.?)$/i.test(raw);
}

export function getToolStatusText(name: string, statusText?: string | null): string {
  const raw = typeof statusText === 'string' ? statusText.trim() : '';
  if (!raw || isGenericToolStatusText(raw)) {
    return `Using ${getToolDisplayName(name)}…`;
  }
  return raw;
}

function shortPath(pathValue: unknown): string | null {
  if (typeof pathValue !== 'string' || !pathValue.trim()) return null;
  const parts = pathValue.split('/').filter(Boolean);
  if (parts.length === 0) return pathValue;
  return parts.slice(-2).join('/');
}

function getSearchQuery(args: Record<string, any> | undefined): string | null {
  if (!args) return null;
  const direct = args.query || args.q;
  if (typeof direct === 'string' && direct.trim()) return direct.trim();
  if (Array.isArray(args.search_query) && args.search_query[0] && typeof args.search_query[0].q === 'string') {
    return args.search_query[0].q;
  }
  return null;
}

export function normalizeToolName(raw: unknown): string {
  if (typeof raw !== 'string') return '';
  let text = raw.trim();
  if (!text) return '';
  text = text.split('\n')[0]?.trim() || '';
  text = text.replace(/^[^A-Za-z0-9_./-]+/, '');
  text = text.replace(/^using tool:\s*/i, '');
  text = text.replace(/^tool completed:\s*/i, '');
  text = text.replace(/^completed tool:\s*/i, '');
  text = text.replace(/^using\s+/i, '');
  text = text.replace(/^result:\s*/i, '');
  text = text.replace(/\s*\.\.\.$/, '');
  text = text.replace(/\s*…$/, '');
  return text.trim();
}

export function resolveToolName(...candidates: unknown[]): string {
  for (const candidate of candidates) {
    const normalized = normalizeToolName(candidate);
    if (normalized) return normalized;
  }
  return 'tool';
}

export function getToolPresentation(name: string): ToolPresentation {
  const canonical = canonicalToolName(name);

  if (canonical === 'read' || canonical === 'read_file') return TOOL_PRESENTATIONS.read;
  if (canonical === 'write' || canonical === 'write_file') return TOOL_PRESENTATIONS.write;
  if (canonical === 'edit' || canonical === 'edit_file' || canonical === 'patch' || canonical === 'apply_patch') return TOOL_PRESENTATIONS.edit;
  if (canonical === 'process') return TOOL_PRESENTATIONS.process;
  if (canonical === 'exec' || canonical === 'execute' || canonical === 'bash' || canonical === 'shell') return TOOL_PRESENTATIONS.exec;
  if (canonical === 'search' || canonical === 'web_search' || canonical === 'search_query' || canonical === 'image_query' || canonical === 'find' || canonical === 'finance' || canonical === 'sports' || canonical === 'time') return TOOL_PRESENTATIONS.search;
  if (canonical === 'web_fetch' || canonical === 'fetch' || canonical === 'open' || canonical === 'click' || canonical === 'screenshot') return TOOL_PRESENTATIONS.fetch;
  if (canonical === 'browser' || canonical === 'canvas' || canonical === 'nodes') return TOOL_PRESENTATIONS.browser;
  if (canonical === 'gateway' || canonical === 'cron') return TOOL_PRESENTATIONS.gateway;
  if (canonical === 'memory_search' || canonical === 'memory_get' || canonical === 'update_plan') return TOOL_PRESENTATIONS.memory;
  if (canonical === 'message') return TOOL_PRESENTATIONS.message;
  if (canonical === 'image' || canonical === 'image_generate' || canonical === 'video_generate' || canonical === 'music_generate' || canonical === 'pdf') return TOOL_PRESENTATIONS.media;
  if (canonical === 'tts' || canonical === 'voice_call') return TOOL_PRESENTATIONS.voice;
  if (
    canonical === 'sessions_spawn'
    || canonical === 'sessions_send'
    || canonical === 'sessions_history'
    || canonical === 'sessions_list'
    || canonical === 'sessions_yield'
    || canonical === 'subagents'
    || canonical === 'agents_list'
    || canonical === 'session_status'
    || canonical === 'parallel'
  ) return TOOL_PRESENTATIONS.session;
  if (canonical === 'weather') return TOOL_PRESENTATIONS.weather;

  return TOOL_PRESENTATIONS.generic;
}

export function getToolSummary(tool: { name: string; arguments?: unknown }): string {
  const rawName = resolveToolName(tool.name);
  const canonical = canonicalToolName(rawName);
  const args = parseToolArgs(tool.arguments);

  if (canonical === 'read' || canonical === 'read_file') {
    const short = shortPath(args?.path || args?.file_path || args?.filePath);
    return short ? `Read ${short}` : 'Read file';
  }

  if (canonical === 'write' || canonical === 'write_file') {
    const short = shortPath(args?.path || args?.file_path || args?.filePath);
    return short ? `Write ${short}` : 'Write file';
  }

  if (canonical === 'edit' || canonical === 'edit_file') {
    const short = shortPath(args?.path || args?.file_path || args?.filePath);
    return short ? `Edit ${short}` : 'Edit file';
  }

  if (canonical === 'apply_patch' || canonical === 'patch') {
    return 'Apply patch';
  }

  if (canonical === 'exec' || canonical === 'execute' || canonical === 'bash' || canonical === 'shell') {
    const command = args?.command || args?.cmd;
    if (typeof command === 'string' && command.trim()) {
      const short = command.trim().length > 60 ? `${command.trim().slice(0, 57)}…` : command.trim();
      return `Run ${short}`;
    }
    return 'Run command';
  }

  if (canonical === 'process') {
    const action = typeof args?.action === 'string' ? args.action : null;
    return action ? `Process ${action}` : 'Inspect process';
  }

  if (canonical === 'search' || canonical === 'web_search' || canonical === 'search_query' || canonical === 'image_query') {
    const query = getSearchQuery(args);
    return query ? `Search “${query.slice(0, 48)}${query.length > 48 ? '…' : ''}”` : 'Search web';
  }

  if (canonical === 'finance') {
    const ticker = typeof args?.ticker === 'string' ? args.ticker.trim() : '';
    return ticker ? `Quote ${ticker}` : 'Quote market';
  }

  if (canonical === 'sports') {
    const league = typeof args?.league === 'string' ? args.league.trim().toUpperCase() : '';
    const team = typeof args?.team === 'string' ? args.team.trim() : '';
    if (league && team) return `${league} ${team}`;
    if (league) return `${league} lookup`;
    return 'Check sports';
  }

  if (canonical === 'time') {
    const offset = typeof args?.utc_offset === 'string' ? args.utc_offset.trim() : '';
    return offset ? `Time ${offset}` : 'Check time';
  }

  if (canonical === 'web_fetch' || canonical === 'fetch') {
    const url = args?.url;
    if (typeof url === 'string' && url.trim()) {
      try {
        return `Fetch ${new URL(url).hostname}`;
      } catch {
        return 'Fetch URL';
      }
    }
    return 'Fetch URL';
  }

  if (canonical === 'open') return 'Open page';
  if (canonical === 'click') return 'Click page link';
  if (canonical === 'find') return 'Find on page';
  if (canonical === 'screenshot') return 'Capture screenshot';

  if (canonical === 'canvas') {
    const action = typeof args?.action === 'string' ? args.action : null;
    return action ? `Canvas ${action}` : 'Inspect canvas';
  }

  if (canonical === 'nodes') {
    const action = typeof args?.action === 'string' ? args.action : null;
    return action ? `Device ${action}` : 'Inspect device';
  }

  if (canonical === 'cron') {
    const action = typeof args?.action === 'string' ? args.action : null;
    return action ? `Schedule ${action}` : 'Schedule task';
  }

  if (canonical === 'gateway') {
    const action = typeof args?.action === 'string' ? args.action : null;
    const path = typeof args?.path === 'string' ? args.path : null;
    if (action && path) return `Gateway ${action} ${path}`;
    if (action) return `Gateway ${action}`;
    return 'Gateway action';
  }

  if (canonical === 'memory_search') {
    const query = getSearchQuery(args) || (typeof args?.query === 'string' ? args.query : null);
    return query ? `Search memory “${query.slice(0, 40)}${query.length > 40 ? '…' : ''}”` : 'Search memory';
  }

  if (canonical === 'memory_get') {
    const short = shortPath(args?.path || args?.file_path || args?.filePath);
    return short ? `Read memory ${short}` : 'Read memory';
  }

  if (canonical === 'update_plan') {
    const count = Array.isArray(args?.plan) ? args.plan.length : 0;
    return count > 0 ? `Update plan (${count} steps)` : 'Update plan';
  }

  if (canonical === 'message') {
    const action = typeof args?.action === 'string' ? args.action : null;
    return action ? `Message ${action}` : 'Send message';
  }

  if (canonical === 'image') return 'Analyze image';
  if (canonical === 'image_generate') return 'Generate image';
  if (canonical === 'video_generate') return 'Generate video';
  if (canonical === 'music_generate') return 'Generate audio';
  if (canonical === 'pdf') return 'Read PDF';
  if (canonical === 'tts') return 'Generate speech';
  if (canonical === 'voice_call') return 'Place voice call';

  if (canonical === 'sessions_spawn') {
    const agentId = typeof args?.agentId === 'string' ? args.agentId : null;
    return agentId ? `Spawn ${agentId}` : 'Spawn agent';
  }
  if (canonical === 'sessions_send') return 'Message agent';
  if (canonical === 'sessions_history') return 'Read agent history';
  if (canonical === 'sessions_list') return 'List sessions';
  if (canonical === 'agents_list') return 'List agents';
  if (canonical === 'session_status') return 'Check session status';
  if (canonical === 'subagents') return 'Manage agents';
  if (canonical === 'parallel') return 'Run tools in parallel';

  if (canonical === 'weather') {
    const location = typeof args?.location === 'string' ? args.location : null;
    return location ? `Weather ${location}` : 'Check weather';
  }

  const presentation = getToolPresentation(rawName);
  return presentation.label;
}

export function isCompactionNotice(content: string): boolean {
  return /\b(context compacted|compaction complete(?:d)?|compacting context|auto-compaction)\b/i.test(content || '');
}
