import type { NativeCliProviderAdapter } from '../types';
import { firstAbsolutePathDir, looksLikePermissionFailure } from '../approvalScope';

function markCodexApprovalCandidate(ctx: Parameters<NativeCliProviderAdapter['handleStdoutLine']>[1], detail: {
  command?: string;
  text?: string;
  toolName?: string;
}): boolean {
  const text = [detail.command, detail.text].filter(Boolean).join('\n');
  if (!looksLikePermissionFailure(text)) return false;
  ctx.state.codexApprovalCandidate = {
    command: detail.command || detail.text || 'Codex CLI command',
    toolName: detail.toolName || 'shell',
    addDir: firstAbsolutePathDir(text),
  };
  return true;
}

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
    const approvedBypass = ctx.state.codexApprovedExecution === true;
    const args = nativeSessionId
      ? ['exec', 'resume', nativeSessionId, '--skip-git-repo-check', '--json']
      : ['exec', '--skip-git-repo-check', '--color', 'never', '--json'];
    if (approvedBypass) {
      args.push('--dangerously-bypass-approvals-and-sandbox');
    } else if (!nativeSessionId) {
      args.push('--sandbox', 'workspace-write');
    }
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
      if (markCodexApprovalCandidate(ctx, { text, toolName: 'shell' })) {
        ctx.state.codexSuppressedApprovalText = text;
        return;
      }
      ctx.setLastAssistantMessage(text);
      if (text) {
        ctx.emitChunk(text);
        ctx.setFullText(text);
      }
      return;
    }

    if ((type === 'item.started' || type === 'item.completed') && parsed?.item?.type === 'command_execution') {
      const command = typeof parsed.item.command === 'string' ? parsed.item.command : 'shell command';
      const output = typeof parsed.item.aggregated_output === 'string' ? parsed.item.aggregated_output : '';
      if (type === 'item.started') {
        ctx.onStatus?.({
          type: 'tool_start',
          content: `Codex is running ${command}`,
          toolName: 'shell',
          toolArgs: { command },
        });
      } else {
        markCodexApprovalCandidate(ctx, { command, text: output, toolName: 'shell' });
        ctx.onStatus?.({
          type: 'tool_end',
          content: output || `Command exited with ${parsed.item.exit_code ?? 0}`,
          toolName: 'shell',
          toolResult: output,
          status: parsed.item.status,
          exitCode: parsed.item.exit_code,
        });
      }
      return;
    }

    if (type === 'item.completed' && parsed?.item?.type === 'reasoning' && parsed?.item?.text) {
      ctx.emitStatus(String(parsed.item.text));
      return;
    }
  },
  finalizeTurn: async (ctx) => {
    const candidate = ctx.state.codexApprovalCandidate;
    if (!candidate || ctx.state.retryStarted || ctx.state.codexApprovedExecution) return;

    ctx.emitStatus('Codex is waiting for command approval…', { permissionDenials: [candidate] });
    const decision = await ctx.requestApproval({
      command: String(candidate.command || 'Codex CLI command'),
      security: 'native-cli',
      ask: 'Codex CLI needs broader execution scope to continue this turn.',
      resolvedPath: typeof candidate.addDir === 'string' ? candidate.addDir : undefined,
      timeoutMs: 120_000,
    });
    if (decision === 'deny') {
      ctx.emitStatus('Codex permission request was denied.', { permissionDenials: [candidate] });
      ctx.setFullText(String(ctx.state.codexSuppressedApprovalText || 'Codex permission request was denied.'));
      return;
    }

    ctx.state.codexApprovedExecution = true;
    ctx.state.codexApprovalCandidate = null;
    ctx.state.retryRequested = true;
    ctx.emitStatus('Permission approved. Retrying Codex with the approved execution scope…');
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
