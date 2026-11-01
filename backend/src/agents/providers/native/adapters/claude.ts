import { randomUUID } from 'crypto';
import path from 'path';
import type { AgentSessionConfig } from '../../../AgentProvider.interface';
import {
  validateClaudeHostGrants,
  validateNativeHostModel,
  validateNativeHostPrompt,
  validateNativeHostSessionId,
  type NativeCliProviderAdapter,
  type NativeCliTurnContext,
} from '../types';
import { nativeSessionMessageCount, type NativeSessionData } from '../../NativeSessionStore';
import { asRecord, extractAbsolutePathDirs } from '../approvalScope';
import { buildNativeCliEnvironment } from '../NativeCliEnvironment';
import { redactNativeProviderText } from '../NativeProviderDiagnostics';
import {
  CLAUDE_CODE_PROJECT_RUNTIME,
  buildClaudeCodeProjectInvocation,
} from '../projectSandbox/ClaudeCodeProjectSandbox';
import { CHAT_BRIDGE_SERVER_NAME, CHAT_BRIDGE_TOOL_NAMES, type ChatBridgeTurn } from '../../../chatBridge/contract';
import { AI_PROVIDER_MAP } from '../../../../config/aiProviders';
import { ChatImageError } from '../../../../services/chatImages/chatImageModelPolicy';
import { HOST_AGENT_RUN_STDIN_MAX_BYTES } from '../../../../services/hostAgentRunActivationGate';

const CLAUDE_STRUCTURED_ERROR_MAX_BYTES = 16 * 1024;

/** Every bridge tool (questions, widgets, goal read/update) is always granted
 * when the bridge is open; `dontAsk` would deny an ungranted one. Claude's own
 * AskUserQuestion cannot reach a person from `-p` and is withheld. */
export const CLAUDE_BRIDGE_ALLOWED_TOOLS = Object.freeze(
  CHAT_BRIDGE_TOOL_NAMES.map((name) => `mcp__${CHAT_BRIDGE_SERVER_NAME}__${name}`),
);

/**
 * Models Claude Code itself declares: the `--model` aliases from its own help
 * ("an alias for the latest model (e.g. 'fable', 'opus', or 'sonnet')") plus
 * the Portal's declared Claude catalog. Every entry is a Claude model with
 * image input; anything else (an arbitrary custom id) is refused photos.
 */
const CLAUDE_CODE_DECLARED_ALIASES = Object.freeze(['fable', 'opus', 'sonnet', 'haiku']);

function claudeDeclaredImageModels(): Set<string> {
  const declared = new Set<string>(CLAUDE_CODE_DECLARED_ALIASES);
  for (const model of AI_PROVIDER_MAP.get('anthropic')?.defaultModels || []) {
    const id = String(model.id || '').trim();
    if (!id) continue;
    declared.add(id);
    if (id.startsWith('anthropic/')) declared.add(id.slice('anthropic/'.length));
  }
  return declared;
}

/**
 * The one stdin line `--input-format stream-json` accepts: a user message with
 * the prompt text followed by base64 JPEG blocks. Deterministic, so the
 * provider can recompute and compare it.
 */
export function encodeClaudeHostStdin(ctx: NativeCliTurnContext): string {
  const images = ctx.chatImages || [];
  if (images.length === 0) return ctx.message;
  const line = `${JSON.stringify({
    type: 'user',
    message: {
      role: 'user',
      content: [
        { type: 'text', text: validateNativeHostPrompt(ctx.message) },
        ...images.map((image) => {
          if (image?.mimeType !== 'image/jpeg' || typeof image.content !== 'string' || !image.content) {
            throw new Error('Claude photo input is not a prepared JPEG');
          }
          return { type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: image.content } };
        }),
      ],
    },
  })}\n`;
  if (Buffer.byteLength(line, 'utf8') > HOST_AGENT_RUN_STDIN_MAX_BYTES) {
    throw new Error('Claude photo input exceeds the host stdin bound');
  }
  return line;
}

