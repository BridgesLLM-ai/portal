/**
 * Tool card registry: canonical tool names, aliases and one guarded model
 * builder per tool family. `buildToolCardModel` never throws; anything it
 * cannot read becomes the generic card, which still shows the tool's name.
 */

import { isBridgesLLMTool, normalizeToolName } from '../../../utils/toolPresentation';
import {
  displayBlock,
  displayText,
  formatBytes,
  isSecretKey,
  REDACTED,
  safeLink,
  shortPath,
  summarizeValue,
  utf8Length,
} from './safeDisplay';
import type {
  ToolCardArgsState,
  ToolCardChip,
  ToolCardDiffLineKind,
  ToolCardField,
  ToolCardInput,
  ToolCardKind,
  ToolCardLink,
  ToolCardModel,
  ToolCardNestedRef,
  ToolCardSection,
  ToolCardStatus,
  ToolCardStepStatus,
  ToolCardTone,
} from './toolCardModel';

type Args = Record<string, unknown>;

const MAX_NESTED_DEPTH = 2;
const MAX_NESTED_CARDS = 10;
const MAX_FIELDS = 12;
const MAX_STEPS = 50;
const MAX_LINKS = 8;
const MAX_REFS = 12;
const MAX_DIFF_LINES = 80;
const MAX_JSON_PARSE_CHARS = 512 * 1024;

/* ─── Names ──────────────────────────────────────────────────────────────── */

export interface ParsedToolName {
  /** Display-bounded raw name (control characters removed). */
  raw: string;
  /** snake_case base name without namespaces; 'tool' when nothing usable. */
  canonical: string;
  /** Namespace the name arrived under, e.g. 'mcp:github', 'openclaw', 'functions'. */
  namespace: string | null;
}

/**
 * Canonicalize the tool names the chat surfaces see: OpenClaw (`exec`),
 * function-call prefixes (`functions.exec`, `default_api:exec`), Codex code
 * mode (`tools.openclaw__sessions_send`), MCP (`mcp__server__tool`,
 * `MCP.server.tool`), plugin namespaces (`openclaw_direct__exec`) and
 * CamelCase harness tools (`WebFetch`, `TodoWrite`).
 */
export function parseToolName(input: unknown): ParsedToolName {
  const raw = displayText(typeof input === 'string' ? input : '', 160);
  let text = normalizeToolName(typeof input === 'string' ? input.slice(0, 400) : '');
  let namespace: string | null = null;

  const colon = /^([A-Za-z0-9_.-]+):([A-Za-z0-9_.$-]+)$/.exec(text);
  if (colon) {
    namespace = colon[1];
    text = colon[2];
  }

  if (text.includes('.')) {
    const parts = text.split('.').filter(Boolean);
    const last = parts.pop();
    if (last) {
      if (parts[0] === 'MCP' && parts.length >= 2) {
        namespace = `mcp:${parts.slice(1).join('.')}`;
      } else if (parts.length > 0 && !namespace) {
        namespace = parts.join('.');
      }
      text = last;
    }
  }

  const mcp = /^mcp__(.+?)__(.+)$/.exec(text);
  if (mcp) {
    namespace = `mcp:${mcp[1]}`;
    text = mcp[2];
  } else {
    const plugin = /^([A-Za-z0-9-]+(?:_[A-Za-z0-9-]+)*)__([A-Za-z0-9].*)$/.exec(text);
    if (plugin) {
      namespace = plugin[1];
      text = plugin[2];
    }
  }

  const canonical = text
    .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
    .replace(/[-\s]+/g, '_')
    .toLowerCase()
    .replace(/[^a-z0-9_]/g, '')
    .replace(/_+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 80);

  return {
    raw: raw || 'tool',
    canonical: canonical || 'tool',
    namespace: namespace ? displayText(namespace, 60) || null : null,
  };
}

const KIND_BY_NAME: Readonly<Record<string, ToolCardKind>> = {
  exec: 'shell',
  execute: 'shell',
  bash: 'shell',
  shell: 'shell',
  shell_command: 'shell',
  local_shell: 'shell',
  exec_command: 'shell',
  run_shell_command: 'shell',
  run_command: 'shell',
  // Antigravity (Cascade-style) tool names.
  command_status: 'process',
  send_command_input: 'process',
  read_terminal: 'process',
  terminal: 'shell',
  powershell: 'shell',
  container_exec: 'shell',
  code: 'code',
  code_execution: 'code',
  execute_code: 'code',
  run_code: 'code',
  python: 'code',
  process: 'process',
  bash_output: 'process',
  task_output: 'process',
  kill_shell: 'process',
  kill_bash: 'process',
  task_stop: 'process',
  write_stdin: 'process',
  read: 'read',
  read_file: 'read',
  view_file: 'read',
  list_directory: 'read',
  list_dir: 'read',
  ls: 'read',
  read_many_files: 'read',
  view_code_item: 'read',
  view_file_outline: 'read',
  notebook_read: 'read',
  memory_get: 'read',
  write: 'write',
  write_file: 'write',
  create_file: 'write',
  write_to_file: 'write',
  edit: 'edit',
  edit_file: 'edit',
  str_replace: 'edit',
  replace: 'edit',
  multi_edit: 'edit',
  notebook_edit: 'edit',
  search_replace: 'edit',
  str_replace_editor: 'edit',
  str_replace_based_edit_tool: 'edit',
  text_editor: 'edit',
  replace_file_content: 'edit',
  multi_replace_file_content: 'edit',
  apply_patch: 'patch',
  patch: 'patch',
  apply_diff: 'patch',
  // Codex exec `file_change` items and ACP `delete` / `move` tool kinds.
  file_change: 'patch',
  delete: 'patch',
  move: 'patch',
  search: 'search',
  search_query: 'search',
  image_query: 'search',
  grep: 'search',
  glob: 'search',
  find: 'search',
  search_file_content: 'search',
  find_files: 'search',
  find_by_name: 'search',
  search_web: 'search',
  web_fetch: 'web',
  fetch: 'web',
  fetch_url: 'web',
  open: 'web',
  open_url: 'web',
  click: 'web',
  scrape: 'web',
  firecrawl_scrape: 'web',
  read_url_content: 'web',
  browser: 'browser',
  screenshot: 'browser',
  progress_card: 'progress',
  update_plan: 'progress',
  todo_write: 'progress',
  write_todos: 'progress',
  task_create: 'progress',
  task_update: 'progress',
  task_get: 'progress',
  task_list: 'progress',
  create_goal: 'goal',
  update_goal: 'goal',
  get_goal: 'goal',
  set_goal: 'goal',
  goal: 'goal',
  sessions_spawn: 'session',
  sessions_send: 'session',
  sessions_yield: 'session',
  sessions_history: 'session',
  sessions_list: 'session',
  session_status: 'session',
  subagents: 'session',
  agents_list: 'session',
  agents_wait: 'session',
  agent: 'session',
  task: 'session',
  spawn_agent: 'session',
  send_input: 'session',
  wait_agent: 'session',
  close_agent: 'session',
  resume_agent: 'session',
  image_generate: 'media',
  video_generate: 'media',
  music_generate: 'media',
  generate_image: 'media',
  image_edit: 'media',
  tts: 'media',
  image: 'media',
  view_image: 'media',
  pdf: 'media',
  ask_user: 'question',
  ask_user_question: 'question',
  request_user_input: 'question',
  request_user_input_async: 'question',
  parallel: 'parallel',
};

