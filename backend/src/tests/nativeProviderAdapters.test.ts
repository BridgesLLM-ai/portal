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
    onStatus: jest.fn(),
    fullText: '',
    lastAssistantMessage: '',
    stderr: '',
    exitCode: 0,
    state: {},
    emitChunk: jest.fn(),
    emitStatus: jest.fn(),
    onExecApproval: jest.fn(),
    setFullText: jest.fn((text: string) => { ctx.fullText = text; }),
    appendFullText: jest.fn((text: string) => { ctx.fullText += text; }),
    setLastAssistantMessage: jest.fn((text: string) => { ctx.lastAssistantMessage = text; }),
    appendStderr: jest.fn((text: string) => { ctx.stderr += text; }),
    requestApproval: jest.fn(async () => 'deny'),
    updateSessionMetadata: jest.fn((metadata: Record<string, unknown>) => {
      ctx.session.metadata = { ...(ctx.session.metadata || {}), ...metadata };
    }),
    rekeySession: jest.fn((nextSessionId: string) => { ctx.session.sessionId = nextSessionId; }),
    stripAnsi: (text: string) => text,
  };
  return ctx;
}

describe('native provider adapters', () => {
  test('Claude adapter streams deltas and records denied permission requests', async () => {
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
    await claudeCodeAdapter.finalizeTurn?.(ctx);

    expect(ctx.emitChunk).toHaveBeenNthCalledWith(1, 'Hello');
    expect(ctx.emitChunk).toHaveBeenNthCalledWith(2, ' there');
    expect(ctx.fullText).toBe('Hello there');
    expect(ctx.requestApproval).toHaveBeenCalledWith(expect.objectContaining({
      command: 'Claude exec',
      security: 'native-cli',
    }));
    expect(ctx.emitStatus).toHaveBeenCalledWith(
      expect.stringMatching(/permission request was denied/i),
      expect.objectContaining({ permissionDenials: [{ tool: 'exec' }] }),
    );
  });

  test('Claude adapter turns an approved permission request into retry scope', async () => {
    const ctx = makeContext();
    (ctx.requestApproval as jest.Mock).mockResolvedValueOnce('allow-once');

    claudeCodeAdapter.handleStdoutLine(JSON.stringify({
      type: 'assistant',
      message: {
        content: [
          {
            type: 'tool_use',
            id: 'toolu-1',
            name: 'Bash',
            input: { command: 'printf hi > /tmp/native-approval-test.txt' },
          },
        ],
      },
    }), ctx);
    claudeCodeAdapter.handleStdoutLine(JSON.stringify({
      type: 'result',
      permission_denials: [{ tool_use_id: 'toolu-1' }],
    }), ctx);
    await claudeCodeAdapter.finalizeTurn?.(ctx);

    expect(ctx.requestApproval).toHaveBeenCalledWith(expect.objectContaining({
      command: 'Bash: printf hi > /tmp/native-approval-test.txt',
      ask: expect.stringMatching(/Claude Code requested permission/i),
      resolvedPath: undefined,
    }));
    expect(ctx.state.retryRequested).toBe(true);
    expect(ctx.state.permissionDenials).toEqual([]);
    expect(ctx.state.approvedAllowedTools).toContain('Bash');
    expect(ctx.state.approvedAddDirs).toContain('/tmp');
    expect(ctx.emitStatus).toHaveBeenCalledWith(expect.stringMatching(/Retrying Claude/i));
  });

  test('Codex adapter rekeys sessions and reports reasoning', () => {
    const ctx = makeContext();
    codexAdapter.handleStdoutLine(JSON.stringify({ type: 'thread.started', thread_id: 'thread-42' }), ctx);
    codexAdapter.handleStdoutLine(JSON.stringify({ type: 'item.completed', item: { type: 'reasoning', text: 'Planning' } }), ctx);
    codexAdapter.handleStdoutLine(JSON.stringify({ type: 'item.started', item: { type: 'command_execution', command: 'echo hi' } }), ctx);
    codexAdapter.handleStdoutLine(JSON.stringify({ type: 'item.completed', item: { type: 'command_execution', command: 'echo hi', aggregated_output: 'hi\n', exit_code: 0, status: 'completed' } }), ctx);
    codexAdapter.handleStdoutLine(JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: 'Done.' } }), ctx);

    expect(ctx.rekeySession).toHaveBeenCalledWith('thread-42');
    expect(ctx.session.metadata?.nativeSessionId).toBe('thread-42');
    expect(ctx.emitStatus).toHaveBeenCalledWith('Planning');
    expect(ctx.onStatus).toHaveBeenCalledWith(expect.objectContaining({ type: 'tool_start', toolName: 'shell' }));
    expect(ctx.onStatus).toHaveBeenCalledWith(expect.objectContaining({ type: 'tool_end', toolResult: 'hi\n' }));
    expect(ctx.fullText).toBe('Done.');
    expect(ctx.emitChunk).toHaveBeenCalledWith('Done.');
  });

  test('Codex adapter requests approval and retries with one-turn execution scope after sandbox denial', async () => {
    const ctx = makeContext();
    (ctx.requestApproval as jest.Mock).mockResolvedValueOnce('allow-once');

    codexAdapter.handleStdoutLine(JSON.stringify({ type: 'thread.started', thread_id: 'thread-approval' }), ctx);
    codexAdapter.handleStdoutLine(JSON.stringify({
      type: 'item.completed',
      item: {
        type: 'agent_message',
        text: "I couldn't write `/tmp/codex-approval.txt`: the path is read-only outside the workspace.",
      },
    }), ctx);
    await codexAdapter.finalizeTurn?.(ctx);

    expect(ctx.requestApproval).toHaveBeenCalledWith(expect.objectContaining({
      command: expect.stringContaining('/tmp/codex-approval.txt'),
      ask: expect.stringMatching(/Codex CLI needs broader execution scope/i),
      resolvedPath: '/tmp',
    }));
    expect(ctx.state.retryRequested).toBe(true);
    expect(ctx.state.codexApprovedExecution).toBe(true);

    const invocation = await codexAdapter.buildInvocation(ctx);
    expect(invocation.args).toContain('--dangerously-bypass-approvals-and-sandbox');
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
    geminiAdapter.handleStdoutLine(JSON.stringify({ type: 'tool_use', tool_name: 'run_shell_command', tool_id: 'tool-1', parameters: { command: 'echo hi' } }), ctx);
    geminiAdapter.handleStdoutLine(JSON.stringify({ type: 'tool_result', tool_id: 'tool-1', status: 'success', output: 'hi\n' }), ctx);
    geminiAdapter.handleStdoutLine(JSON.stringify({ type: 'message', role: 'assistant', content: 'Hel', delta: true }), ctx);
    geminiAdapter.handleStdoutLine(JSON.stringify({ type: 'message', role: 'assistant', content: 'lo', delta: true }), ctx);

    expect(ctx.emitStatus).toHaveBeenCalledWith('Searching docs');
    expect(ctx.onStatus).toHaveBeenCalledWith(expect.objectContaining({ type: 'tool_start', toolName: 'run_shell_command' }));
    expect(ctx.onStatus).toHaveBeenCalledWith(expect.objectContaining({ type: 'tool_end', toolResult: 'hi\n' }));
    expect(ctx.emitChunk).toHaveBeenNthCalledWith(1, 'Hel');
    expect(ctx.emitChunk).toHaveBeenNthCalledWith(2, 'lo');
    expect(ctx.fullText).toBe('Hello');
  });

  test('Gemini adapter asks before enabling headless tool execution', async () => {
    const ctx = makeContext();
    ctx.message = 'Write exactly hi to /tmp/gemini-approval.txt using a command.';
    (ctx.requestApproval as jest.Mock).mockResolvedValueOnce('allow-once');

    const invocation = await geminiAdapter.buildInvocation(ctx);

    expect(ctx.requestApproval).toHaveBeenCalledWith(expect.objectContaining({
      command: 'Gemini CLI tool execution for this turn',
      ask: expect.stringMatching(/Gemini CLI headless mode needs approval/i),
      resolvedPath: '/tmp',
    }));
    expect(invocation.args).toContain('--approval-mode');
    expect(invocation.args).toContain('yolo');
  });

  test('Gemini adapter falls back to plan mode when tool execution is denied', async () => {
    const ctx = makeContext();
    ctx.message = 'Run a shell command to inspect /tmp.';
    (ctx.requestApproval as jest.Mock).mockResolvedValueOnce('deny');

    const invocation = await geminiAdapter.buildInvocation(ctx);

    expect(ctx.state.geminiToolExecutionDenied).toBe(true);
    expect(invocation.args).toContain('--approval-mode');
    expect(invocation.args).toContain('plan');
  });
});
