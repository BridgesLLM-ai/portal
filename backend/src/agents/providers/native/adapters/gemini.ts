import { execFile } from 'child_process';
import { buildTranscriptPrompt } from '../../NativeSessionStore';
import type { NativeCliProviderAdapter, NativeCliTurnContext } from '../types';
import { firstAbsolutePathDir, looksLikeFilesystemOrToolRequest, looksLikePermissionFailure } from '../approvalScope';

type GeminiApprovalMode = 'default' | 'auto_edit' | 'yolo' | 'plan';

async function runGeminiText(prompt: string, cwd: string, model?: string, approvalMode: GeminiApprovalMode = 'default'): Promise<string> {
  const args = ['-p', prompt, '--output-format', 'text', '--skip-trust', '--approval-mode', approvalMode];
  if (model) args.push('--model', model);
  return new Promise((resolve, reject) => {
    execFile('gemini', args, { cwd, env: process.env, maxBuffer: 1024 * 1024 * 8 }, (err, stdout, stderr) => {
      if (err && !stdout) return reject(new Error((stderr || err.message || 'Gemini text fallback failed').trim()));
      resolve((stdout || '').trim());
    });
  });
}

function getGeminiToolApprovalMode(ctx: NativeCliTurnContext): GeminiApprovalMode {
  return ctx.state.geminiToolExecutionApproved === true ? 'yolo'
    : ctx.state.geminiToolExecutionDenied === true ? 'plan'
      : 'default';
}

async function prepareGeminiApprovalMode(ctx: NativeCliTurnContext, prompt: string): Promise<GeminiApprovalMode> {
  if (!looksLikeFilesystemOrToolRequest(prompt)) return 'default';
  if (ctx.state.geminiToolApprovalAsked) return getGeminiToolApprovalMode(ctx);

  ctx.state.geminiToolApprovalAsked = true;
  ctx.emitStatus('Gemini CLI is waiting for command approval…');
  const decision = await ctx.requestApproval({
    command: 'Gemini CLI tool execution for this turn',
    security: 'native-cli',
    ask: 'Gemini CLI headless mode needs approval before running file, shell, or tool actions.',
    resolvedPath: firstAbsolutePathDir(prompt) || undefined,
    timeoutMs: 120_000,
  });
  if (decision === 'deny') {
    ctx.state.geminiToolExecutionDenied = true;
    ctx.emitStatus('Gemini tool execution was denied. Continuing in read-only plan mode.');
    return 'plan';
  }
  ctx.state.geminiToolExecutionApproved = true;
  ctx.emitStatus('Command approved. Running Gemini with tool execution enabled…');
  return 'yolo';
}

export const geminiAdapter: NativeCliProviderAdapter = {
  providerName: 'GEMINI',
  displayName: 'Gemini CLI',
  cliCommand: 'gemini',
  messageIdPrefix: 'gemini-msg',
  initialStatus: 'Running Gemini CLI...',
  spawnErrorPrefix: 'Failed to spawn gemini CLI',
  buildInvocation: async (ctx) => {
    const prompt = buildTranscriptPrompt(ctx.session.messages.slice(0, -1), ctx.message);
    ctx.state.prompt = prompt;
    const approvalMode = await prepareGeminiApprovalMode(ctx, prompt);
    ctx.state.geminiApprovalMode = approvalMode;
    const args = ['-p', prompt, '--output-format', 'stream-json', '--skip-trust', '--approval-mode', approvalMode];
    if (ctx.session.model) args.push('--model', ctx.session.model);
    return { command: 'gemini', args };
  },
  handleStdoutLine: (line, ctx) => {
    let parsed: any;
    try {
      parsed = JSON.parse(line.trim());
    } catch {
      return;
    }

    if (parsed?.type === 'message' && parsed?.role === 'assistant' && typeof parsed?.content === 'string') {
      if (parsed?.delta) {
        ctx.appendFullText(parsed.content);
        ctx.emitChunk(parsed.content);
      } else if (!ctx.fullText) {
        ctx.setFullText(parsed.content);
        ctx.emitChunk(parsed.content);
      }
      return;
    }

    if (parsed?.type === 'thought' && typeof parsed?.subject === 'string') {
      ctx.emitStatus(parsed.subject);
      return;
    }

    if (parsed?.type === 'tool_use' && typeof parsed?.tool_name === 'string') {
      ctx.onStatus?.({
        type: 'tool_start',
        content: `Gemini is using ${parsed.tool_name}`,
        toolName: parsed.tool_name,
        toolArgs: parsed.parameters || {},
        toolCallId: parsed.tool_id,
      });
      return;
    }

    if (parsed?.type === 'tool_result') {
      const output = typeof parsed.output === 'string' ? parsed.output : '';
      if (parsed?.status === 'error' && looksLikePermissionFailure(output || JSON.stringify(parsed.error || {}))) {
        ctx.state.geminiApprovalCandidate = {
          command: String(parsed.tool_name || 'Gemini CLI tool'),
          addDir: firstAbsolutePathDir(output || JSON.stringify(parsed.parameters || {})),
        };
      }
      ctx.onStatus?.({
        type: 'tool_end',
        content: output,
        toolName: parsed.tool_name,
        toolResult: parsed.output,
        status: parsed.status,
        toolCallId: parsed.tool_id,
      });
      return;
    }

    if (parsed?.type === 'error') {
      ctx.appendStderr(`${parsed?.message || 'Gemini error'}\n`);
    }
  },
  finalizeTurn: async (ctx) => {
    const candidate = ctx.state.geminiApprovalCandidate;
    if (candidate && !ctx.state.retryStarted && !ctx.state.geminiToolExecutionApproved) {
      ctx.emitStatus('Gemini CLI is waiting for command approval…', { permissionDenials: [candidate] });
      const decision = await ctx.requestApproval({
        command: String(candidate.command || 'Gemini CLI tool execution'),
        security: 'native-cli',
        ask: 'Gemini CLI needs tool execution approval to continue this turn.',
        resolvedPath: typeof candidate.addDir === 'string' ? candidate.addDir : undefined,
        timeoutMs: 120_000,
      });
      if (decision !== 'deny') {
        ctx.state.geminiToolExecutionApproved = true;
        ctx.state.geminiToolExecutionDenied = false;
        ctx.state.geminiApprovalCandidate = null;
        ctx.state.retryRequested = true;
        ctx.emitStatus('Permission approved. Retrying Gemini with tool execution enabled…');
        return;
      }
      ctx.emitStatus('Gemini tool execution was denied.', { permissionDenials: [candidate] });
    }
    if (ctx.fullText) return;
    const fallback = await runGeminiText(
      String(ctx.state.prompt || ''),
      ctx.session.cwd,
      ctx.session.model,
      (ctx.state.geminiApprovalMode as GeminiApprovalMode) || getGeminiToolApprovalMode(ctx),
    );
    ctx.setFullText(ctx.stripAnsi(fallback).trim());
  },
  getResultText: (ctx) => ctx.fullText,
  getResultMetadata: (ctx) => ({
    provider: 'gemini-cli',
    exitCode: ctx.exitCode,
    model: ctx.session.model || null,
    resolvedSessionId: ctx.session.sessionId,
  }),
  getErrorMessage: (ctx) => ctx.stripAnsi(ctx.stderr).trim() || `Gemini CLI exited with code ${ctx.exitCode}`,
};