function claudeBridgeMcpConfig(bridge: ChatBridgeTurn): string {
  const { command, args } = bridge.launch;
  if (!path.isAbsolute(command) || args.length !== 1 || !path.isAbsolute(args[0])) {
    throw new Error('Claude chat bridge launch is invalid');
  }
  // Command and script path only: the capability token travels in the process
  // environment Claude hands to its MCP children, never in argv.
  return JSON.stringify({
    mcpServers: {
      [CHAT_BRIDGE_SERVER_NAME]: { type: 'stdio', command, args: [...args] },
    },
  });
}

async function assertClaudeImageModel(session: NativeSessionData): Promise<string> {
  const model = validateNativeHostModel(session.model);
  // No override: Claude Code runs its own default, which is one of its
  // declared Claude models.
  if (!model) return 'claude-code-default';
  if (!claudeDeclaredImageModels().has(model)) throw new ChatImageError('IMAGE_MODEL_UNSUPPORTED');
  return model;
}

function captureClaudeStructuredError(parsed: any): string | null {
  const errorCode = typeof parsed?.error === 'string'
    ? parsed.error.trim().toLowerCase().replace(/[^a-z0-9_-]+/g, '_').slice(0, 80)
    : '';
  if (parsed?.isApiErrorMessage !== true && !errorCode) return null;

  const content = Array.isArray(parsed?.message?.content)
    ? parsed.message.content
        .filter((part: any) => part?.type === 'text' && typeof part?.text === 'string')
        .map((part: any) => part.text)
        .join('\n')
    : '';
  const diagnostic = [
    content,
    // Keep the typed code at the tail because the shared bounded diagnostic
    // helper retains the newest bytes when provider output is oversized.
    `Claude Code provider error: ${errorCode || 'api_error'}`,
  ].filter(Boolean).join('\n');
  return redactNativeProviderText(diagnostic, CLAUDE_STRUCTURED_ERROR_MAX_BYTES);
}

/**
 * True once the current attempt produced at least one stream-json record.
 * `-p --output-format stream-json` always opens with a `system` init record,
 * so a run without any record never started its session.
 */
function claudeStreamStarted(ctx: NativeCliTurnContext): boolean {
  const seen = ctx.state.claudeStreamRecordAttempt;
  return typeof seen === 'number' && seen === Number(ctx.state.turnAttempt || 0);
}

/**
 * Claude Code 2.1.314+ reports a `-p` startup failure as a non-zero exit with
 * an error; 2.1.309 and older exit 0 with no output at all. Both mean the
 * session never started, and neither may settle as an empty answer.
 */
function claudeStartupFailureMessage(ctx: NativeCliTurnContext): string {
  const detail = redactNativeProviderText(ctx.stderr.trim(), CLAUDE_STRUCTURED_ERROR_MAX_BYTES);
  const how = ctx.exitCode === 0
    ? 'exited without any output'
    : `exited with code ${ctx.exitCode} before any output`;
  return `Claude Code could not start the session: it ${how}.${detail ? ` ${detail}` : ''}`;
}

function getToolUseId(value: any): string | null {
  return typeof value?.tool_use_id === 'string' ? value.tool_use_id
    : typeof value?.toolUseId === 'string' ? value.toolUseId
      : typeof value?.id === 'string' ? value.id
        : null;
}

function getClaudeToolUses(ctx: NativeCliTurnContext): Record<string, any> {
  if (!ctx.state.claudeToolUses || typeof ctx.state.claudeToolUses !== 'object') {
    ctx.state.claudeToolUses = {};
  }
  return ctx.state.claudeToolUses as Record<string, any>;
}

function getClaudeStringSet(ctx: NativeCliTurnContext, key: string): Set<string> {
  const current = ctx.state[key];
  if (current instanceof Set) return current;
  const next = new Set<string>();
  ctx.state[key] = next;
  return next;
}

function markClaudeNativeSessionEstablished(
  ctx: NativeCliTurnContext,
  candidateSessionId?: unknown,
): void {
  const candidate = typeof candidateSessionId === 'string' ? candidateSessionId.trim() : '';
  const nativeSessionId = candidate
    || (typeof ctx.state.nativeSessionId === 'string' ? ctx.state.nativeSessionId.trim() : '')
    || (typeof ctx.session.metadata?.nativeSessionId === 'string'
      ? ctx.session.metadata.nativeSessionId.trim()
      : '');
  if (!nativeSessionId) return;
  ctx.state.nativeSessionId = nativeSessionId;
  ctx.updateSessionMetadata({ nativeSessionId, nativeSessionEstablished: true });
}

