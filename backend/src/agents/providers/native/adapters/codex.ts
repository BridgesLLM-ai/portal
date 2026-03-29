import type { NativeCliProviderAdapter } from '../types';

export const codexAdapter: NativeCliProviderAdapter = {
  providerName: 'CODEX',
  displayName: 'Codex',
  cliCommand: 'codex',
  messageIdPrefix: 'codex-msg',
  initialStatus: 'Codex is working…',
  spawnErrorPrefix: 'Failed to spawn codex CLI',
  buildInvocation: (ctx) => {
    const nativeSessionId = typeof ctx.session.metadata?.nativeSessionId === 'string' && ctx.session.metadata.nativeSessionId.trim()
      ? String(ctx.session.metadata.nativeSessionId).trim()
      : null;
    ctx.state.nativeSessionId = nativeSessionId;
    const args = nativeSessionId
      ? ['exec', 'resume', nativeSessionId, '--skip-git-repo-check', '--json']
      : ['exec', '--skip-git-repo-check', '--color', 'never', '--json'];
    if (ctx.session.model) args.push('--model', ctx.session.model);
    args.push(ctx.message);
    return { command: 'codex', args };
  },
  handleStdoutLine: (line, ctx) => {
    let parsed: any;
    try {
      parsed = JSON.parse(line.trim());
    } catch {
      const plain = ctx.stripAnsi(line.trim());
      if (plain) {
        ctx.setFullText(ctx.fullText ? `${ctx.fullText}
${plain}` : plain);
        ctx.emitChunk(`${plain}
`);
      }
      return;
    }

    const type = parsed?.type;
    if (type === 'thread.started' && typeof parsed?.thread_id === 'string' && parsed.thread_id.trim()) {
      const resolvedThreadId = parsed.thread_id.trim();
      ctx.rekeySession(resolvedThreadId);
      ctx.state.nativeSessionId = resolvedThreadId;
      ctx.updateSessionMetadata({ nativeSessionId: resolvedThreadId });
      ctx.onStatus?.({ type: 'session', sessionId: resolvedThreadId });
      return;
    }

    if (type === 'item.completed' && parsed?.item?.type === 'agent_message' && parsed?.item?.text) {
      const text = String(parsed.item.text).trim();
      ctx.setLastAssistantMessage(text);
      if (text) {
        ctx.emitChunk(text);
        ctx.setFullText(text);
      }
      return;
    }

    if (type === 'item.completed' && parsed?.item?.type === 'reasoning' && parsed?.item?.text) {
      ctx.emitStatus(String(parsed.item.text));
      return;
    }
  },
  getResultText: (ctx) => ctx.fullText || ctx.lastAssistantMessage,
  getResultMetadata: (ctx) => ({
    provider: 'codex-cli',
    exitCode: ctx.exitCode,
    model: ctx.session.model || null,
    resolvedSessionId: ctx.session.sessionId,
    nativeSessionId: ctx.state.nativeSessionId || ctx.session.metadata?.nativeSessionId || null,
  }),
};
