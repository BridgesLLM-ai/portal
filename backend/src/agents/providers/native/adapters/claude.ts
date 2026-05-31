import { randomUUID } from 'crypto';
import path from 'path';
import type { AgentSessionConfig } from '../../../AgentProvider.interface';
import type { NativeCliProviderAdapter, NativeCliTurnContext } from '../types';
import { asRecord, extractAbsolutePathDirs } from '../approvalScope';

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
  configureSession: async (_userId: string, config?: AgentSessionConfig) => ({
    ...config,
    metadata: {
      ...(config?.metadata || {}),
      nativeSessionId: randomUUID(),
    },
  }),
  buildInvocation: (ctx) => {
    const nativeSessionId = typeof ctx.session.metadata?.nativeSessionId === 'string' && ctx.session.metadata.nativeSessionId.trim()
      ? String(ctx.session.metadata.nativeSessionId).trim()
      : ctx.session.sessionId;
    const isFirstTurn = ctx.session.messages.filter((entry) => entry.role === 'user').length <= 1;
    const isRetry = Number(ctx.state.turnAttempt || 0) > 1;
    const args = ['-p', '--verbose', '--output-format', 'stream-json', '--include-partial-messages'];
    const allowedTools = Array.isArray(ctx.state.approvedAllowedTools) ? ctx.state.approvedAllowedTools.filter(Boolean) : [];
    const addDirs = Array.isArray(ctx.state.approvedAddDirs) ? ctx.state.approvedAddDirs.filter(Boolean) : [];
    if (allowedTools.length > 0) args.push('--allowedTools', allowedTools.join(' '));
    for (const dir of addDirs) args.push('--add-dir', dir);
    if (isFirstTurn && !isRetry) {
      args.push('--session-id', nativeSessionId);
    } else {
      args.push('--resume', nativeSessionId);
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

    if (parsed?.type === 'assistant' && Array.isArray(parsed?.message?.content)) {
      for (const part of parsed.message.content) {
        if (part?.type === 'tool_use' && typeof part?.id === 'string') {
          getClaudeToolUses(ctx)[part.id] = part;
          ctx.onStatus?.({
            type: 'tool_start',
            content: `Claude wants to use ${part.name || 'a tool'}`,
            toolName: part.name,
            toolArgs: part.input || {},
          });
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

    if (parsed?.type === 'result') {
      if (typeof parsed?.session_id === 'string' && parsed.session_id.trim()) {
        const resolvedNativeSessionId = parsed.session_id.trim();
        ctx.state.nativeSessionId = resolvedNativeSessionId;
        ctx.updateSessionMetadata({ nativeSessionId: resolvedNativeSessionId });
      }
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
      ctx.emitStatus('Claude session initialized');
    }
  },
  finalizeTurn: async (ctx) => {
    const permissionDenials = (ctx.state.permissionDenials as any[]) || [];
    if (permissionDenials.length > 0) {
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
  }),
};