function startClaudeTool(ctx: NativeCliTurnContext, tool: any): void {
  const toolCallId = getToolUseId(tool);
  if (!toolCallId || getClaudeStringSet(ctx, 'claudeStartedTools').has(toolCallId)) return;
  getClaudeStringSet(ctx, 'claudeStartedTools').add(toolCallId);
  getClaudeToolUses(ctx)[toolCallId] = tool;
  ctx.emitStatus(`Claude is using ${String(tool?.name || 'a tool')}`, {
    type: 'tool_start',
    toolName: String(tool?.name || 'tool'),
    toolCallId,
    toolArgs: asRecord(tool?.input),
  });
}

function updateClaudeTool(ctx: NativeCliTurnContext, toolCallId: string, update: unknown): void {
  if (!toolCallId || getClaudeStringSet(ctx, 'claudeEndedTools').has(toolCallId)) return;
  ctx.emitStatus('Claude tool input updated', {
    type: 'tool_update',
    toolCallId,
    toolArgsDelta: update,
  });
}

function endClaudeTool(ctx: NativeCliTurnContext, result: any): void {
  const toolCallId = getToolUseId(result);
  if (!toolCallId || getClaudeStringSet(ctx, 'claudeEndedTools').has(toolCallId)) return;
  getClaudeStringSet(ctx, 'claudeEndedTools').add(toolCallId);
  const tool = getClaudeToolUses(ctx)[toolCallId];
  const content = typeof result?.content === 'string'
    ? result.content
    : Array.isArray(result?.content)
      ? result.content.map((entry: any) => String(entry?.text || entry?.content || '')).filter(Boolean).join('\n')
      : '';
  ctx.emitStatus(content || (result?.is_error ? 'Claude tool failed' : 'Claude tool completed'), {
    type: 'tool_end',
    toolName: String(tool?.name || result?.name || 'tool'),
    toolCallId,
    toolResult: content,
    isError: result?.is_error === true,
  });
}

function getDenialInput(denial: any): Record<string, any> {
  const toolInput = asRecord(denial?.tool_input);
  return Object.keys(toolInput).length > 0 ? toolInput : asRecord(denial?.input);
}

function summarizeToolUse(toolUse: any, denial: any): { command: string; allowedTool: string | null; addDir: string | null; resolvedPath?: string } {
  const name = String(toolUse?.name || denial?.tool || denial?.tool_name || denial?.name || 'Claude tool').trim();
  const input = {
    ...getDenialInput(denial),
    ...asRecord(toolUse?.input),
  };

  if (name === 'Bash') {
    const command = String(input.command || denial?.command || '').trim();
    const addDirs = command ? extractAbsolutePathDirs(command) : [];
    return {
      command: command ? `Bash: ${command}` : 'Bash command',
      allowedTool: 'Bash',
      addDir: addDirs[0] || null,
    };
  }

  const filePath = String(input.file_path || input.path || input.notebook_path || denial?.path || '').trim();
  const resolvedPath = filePath || undefined;
  const addDir = filePath && path.isAbsolute(filePath)
    ? (filePath.includes('.') ? path.dirname(filePath) : filePath)
    : null;
  const detail = filePath ? `${name}: ${filePath}` : name;

  return {
    command: `Claude ${detail}`,
    allowedTool: name || null,
    addDir,
    resolvedPath,
  };
}