/** Card family for a canonical name (exact aliases first, then name patterns). */
export function resolveToolCardKind(canonical: string): ToolCardKind {
  const exact = KIND_BY_NAME[canonical];
  if (exact) return exact;
  if (canonical.endsWith('_search')) return 'search';
  if (canonical.startsWith('browser_')) return 'browser';
  return 'generic';
}

function humanize(canonical: string): string {
  if (!canonical || canonical === 'tool') return 'Tool';
  if (canonical === 'tts') return 'TTS';
  if (canonical === 'pdf') return 'PDF';
  const words = canonical.replace(/_/g, ' ').trim();
  return words.charAt(0).toUpperCase() + words.slice(1);
}

/* ─── Argument and result parsing ────────────────────────────────────────── */

interface ParsedArgs {
  state: ToolCardArgsState;
  args: Args;
  text: string | null;
}

function isRecord(value: unknown): value is Args {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

export function parseToolArguments(raw: unknown, status: ToolCardStatus): ParsedArgs {
  if (raw === undefined || raw === null || raw === '') return { state: 'none', args: {}, text: null };
  if (isRecord(raw)) return { state: 'object', args: raw, text: null };
  if (typeof raw === 'string') {
    const trimmed = raw.trim();
    if (!trimmed) return { state: 'none', args: {}, text: null };
    if (trimmed.startsWith('{')) {
      if (trimmed.length <= MAX_JSON_PARSE_CHARS) {
        try {
          const parsed: unknown = JSON.parse(trimmed);
          if (isRecord(parsed)) return { state: 'object', args: parsed, text: null };
        } catch {
          // fall through: a streaming call is still assembling its JSON.
        }
      }
      return { state: status === 'running' ? 'partial' : 'malformed', args: {}, text: raw };
    }
    if (trimmed.startsWith('[')) return { state: 'malformed', args: {}, text: raw };
    // Freeform tools (Codex apply_patch / code-mode exec) send plain text.
    return { state: 'text', args: {}, text: raw };
  }
  return { state: 'malformed', args: {}, text: null };
}

function parseJson(text: unknown): unknown {
  if (typeof text !== 'string') return undefined;
  const trimmed = text.trim();
  if (!trimmed || trimmed.length > MAX_JSON_PARSE_CHARS) return undefined;
  if (!trimmed.startsWith('{') && !trimmed.startsWith('[')) return undefined;
  try {
    return JSON.parse(trimmed) as unknown;
  } catch {
    return undefined;
  }
}

function str(args: Args, ...keys: string[]): string | null {
  for (const key of keys) {
    const value = args[key];
    if (typeof value === 'string' && value.trim()) return value;
  }
  return null;
}

function num(args: Args, ...keys: string[]): number | null {
  for (const key of keys) {
    const value = args[key];
    if (typeof value === 'number' && Number.isFinite(value)) return value;
    if (typeof value === 'string' && value.trim() && Number.isFinite(Number(value))) return Number(value);
  }
  return null;
}

function bool(args: Args, key: string): boolean {
  return args[key] === true;
}

function arr(args: Args, key: string): unknown[] | null {
  const value = args[key];
  return Array.isArray(value) ? value : null;
}

/* ─── Section helpers ────────────────────────────────────────────────────── */

function chip(label: string, tone: ToolCardTone = 'neutral'): ToolCardChip {
  return { label: displayText(label, 40), tone };
}

function codeSection(label: string, value: unknown, maxChars = 4000, maxLines = 60): ToolCardSection | null {
  const block = displayBlock(value, maxChars, maxLines);
  return block.text ? { type: 'code', label, text: block.text, truncated: block.truncated } : null;
}

function textSection(label: string, value: unknown, maxChars = 1500, maxLines = 30): ToolCardSection | null {
  const block = displayBlock(value, maxChars, maxLines);
  return block.text ? { type: 'text', label, text: block.text, truncated: block.truncated } : null;
}

function fieldsSection(rows: Array<ToolCardField | null>, label?: string): ToolCardSection | null {
  const present = rows.filter((row): row is ToolCardField => Boolean(row && row.value));
  if (present.length === 0) return null;
  return {
    type: 'fields',
    ...(label ? { label } : {}),
    rows: present.slice(0, MAX_FIELDS),
    truncated: present.length > MAX_FIELDS,
  };
}

function field(label: string, value: unknown, mono = false): ToolCardField | null {
  if (isSecretKey(label)) return value === undefined || value === null || value === '' ? null : { label, value: REDACTED, redacted: true };
  const text = typeof value === 'string' ? displayText(value, 300) : summarizeValue(value);
  return text ? { label, value: text, ...(mono ? { mono: true } : {}) } : null;
}

/** Top-level argument table for keys not already shown; secret keys are masked. */
function argumentFields(args: Args, omit: readonly string[] = []): ToolCardSection | null {
  const skip = new Set(omit);
  const rows: ToolCardField[] = [];
  let keys: string[] = [];
  try {
    keys = Object.keys(args);
  } catch {
    return null;
  }
  for (const key of keys) {
    if (skip.has(key)) continue;
    const label = displayText(key, 40);
    if (!label) continue;
    const value = args[key];
    if (isSecretKey(key)) {
      if (value !== undefined && value !== null && value !== '') rows.push({ label, value: REDACTED, redacted: true });
      continue;
    }
    const text = summarizeValue(value);
    if (text) rows.push({ label, value: text });
  }
  if (rows.length === 0) return null;
  return { type: 'fields', label: 'Arguments', rows: rows.slice(0, MAX_FIELDS), truncated: rows.length > MAX_FIELDS };
}

function linkFrom(value: unknown, title?: unknown, snippet?: unknown): ToolCardLink | null {
  const link = safeLink(value);
  if (!link) return null;
  const titleText = displayText(title, 120);
  const snippetText = displayText(snippet, 200);
  return {
    title: titleText || link.host || link.label,
    href: link.href,
    host: link.host,
    ...(snippetText ? { snippet: snippetText } : {}),
  };
}

function shorten(value: string, max = 60): string {
  return displayText(value, max);
}

/* ─── Family builders ────────────────────────────────────────────────────── */

interface BuildContext {
  tool: ToolCardInput;
  name: ParsedToolName;
  parsed: ParsedArgs;
  depth: number;
}

interface BuiltCard {
  kind?: ToolCardKind;
  title: string;
  subtitle?: string | null;
  chips?: ToolCardChip[];
  sections?: Array<ToolCardSection | null>;
  /** Label for the result section; null when the builder rendered the result itself. */
  resultLabel?: string | null;
}

const JS_NON_TOOL_CALLS = new Set([
  'Promise', 'JSON', 'Math', 'Object', 'Array', 'String', 'Number', 'Boolean', 'Date', 'Symbol', 'Reflect',
  'Error', 'console', 'setTimeout', 'sleep', 'text', 'image', 'results', 'catalog', 'nodes', 'skills',
  'namespaces', 'API', 'MCP', 'fetch', 'require', 'import', 'tool', 'search', 'describe', 'node', 'wait',
]);

/** Display-only list of tool references in a code-mode cell. Nothing is executed. */
export function extractNestedToolRefs(code: string): { items: ToolCardNestedRef[]; truncated: boolean } {
  const source = code.slice(0, 64 * 1024);
  const order: string[] = [];
  const counts = new Map<string, number>();
  const add = (name: string) => {
    if (!counts.has(name)) order.push(name);
    counts.set(name, (counts.get(name) || 0) + 1);
  };
  const patterns: Array<[RegExp, (match: RegExpExecArray) => string | null]> = [
    [/\btools\.([A-Za-z_$][\w$]*)\s*\(/g, (m) => m[1]],
    [/\bMCP\.([A-Za-z_$][\w$]*)\.([A-Za-z_$][\w$]*)\s*\(/g, (m) => `mcp__${m[1]}__${m[2]}`],
    [/\bawait\s+([A-Za-z_$][\w$]*)\s*\(/g, (m) => (JS_NON_TOOL_CALLS.has(m[1]) ? null : m[1])],
  ];
  const hits: Array<{ index: number; name: string }> = [];
  for (const [pattern, pick] of patterns) {
    let match: RegExpExecArray | null;
    while ((match = pattern.exec(source)) !== null) {
      const name = pick(match);
      if (name) hits.push({ index: match.index, name });
      if (hits.length > 500) break;
    }
  }
  hits.sort((a, b) => a.index - b.index);
  for (const hit of hits) add(hit.name);
  const items = order.slice(0, MAX_REFS).map((raw) => {
    const parsed = parseToolName(raw);
    return { name: parsed.canonical, namespace: parsed.namespace, count: counts.get(raw) || 1 };
  });
  return { items, truncated: order.length > MAX_REFS };
}

function looksLikeCode(text: string): boolean {
  return /(^|\n)\s*\/\/\s*@exec\b/.test(text)
    || /\bawait\s+[A-Za-z_$][\w$.]*\s*\(/.test(text)
    || /\btools\.[A-Za-z_$][\w$]*\s*\(/.test(text)
    || /\b(?:const|let)\s+[A-Za-z_$][\w$]*\s*=/.test(text);
}

function shellCommand(args: Args): string | null {
  const direct = str(args, 'command', 'cmd', 'script', 'CommandLine');
  if (direct) return direct;
  const list = arr(args, 'command') || arr(args, 'cmd') || arr(args, 'argv');
  if (list && list.every((part) => typeof part === 'string')) {
    const parts = list as string[];
    if (parts.length >= 3 && /(^|\/)(ba|z|da)?sh$/.test(parts[0]) && /^-l?c$/.test(parts[1])) return parts.slice(2).join(' ');
    return parts.join(' ');
  }
  return null;
}

function exitCodeFrom(result: string | undefined): number | null {
  if (!result) return null;
  const tail = result.slice(-2000);
  const match = /\bexit(?:ed with)? code[:= ]\s*(-?\d{1,3})\b/i.exec(tail)
    || /\(exit(?: code)? (-?\d{1,3})\)/i.exec(tail)
    || /"?exitCode"?\s*[:=]\s*(-?\d{1,3})\b/.exec(tail);
  return match ? Number(match[1]) : null;
}

function buildCode(ctx: BuildContext, code: string, title: string | null): BuiltCard {
  const pragma = /^\s*\/\/\s*@exec:?\s*(.*)$/m.exec(code);
  const refs = extractNestedToolRefs(code);
  return {
    kind: 'code',
    title: title ? `Code: ${shorten(title, 80)}` : 'Run code',
    chips: [
      ...(ctx.name.canonical !== 'exec' ? [] : [chip('code mode', 'info')]),
      ...(pragma ? [chip('exec options')] : []),
      ...(refs.items.length ? [chip(`${refs.items.length} tool${refs.items.length === 1 ? '' : 's'}`)] : []),
    ],
    sections: [
      refs.items.length ? { type: 'refs', label: 'Calls tools', items: refs.items, truncated: refs.truncated } : null,
      codeSection('Code', code),
    ],
    resultLabel: 'Output',
  };
}

function buildShell(ctx: BuildContext): BuiltCard {
  const { args, text } = ctx.parsed;
  if (ctx.parsed.state === 'object') {
    const code = str(args, 'code');
    if (code) return buildCode(ctx, code, str(args, 'title'));
    const command = str(args, 'command');
    if (command && str(args, 'title') && looksLikeCode(command)) return buildCode(ctx, command, str(args, 'title'));
  } else if (ctx.parsed.state === 'text' && text) {
    if (looksLikeCode(text)) return buildCode(ctx, text, null);
  }
  const command = ctx.parsed.state === 'text' ? text : shellCommand(args);
  const firstLine = command ? command.trim().split('\n')[0] : '';
  const cwd = str(args, 'workdir', 'cwd', 'dir', 'directory', 'Cwd');
  const timeout = num(args, 'timeoutSeconds', 'timeout_seconds');
  const exitCode = exitCodeFrom(ctx.tool.result);
  const chips: ToolCardChip[] = [];
  if (exitCode !== null) chips.push(chip(`exit ${exitCode}`, exitCode === 0 ? 'good' : 'bad'));
  if (bool(args, 'background') || bool(args, 'run_in_background')) chips.push(chip('background', 'info'));
  if (bool(args, 'elevated')) chips.push(chip('elevated', 'warn'));
  const host = str(args, 'host');
  if (host) chips.push(chip(host));
  if (timeout !== null) chips.push(chip(timeout === 0 ? 'no timeout' : `timeout ${timeout}s`));
  return {
    title: firstLine ? `Run ${shorten(firstLine, 80)}` : 'Run command',
    subtitle: cwd ? displayText(cwd, 80) : str(args, 'description') ? displayText(str(args, 'description'), 80) : null,
    chips,
    sections: [
      codeSection('Command', command, 2000, 30),
      ctx.parsed.state === 'object'
        ? argumentFields(args, ['command', 'cmd', 'script', 'argv', 'workdir', 'cwd', 'dir', 'directory', 'background', 'run_in_background', 'elevated', 'host', 'timeoutSeconds', 'timeout_seconds', 'description', 'CommandLine', 'Cwd'])
        : null,
    ],
    resultLabel: 'Output',
  };
}

function buildProcess(ctx: BuildContext): BuiltCard {
  const { args } = ctx.parsed;
  const action = str(args, 'action');
  const session = str(args, 'sessionId', 'session_id', 'shell_id', 'bash_id', 'task_id', 'CommandId');
  const stops = ctx.name.canonical === 'kill_shell' || ctx.name.canonical === 'kill_bash' || ctx.name.canonical === 'task_stop';
  const label = action || (stops ? 'stop' : 'check output');
  return {
    title: `Process ${shorten(label, 30)}${session ? ` ${shorten(session, 24)}` : ''}`,
    chips: [],
    sections: [
      ctx.name.canonical === 'write_stdin' ? fieldsSection([field('input', str(args, 'chars', 'input') ? `${utf8Length(str(args, 'chars', 'input') || '')} characters` : null)]) : null,
      argumentFields(args, ['action', 'sessionId', 'session_id', 'shell_id', 'bash_id', 'task_id', 'CommandId', 'chars', 'input', 'data', 'text', 'keys']),
    ],
    resultLabel: 'Output',
  };
}

function pathOf(args: Args): string | null {
  return str(args, 'path', 'file_path', 'filePath', 'target_file', 'notebook_path', 'dir_path', 'directory', 'file',
    'absolute_path', 'AbsolutePath', 'TargetFile', 'DirectoryPath');
}

function buildRead(ctx: BuildContext): BuiltCard {
  const { args } = ctx.parsed;
  const path = pathOf(args);
  const paths = arr(args, 'paths') || arr(args, 'files');
  const offset = num(args, 'offset', 'start_line', 'startLine', 'line');
  const limit = num(args, 'limit', 'lines', 'max_lines');
  const end = num(args, 'end_line', 'endLine');
  const chips: ToolCardChip[] = [];
  if (offset !== null && end !== null) chips.push(chip(`lines ${offset}–${end}`));
  else if (offset !== null) chips.push(chip(limit !== null ? `from line ${offset}, ${limit} lines` : `from line ${offset}`));
  else if (limit !== null) chips.push(chip(`${limit} lines`));
  const isList = ctx.name.canonical === 'list_directory' || ctx.name.canonical === 'list_dir' || ctx.name.canonical === 'ls';
  const isMemory = ctx.name.canonical === 'memory_get';
  const verb = isList ? 'List' : isMemory ? 'Read memory' : 'Read';
  let title = path ? `${verb} ${shortPath(path)}` : `${verb} ${isList ? 'directory' : 'file'}`;
  if (!path && paths && paths.length) title = `${verb} ${paths.length} file${paths.length === 1 ? '' : 's'}`;
  return {
    title,
    subtitle: path ? displayText(path, 120) : null,
    chips,
    sections: [
      paths && paths.length
        ? fieldsSection(paths.slice(0, MAX_FIELDS).map((item, index) => field(`${index + 1}`, typeof item === 'string' ? item : summarizeValue(item), true)), 'Files')
        : null,
    ],
    resultLabel: isList ? 'Entries' : 'Content',
  };
}

function buildWrite(ctx: BuildContext): BuiltCard {
  const { args } = ctx.parsed;
  const path = pathOf(args);
  const content = str(args, 'content', 'text', 'file_text', 'contents', 'CodeContent');
  const chips: ToolCardChip[] = [];
  if (content !== null) {
    const lines = content.split('\n').length;
    chips.push(chip(`${lines} line${lines === 1 ? '' : 's'} · ${formatBytes(utf8Length(content))}`));
  }
  return {
    title: path ? `Write ${shortPath(path)}` : 'Write file',
    subtitle: path ? displayText(path, 120) : null,
    chips,
    sections: [codeSection('Content', content, 3000, 40)],
    resultLabel: 'Result',
  };
}

function diffLines(oldText: string | null, newText: string | null, budget: { left: number }): Array<{ kind: ToolCardDiffLineKind; text: string }> {
  const lines: Array<{ kind: ToolCardDiffLineKind; text: string }> = [];
  const push = (kind: ToolCardDiffLineKind, value: string | null) => {
    if (value === null) return;
    const block = displayBlock(value, 4000, MAX_DIFF_LINES);
    for (const line of block.text.split('\n')) {
      if (budget.left <= 0) return;
      lines.push({ kind, text: line });
      budget.left -= 1;
    }
  };
  push('del', oldText);
  push('add', newText);
  return lines;
}

function buildEdit(ctx: BuildContext): BuiltCard {
  const { args } = ctx.parsed;
  const command = str(args, 'command');
  // Anthropic text-editor tools route several operations through one name.
  if (command === 'view') return buildRead(ctx);
  if (command === 'create') return { ...buildWrite(ctx), kind: 'write' };
  const path = pathOf(args);
  const edits = arr(args, 'edits') || arr(args, 'ReplacementChunks');
  const budget = { left: MAX_DIFF_LINES };
  const lines: Array<{ kind: ToolCardDiffLineKind; text: string }> = [];
  let editCount = 0;
  if (edits) {
    for (const edit of edits) {
      if (!isRecord(edit)) continue;
      editCount += 1;
      if (lines.length) lines.push({ kind: 'meta', text: '…' });
      lines.push(...diffLines(
        str(edit, 'old_string', 'oldText', 'old_str', 'old', 'oldString', 'TargetContent'),
        str(edit, 'new_string', 'newText', 'new_str', 'new', 'newString', 'ReplacementContent'),
        budget,
      ));
    }
  } else {
    const oldText = str(args, 'old_string', 'oldText', 'old_str', 'old_text', 'oldString');
    const newText = str(args, 'new_string', 'newText', 'new_str', 'new_text', 'insert_text', 'newString');
    if (oldText !== null || newText !== null) editCount = 1;
    // ACP harnesses (OpenCode) report whole-file writes under the edit kind.
    else if (str(args, 'content', 'file_text', 'contents', 'CodeContent') !== null) return { ...buildWrite(ctx), kind: 'write' };
    lines.push(...diffLines(oldText, newText, budget));
  }
  const chips: ToolCardChip[] = [];
  if (editCount > 1) chips.push(chip(`${editCount} edits`));
  if (bool(args, 'replace_all') || bool(args, 'replaceAll')) chips.push(chip('replace all', 'warn'));
  if (command === 'insert') chips.push(chip(`insert at ${num(args, 'insert_line') ?? '?'}`));
  return {
    title: path ? `Edit ${shortPath(path)}` : 'Edit file',
    subtitle: path ? displayText(path, 120) : null,
    chips,
    sections: [lines.length ? { type: 'diff', label: 'Change', lines, truncated: budget.left <= 0 } : null],
    resultLabel: 'Result',
  };
}

function buildPatch(ctx: BuildContext): BuiltCard {
  const { args } = ctx.parsed;
  const patchText = ctx.parsed.state === 'text' ? ctx.parsed.text : str(args, 'patch', 'input', 'diff', 'content');
  const files: string[] = [];
  const lines: Array<{ kind: ToolCardDiffLineKind; text: string }> = [];
  let truncated = false;
  if (patchText) {
    const block = displayBlock(patchText, 8000, 400);
    truncated = block.truncated;
    for (const line of block.text.split('\n')) {
      const fileMatch = /^\*\*\* (?:Update|Add|Delete) File: (.+)$/.exec(line) || /^\+\+\+ (?:b\/)?(.+)$/.exec(line);
      if (fileMatch && fileMatch[1] !== '/dev/null' && !files.includes(fileMatch[1])) files.push(fileMatch[1]);
      if (lines.length >= MAX_DIFF_LINES) {
        truncated = true;
        continue;
      }
      let kind: ToolCardDiffLineKind = 'ctx';
      if (/^(\*\*\*|@@|\+\+\+ |--- |diff )/.test(line)) kind = 'meta';
      else if (line.startsWith('+')) kind = 'add';
      else if (line.startsWith('-')) kind = 'del';
      lines.push({ kind, text: line });
    }
  }
  const title = files.length === 1 ? `Patch ${shortPath(files[0])}` : files.length > 1 ? `Patch ${files.length} files` : 'Apply patch';
  return {
    title,
    chips: files.length > 1 ? [chip(`${files.length} files`)] : [],
    sections: [
      files.length > 1 ? fieldsSection(files.slice(0, MAX_FIELDS).map((file, index) => field(`${index + 1}`, file, true)), 'Files') : null,
      lines.length ? { type: 'diff', label: 'Patch', lines, truncated } : null,
    ],
    resultLabel: 'Result',
  };
}

type FileChangeKind = 'add' | 'delete' | 'update' | 'move';

const FILE_CHANGE_TOOLS: ReadonlySet<string> = new Set(['file_change', 'delete', 'move']);
const MAX_FILE_CHANGES = 1000;

const FILE_CHANGE_KINDS: Readonly<Record<string, FileChangeKind>> = {
  add: 'add', added: 'add', create: 'add', created: 'add', new: 'add',
  delete: 'delete', deleted: 'delete', remove: 'delete', removed: 'delete',
  update: 'update', updated: 'update', modify: 'update', modified: 'update', edit: 'update',
  move: 'move', moved: 'move', rename: 'move', renamed: 'move',
};

const FILE_CHANGE_VIEW: Readonly<Record<FileChangeKind, { verb: string; label: string; tone: ToolCardTone }>> = {
  add: { verb: 'Add', label: 'added', tone: 'good' },
  update: { verb: 'Edit', label: 'updated', tone: 'neutral' },
  delete: { verb: 'Delete', label: 'deleted', tone: 'bad' },
  move: { verb: 'Move', label: 'moved', tone: 'info' },
};

function fileChangeKind(value: unknown, fallback: FileChangeKind): FileChangeKind {
  return typeof value === 'string' ? FILE_CHANGE_KINDS[value.trim().toLowerCase()] ?? fallback : fallback;
}

/**
 * Applied file changes without a diff: Codex `file_change` items list each path
 * with its change kind; ACP `delete` / `move` tool kinds name one target.
 */
function buildFileChange(ctx: BuildContext): BuiltCard {
  const { args } = ctx.parsed;
  const canonical = ctx.name.canonical;
  const entries: Array<{ path: string; to: string | null; kind: FileChangeKind }> = [];
  const changes = arr(args, 'changes');
  if (changes) {
    for (const change of changes.slice(0, MAX_FILE_CHANGES)) {
      if (!isRecord(change)) continue;
      const path = pathOf(change);
      if (path) entries.push({ path, to: null, kind: fileChangeKind(change.kind ?? change.type ?? change.action, 'update') });
    }
  } else if (canonical === 'move') {
    const from = str(args, 'from', 'source', 'src', 'old_path', 'oldPath') ?? pathOf(args);
    const to = str(args, 'to', 'destination', 'dest', 'new_path', 'newPath');
    if (from) entries.push({ path: from, to, kind: 'move' });
    else if (to) entries.push({ path: to, to: null, kind: 'move' });
  } else {
    const path = pathOf(args);
    if (path) entries.push({ path, to: null, kind: canonical === 'delete' ? 'delete' : 'update' });
  }
  const describe = (entry: { path: string; to: string | null }) => (entry.to ? `${entry.path} → ${entry.to}` : entry.path);
  if (entries.length === 1) {
    const [entry] = entries;
    const view = FILE_CHANGE_VIEW[entry.kind];
    return {
      title: `${view.verb} ${shortPath(entry.path) || ''}${entry.to ? ` → ${shortPath(entry.to) || ''}` : ''}`.trim(),
      subtitle: displayText(describe(entry), 120),
      chips: [chip(view.label, view.tone)],
      resultLabel: 'Result',
    };
  }
  const counts = new Map<FileChangeKind, number>();
  for (const entry of entries) counts.set(entry.kind, (counts.get(entry.kind) || 0) + 1);
  const order: FileChangeKind[] = ['add', 'update', 'delete', 'move'];
  return {
    title: entries.length ? `Change ${entries.length} files` : canonical === 'delete' ? 'Delete file' : canonical === 'move' ? 'Move file' : 'Change files',
    chips: order.filter((kind) => counts.has(kind)).map((kind) => chip(`${counts.get(kind)} ${FILE_CHANGE_VIEW[kind].label}`, FILE_CHANGE_VIEW[kind].tone)),
    sections: [
      fieldsSection(entries.slice(0, MAX_FIELDS + 1).map((entry) => field(FILE_CHANGE_VIEW[entry.kind].label, describe(entry), true)), 'Files'),
    ],
    resultLabel: 'Result',
  };
}

function searchQuery(args: Args): string | null {
  const direct = str(args, 'query', 'q', 'pattern', 'regex', 'search', 'searchTerm', 'text', 'Query', 'Pattern');
  if (direct) return direct;
  const nested = arr(args, 'search_query');
  if (nested && isRecord(nested[0])) return str(nested[0], 'q', 'query');
  return null;
}

function searchLinks(result: string | undefined): { items: ToolCardLink[]; total: number } | null {
  const parsed = parseJson(result);
  const candidates: unknown[] = [];
  if (Array.isArray(parsed)) candidates.push(...parsed);
  else if (isRecord(parsed)) {
    for (const key of ['results', 'items', 'data', 'hits', 'organic']) {
      const value = parsed[key];
      if (Array.isArray(value)) {
        candidates.push(...value);
        break;
      }
      if (isRecord(value) && Array.isArray(value.results)) {
        candidates.push(...value.results);
        break;
      }
    }
    if (!candidates.length && isRecord(parsed.web) && Array.isArray(parsed.web.results)) candidates.push(...parsed.web.results);
  }
  const items: ToolCardLink[] = [];
  for (const candidate of candidates) {
    if (!isRecord(candidate)) continue;
    const link = linkFrom(candidate.url ?? candidate.link ?? candidate.href, candidate.title ?? candidate.name, candidate.snippet ?? candidate.description ?? candidate.content);
    if (link) items.push(link);
  }
  return items.length ? { items, total: items.length } : null;
}

function buildSearch(ctx: BuildContext): BuiltCard {
  const { args } = ctx.parsed;
  const query = searchQuery(args);
  const scope = str(args, 'path', 'include', 'glob', 'type', 'directory', 'domain', 'SearchPath', 'SearchDirectory');
  const chips: ToolCardChip[] = [];
  const provider = ctx.name.canonical.endsWith('_search') && !['web_search', 'memory_search', 'tool_search', 'grep_search', 'google_web_search', 'file_search', 'codebase_search'].includes(ctx.name.canonical)
    ? ctx.name.canonical.replace(/_search$/, '')
    : null;
  if (provider) chips.push(chip(provider, 'info'));
  const count = num(args, 'count', 'max_results', 'limit', 'maxResults');
  if (count !== null) chips.push(chip(`max ${count}`));
  const links = ctx.tool.status === 'done' ? searchLinks(ctx.tool.result) : null;
  if (links) chips.push(chip(`${links.total} result${links.total === 1 ? '' : 's'}`));
  const noun = ctx.name.canonical === 'memory_search' ? 'Search memory' : ctx.name.canonical === 'tool_search' ? 'Find tools'
    : ctx.name.canonical === 'glob' ? 'Match' : ctx.name.canonical === 'find_by_name' ? 'Find files' : 'Search';
  const title = ctx.name.canonical === 'glob' && query
    ? `Match ${shorten(query, 60)}`
    : query ? `${noun} “${shorten(query, 56)}”` : noun;
  return {
    title,
    subtitle: scope ? displayText(scope, 80) : null,
    chips,
    sections: [
      links ? { type: 'links', label: 'Results', items: links.items.slice(0, MAX_LINKS), truncated: links.items.length > MAX_LINKS } : null,
    ],
    resultLabel: links ? null : 'Results',
  };
}

function buildWeb(ctx: BuildContext): BuiltCard {
  const { args } = ctx.parsed;
  const url = str(args, 'url', 'href', 'link', 'uri', 'Url');
  const link = linkFrom(url);
  const verb = ctx.name.canonical === 'click' ? 'Click' : ctx.name.canonical.startsWith('open') ? 'Open' : 'Fetch';
  const target = link?.host || (url ? shorten(url, 60) : null);
  const chips: ToolCardChip[] = [];
  const mode = str(args, 'extractMode', 'format');
  if (mode) chips.push(chip(mode));
  const maxChars = num(args, 'maxChars', 'max_length');
  if (maxChars !== null) chips.push(chip(`max ${maxChars} chars`));
  return {
    title: target ? `${verb} ${target}` : `${verb} page`,
    chips,
    sections: [
      link ? { type: 'links', label: 'Page', items: [link], truncated: false } : null,
      textSection('Prompt', str(args, 'prompt'), 600, 10),
    ],
    resultLabel: 'Page content',
  };
}

function buildBrowser(ctx: BuildContext): BuiltCard {
  const { args } = ctx.parsed;
  const fromName = ctx.name.canonical.startsWith('browser_') ? ctx.name.canonical.slice('browser_'.length) : null;
  const action = str(args, 'action', 'command', 'kind') || fromName || (ctx.name.canonical === 'screenshot' ? 'screenshot' : null);
  const request = isRecord(args.request) ? args.request : {};
  const url = str(args, 'url', 'targetUrl', 'href') || str(request, 'url');
  const link = linkFrom(url);
  const typed = str(args, 'text', 'value') ?? str(request, 'text', 'value');
  const target = str(args, 'ref', 'selector', 'element', 'targetId') || str(request, 'ref', 'selector', 'element');
  const chips: ToolCardChip[] = [];
  const profile = str(args, 'profile');
  if (profile) chips.push(chip(profile, 'info'));
  const title = link?.host
    ? `Browser ${shorten(action || 'open', 24)} ${link.host}`
    : `Browser ${shorten(action || 'action', 40)}`;
  return {
    title,
    chips,
    sections: [
      link ? { type: 'links', label: 'Page', items: [link], truncated: false } : null,
      fieldsSection([
        field('target', target, true),
        // Typed text can be a credential: show only its length.
        typed !== null ? { label: 'typed', value: `${utf8Length(typed)} characters (hidden)`, redacted: true } : null,
      ]),
    ],
    resultLabel: 'Result',
  };
}

function stepStatus(value: unknown): ToolCardStepStatus {
  if (value === 'pending' || value === 'in_progress' || value === 'completed') return value;
  if (value === 'done' || value === 'complete') return 'completed';
  if (value === 'running' || value === 'active' || value === 'in-progress') return 'in_progress';
  if (value === 'todo' || value === 'not_started') return 'pending';
  return 'unknown';
}

function stepsFrom(list: unknown[] | null, textKeys: string[]): { steps: Array<{ text: string; status: ToolCardStepStatus }>; truncated: boolean } | null {
  if (!list) return null;
  const steps: Array<{ text: string; status: ToolCardStepStatus }> = [];
  for (const item of list) {
    if (steps.length >= MAX_STEPS) break;
    if (typeof item === 'string') {
      const text = displayText(item, 200);
      if (text) steps.push({ text, status: 'unknown' });
      continue;
    }
    if (!isRecord(item)) continue;
    const text = displayText(str(item, ...textKeys), 200);
    if (text) steps.push({ text, status: stepStatus(item.status) });
  }
  return { steps, truncated: list.length > MAX_STEPS };
}

function buildProgress(ctx: BuildContext): BuiltCard {
  const { args } = ctx.parsed;
  const canonical = ctx.name.canonical;
  if (canonical === 'task_create' || canonical === 'task_update' || canonical === 'task_get' || canonical === 'task_list') {
    const subject = str(args, 'subject', 'title', 'description');
    const verb = canonical === 'task_create' ? 'Create task' : canonical === 'task_update' ? 'Update task' : 'Check tasks';
    return {
      title: subject ? `${verb}: ${shorten(subject, 60)}` : verb,
      chips: str(args, 'status') ? [chip(str(args, 'status') || '')] : [],
      sections: [argumentFields(args, ['subject', 'title'])],
      resultLabel: 'Result',
    };
  }
  const plan = stepsFrom(arr(args, 'plan') || arr(args, 'todos') || arr(args, 'steps'), ['step', 'content', 'text', 'title', 'activeForm']);
  const markdown = str(args, 'markdown', 'explanation', 'note');
  const steps = plan?.steps || [];
  const completed = steps.filter((step) => step.status === 'completed').length;
  const cleared = canonical === 'progress_card' && ctx.parsed.state === 'object' && steps.length === 0 && !markdown;
  const noun = canonical === 'todo_write' || canonical === 'write_todos' ? 'to-dos' : canonical === 'update_plan' ? 'plan' : 'progress';
  return {
    title: cleared ? 'Clear progress card' : `Update ${noun}${steps.length ? ` · ${completed}/${steps.length}` : ''}`,
    chips: [],
    sections: [
      steps.length ? { type: 'steps', label: canonical === 'progress_card' ? 'Plan' : 'Steps', steps, truncated: Boolean(plan?.truncated) } : null,
      textSection(canonical === 'update_plan' ? 'Explanation' : 'Note', markdown, 1500, 30),
    ],
    resultLabel: 'Result',
  };
}

function buildGoal(ctx: BuildContext): BuiltCard {
  const { args } = ctx.parsed;
  const canonical = ctx.name.canonical;
  const objective = str(args, 'objective', 'goal');
  const status = str(args, 'status');
  const budget = num(args, 'token_budget', 'tokenBudget');
  const note = str(args, 'note');
  const resultGoal = (() => {
    const parsed = parseJson(ctx.tool.result);
    if (!isRecord(parsed)) return null;
    return isRecord(parsed.goal) ? parsed.goal : parsed;
  })();
  const title = canonical === 'get_goal'
    ? 'Check goal'
    : canonical === 'update_goal'
      ? `Goal ${status ? `→ ${shorten(status, 20)}` : 'update'}`
      : objective ? `Set goal: ${shorten(objective, 60)}` : 'Set goal';
  return {
    title,
    chips: budget !== null ? [chip(`budget ${budget} tokens`)] : [],
    sections: [
      textSection('Objective', objective, 1500, 20),
      textSection('Note', note, 600, 10),
      resultGoal && (resultGoal.objective !== undefined || resultGoal.status !== undefined)
        ? fieldsSection([field('status', resultGoal.status), field('objective', resultGoal.objective), field('tokens used', resultGoal.tokensUsed ?? resultGoal.tokens_used)], 'Goal')
        : null,
    ],
    resultLabel: resultGoal ? null : 'Result',
  };
}

function buildSession(ctx: BuildContext): BuiltCard {
  const { args } = ctx.parsed;
  const canonical = ctx.name.canonical;
  const result = parseJson(ctx.tool.result);
  const resultRecord = isRecord(result) ? result : null;
  const chips: ToolCardChip[] = [];
  const resultStatus = resultRecord ? displayText(resultRecord.status, 24) : '';
  if (resultStatus) chips.push(chip(resultStatus, resultStatus === 'accepted' || resultStatus === 'ok' ? 'good' : resultStatus === 'error' || resultStatus === 'rejected' ? 'bad' : 'neutral'));
  const resultFields = resultRecord
    ? fieldsSection([
      field('child session', resultRecord.childSessionKey, true),
      field('session', resultRecord.sessionKey, true),
      field('run', resultRecord.runId, true),
      field('delivery', isRecord(resultRecord.delivery) ? resultRecord.delivery.status : undefined),
      field('disposition', resultRecord.targetDisposition),
    ], 'Outcome')
    : null;

  if (canonical === 'sessions_spawn' || canonical === 'spawn_agent' || canonical === 'task' || canonical === 'agent') {
    const who = str(args, 'agentId', 'label', 'subagent_type', 'agent_type', 'name');
    const task = str(args, 'task', 'prompt', 'message', 'description');
    const model = str(args, 'model');
    if (model) chips.push(chip(model));
    const runtime = str(args, 'runtime');
    if (runtime) chips.push(chip(runtime, 'info'));
    return {
      title: who ? `Spawn ${shorten(who, 50)}` : 'Spawn agent',
      subtitle: str(args, 'label', 'taskName', 'description') && who !== str(args, 'label') ? displayText(str(args, 'label', 'taskName', 'description'), 80) : null,
      chips,
      sections: [textSection('Task', task, 1500, 24), resultFields],
      resultLabel: resultFields ? null : 'Result',
    };
  }
  if (canonical === 'sessions_send' || canonical === 'send_input') {
    const target = str(args, 'sessionKey', 'label', 'target', 'id', 'agent_id');
    return {
      title: target ? `Message ${shorten(target, 50)}` : 'Message agent',
      chips,
      sections: [textSection('Message', str(args, 'message', 'text', 'input'), 1500, 24), resultFields],
      resultLabel: resultFields ? null : 'Result',
    };
  }
  const titles: Record<string, string> = {
    sessions_yield: 'Wait for agents',
    agents_wait: 'Wait for agents',
    wait_agent: 'Wait for agent',
    sessions_history: 'Read agent history',
    sessions_list: 'List sessions',
    session_status: 'Check session status',
    agents_list: 'List agents',
    close_agent: 'Close agent',
    resume_agent: 'Resume agent',
  };
  const action = str(args, 'action');
  const title = canonical === 'subagents' ? `Subagents ${shorten(action || 'check', 30)}` : titles[canonical] || humanize(canonical);
  return {
    title,
    chips,
    sections: [resultFields, argumentFields(args, ['action'])],
    resultLabel: resultFields ? null : 'Result',
  };
}

function buildMedia(ctx: BuildContext): BuiltCard {
  const { args } = ctx.parsed;
  const canonical = ctx.name.canonical;
  const action = str(args, 'action');
  const prompt = str(args, 'prompt', 'text', 'input');
  const chips: ToolCardChip[] = [];
  const model = str(args, 'model');
  if (model) chips.push(chip(model));
  for (const key of ['aspectRatio', 'size', 'resolution', 'quality', 'outputFormat']) {
    const value = str(args, key);
    if (value) chips.push(chip(value));
  }
  const duration = num(args, 'durationSeconds');
  if (duration !== null) chips.push(chip(`${duration}s`));
  const count = num(args, 'count');
  if (count !== null && count > 1) chips.push(chip(`×${count}`));
  const nouns: Record<string, string> = {
    image_generate: 'image',
    generate_image: 'image',
    image_edit: 'image',
    video_generate: 'video',
    music_generate: 'audio',
  };
  let title: string;
  if (nouns[canonical]) {
    title = action === 'status' ? `Check ${nouns[canonical]} job` : action === 'list' ? `List ${nouns[canonical]} providers` : `Generate ${nouns[canonical]}`;
  } else if (canonical === 'tts') title = 'Generate speech';
  else if (canonical === 'pdf') title = 'Read PDF';
  else {
    const source = str(args, 'path', 'image', 'url', 'file_path');
    title = source ? `View image ${shortPath(source) || ''}`.trim() : 'View image';
  }
  const refs: unknown[] = [
    ...(arr(args, 'images') || []),
    ...(arr(args, 'pdfs') || []),
    ...(arr(args, 'videos') || []),
    args.image,
    args.pdf,
    args.video,
  ].filter((value) => typeof value === 'string' && value.trim());
  const refLinks = refs.slice(0, MAX_LINKS).map((value) => linkFrom(value) || { title: displayText(value, 120), href: null, host: null });
  return {
    title,
    chips,
    sections: [
      textSection(canonical === 'tts' ? 'Text' : 'Prompt', prompt, 1500, 20),
      refLinks.length ? { type: 'links', label: 'References', items: refLinks, truncated: refs.length > MAX_LINKS } : null,
    ],
    resultLabel: 'Result',
  };
}

function buildQuestion(ctx: BuildContext): BuiltCard {
  const { args } = ctx.parsed;
  const questions = arr(args, 'questions');
  const texts: string[] = [];
  if (questions) {
    for (const item of questions) {
      const text = isRecord(item) ? str(item, 'question', 'prompt', 'text') : typeof item === 'string' ? item : null;
      if (text) texts.push(text);
    }
  }
  const single = str(args, 'question', 'prompt');
  if (single) texts.unshift(single);
  return {
    title: texts.length ? `Ask: ${shorten(texts[0], 70)}` : 'Ask a question',
    chips: texts.length > 1 ? [chip(`${texts.length} questions`)] : [],
    sections: [textSection('Questions', texts.join('\n'), 1500, 20)],
    resultLabel: 'Answer',
  };
}

function buildParallel(ctx: BuildContext): BuiltCard {
  const { args } = ctx.parsed;
  const uses = arr(args, 'tool_uses') || arr(args, 'calls') || arr(args, 'tools') || [];
  const cards: ToolCardModel[] = [];
  if (ctx.depth < MAX_NESTED_DEPTH) {
    uses.slice(0, MAX_NESTED_CARDS).forEach((use, index) => {
      const record = isRecord(use) ? use : {};
      cards.push(buildToolCardModel({
        id: `${ctx.tool.id}#${index}`,
        name: str(record, 'recipient_name', 'name', 'tool') || 'tool',
        status: ctx.tool.status,
        arguments: record.parameters ?? record.arguments ?? record.args,
      }, ctx.depth + 1));
    });
  }
  return {
    title: uses.length ? `Run ${uses.length} tool${uses.length === 1 ? '' : 's'} in parallel` : 'Run tools in parallel',
    chips: [],
    sections: [
      cards.length
        ? { type: 'nested', label: 'Calls', cards, truncated: uses.length > cards.length }
        : uses.length ? textSection('Calls', `${uses.length} nested call${uses.length === 1 ? '' : 's'} (not expanded)`) : null,
    ],
    resultLabel: 'Result',
  };
}

function primaryDetail(args: Args): string | null {
  for (const key of ['action', 'command', 'path', 'url', 'query', 'name', 'title', 'id']) {
    if (isSecretKey(key)) continue;
    const value = args[key];
    if (typeof value === 'string' && value.trim()) {
      return key === 'url' ? safeLink(value)?.host || displayText(value, 50) : displayText(key === 'path' ? shortPath(value) || value : value, 50);
    }
  }
  return null;
}

function buildGeneric(ctx: BuildContext): BuiltCard {
  const { args, state, text } = ctx.parsed;
  const detail = state === 'object' ? primaryDetail(args) : null;
  const chips: ToolCardChip[] = [];
  if (ctx.name.namespace) chips.push(chip(ctx.name.namespace.replace(/^mcp:/, 'MCP · '), 'info'));
  return {
    kind: 'generic',
    title: detail ? `${humanize(ctx.name.canonical)} · ${detail}` : humanize(ctx.name.canonical),
    chips,
    sections: [
      state === 'object' ? argumentFields(args) : null,
      state === 'text' ? codeSection('Input', text, 2000, 30) : null,
    ],
    resultLabel: 'Result',
  };
}

const BUILDERS: Readonly<Record<ToolCardKind, (ctx: BuildContext) => BuiltCard>> = {
  shell: buildShell,
  code: (ctx) => {
    const code = ctx.parsed.state === 'text' ? ctx.parsed.text || '' : str(ctx.parsed.args, 'code', 'source', 'command', 'input') || '';
    return buildCode(ctx, code, str(ctx.parsed.args, 'title'));
  },
  process: buildProcess,
  read: buildRead,
  write: buildWrite,
  edit: buildEdit,
  patch: (ctx) => (FILE_CHANGE_TOOLS.has(ctx.name.canonical) ? buildFileChange(ctx) : buildPatch(ctx)),
  search: buildSearch,
  web: buildWeb,
  browser: buildBrowser,
  progress: buildProgress,
  goal: buildGoal,
  session: buildSession,
  media: buildMedia,
  question: buildQuestion,
  parallel: buildParallel,
  generic: buildGeneric,
};

/* ─── Assembly ───────────────────────────────────────────────────────────── */

function durationOf(tool: ToolCardInput): number | null {
  const { startedAt, endedAt } = tool;
  if (typeof startedAt !== 'number' || typeof endedAt !== 'number') return null;
  const ms = endedAt - startedAt;
  return Number.isFinite(ms) && ms >= 0 ? ms : null;
}

function safeStatus(value: unknown): ToolCardStatus {
  return value === 'running' || value === 'error' ? value : 'done';
}

function finish(ctx: BuildContext, kind: ToolCardKind, built: BuiltCard): ToolCardModel {
  const sections = (built.sections || []).filter((section): section is ToolCardSection => Boolean(section));
  const resultLabel = built.resultLabel === undefined ? 'Result' : built.resultLabel;
  if (resultLabel !== null && typeof ctx.tool.result === 'string' && ctx.tool.result.trim()) {
    const result = codeSection(ctx.tool.status === 'error' ? 'Error' : resultLabel, ctx.tool.result, 4000, 60);
    if (result) sections.push(result);
  } else if (ctx.tool.status === 'error' && typeof ctx.tool.result === 'string' && ctx.tool.result.trim()) {
    const result = codeSection('Error', ctx.tool.result, 2000, 30);
    if (result) sections.push(result);
  }
  if (ctx.parsed.state === 'malformed' && ctx.parsed.text) {
    const raw = codeSection('Arguments (unreadable)', ctx.parsed.text, 1500, 20);
    if (raw) sections.unshift(raw);
  }
  const brand = isBridgesLLMTool(ctx.tool.name, ctx.parsed.args) ? 'bridgesllm' as const : undefined;
  const chips = [...(brand ? [chip('BridgesLLM', 'info')] : []), ...(built.chips || [])];
  if (ctx.parsed.state === 'malformed') chips.unshift(chip('unreadable arguments', 'warn'));
  return {
    id: String(ctx.tool.id),
    rawName: ctx.name.raw,
    canonicalName: ctx.name.canonical,
    displayName: humanize(ctx.name.canonical),
    namespace: ctx.name.namespace,
    kind,
    ...(brand ? { brand } : {}),
    status: ctx.tool.status,
    argsState: ctx.parsed.state,
    title: displayText(built.title, 120) || humanize(ctx.name.canonical),
    subtitle: built.subtitle ? displayText(built.subtitle, 120) || null : null,
    chips: chips.slice(0, 6),
    sections,
    durationMs: durationOf(ctx.tool),
  };
}

/** Minimal model from the name alone; used when anything else fails. */
export function fallbackToolCardModel(tool: Partial<ToolCardInput> | null | undefined): ToolCardModel {
  let name: ParsedToolName;
  try {
    name = parseToolName(tool?.name);
  } catch {
    name = { raw: 'tool', canonical: 'tool', namespace: null };
  }
  return {
    id: typeof tool?.id === 'string' ? tool.id : String(tool?.id ?? ''),
    rawName: name.raw,
    canonicalName: name.canonical,
    displayName: humanize(name.canonical),
    namespace: name.namespace,
    kind: 'generic',
    status: safeStatus(tool?.status),
    argsState: 'malformed',
    title: humanize(name.canonical),
    subtitle: null,
    chips: [],
    sections: [],
    durationMs: null,
  };
}

/**
 * Build the card model for one tool call. Pure and total: malformed, partial or
 * hostile input yields a generic model that still names the tool.
 */
export function buildToolCardModel(tool: ToolCardInput, depth = 0): ToolCardModel {
  try {
    const input: ToolCardInput = { ...tool, status: safeStatus(tool.status) };
    const name = parseToolName(input.name);
    const parsed = parseToolArguments(input.arguments, input.status);
    const ctx: BuildContext = { tool: input, name, parsed, depth };
    const kind = resolveToolCardKind(name.canonical);
    if (parsed.state === 'partial') {
      return finish(ctx, kind, { title: `${humanize(name.canonical)}…`, chips: [chip('preparing', 'info')], resultLabel: null });
    }
    if (parsed.state === 'malformed' || (parsed.state === 'text' && kind !== 'shell' && kind !== 'code' && kind !== 'patch')) {
      return finish(ctx, 'generic', buildGeneric(ctx));
    }
    try {
      const built = BUILDERS[kind](ctx);
      return finish(ctx, built.kind || kind, built);
    } catch {
      return finish(ctx, 'generic', buildGeneric(ctx));
    }
  } catch {
    return fallbackToolCardModel(tool);
  }
}
