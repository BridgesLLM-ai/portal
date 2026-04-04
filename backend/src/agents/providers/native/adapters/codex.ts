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
    const permissionLevel = ctx.state.permissionLevel || 'sandboxed';
    const permFlag = permissionLevel === 'elevated'
      ? '--dangerously-bypass-approvals-and-sandbox'
      : '--full-auto';

    const args = nativeSessionId
      ? ['exec', 'resume', '--skip-git-repo-check', '--json', permFlag, nativeSessionId]
      : ['exec', '--skip-git-repo-check', '--color', 'never', '--json', permFlag];
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
        ctx.setFullText(ctx.fullText ? `${ctx.fullText}\n${plain}` : plain);
        ctx.emitChunk(`${plain}\n`);
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

    if (type === 'turn.started') {
      ctx.emitStatus('Codex is working\u2026');
      return;
    }

    // Command execution started — surface as tool_start for the UI
    if (type === 'item.started' && parsed?.item?.type === 'command_execution') {
      const cmd = parsed.item.command || 'Running command';
      ctx.onStatus?.({ type: 'tool_start', content: cmd, toolName: 'shell', toolArgs: { command: cmd } });
      return;
    }

    // Command execution completed — surface as tool_end with output
    if (type === 'item.completed' && parsed?.item?.type === 'command_execution') {
      const cmd = parsed.item.command || 'command';
      const exitCode = parsed.item.exit_code;
      const output = parsed.item.aggregated_output || '';
      // Truncate very long output for status display
      const truncated = output.length > 500 ? output.slice(0, 500) + '\n... (truncated)' : output;
      ctx.onStatus?.({ type: 'tool_end', content: `Exit ${exitCode}`, toolName: 'shell', toolResult: { command: cmd, exitCode, output: truncated } });
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
      ctx.onStatus?.({ type: 'thinking', content: String(parsed.item.text) });
      return;
    }

    // Turn completed — extract usage metadata
    if (type === 'turn.completed' && parsed?.usage) {
      ctx.state.usage = parsed.usage;
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
    usage: ctx.state.usage || null,
  }),
};