async function requestApprovalsForDenials(ctx: NativeCliTurnContext, denials: any[]): Promise<boolean> {
  const toolUses = getClaudeToolUses(ctx);
  const approvedTools = new Set<string>(Array.isArray(ctx.state.approvedAllowedTools) ? ctx.state.approvedAllowedTools : []);
  const approvedDirs = new Set<string>(Array.isArray(ctx.state.approvedAddDirs) ? ctx.state.approvedAddDirs : []);
  let approvedAny = false;

  for (const denial of denials) {
    const toolUseId = getToolUseId(denial);
    const toolUse = toolUseId ? toolUses[toolUseId] : null;
    const summary = summarizeToolUse(toolUse, denial);
    const decision = await ctx.requestApproval({
      command: summary.command,
      security: 'native-cli',
      ask: 'Claude Code requested permission to continue this turn.',
      resolvedPath: summary.resolvedPath,
      timeoutMs: 120_000,
    });
    if (decision === 'deny') continue;
    approvedAny = true;
    if (summary.allowedTool) approvedTools.add(summary.allowedTool);
    if (summary.addDir) approvedDirs.add(summary.addDir);
  }

  ctx.state.approvedAllowedTools = Array.from(approvedTools);
  ctx.state.approvedAddDirs = Array.from(approvedDirs);
  return approvedAny;
}

