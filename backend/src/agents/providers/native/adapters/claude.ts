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
    const args = ['-p', '--verbose', '--output-format', 'stream-json', '--include-partial-messages'];
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

    if (parsed?.type === 'assistant' && Array.isArray(parsed?.message?.content)) {
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
  finalizeTurn: (ctx) => {
    const permissionDenials = (ctx.state.permissionDenials as any[]) || [];
    if (permissionDenials.length > 0) {
      ctx.emitStatus(
        'Claude hit permission limits. Interactive approval bridge still needs implementation for true in-browser approve/deny.',
        { permissionDenials },
      );
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
