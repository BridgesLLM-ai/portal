import { buildTranscriptPrompt, nativeSessionMessageCount } from '../../NativeSessionStore';
import type { NativeCliProviderAdapter, NativeCliTurnContext } from '../types';
import { NativeProviderDiagnosticError } from '../NativeProviderDiagnostics';
import { firstAbsolutePathDir, looksLikeFilesystemOrToolRequest } from '../approvalScope';
import {
  ANTIGRAVITY_PROJECT_RUNTIME,
  buildAntigravityProjectInvocation,
} from '../projectSandbox/AntigravityProjectSandbox';

type AntigravityApprovalMode = 'sandbox' | 'trusted';

function normalizeAntigravityModel(model?: string | null): string | null {
  const raw = String(model || '').trim();
  if (!raw) return null;
  const modelName = raw
    .replace(/^google-antigravity\//, '')
    .replace(/^google-gemini-cli\//, '')
    .replace(/^google\//, '');
  switch (modelName) {
    case 'gemini-3-flash-preview':
    case 'gemini-3-flash':
      return 'gemini-3.5-flash';
    case 'gemini-3.1-pro-preview':
      return 'gemini-3.1-pro-high';
    case 'gemini-3-pro-preview':
    case 'gemini-3-pro-high':
      return 'gemini-3.1-pro-high';
    case 'gemini-3.1-flash-lite':
    case 'gemini-3.1-flash-lite-preview':
      return 'gemini-3.5-flash';
    default:
      return modelName;
  }
}

function parseAntigravityActionLine(line: string): { toolName: string; action: string } | null {
  const clean = line.trim().replace(/\s+/g, ' ');
  const match = clean.match(/^(?:[-*]\s*)?(?:I(?:'ll| will| am going to| need to| should| can)|I'm going to)\s+(.+?)[.!?]?$/i);
  const action = match?.[1]?.trim();
  if (!action) return null;

  if (!/^(list|run|read|inspect|check|search|open|create|write|update|modify|delete|edit|look|view|analy[sz]e|examine|use|confirm)\b/i.test(action)) {
    return null;
  }

  let toolName = 'antigravity';
  if (/^(run|execute)\b/i.test(action)) toolName = 'shell';
  else if (/^(list|inspect|check|look|view|examine|confirm)\b/i.test(action)) toolName = 'inspect';
  else if (/^(read|open)\b/i.test(action)) toolName = 'read';
  else if (/^search\b/i.test(action)) toolName = 'search';
  else if (/^(create|write|update|modify|delete|edit)\b/i.test(action)) toolName = 'edit';

  return { toolName, action };
}

function emitAntigravityToolEvent(ctx: NativeCliTurnContext, actionLine: string): boolean {
  const parsed = parseAntigravityActionLine(actionLine);
  if (!parsed) return false;

  const counter = Number(ctx.state.antigravityToolEventCounter || 0) + 1;
  ctx.state.antigravityToolEventCounter = counter;
  const toolCallId = `antigravity-tool-${Date.now()}-${counter}`;

  ctx.emitStatus(`Antigravity: ${parsed.action}`, {
    type: 'tool_start',
    toolName: parsed.toolName,
    toolCallId,
    toolArgs: { action: parsed.action },
    content: parsed.action,
  });
  ctx.emitStatus(parsed.action, {
    type: 'tool_end',
    toolName: parsed.toolName,
    toolCallId,
    toolResult: parsed.action,
    content: parsed.action,
  });
  return true;
}

function startAntigravityWorkspaceTool(ctx: NativeCliTurnContext): void {
  if (ctx.state.antigravityWorkspaceToolCallId) return;
  const toolCallId = `antigravity-workspace-${Date.now()}`;
  ctx.state.antigravityWorkspaceToolCallId = toolCallId;
  ctx.emitStatus('Antigravity workspace tools approved', {
    type: 'tool_start',
    toolName: 'antigravity',
    toolCallId,
    toolArgs: { mode: 'trusted workspace execution' },
    content: 'Antigravity workspace tools approved',
  });
}

function finishAntigravityWorkspaceTool(ctx: NativeCliTurnContext, failed = false): void {
  const toolCallId = typeof ctx.state.antigravityWorkspaceToolCallId === 'string'
    ? ctx.state.antigravityWorkspaceToolCallId
    : '';
  if (!toolCallId || ctx.state.antigravityWorkspaceToolFinished) return;
  ctx.state.antigravityWorkspaceToolFinished = true;
  const content = failed
    ? 'Antigravity workspace execution ended without a completed response'
    : 'Antigravity workspace turn completed';
  ctx.emitStatus(content, {
    type: 'tool_end',
    toolName: 'antigravity',
    toolCallId,
    toolResult: content,
    content,
    isError: failed,
  });
}

function getAntigravityToolApprovalMode(ctx: NativeCliTurnContext): AntigravityApprovalMode {
  return ctx.state.antigravityToolExecutionApproved === true ? 'trusted' : 'sandbox';
}

async function prepareAntigravityApprovalMode(ctx: NativeCliTurnContext, prompt: string): Promise<AntigravityApprovalMode> {
  if (!looksLikeFilesystemOrToolRequest(prompt)) return 'sandbox';
  if (ctx.state.antigravityToolApprovalAsked) return getAntigravityToolApprovalMode(ctx);

  ctx.state.antigravityToolApprovalAsked = true;
  ctx.emitStatus('Antigravity is waiting for command approval...');
  const decision = await ctx.requestApproval({
    command: 'Antigravity tool execution for this turn',
    security: 'native-cli',
    ask: 'Antigravity can run file, shell, or tool actions for this request. Approve only if you want it to operate in the project workspace.',
    resolvedPath: firstAbsolutePathDir(prompt) || undefined,
    timeoutMs: 120_000,
  });
  if (decision === 'deny') {
    ctx.state.antigravityToolExecutionDenied = true;
    ctx.emitStatus('Antigravity tool execution was denied. Running in sandbox mode.');
    return 'sandbox';
  }
  ctx.state.antigravityToolExecutionApproved = true;
  ctx.emitStatus('Command approved. Running Antigravity with workspace tool execution enabled...');
  return 'trusted';
}

export const geminiAdapter: NativeCliProviderAdapter = {
  providerName: 'GEMINI',
  displayName: 'Google Antigravity',
  cliCommand: 'agy',
  messageIdPrefix: 'gemini-msg',
  initialStatus: 'Running Google Antigravity...',
  spawnErrorPrefix: 'Failed to spawn Antigravity CLI',
  configureSession: (_userId, config) => {
    if (config.executionContext.scope !== 'PROJECT_SANDBOX') return config;
    return {
      ...config,
      metadata: {
        ...(config.metadata || {}),
        cwd: config.executionContext.canonicalRoot,
        projectRuntime: ANTIGRAVITY_PROJECT_RUNTIME,
        sandboxPolicyFingerprint: config.executionContext.policyFingerprint,
      },
    };
  },
  buildInvocation: async (ctx) => {
    if (ctx.session.executionContext?.scope === 'PROJECT_SANDBOX') {
      const nativeSessionId = typeof ctx.session.metadata?.nativeSessionId === 'string'
        ? ctx.session.metadata.nativeSessionId
        : null;
      return buildAntigravityProjectInvocation({
        executionContext: ctx.session.executionContext,
        nativeSessionId,
        model: ctx.session.model,
        message: ctx.message,
        qualification: ctx.session.metadata?.qualification === true,
        turnId: `${ctx.originalSessionId}:${String(ctx.state.turnAttempt || 1)}:${nativeSessionMessageCount(ctx.session)}`,
      });
    }
    const prompt = buildTranscriptPrompt(ctx.session.messages.slice(0, -1), ctx.message);
    const approvalMode = await prepareAntigravityApprovalMode(ctx, prompt);
    const args = ['--print-timeout', '5m', '--add-dir', ctx.session.cwd];
    const model = normalizeAntigravityModel(ctx.session.model);
    if (model) args.push('--model', model);
    if (approvalMode === 'trusted') {
      startAntigravityWorkspaceTool(ctx);
      args.push('--dangerously-skip-permissions');
    } else {
      args.push('--sandbox');
    }
    args.push('--print', prompt);
    // The auto-update guard is applied by the sanitized native-CLI environment
    // (NativeCliEnvironment), which deliberately builds a minimal env rather
    // than inheriting the Portal's own — that env holds DATABASE_URL and
    // JWT_SECRET. Do not attach `options.env` here.
    return { command: 'agy', args };
  },
  handleStdoutLine: (line, ctx) => {
    if (ctx.session.executionContext?.scope === 'PROJECT_SANDBOX') {
      let event: any;
      try {
        event = JSON.parse(line);
      } catch {
        return;
      }
      if (event?.portalNativeEvent !== 1 || typeof event?.type !== 'string') return;
      switch (event.type) {
        case 'session': {
          const nativeSessionId = String(event.conversationId || '').trim();
          if (nativeSessionId) {
            ctx.state.nativeSessionId = nativeSessionId;
            ctx.updateSessionMetadata({ nativeSessionId });
          }
          return;
        }
        case 'thinking':
          ctx.emitStatus(String(event.content || ''), { type: 'thinking' });
          return;
        case 'tool_start':
          ctx.emitStatus(String(event.content || event.toolName || 'Antigravity tool started'), {
            type: 'tool_start',
            toolName: String(event.toolName || 'antigravity_tool'),
            toolCallId: String(event.toolCallId || ''),
            toolArgs: event.toolArgs || {},
          });
          return;
        case 'tool_update':
          ctx.emitStatus(String(event.content || 'Antigravity tool updated'), {
            type: 'tool_update',
            toolName: String(event.toolName || 'antigravity_tool'),
            toolCallId: String(event.toolCallId || ''),
            status: String(event.status || 'RUNNING'),
          });
          return;
        case 'tool_end':
          ctx.emitStatus(String(event.content || event.toolResult || 'Antigravity tool completed'), {
            type: 'tool_end',
            toolName: String(event.toolName || 'antigravity_tool'),
            toolCallId: String(event.toolCallId || ''),
            toolResult: String(event.toolResult || ''),
            isError: event.isError === true,
          });
          return;
        case 'text': {
          const text = String(event.content || '');
          if (text) {
            ctx.appendFullText(text);
            ctx.emitChunk(text);
          }
          return;
        }
        case 'error':
          ctx.appendStderr(`${String(event.content || 'Antigravity bridge failed')}\n`);
          return;
        case 'result':
          if (event.conversationId) {
            const nativeSessionId = String(event.conversationId).trim();
            ctx.state.nativeSessionId = nativeSessionId;
            ctx.updateSessionMetadata({ nativeSessionId });
          }
          return;
        default:
          return;
      }
    }
    const clean = ctx.stripAnsi(line).trimEnd();
    if (!clean) return;
    if (emitAntigravityToolEvent(ctx, clean)) return;
    ctx.appendFullText(`${clean}\n`);
    ctx.emitChunk(`${clean}\n`);
  },
  handleStdoutRemainder: (text, ctx) => {
    if (ctx.session.executionContext?.scope === 'PROJECT_SANDBOX') {
      const clean = text.trim();
      if (clean) geminiAdapter.handleStdoutLine(clean, ctx);
      return;
    }
    const clean = ctx.stripAnsi(text).trimEnd();
    if (!clean) return;
    ctx.appendFullText(clean);
    ctx.emitChunk(clean);
  },
  handleStderrChunk: (chunk, ctx) => {
    const clean = ctx.stripAnsi(chunk);
    if (/authentication required|please sign in|paste the authorization code|accounts\.google\.com/i.test(clean)) {
      ctx.emitStatus('Antigravity is waiting for Google sign-in on this server.');
    }
  },
  finalizeTurn: async (ctx) => {
    if (ctx.session.executionContext?.scope === 'PROJECT_SANDBOX') return;
    if (/please sign in|authentication required|paste the authorization code|accounts\.google\.com/i.test(ctx.stderr)) {
      finishAntigravityWorkspaceTool(ctx, true);
      throw new NativeProviderDiagnosticError(
        'AUTH_REQUIRED',
        'Google Antigravity authentication is unavailable. Reconnect it in AI Settings and retry.',
      );
    }
    // A nonzero exit is settled by NativeCliAdapterProvider using the original
    // stderr and exit status. Never launch a second provider process here:
    // the first invocation may already have performed tools or side effects.
    if (typeof ctx.exitCode === 'number' && ctx.exitCode !== 0) {
      finishAntigravityWorkspaceTool(ctx, true);
      return;
    }
    if (ctx.fullText) {
      finishAntigravityWorkspaceTool(ctx);
      return;
    }
    finishAntigravityWorkspaceTool(ctx, true);
    throw new NativeProviderDiagnosticError(
      'PROVIDER_FAILED',
      'Google Antigravity completed without an assistant response. The turn was not retried to prevent duplicate work.',
    );
  },
  getResultText: (ctx) => ctx.fullText,
  getResultMetadata: (ctx) => ({
    provider: 'google-antigravity',
    exitCode: ctx.exitCode,
    model: ctx.session.model || null,
    resolvedSessionId: ctx.session.sessionId,
    nativeSessionId: ctx.state.nativeSessionId || ctx.session.metadata?.nativeSessionId || null,
  }),
  getErrorMessage: (ctx) => {
    const stderr = ctx.stripAnsi(ctx.stderr).trim();
    if (/please sign in|authentication required|paste the authorization code|accounts\.google\.com/i.test(stderr)) {
      return 'Google Antigravity is installed but not signed in on this server. Open AI Setup, run the Antigravity native login, and paste the Google authorization code.';
    }
    return stderr || `Antigravity CLI exited with code ${ctx.exitCode}`;
  },
};
