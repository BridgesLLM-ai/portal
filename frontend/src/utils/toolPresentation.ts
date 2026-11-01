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
  | 'widget'
  | 'progress'
  | 'question'
  | 'schedule'
  | 'goal'
  | 'dashboard'
  | 'weather'
  | 'bridgesllm'
  | 'generic';

export interface ToolPresentation {
  key: ToolVisualKind;
  label: string;
  surfaceClass: string;
  iconBadgeClass: string;
  iconClass: string;
}

const TOOL_PRESENTATIONS: Record<ToolVisualKind, ToolPresentation> = {
  bridgesllm: {
    key: 'bridgesllm',
    label: 'BridgesLLM',
    surfaceClass: 'bg-[rgba(16,185,129,0.08)] border-[rgba(16,185,129,0.22)] hover:bg-[rgba(16,185,129,0.14)]',
    iconBadgeClass: 'border-emerald-400/25 bg-emerald-400/10',
    iconClass: 'text-emerald-300',
  },
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
  widget: {
    key: 'widget', label: 'Widget',
    surfaceClass: 'bg-violet-400/[0.08] border-violet-400/20 hover:bg-violet-400/[0.14]',
    iconBadgeClass: 'border-violet-400/25 bg-violet-400/10',
    iconClass: 'text-violet-300',
  },
  progress: {
    key: 'progress', label: 'Progress',
    surfaceClass: 'bg-sky-400/[0.08] border-sky-400/20 hover:bg-sky-400/[0.14]',
    iconBadgeClass: 'border-sky-400/25 bg-sky-400/10',
    iconClass: 'text-sky-300',
  },
  question: {
    key: 'question', label: 'Question',
    surfaceClass: 'bg-amber-400/[0.08] border-amber-400/20 hover:bg-amber-400/[0.14]',
    iconBadgeClass: 'border-amber-400/25 bg-amber-400/10',
    iconClass: 'text-amber-300',
  },
  schedule: {
    key: 'schedule', label: 'Schedule',
    surfaceClass: 'bg-orange-400/[0.08] border-orange-400/20 hover:bg-orange-400/[0.14]',
    iconBadgeClass: 'border-orange-400/25 bg-orange-400/10',
    iconClass: 'text-orange-300',
  },
  goal: {
    key: 'goal', label: 'Goal',
    surfaceClass: 'bg-emerald-400/[0.08] border-emerald-400/20 hover:bg-emerald-400/[0.14]',
    iconBadgeClass: 'border-emerald-400/25 bg-emerald-400/10',
    iconClass: 'text-emerald-300',
  },
  dashboard: {
    key: 'dashboard', label: 'Dashboard',
    surfaceClass: 'bg-indigo-400/[0.08] border-indigo-400/20 hover:bg-indigo-400/[0.14]',
    iconBadgeClass: 'border-indigo-400/25 bg-indigo-400/10',
    iconClass: 'text-indigo-300',
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

export function canonicalToolName(name: string): string {
  let text = normalizeToolName(name).slice(0, 400);
  // Tool identity is unchanged upstream. Unwrap transport namespaces only for
  // presentation: MCP aliases (mcp__<server>__<tool>), dotted/colon prefixes
  // (functions.read, openclaw:show_widget) and tools.<plugin>__<tool>.
  text = text.split(/[.:]/).filter(Boolean).pop() || text;
  text = text.split('__').filter(Boolean).pop() || text;
  // Direct-harness tools use CamelCase (WebFetch, TaskUpdate, TodoWrite…);
  // fold them onto the snake_case names the mapping already knows.
  return text.replace(/([a-z0-9])([A-Z])/g, '$1_$2')
    .replace(/[-\s]+/g, '_').toLowerCase() || 'tool';
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

/** Presentation only: branding is never an authorization or trust signal. */
export function isBridgesLLMTool(name: string, toolArguments?: unknown): boolean {
  const branded = (value: unknown) => typeof value === 'string'
    && value.length <= 2048
    && /(?:^|[.:/_-])bridgesllm(?:$|[.:/_-])/i.test(value);
  if (branded(normalizeToolName(name))) return true;
  const canonical = canonicalToolName(name).split('__').pop() || '';
  const isSkill = ['skill', 'slash_command', 'skill_workshop', 'skills', 'skills_read', 'skills_load'].includes(canonical)
    || /(?:^|[.:])skills[.:](?:read|load)$/.test(name);
  const isRead = ['read', 'read_file', 'view_file'].includes(canonical);
  if (!isSkill && !isRead) return false;
  let args = toolArguments;
  if (typeof args === 'string' && args.length <= 65536) {
    try { args = JSON.parse(args); } catch { return false; }
  }
  if (!args || typeof args !== 'object' || Array.isArray(args)) return false;
  const record = args as Record<string, unknown>;
  if (isSkill && ['skill', 'skillName', 'skill_name', 'skillId', 'skill_id', 'name', 'package', 'packageId', 'package_id', 'resource']
    .some((key) => branded(record[key]))) return true;
  // Reading the bundled guide is how file-based harnesses invoke skills.
  return ['path', 'file_path', 'filePath', 'resource'].some((key) => {
    const value = record[key];
    return typeof value === 'string' && value.length <= 2048
      && /(?:^|\/)(?:skills|workshop-skills|plugin-skills)\/bridgesllm(?:[-_][a-z0-9_-]+)?\/(?:SKILL\.md|references\/[a-z0-9_./-]+\.md)$/i.test(value);
  });
}

export function getToolPresentation(name: string, toolArguments?: unknown): ToolPresentation {
  if (isBridgesLLMTool(name, toolArguments)) return TOOL_PRESENTATIONS.bridgesllm;
  const canonical = canonicalToolName(name);

  if (['show_widget', 'canvas'].includes(canonical)) return TOOL_PRESENTATIONS.widget;
  if (['progress_card', 'update_plan', 'todo_write', 'write_todos', 'task_create', 'task_update', 'task_get', 'task_list', 'enter_plan_mode', 'exit_plan_mode'].includes(canonical)) return TOOL_PRESENTATIONS.progress;
  if (['ask_user', 'ask_user_question', 'request_user_input', 'request_user_input_async'].includes(canonical)) return TOOL_PRESENTATIONS.question;
  if (['automations', 'cron'].includes(canonical)) return TOOL_PRESENTATIONS.schedule;
  if (['create_goal', 'update_goal', 'get_goal', 'set_goal', 'goal'].includes(canonical)) return TOOL_PRESENTATIONS.goal;
  if (['dashboard', 'show_dashboard'].includes(canonical)) return TOOL_PRESENTATIONS.dashboard;
  if (canonical.startsWith('browser_') || ['computer', 'screen', 'mobile_ui'].includes(canonical)) return TOOL_PRESENTATIONS.browser;
  if (canonical === 'read' || canonical === 'read_file' || canonical === 'ls' || canonical === 'list_directory' || canonical === 'read_many_files' || canonical === 'notebook_read'
    || canonical === 'view_file' || canonical === 'list_dir') return TOOL_PRESENTATIONS.read;
  if (canonical === 'write' || canonical === 'write_file' || canonical === 'write_to_file') return TOOL_PRESENTATIONS.write;
  if (canonical === 'edit' || canonical === 'edit_file' || canonical === 'patch' || canonical === 'apply_patch' || canonical === 'replace' || canonical === 'multi_edit' || canonical === 'notebook_edit'
    || canonical === 'file_change' || canonical === 'replace_file_content' || canonical === 'multi_replace_file_content') return TOOL_PRESENTATIONS.edit;
  if (canonical === 'process' || canonical === 'bash_output' || canonical === 'task_output' || canonical === 'kill_shell' || canonical === 'task_stop') return TOOL_PRESENTATIONS.process;
  if (canonical === 'terminal' || canonical === 'exec_command' || canonical === 'exec' || canonical === 'execute' || canonical === 'bash' || canonical === 'shell' || canonical === 'run_shell_command' || canonical === 'run_command' || canonical === 'skill' || canonical === 'slash_command') return TOOL_PRESENTATIONS.exec;
  if (canonical === 'search' || canonical === 'web_search' || canonical === 'search_query' || canonical === 'image_query' || canonical === 'find' || canonical === 'finance' || canonical === 'sports' || canonical === 'time' || canonical === 'grep_search' || canonical === 'glob' || canonical === 'grep' || canonical === 'search_file_content' || canonical === 'google_web_search' || canonical === 'tool_search' || canonical === 'tool_describe'
    || canonical === 'find_by_name' || canonical === 'search_web' || canonical === 'codebase_search') return TOOL_PRESENTATIONS.search;
  if (canonical === 'web_fetch' || canonical === 'fetch' || canonical === 'open' || canonical === 'click' || canonical === 'screenshot' || canonical === 'read_url_content') return TOOL_PRESENTATIONS.fetch;
  if (canonical === 'browser' || canonical === 'canvas' || canonical === 'nodes') return TOOL_PRESENTATIONS.browser;
  if (canonical === 'gateway' || canonical === 'cron') return TOOL_PRESENTATIONS.gateway;
  if (
    canonical === 'memory_search'
    || canonical === 'memory_get'
    || canonical === 'save_memory'
    || canonical === 'update_plan'
    || canonical === 'todo_write'
    || canonical === 'write_todos'
    || canonical === 'task_create'
    || canonical === 'task_update'
    || canonical === 'task_get'
    || canonical === 'task_list'
    || canonical === 'enter_plan_mode'
    || canonical === 'exit_plan_mode'
  ) return TOOL_PRESENTATIONS.memory;
  if (
    canonical === 'message'
    || canonical === 'send_message'
    || canonical === 'push_notification'
    || canonical === 'ask_user_question'
    || canonical === 'ask_user'
    || canonical === 'request_user_input'
  ) return TOOL_PRESENTATIONS.message;
  if (canonical === 'image' || canonical === 'image_generate' || canonical === 'video_generate' || canonical === 'music_generate' || canonical === 'pdf' || canonical === 'view_image') return TOOL_PRESENTATIONS.media;
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
    || ['sessions', 'agents_wait', 'spawn_agent', 'wait_agent', 'send_input', 'resume_agent', 'close_agent'].includes(canonical)
    || canonical === 'parallel'
    || canonical === 'task'
    || canonical === 'agent'
  ) return TOOL_PRESENTATIONS.session;
  if (canonical === 'weather') return TOOL_PRESENTATIONS.weather;

  return TOOL_PRESENTATIONS.generic;
}

export function getToolSummary(tool: { name: string; arguments?: unknown }): string {
  const rawName = resolveToolName(tool.name);
  const canonical = canonicalToolName(rawName);
  const args = parseToolArgs(tool.arguments);

  if (canonical === 'read' || canonical === 'read_file' || canonical === 'notebook_read') {
    const short = shortPath(args?.path || args?.file_path || args?.filePath || args?.notebook_path);
    return short ? `Read ${short}` : 'Read file';
  }

  if (canonical === 'read_many_files') {
    const count = Array.isArray(args?.paths) ? args.paths.length : 0;
    return count > 0 ? `Read ${count} files` : 'Read files';
  }

  if (canonical === 'list_directory') {
    const short = shortPath(args?.dir_path || args?.path || args?.directory);
    return short ? `List ${short}` : 'List directory';
  }

  if (canonical === 'write' || canonical === 'write_file') {
    const short = shortPath(args?.path || args?.file_path || args?.filePath);
    return short ? `Write ${short}` : 'Write file';
  }

  if (canonical === 'edit' || canonical === 'edit_file' || canonical === 'multi_edit' || canonical === 'notebook_edit') {
    const short = shortPath(args?.path || args?.file_path || args?.filePath || args?.notebook_path);
    return short ? `Edit ${short}` : 'Edit file';
  }

  if (canonical === 'replace') {
    const short = shortPath(args?.file_path || args?.path || args?.filePath);
    return short ? `Replace in ${short}` : 'Replace text';
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

  if (canonical === 'run_shell_command') {
    const command = args?.command || args?.cmd;
    if (typeof command === 'string' && command.trim()) {
      const short = command.trim().length > 60 ? `${command.trim().slice(0, 57)}…` : command.trim();
      return `Run ${short}`;
    }
    return 'Run shell command';
  }

  if (canonical === 'process') {
    const action = typeof args?.action === 'string' ? args.action : null;
    return action ? `Process ${action}` : 'Inspect process';
  }

  if (canonical === 'search' || canonical === 'web_search' || canonical === 'search_query' || canonical === 'image_query') {
    const query = getSearchQuery(args);
    return query ? `Search “${query.slice(0, 48)}${query.length > 48 ? '…' : ''}”` : 'Search web';
  }

  if (canonical === 'grep_search') {
    const query = typeof args?.query === 'string' ? args.query.trim() : '';
    return query ? `Search “${query.slice(0, 48)}${query.length > 48 ? '…' : ''}”` : 'Search files';
  }

  if (canonical === 'glob') {
    const pattern = typeof args?.pattern === 'string' ? args.pattern.trim() : '';
    return pattern ? `Match ${pattern}` : 'Match files';
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

  const isProgressCard = canonical === 'progress_card' || canonical.endsWith('__progress_card');
  if (isProgressCard && !Array.isArray(args?.plan)) return 'Update progress';

  if (canonical === 'update_plan' || isProgressCard) {
    const count = Array.isArray(args?.plan) ? args.plan.length : 0;
    return count > 0 ? `Update plan (${count} steps)` : 'Update plan';
  }

  if (canonical === 'todo_write') {
    const count = Array.isArray(args?.todos) ? args.todos.length : 0;
    return count > 0 ? `Update to-dos (${count})` : 'Update to-dos';
  }

  if (canonical === 'task_create') return 'Create task';
  if (canonical === 'task_update') return 'Update task';
  if (canonical === 'task_get' || canonical === 'task_list') return 'Check tasks';
  if (canonical === 'task_output') return 'Check task output';
  if (canonical === 'task_stop') return 'Stop task';
  if (canonical === 'bash_output') return 'Check command output';
  if (canonical === 'kill_shell') return 'Stop command';
  if (canonical === 'enter_plan_mode') return 'Start planning';
  if (canonical === 'exit_plan_mode') return 'Present plan';
  if (canonical === 'save_memory') return 'Save memory';
  if (
    canonical === 'ask_user_question'
    || canonical === 'ask_user'
    || canonical === 'request_user_input'
    || canonical === 'request_user_input_async'
  ) return 'Ask a question';
  if (canonical === 'send_message') return 'Message agent';
  if (canonical === 'push_notification') return 'Send notification';
  if (canonical === 'view_image') return 'View image';

  if (canonical === 'skill') {
    const skillName = typeof args?.skill === 'string' ? args.skill.trim() : '';
    return skillName ? `Skill ${skillName}` : 'Run skill';
  }

  if (canonical === 'slash_command') {
    const command = typeof args?.command === 'string' ? args.command.trim() : '';
    return command ? `Run ${command.slice(0, 48)}` : 'Run command';
  }

  if (canonical === 'tool_search') {
    const query = typeof args?.query === 'string' ? args.query.trim() : '';
    return query ? `Find tools “${query.slice(0, 40)}${query.length > 40 ? '…' : ''}”` : 'Find tools';
  }

  if (canonical === 'task' || canonical === 'agent') {
    const kind = typeof args?.subagent_type === 'string' ? args.subagent_type.trim() : '';
    const description = typeof args?.description === 'string' ? args.description.trim() : '';
    if (kind) return `Agent ${kind}`;
    return description ? `Agent: ${description.slice(0, 44)}${description.length > 44 ? '…' : ''}` : 'Run agent';
  }

  if (canonical === 'search_file_content' || canonical === 'grep') {
    const query = typeof args?.pattern === 'string' ? args.pattern.trim() : (typeof args?.query === 'string' ? args.query.trim() : '');
    return query ? `Search “${query.slice(0, 48)}${query.length > 48 ? '…' : ''}”` : 'Search files';
  }

  if (canonical === 'google_web_search') {
    const query = getSearchQuery(args);
    return query ? `Search “${query.slice(0, 48)}${query.length > 48 ? '…' : ''}”` : 'Search web';
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

  if (canonical === 'show_widget') return typeof args?.title === 'string' ? `Show ${args.title.slice(0, 80)}` : 'Show interactive widget';
  if (canonical === 'dashboard') return 'Update dashboard';
  if (canonical === 'automations') return 'Manage automations';

  if (canonical === 'weather') {
    const location = typeof args?.location === 'string' ? args.location : null;
    return location ? `Weather ${location}` : 'Check weather';
  }

  const presentation = getToolPresentation(rawName);
  return presentation.label;
}

export function isCompactionNotice(content: string): boolean {
  const normalized = String(content || '').replace(/\s+/g, ' ').trim();
  if (!normalized) return false;

  const marker = normalized.replace(/^[^\p{L}\p{N}]+/u, '').trim();
  return [
    /^context compacted\.?$/i,
    /^context maintenance (?:in progress|finished|complete(?:d)?)\.?$/i,
    /^compacting context[.…]*$/i,
    /^preparing (?:context maintenance|compaction)[.…]*$/i,
    /^auto-compaction(?: started| in progress| complete(?:d)?)?[.…]*$/i,
    /^context compaction(?: started| in progress| complete(?:d)?)?[.…]*$/i,
    /^memory flush(?: started| complete(?:d)?| in progress)?[.…]*$/i,
    /^heartbeat check (?:started|complete(?:d)?)[.…]*$/i,
    /^compacted\s*\([^)]{1,80}\)(?:\s*[•-]\s*context\b.*)?$/i,
    /^compaction (?:complete(?:d)?|finished|in progress|started|incomplete|did not complete)\.?$/i,
    /^compaction skipped(?::.*)?$/i,
  ].some((pattern) => pattern.test(marker));
}

/**
 * The ask-question tool is the only tool the user is expected to act on, so
 * both chat surfaces render it as an answer card rather than an inert pill.
 * Matched on the canonical name so provider-specific prefixes still resolve.
 */
export function isAskQuestionTool(toolName: unknown): boolean {
  if (typeof toolName !== 'string') return false;
  const canonical = canonicalToolName(toolName);
  return canonical === 'ask_user_question'
    || canonical === 'ask_user'
    || canonical === 'request_user_input'
    || canonical === 'request_user_input_async';
}
