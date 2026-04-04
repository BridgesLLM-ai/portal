import { randomUUID } from 'crypto';
import type { AgentSessionConfig } from '../../../AgentProvider.interface';
import type { NativeCliProviderAdapter } from '../types';

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
    const permissionLevel = ctx.state.permissionLevel || 'sandboxed';
    const permissionMode = permissionLevel === 'elevated' ? 'auto' : 'acceptEdits';
    const args = ['-p', '--verbose', '--output-format', 'stream-json', '--include-partial-messages', '--permission-mode', permissionMode];

    // In elevated mode, grant access to the entire filesystem
    if (permissionLevel === 'elevated') {
      args.push('--add-dir', '/');
    }
    if (isFirstTurn) {
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

    const type = parsed?.type;

    // System init — extract model and session info
    if (type === 'system' && parsed?.subtype === 'init') {
      if (parsed.model) ctx.state.claudeModel = parsed.model;
      if (parsed.session_id) {
        ctx.state.nativeSessionId = parsed.session_id;
        ctx.updateSessionMetadata({ nativeSessionId: parsed.session_id });
      }
      ctx.emitStatus('Claude session initialized');
      return;
    }

    // Assistant message — extract text content and tool use blocks
    if (type === 'assistant' && Array.isArray(parsed?.message?.content)) {
      let textContent = '';
      for (const block of parsed.message.content) {
        if (block?.type === 'text' && typeof block?.text === 'string') {
          textContent += block.text;
        }
        // Tool use blocks — surface as tool_start events
        if (block?.type === 'tool_use' && block?.name) {
          ctx.onStatus?.({
            type: 'tool_start',
            content: block.name,
            toolName: block.name,
            toolArgs: block.input || {},
          });
        }
        // Thinking blocks
        if (block?.type === 'thinking' && typeof block?.thinking === 'string' && block.thinking.trim()) {
          ctx.onStatus?.({ type: 'thinking', content: block.thinking });
        }
      }
      if (textContent && textContent !== ctx.fullText) {
        const delta = textContent.startsWith(ctx.fullText) ? textContent.slice(ctx.fullText.length) : textContent;
        ctx.setFullText(textContent);
        if (delta) ctx.emitChunk(delta);
      }
      return;
    }

    // Tool result events from Claude
    if (type === 'tool_result') {
      const toolName = parsed.tool_name || parsed.name || 'tool';
      ctx.onStatus?.({
        type: 'tool_end',
        content: '',
        toolName,
        toolResult: parsed.output || parsed.content,
      });
      return;
    }

    // Result event — final turn summary
    if (type === 'result') {
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
      // Capture usage/cost data
      if (parsed.usage) ctx.state.usage = parsed.usage;
      if (parsed.total_cost_usd != null) ctx.state.totalCostUsd = parsed.total_cost_usd;
      if (parsed.modelUsage) ctx.state.modelUsage = parsed.modelUsage;
      return;
    }

    // Tool result returned to Claude (happens when a tool is blocked by permissions)
    if (type === 'user' && parsed?.tool_use_result && typeof parsed.tool_use_result === 'string') {
      const isBlocked = /blocked|denied|not allowed|permission/i.test(parsed.tool_use_result);
      if (isBlocked) {
        ctx.onStatus?.({
          type: 'tool_end',
          content: parsed.tool_use_result,
          toolName: 'permission_denied',
          toolResult: { error: parsed.tool_use_result, blocked: true },
        });
      }
      return;
    }

    // Rate limit event
    if (type === 'rate_limit_event' && parsed?.rate_limit_info?.status === 'limited') {
      ctx.emitStatus('Claude rate limit reached \u2014 response may be delayed');
      return;
    }
  },
  finalizeTurn: (ctx) => {
    // With --permission-mode auto, Claude Code has broad tool access in print mode.
    // Permission denials should be rare, but log them if they occur.
    const permissionDenials = (ctx.state.permissionDenials as any[]) || [];
    if (permissionDenials.length > 0) {
      ctx.emitStatus(
        `Claude encountered ${permissionDenials.length} permission issue(s) during this turn.`,
        { permissionDenials },
      );
    }
  },
  getResultText: (ctx) => ctx.fullText,
  getResultMetadata: (ctx) => ({
    provider: 'claude-cli',
    exitCode: ctx.exitCode,
    permissionDenials: (ctx.state.permissionDenials as any[]) || [],
    model: ctx.state.claudeModel || ctx.session.model || null,
    resolvedSessionId: ctx.session.sessionId,
    nativeSessionId: ctx.state.nativeSessionId || ctx.session.metadata?.nativeSessionId || null,
    usage: ctx.state.usage || null,
    totalCostUsd: ctx.state.totalCostUsd || null,
    modelUsage: ctx.state.modelUsage || null,
  }),
};
