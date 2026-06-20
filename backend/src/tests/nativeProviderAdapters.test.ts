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

  test('Antigravity adapter uses transcript prompts and accumulates plain text output', () => {
    const prompt = buildTranscriptPrompt([
      { id: '1', role: 'user', content: 'Earlier question', timestamp: new Date().toISOString() },
      { id: '2', role: 'assistant', content: 'Earlier answer', timestamp: new Date().toISOString() },
    ], 'Latest question');
    expect(prompt).toMatch(/Earlier question/);
    expect(prompt).toMatch(/Latest question/);

    const ctx = makeContext();
    geminiAdapter.handleStdoutLine('Hel', ctx);
    geminiAdapter.handleStdoutRemainder?.('lo', ctx);

    expect(ctx.emitChunk).toHaveBeenNthCalledWith(1, 'Hel\n');
    expect(ctx.emitChunk).toHaveBeenNthCalledWith(2, 'lo');
    expect(ctx.fullText).toBe('Hel\nlo');
  });

  test('Antigravity adapter surfaces printed action lines as tool events', () => {
    const ctx = makeContext();

    geminiAdapter.handleStdoutLine('I will list the current directory.', ctx);
    geminiAdapter.handleStdoutLine('DONE', ctx);

    expect(ctx.emitStatus).toHaveBeenCalledWith(
      expect.stringMatching(/Antigravity: list the current directory/i),
      expect.objectContaining({ type: 'tool_start', toolName: 'inspect' }),
    );
    expect(ctx.emitStatus).toHaveBeenCalledWith(
      'list the current directory',
      expect.objectContaining({ type: 'tool_end', toolName: 'inspect' }),
    );
    expect(ctx.emitChunk).toHaveBeenCalledTimes(1);
    expect(ctx.emitChunk).toHaveBeenCalledWith('DONE\n');
    expect(ctx.fullText).toBe('DONE\n');
  });

  test('Antigravity adapter asks before enabling trusted tool execution', async () => {
    const ctx = makeContext();
    ctx.message = 'Write exactly hi to /tmp/antigravity-approval.txt using a command.';
    (ctx.requestApproval as jest.Mock).mockResolvedValueOnce('allow-once');

    const invocation = await geminiAdapter.buildInvocation(ctx);
    ctx.setFullText('done');
    await geminiAdapter.finalizeTurn?.(ctx);

    expect(ctx.requestApproval).toHaveBeenCalledWith(expect.objectContaining({
      command: 'Antigravity tool execution for this turn',
      ask: expect.stringMatching(/Antigravity can run file, shell, or tool actions/i),
      resolvedPath: '/tmp',
    }));
    expect(invocation.command).toBe('agy');
    expect(invocation.args).toContain('--dangerously-skip-permissions');
    expect(ctx.emitStatus).toHaveBeenCalledWith(
      'Antigravity workspace tools approved',
      expect.objectContaining({ type: 'tool_start', toolName: 'antigravity' }),
    );
    expect(ctx.emitStatus).toHaveBeenCalledWith(
      'Antigravity workspace turn completed',
      expect.objectContaining({ type: 'tool_end', toolName: 'antigravity' }),
    );
  });

  test('Antigravity adapter maps stale model ids and places flags before print prompt', async () => {
    const ctx = makeContext();
    ctx.session.model = 'google-antigravity/gemini-3-flash-preview';
    ctx.message = 'Reply exactly OK.';

    const invocation = await geminiAdapter.buildInvocation(ctx);

    expect(invocation.command).toBe('agy');
    expect(invocation.args).toContain('--model');
    expect(invocation.args[invocation.args.indexOf('--model') + 1]).toBe('gemini-3.5-flash');

    const printIndex = invocation.args.indexOf('--print');
    expect(printIndex).toBeGreaterThan(0);
    expect(invocation.args.slice(printIndex)).toHaveLength(2);
    expect(invocation.args.at(-1)).toMatch(/Reply exactly OK/);

    for (const flag of ['--print-timeout', '--add-dir', '--model', '--sandbox']) {
      expect(invocation.args.indexOf(flag)).toBeGreaterThanOrEqual(0);
      expect(invocation.args.indexOf(flag)).toBeLessThan(printIndex);
    }
  });

  test('Antigravity adapter stays sandboxed when tool execution is denied', async () => {
    const ctx = makeContext();
    ctx.message = 'Run a shell command to inspect /tmp.';
    (ctx.requestApproval as jest.Mock).mockResolvedValueOnce('deny');

    const invocation = await geminiAdapter.buildInvocation(ctx);

    expect(ctx.state.antigravityToolExecutionDenied).toBe(true);
    expect(invocation.command).toBe('agy');
    expect(invocation.args).toContain('--sandbox');
    expect(invocation.args).not.toContain('--dangerously-skip-permissions');
  });
});