export const claudeCodeAdapter: NativeCliProviderAdapter = {
  providerName: 'CLAUDE_CODE',
  displayName: 'Claude',
  cliCommand: '/usr/bin/claude',
  messageIdPrefix: 'claude-msg',
  initialStatus: 'Claude is thinking…',
  spawnErrorPrefix: 'Failed to spawn claude CLI',
  supportsChatBridge: true,
  supportsChatImages: true,
  assertChatImageModel: assertClaudeImageModel,
  encodeHostStdin: encodeClaudeHostStdin,
  configureSession: async (_userId: string, config: AgentSessionConfig) => ({
    ...config,
    metadata: {
      ...(config.metadata || {}),
      ...(config.executionContext.scope === 'PROJECT_SANDBOX'
        ? {
            cwd: config.executionContext.canonicalRoot,
            projectRuntime: CLAUDE_CODE_PROJECT_RUNTIME,
            sandboxPolicyFingerprint: config.executionContext.policyFingerprint,
          }
        : { nativeSessionId: randomUUID() }),
    },
  }),
  buildInvocation: async (ctx) => {
    const nativeSessionId = typeof ctx.session.metadata?.nativeSessionId === 'string' && ctx.session.metadata.nativeSessionId.trim()
      ? String(ctx.session.metadata.nativeSessionId).trim()
      : ctx.session.sessionId;
    if (ctx.session.executionContext?.scope === 'PROJECT_SANDBOX') {
      const invocation = await buildClaudeCodeProjectInvocation({
        executionContext: ctx.session.executionContext,
        nativeSessionId,
        nativeSessionEstablished: ctx.session.metadata?.nativeSessionEstablished === true,
        model: ctx.session.model,
        message: ctx.message,
        qualification: ctx.session.metadata?.qualification === true,
        turnId: `${ctx.originalSessionId}:${String(ctx.state.turnAttempt || 1)}:${nativeSessionMessageCount(ctx.session)}`,
      });
      ctx.state.nativeSessionId = invocation.nativeSessionId;
      ctx.updateSessionMetadata({ nativeSessionId: invocation.nativeSessionId });
      return invocation;
    }
    const hostSessionId = validateNativeHostSessionId(nativeSessionId, true)!;
    const hostModel = validateNativeHostModel(ctx.session.model);
    validateNativeHostPrompt(ctx.message);
    const stdinText = encodeClaudeHostStdin(ctx);
    const { allowedTools, addDirs } = validateClaudeHostGrants(
      ctx.state.approvedAllowedTools,
      ctx.state.approvedAddDirs,
    );
    const bridge = ctx.chatBridge || null;
    const args = [
      '-p',
      '--verbose',
      '--output-format', 'stream-json',
      '--include-partial-messages',
    ];
    if ((ctx.chatImages || []).length > 0) args.push('--input-format', 'stream-json');
    let env: NodeJS.ProcessEnv | undefined;
    if (bridge) {
      // `--safe-mode` refuses every MCP server, including --mcp-config, so the
      // bridge replaces it with explicit isolation (probed 2.1.295): no
      // settings sources, no user/project CLAUDE.md, skills, hooks, plugins,
      // slash commands or auto-memory, and exactly one MCP server.
      args.push(
        '--setting-sources', '',
        '--strict-mcp-config',
        '--mcp-config', claudeBridgeMcpConfig(bridge),
        '--disable-slash-commands',
        '--settings', '{"autoMemoryEnabled":false}',
        '--permission-mode', 'dontAsk',
      );
      const grants = [...new Set([...CLAUDE_BRIDGE_ALLOWED_TOOLS, ...allowedTools])].sort();
      args.push('--allowedTools', grants.join(' '));
      args.push('--disallowedTools', 'AskUserQuestion');
      env = {
        ...buildNativeCliEnvironment('CLAUDE_CODE'),
        CLAUDE_CODE_DISABLE_AUTO_MEMORY: '1',
        MCP_TOOL_TIMEOUT: String(bridge.launch.toolTimeoutMs),
        // Host runs deliver this environment over the activation socket only.
        ...bridge.launch.env,
      };
    } else {
      args.push(
        // Never inherit host CLAUDE.md, skills, hooks, plugins, MCP servers,
        // permission allowlists, additional directories, or default mode.
        // `dontAsk` denies ungranted tools so the structured denial can cross
        // the Portal approval broker and an exact grant can be retried.
        '--safe-mode',
        '--disable-slash-commands',
        '--strict-mcp-config',
        '--mcp-config', '{"mcpServers":{}}',
        '--setting-sources', '',
        '--permission-mode', 'dontAsk',
      );
      if (allowedTools.length > 0) args.push('--allowedTools', allowedTools.join(' '));
    }
    for (const dir of addDirs) args.push('--add-dir', dir);
    if (ctx.session.metadata?.nativeSessionEstablished === true) {
      args.push('--resume', hostSessionId);
    } else {
      args.push('--session-id', hostSessionId);
    }
    if (hostModel) args.push('--model', hostModel);
    ctx.state.nativeSessionId = hostSessionId;
    return { command: '/usr/bin/claude', args, stdinText, ...(env ? { options: { env } } : {}) };
  },
  handleStdoutLine: (line, ctx) => {
    let parsed: any;
    try {
      parsed = JSON.parse(line.trim());
    } catch {
      return;
    }
    if (parsed && typeof parsed === 'object') {
      ctx.state.claudeStreamRecordAttempt = Number(ctx.state.turnAttempt || 0);
    }

    const structuredError = captureClaudeStructuredError(parsed);
    if (structuredError) {
      const previous = typeof ctx.state.claudeStructuredError === 'string'
        ? ctx.state.claudeStructuredError
        : '';
      ctx.state.claudeStructuredError = redactNativeProviderText(
        [previous, structuredError].filter(Boolean).join('\n'),
        CLAUDE_STRUCTURED_ERROR_MAX_BYTES,
      );
      // Claude Code (observed 2.1.214 through 2.1.228) emits provider API
      // failures as an `assistant` record.
      // Treating that record as an answer leaks an implementation diagnostic
      // into chat and masks the authoritative authentication failure.
      return;
    }

    if (parsed?.type === 'stream_event' && parsed?.event && typeof parsed.event === 'object') {
      const event = parsed.event;
      if (event.type === 'content_block_start' && event.content_block?.type === 'tool_use') {
        const toolCallId = getToolUseId(event.content_block);
        if (toolCallId && Number.isInteger(event.index)) {
          const byIndex = (ctx.state.claudeToolByIndex ||= {}) as Record<string, string>;
          byIndex[String(event.index)] = toolCallId;
        }
        startClaudeTool(ctx, event.content_block);
        return;
      }
      if (event.type === 'content_block_delta') {
        if (event.delta?.type === 'text_delta' && typeof event.delta.text === 'string') {
          ctx.appendFullText(event.delta.text);
          ctx.emitChunk(event.delta.text);
          return;
        }
        if (event.delta?.type === 'thinking_delta' && typeof event.delta.thinking === 'string') {
          ctx.emitStatus(event.delta.thinking, { type: 'thinking' });
          return;
        }
        if (event.delta?.type === 'input_json_delta') {
          const byIndex = (ctx.state.claudeToolByIndex || {}) as Record<string, string>;
          const toolCallId = byIndex[String(event.index)] || '';
          updateClaudeTool(ctx, toolCallId, event.delta.partial_json || '');
          return;
        }
      }
    }

    if (parsed?.type === 'assistant' && Array.isArray(parsed?.message?.content)) {
      for (const part of parsed.message.content) {
        if (part?.type === 'tool_use') startClaudeTool(ctx, part);
        if (part?.type === 'thinking' && typeof part?.thinking === 'string') {
          ctx.emitStatus(part.thinking, { type: 'thinking' });
        }
      }
      const text = parsed.message.content
        .filter((part: any) => part?.type === 'text' && typeof part?.text === 'string')
        .map((part: any) => part.text)
        .join('');
      if (text && text !== ctx.fullText) {
        const delta = text.startsWith(ctx.fullText) ? text.slice(ctx.fullText.length) : text;
        ctx.setFullText(text);
        if (delta) ctx.emitChunk(delta);
      }
      return;
    }

    if (parsed?.type === 'user' && Array.isArray(parsed?.message?.content)) {
      for (const part of parsed.message.content) {
        if (part?.type === 'tool_result') endClaudeTool(ctx, part);
      }
      return;
    }

    if (parsed?.type === 'result') {
      if (typeof parsed?.session_id === 'string' && parsed.session_id.trim()) {
        const resolvedNativeSessionId = parsed.session_id.trim();
        ctx.state.nativeSessionId = resolvedNativeSessionId;
      }
      markClaudeNativeSessionEstablished(ctx, parsed?.session_id);
      if (typeof parsed?.result === 'string' && parsed.result.trim() && !ctx.fullText) {
        const text = parsed.result.trim();
        ctx.setFullText(text);
        ctx.emitChunk(text);
      }
      if (Array.isArray(parsed?.permission_denials)) {
        ctx.state.permissionDenials = [
          ...((ctx.state.permissionDenials as any[]) || []),
          ...parsed.permission_denials,
        ];
      }
      return;
    }

    if (parsed?.type === 'system' && parsed?.subtype === 'init') {
      markClaudeNativeSessionEstablished(ctx, parsed?.session_id);
      ctx.emitStatus('Claude session initialized');
    }
  },
  finalizeTurn: async (ctx) => {
    if (typeof ctx.state.claudeStructuredError === 'string' && ctx.state.claudeStructuredError) {
      throw new Error(ctx.state.claudeStructuredError);
    }
    // Older hosts: exit 0 and no output is a startup failure, not an empty answer.
    // A non-zero exit is reported by the runner through getErrorMessage.
    if (ctx.exitCode === 0 && !claudeStreamStarted(ctx) && !ctx.fullText) {
      throw new Error(claudeStartupFailureMessage(ctx));
    }
    const permissionDenials = (ctx.state.permissionDenials as any[]) || [];
    if (permissionDenials.length > 0) {
      if (ctx.session.executionContext?.scope === 'PROJECT_SANDBOX') {
        ctx.emitStatus('Claude Code denied a request outside the confined Project boundary.', {
          permissionDenials,
        });
        return;
      }
      if (!ctx.state.retryStarted) {
        ctx.emitStatus('Claude is waiting for permission approval…', { permissionDenials });
        const approved = await requestApprovalsForDenials(ctx, permissionDenials);
        if (approved) {
          ctx.state.permissionDenials = [];
          ctx.state.retryRequested = true;
          ctx.emitStatus('Permission approved. Retrying Claude with the approved scope…');
          return;
        }
      }
      ctx.emitStatus('Claude permission request was denied.', { permissionDenials });
    }
  },
  getResultText: (ctx) => ctx.fullText,
  getResultMetadata: (ctx) => ({
    provider: 'claude-cli',
    exitCode: ctx.exitCode,
    permissionDenials: (ctx.state.permissionDenials as any[]) || [],
    model: ctx.session.model || null,
    resolvedSessionId: ctx.session.sessionId,
    nativeSessionId: ctx.state.nativeSessionId || ctx.session.metadata?.nativeSessionId || null,
    nativeSessionEstablished: ctx.session.metadata?.nativeSessionEstablished === true,
  }),
  getErrorMessage: (ctx) => (
    typeof ctx.state.claudeStructuredError === 'string' && ctx.state.claudeStructuredError
      ? ctx.state.claudeStructuredError
      : !claudeStreamStarted(ctx)
        ? claudeStartupFailureMessage(ctx)
        : ctx.stderr || `Claude CLI exited with code ${ctx.exitCode}`
  ),
};
