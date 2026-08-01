import type { NativeCliProviderAdapter } from '../types';
import { firstAbsolutePathDir, looksLikePermissionFailure } from '../approvalScope';
import {
  CODEX_PROJECT_RUNTIME,
  buildCodexProjectInvocation,
} from '../projectSandbox/CodexProjectSandbox';

/**
 * Codex produces no summarisable reasoning unless an effort is requested, and
 * no readable summary unless one is asked for. Both are sent on every managed
 * host-operator turn so Agent Chat can show thinking at all. Kept as
 * named constants because they are the seam a user-facing reasoning control
 * will bind to.
 */
const CODEX_REASONING_EFFORT = 'medium';
const CODEX_REASONING_SUMMARY = 'auto';

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
  configureSession: (_userId, config) => {
    if (config.executionContext.scope !== 'PROJECT_SANDBOX') return config;
    return {
      ...config,
      metadata: {
        ...(config.metadata || {}),
        cwd: config.executionContext.canonicalRoot,
        projectRuntime: CODEX_PROJECT_RUNTIME,
        sandboxPolicyFingerprint: config.executionContext.policyFingerprint,
      },
    };
  },
  buildInvocation: (ctx) => {
    const nativeSessionId = typeof ctx.session.metadata?.nativeSessionId === 'string' && ctx.session.metadata.nativeSessionId.trim()
      ? String(ctx.session.metadata.nativeSessionId).trim()
      : null;
    ctx.state.nativeSessionId = nativeSessionId;
    if (ctx.session.executionContext?.scope === 'PROJECT_SANDBOX') {
      return buildCodexProjectInvocation({
        executionContext: ctx.session.executionContext,
        turnId: String(ctx.state.portalRunId || ''),
        nativeSessionId,
        model: ctx.session.model,
        message: ctx.message,
      });
    }
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
    // Portal never asked Codex for a reasoning effort, so every turn
    // ran with `reasoning_effort: null`. Codex still emitted `reasoning` items,
    // but with an empty summary -- nothing to render -- which is why Agent Chat
    // showed no thinking at all while the Session Controls advertised
    // "Stream when supported". The handler below already consumes reasoning
    // text; it was simply never produced.
    args.push('-c', `model_reasoning_effort="${CODEX_REASONING_EFFORT}"`);
    args.push('-c', `model_reasoning_summary="${CODEX_REASONING_SUMMARY}"`);
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
      // The Portal session ID is the immutable local identity for every scope.
      // Codex's thread UUID is provider resume metadata, never a Portal rekey.
      ctx.state.nativeSessionId = resolvedThreadId;
      ctx.updateSessionMetadata({ nativeSessionId: resolvedThreadId });
      if (ctx.session.executionContext?.scope !== 'PROJECT_SANDBOX') {
        ctx.onStatus?.({
          type: 'session',
          sessionId: ctx.session.sessionId,
          nativeSessionId: resolvedThreadId,
        });
      }
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

    if ((type === 'item.started' || type === 'item.updated' || type === 'item.completed') && parsed?.item?.type === 'command_execution') {
      const command = typeof parsed.item.command === 'string' ? parsed.item.command : 'shell command';
      const output = typeof parsed.item.aggregated_output === 'string' ? parsed.item.aggregated_output : '';
      const toolCallId = typeof parsed.item.id === 'string' && parsed.item.id.trim()
        ? parsed.item.id.trim()
        : undefined;
      if (type === 'item.started') {
        ctx.onStatus?.({
          type: 'tool_start',
          content: `Codex is running ${command}`,
          toolName: 'shell',
          toolArgs: { command },
          toolCallId,
        });
      } else if (type === 'item.updated') {
        ctx.onStatus?.({
          type: 'tool_update',
          content: output || `Codex is running ${command}`,
          toolName: 'shell',
          toolResult: output,
          toolCallId,
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
          toolCallId,
        });
      }
      return;
    }

    if (type === 'item.completed' && parsed?.item?.type === 'reasoning') {
      // Codex reports a reasoning item either as plain `text` or as a
      // `summary` array of `summary_text` entries. Only the first shape was
      // read, so a turn that produced a real summary — the common case once an
      // effort is in play — rendered no thinking at all.
      const summaryText = Array.isArray(parsed.item.summary)
        ? parsed.item.summary
          .map((entry: any) => (typeof entry?.text === 'string' ? entry.text : ''))
          .filter((entry: string) => entry.trim().length > 0)
          .join('\n')
        : '';
      const reasoningText = typeof parsed.item.text === 'string' && parsed.item.text.trim()
        ? parsed.item.text
        : summaryText;
      if (reasoningText.trim()) {
        ctx.onStatus?.({ type: 'thinking', content: String(reasoningText) });
      }
      return;
    }
  },
  finalizeTurn: async (ctx) => {
    const candidate = ctx.state.codexApprovalCandidate;
    if (ctx.session.executionContext?.scope === 'PROJECT_SANDBOX') {
      if (candidate) {
        const denialText = String(
          ctx.state.codexSuppressedApprovalText
          || 'Codex could not complete that operation because the Project Sandbox blocked access outside this project.',
        );
        ctx.emitStatus('Codex Project Sandbox blocked an operation outside the project boundary.', {
          permissionDenials: [candidate],
        });
        ctx.setFullText(denialText);
      }
      return;
    }
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
    executionScope: ctx.session.executionContext?.scope || null,
    runtime: ctx.session.executionContext?.scope === 'PROJECT_SANDBOX' ? CODEX_PROJECT_RUNTIME : 'codex-cli',
    resolvedSessionId: ctx.session.sessionId,
    nativeSessionId: ctx.state.nativeSessionId || ctx.session.metadata?.nativeSessionId || null,
  }),
  getErrorMessage: (ctx) => {
    if (ctx.session.executionContext?.scope !== 'PROJECT_SANDBOX') {
      return ctx.stderr || `Codex CLI exited with code ${ctx.exitCode}`;
    }
    const detail = String(ctx.stderr || '').toLowerCase();
    if (/auth|oauth|token|login|unauthori[sz]ed/.test(detail)) {
      return 'Codex authentication is unavailable. Reconnect Codex in AI Settings and retry.';
    }
    if (/model|entitlement|not found|unsupported/.test(detail)) {
      return 'Codex rejected the configured Project model. Choose an available Codex model and retry.';
    }
    return 'The confined Codex Project runtime ended before completing the turn.';
  },
};
