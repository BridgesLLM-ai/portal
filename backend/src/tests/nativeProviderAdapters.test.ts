import { claudeCodeAdapter } from '../agents/providers/native/adapters/claude';
import { codexAdapter } from '../agents/providers/native/adapters/codex';
import { geminiAdapter } from '../agents/providers/native/adapters/gemini';
import type { NativeCliTurnContext } from '../agents/providers/native/types';
import { buildTranscriptPrompt } from '../agents/providers/NativeSessionStore';

function makeContext(): NativeCliTurnContext {
  const ctx: NativeCliTurnContext = {
    session: {
      sessionId: 'session-1',
      provider: 'CODEX',
      userId: 'user-1',
      createdAt: new Date().toISOString(),
      lastActivityAt: new Date().toISOString(),
      cwd: '/tmp',
      messages: [],
      metadata: {},
    },
    originalSessionId: 'session-1',
    message: 'hello',
    fullText: '',
    lastAssistantMessage: '',
    stderr: '',
    exitCode: 0,
    state: {},
    emitChunk: jest.fn(),
    emitStatus: jest.fn(),
    setFullText: jest.fn((text: string) => { ctx.fullText = text; }),
    appendFullText: jest.fn((text: string) => { ctx.fullText += text; }),
    setLastAssistantMessage: jest.fn((text: string) => { ctx.lastAssistantMessage = text; }),
    appendStderr: jest.fn((text: string) => { ctx.stderr += text; }),
    updateSessionMetadata: jest.fn((metadata: Record<string, unknown>) => {
      ctx.session.metadata = { ...(ctx.session.metadata || {}), ...metadata };
    }),
    rekeySession: jest.fn((nextSessionId: string) => { ctx.session.sessionId = nextSessionId; }),
    stripAnsi: (text: string) => text,
  };
  return ctx;
}

describe('native provider adapters', () => {
  test('Claude adapter streams deltas and records permission denials', () => {
    const ctx = makeContext();
    claudeCodeAdapter.handleStdoutLine(JSON.stringify({
      type: 'assistant',
      message: { content: [{ type: 'text', text: 'Hello' }] },
    }), ctx);
    claudeCodeAdapter.handleStdoutLine(JSON.stringify({
      type: 'assistant',
      message: { content: [{ type: 'text', text: 'Hello there' }] },
    }), ctx);
    claudeCodeAdapter.handleStdoutLine(JSON.stringify({
      type: 'result',
      permission_denials: [{ tool: 'exec' }],
    }), ctx);
    claudeCodeAdapter.finalizeTurn?.(ctx);

    expect(ctx.emitChunk).toHaveBeenNthCalledWith(1, 'Hello');
    expect(ctx.emitChunk).toHaveBeenNthCalledWith(2, ' there');
    expect(ctx.fullText).toBe('Hello there');
    expect(ctx.emitStatus).toHaveBeenCalledWith(
      expect.stringMatching(/permission limits/i),
      expect.objectContaining({ permissionDenials: [{ tool: 'exec' }] }),
    );
  });

  test('Codex adapter rekeys sessions and reports reasoning', () => {
    const ctx = makeContext();
    codexAdapter.handleStdoutLine(JSON.stringify({ type: 'thread.started', thread_id: 'thread-42' }), ctx);
    codexAdapter.handleStdoutLine(JSON.stringify({ type: 'item.completed', item: { type: 'reasoning', text: 'Planning' } }), ctx);
    codexAdapter.handleStdoutLine(JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: 'Done.' } }), ctx);

    expect(ctx.rekeySession).toHaveBeenCalledWith('thread-42');
    expect(ctx.session.metadata?.nativeSessionId).toBe('thread-42');
    expect(ctx.emitStatus).toHaveBeenCalledWith('Planning');
    expect(ctx.fullText).toBe('Done.');
    expect(ctx.emitChunk).toHaveBeenCalledWith('Done.');
  });

  test('Gemini adapter uses transcript prompts and accumulates deltas', () => {
    const prompt = buildTranscriptPrompt([
      { id: '1', role: 'user', content: 'Earlier question', timestamp: new Date().toISOString() },
      { id: '2', role: 'assistant', content: 'Earlier answer', timestamp: new Date().toISOString() },
    ], 'Latest question');
    expect(prompt).toMatch(/Earlier question/);
    expect(prompt).toMatch(/Latest question/);

    const ctx = makeContext();
    geminiAdapter.handleStdoutLine(JSON.stringify({ type: 'thought', subject: 'Searching docs' }), ctx);
    geminiAdapter.handleStdoutLine(JSON.stringify({ type: 'message', role: 'assistant', content: 'Hel', delta: true }), ctx);
    geminiAdapter.handleStdoutLine(JSON.stringify({ type: 'message', role: 'assistant', content: 'lo', delta: true }), ctx);

    expect(ctx.emitStatus).toHaveBeenCalledWith('Searching docs');
    expect(ctx.emitChunk).toHaveBeenNthCalledWith(1, 'Hel');
    expect(ctx.emitChunk).toHaveBeenNthCalledWith(2, 'lo');
    expect(ctx.fullText).toBe('Hello');
  });
});
