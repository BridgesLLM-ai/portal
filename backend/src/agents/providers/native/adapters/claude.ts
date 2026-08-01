import { randomUUID } from 'crypto';
import path from 'path';
import type { AgentSessionConfig } from '../../../AgentProvider.interface';
import type { NativeCliProviderAdapter, NativeCliTurnContext } from '../types';
import { nativeSessionMessageCount } from '../../NativeSessionStore';
import { asRecord, extractAbsolutePathDirs } from '../approvalScope';
import { redactNativeProviderText } from '../NativeProviderDiagnostics';
import {
  CLAUDE_CODE_PROJECT_RUNTIME,
  buildClaudeCodeProjectInvocation,
} from '../projectSandbox/ClaudeCodeProjectSandbox';

const CLAUDE_STRUCTURED_ERROR_MAX_BYTES = 16 * 1024;

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
  cliCommand: 'claude',
  messageIdPrefix: 'claude-msg',
  initialStatus: 'Claude is thinking…',
  spawnErrorPrefix: 'Failed to spawn claude CLI',
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
    const args = ['-p', '--verbose', '--output-format', 'stream-json', '--include-partial-messages'];
    const allowedTools = Array.isArray(ctx.state.approvedAllowedTools) ? ctx.state.approvedAllowedTools.filter(Boolean) : [];
    const addDirs = Array.isArray(ctx.state.approvedAddDirs) ? ctx.state.approvedAddDirs.filter(Boolean) : [];
    if (allowedTools.length > 0) args.push('--allowedTools', allowedTools.join(' '));
    for (const dir of addDirs) args.push('--add-dir', dir);
    if (ctx.session.metadata?.nativeSessionEstablished === true) {
      args.push('--resume', nativeSessionId);
    } else {
      args.push('--session-id', nativeSessionId);
    }
    if (ctx.session.model) args.push('--model', ctx.session.model);
    args.push(ctx.message);
    ctx.state.nativeSessionId = nativeSessionId;
    return { command: 'claude', args };
  },
  handleStdoutLine: (line, ctx) => {
    let parsed: any;
    try {
      parsed = JSON.parse(line.trim());
    } catch {
      return;
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
      // Claude Code (observed 2.1.214 through 2.1.220) emits provider API
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
      : ctx.stderr || `Claude CLI exited with code ${ctx.exitCode}`
  ),
};
