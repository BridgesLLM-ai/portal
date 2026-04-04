import { execFile } from 'child_process';
import { buildTranscriptPrompt } from '../../NativeSessionStore';
import type { NativeCliProviderAdapter } from '../types';

async function runGeminiText(prompt: string, cwd: string, model?: string): Promise<string> {
  const args = ['-p', prompt, '--output-format', 'text'];
  if (model) args.push('--model', model);
  return new Promise((resolve, reject) => {
    execFile('gemini', args, { cwd, env: process.env, maxBuffer: 1024 * 1024 * 8 }, (err, stdout, stderr) => {
      if (err && !stdout) return reject(new Error((stderr || err.message || 'Gemini text fallback failed').trim()));
      resolve((stdout || '').trim());
    });
  });
}

export const geminiAdapter: NativeCliProviderAdapter = {
  providerName: 'GEMINI',
  displayName: 'Gemini CLI',
  cliCommand: 'gemini',
  messageIdPrefix: 'gemini-msg',
  initialStatus: 'Running Gemini CLI...',
  spawnErrorPrefix: 'Failed to spawn gemini CLI',
  buildInvocation: (ctx) => {
    const prompt = buildTranscriptPrompt(ctx.session.messages.slice(0, -1), ctx.message);
    ctx.state.prompt = prompt;
    const permissionLevel = ctx.state.permissionLevel || 'sandboxed';
    const approvalFlag = permissionLevel === 'elevated' ? '--yolo' : '--approval-mode';
    const args = permissionLevel === 'elevated'
      ? ['-p', prompt, '--output-format', 'stream-json', '--yolo']
      : ['-p', prompt, '--output-format', 'stream-json', '--approval-mode', 'auto_edit'];
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

    const type = parsed?.type;

    // Init event — extract session/model info
    if (type === 'init') {
      if (parsed.model) ctx.state.geminiModel = parsed.model;
      if (parsed.session_id) ctx.state.geminiSessionId = parsed.session_id;
      return;
    }

    // Assistant message (streaming delta or full)
    if (type === 'message' && parsed?.role === 'assistant' && typeof parsed?.content === 'string') {
      if (parsed?.delta) {
        ctx.appendFullText(parsed.content);
        ctx.emitChunk(parsed.content);
      } else if (!ctx.fullText) {
        ctx.setFullText(parsed.content);
        ctx.emitChunk(parsed.content);
      }
      return;
    }

    // Tool call events
    if (type === 'tool_call') {
      const toolName = parsed.name || parsed.tool || 'tool';
      ctx.onStatus?.({ type: 'tool_start', content: toolName, toolName, toolArgs: parsed.args || parsed.input });
      return;
    }

    if (type === 'tool_result') {
      const toolName = parsed.name || parsed.tool || 'tool';
      ctx.onStatus?.({ type: 'tool_end', content: '', toolName, toolResult: parsed.output || parsed.result });
      return;
    }

    // Thinking events
    if (type === 'thought' && typeof parsed?.subject === 'string') {
      ctx.onStatus?.({ type: 'thinking', content: parsed.subject });
      return;
    }

    // Result event — extract stats
    if (type === 'result') {
      ctx.state.geminiStats = parsed.stats || null;
      return;
    }

    if (type === 'error') {
      ctx.appendStderr(`${parsed?.message || 'Gemini error'}\n`);
    }
  },
  finalizeTurn: async (ctx) => {
    if (ctx.fullText) return;
    const fallback = await runGeminiText(String(ctx.state.prompt || ''), ctx.session.cwd, ctx.session.model);
    ctx.setFullText(ctx.stripAnsi(fallback).trim());
  },
  getResultText: (ctx) => ctx.fullText,
  getResultMetadata: (ctx) => ({
    provider: 'gemini-cli',
    exitCode: ctx.exitCode,
    model: ctx.state.geminiModel || ctx.session.model || null,
    resolvedSessionId: ctx.session.sessionId,
    stats: ctx.state.geminiStats || null,
  }),
  getErrorMessage: (ctx) => ctx.stripAnsi(ctx.stderr).trim() || `Gemini CLI exited with code ${ctx.exitCode}`,
};
