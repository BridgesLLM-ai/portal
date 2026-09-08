import { claudeCodeAdapter } from '../agents/providers/native/adapters/claude';
import { codexAdapter } from '../agents/providers/native/adapters/codex';
import { geminiAdapter } from '../agents/providers/native/adapters/gemini';
import { grokAdapter } from '../agents/providers/native/adapters/grok';
import { buildNativeCliEnvironment } from '../agents/providers/native/NativeCliEnvironment';
import type { NativeCliTurnContext } from '../agents/providers/native/types';
import { buildTranscriptPrompt } from '../agents/providers/NativeSessionStore';
import {
  classifyNativeProviderError,
  isNativeProviderAuthFailure,
} from '../agents/providers/native/NativeProviderDiagnostics';

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
    stripAnsi: (text: string) => text,
  };
  return ctx;
}

describe('native provider adapters', () => {
  test('Claude Code structured authentication failures are redacted errors, never assistant text', async () => {
    const ctx = makeContext();
    ctx.session.provider = 'CLAUDE_CODE';
    const capturedFailure = {
      type: 'assistant',
      message: {
        content: [{
          type: 'text',
          text: 'OAuth session expired and could not be refreshed. access_token=do-not-expose-this-value',
        }],
      },
      error: 'authentication_failed',
      isApiErrorMessage: true,
    };

    claudeCodeAdapter.handleStdoutLine(JSON.stringify(capturedFailure), ctx);

    expect(ctx.emitChunk).not.toHaveBeenCalled();
    expect(ctx.fullText).toBe('');
    const diagnostic = claudeCodeAdapter.getErrorMessage?.(ctx) || '';
    expect(diagnostic).toContain('authentication_failed');
    expect(diagnostic).toContain('access_token=[redacted]');
    expect(diagnostic).not.toContain('do-not-expose-this-value');
    expect(Buffer.byteLength(diagnostic, 'utf8')).toBeLessThanOrEqual(16 * 1024);
    expect(isNativeProviderAuthFailure(diagnostic)).toBe(true);
    expect(classifyNativeProviderError('Claude', diagnostic)).toMatchObject({
      code: 'AUTH_REQUIRED',
      message: expect.stringMatching(/authentication is unavailable/i),
    });
    await expect(claudeCodeAdapter.finalizeTurn?.(ctx)).rejects.toThrow(diagnostic);
  });

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

    const approvedRetry = await claudeCodeAdapter.buildInvocation(ctx);
    expect(approvedRetry.args).toEqual(expect.arrayContaining([
      '--safe-mode',
      '--disable-slash-commands',
      '--strict-mcp-config',
      '--mcp-config',
      '{"mcpServers":{}}',
      '--setting-sources',
      '',
      '--permission-mode',
      'dontAsk',
      '--allowedTools',
      'Bash',
      '--add-dir',
      '/tmp',
    ]));
    expect(approvedRetry.args.join(' ')).not.toMatch(/bypassPermissions/i);
  });

  test('Claude pre-spawn retries retain session-id until init or result establishes resume state', async () => {
    const ctx = makeContext();
    ctx.session.provider = 'CLAUDE_CODE';
    ctx.session.metadata = { nativeSessionId: '11111111-1111-4111-8111-111111111111' };
    ctx.state.turnAttempt = 2;

    const retryBeforeSpawn = await claudeCodeAdapter.buildInvocation(ctx);
    expect(retryBeforeSpawn).toEqual({
      command: '/usr/bin/claude',
      args: [
        '-p',
        '--verbose',
        '--output-format',
        'stream-json',
        '--include-partial-messages',
        '--safe-mode',
        '--disable-slash-commands',
        '--strict-mcp-config',
        '--mcp-config',
        '{"mcpServers":{}}',
        '--setting-sources',
        '',
        '--permission-mode',
        'dontAsk',
        '--session-id',
        '11111111-1111-4111-8111-111111111111',
      ],
      stdinText: 'hello',
    });

    claudeCodeAdapter.handleStdoutLine(JSON.stringify({
      type: 'system',
      subtype: 'init',
      session_id: '11111111-1111-4111-8111-111111111111',
    }), ctx);
    expect(ctx.updateSessionMetadata).toHaveBeenCalledWith(expect.objectContaining({
      nativeSessionEstablished: true,
    }));
    const establishedRetry = await claudeCodeAdapter.buildInvocation(ctx);
    expect(establishedRetry).toEqual({
      command: '/usr/bin/claude',
      args: [
        '-p',
        '--verbose',
        '--output-format',
        'stream-json',
        '--include-partial-messages',
        '--safe-mode',
        '--disable-slash-commands',
        '--strict-mcp-config',
        '--mcp-config',
        '{"mcpServers":{}}',
        '--setting-sources',
        '',
        '--permission-mode',
        'dontAsk',
        '--resume',
        '11111111-1111-4111-8111-111111111111',
      ],
      stdinText: 'hello',
    });
  });

  test('Codex host-operator turns use the exact absolute executable and bounded argv', async () => {
    const ctx = makeContext();
    const input = await codexAdapter.buildInvocation(ctx);

    expect(input).toEqual({
      command: '/usr/bin/codex',
      args: [
        'exec',
        '--skip-git-repo-check',
        '--color',
        'never',
        '--json',
        '--sandbox',
        'workspace-write',
        '-c',
        'model_reasoning_effort="medium"',
        '-c',
        'model_reasoning_summary="auto"',
        '-',
      ],
      stdinText: 'hello',
    });
  });

  test('Codex unapproved resume pins workspace-write instead of inheriting local config', async () => {
    const ctx = makeContext();
    ctx.session.metadata = { nativeSessionId: 'thread-unapproved-resume' };

    const input = await codexAdapter.buildInvocation(ctx);

    expect(input).toEqual({
      command: '/usr/bin/codex',
      args: [
        'exec',
        'resume',
        'thread-unapproved-resume',
        '--skip-git-repo-check',
        '--json',
        '-c',
        'sandbox_mode="workspace-write"',
        '-c',
        'model_reasoning_effort="medium"',
        '-c',
        'model_reasoning_summary="auto"',
        '-',
      ],
      stdinText: 'hello',
    });
  });

  test.each([
    '--last',
    'thread id with spaces',
    `thread-${'a'.repeat(512)}`,
  ])('Codex host resume rejects unsafe native session identity %p', async (nativeSessionId) => {
    const ctx = makeContext();
    ctx.session.metadata = { nativeSessionId };

    await expect(codexAdapter.buildInvocation(ctx)).rejects.toThrow(/session identity is invalid/i);
  });

  test.each([
    '',
    'contains\0nul',
    'a'.repeat((256 * 1024) + 1),
  ])('Codex host invocation rejects invalid private prompt bytes', async (message) => {
    const ctx = makeContext();
    ctx.message = message;

    await expect(codexAdapter.buildInvocation(ctx)).rejects.toThrow(/prompt is invalid/i);
  });

  test('host adapters reject unsafe models and Claude capability grants', async () => {
    const codex = makeContext();
    codex.session.model = '--dangerous-option';
    await expect(codexAdapter.buildInvocation(codex)).rejects.toThrow(/model is invalid/i);

    const claude = makeContext();
    claude.session.provider = 'CLAUDE_CODE';
    claude.session.metadata = { nativeSessionId: 'claude-session-safe' };
    claude.state.approvedAllowedTools = ['Bash', 'Bash'];
    await expect(claudeCodeAdapter.buildInvocation(claude)).rejects.toThrow(/duplicates/i);

    claude.state.approvedAllowedTools = ['Bash'];
    claude.state.approvedAddDirs = ['/'];
    await expect(claudeCodeAdapter.buildInvocation(claude)).rejects.toThrow(/add-directory grant is invalid/i);

    claude.state.approvedAddDirs = ['relative/path'];
    await expect(claudeCodeAdapter.buildInvocation(claude)).rejects.toThrow(/add-directory grant is invalid/i);

    claude.state.approvedAddDirs = [];
    claude.state.approvedAllowedTools = ['--bad-tool'];
    await expect(claudeCodeAdapter.buildInvocation(claude)).rejects.toThrow(/allowed-tool grant is invalid/i);
  });

  test('Codex reasoning summaries render as thinking, not just plain text items', () => {
    // Codex reports reasoning either as `text` or as a `summary`
    // array of `summary_text` entries. Only the first shape was read, so real
    // summaries produced no thinking in Agent Chat.
    const ctx = makeContext();
    codexAdapter.handleStdoutLine(JSON.stringify({
      type: 'item.completed',
      item: {
        type: 'reasoning',
        summary: [{ type: 'summary_text', text: '**Analyzing boat crossing sequence constraints**' }],
      },
    }), ctx);

    expect(ctx.onStatus).toHaveBeenCalledWith(expect.objectContaining({
      type: 'thinking',
      content: '**Analyzing boat crossing sequence constraints**',
    }));
  });

  test('Codex adapter preserves the Portal session identity and reports reasoning', () => {
    const ctx = makeContext();
    codexAdapter.handleStdoutLine(JSON.stringify({ type: 'thread.started', thread_id: 'thread-42' }), ctx);
    codexAdapter.handleStdoutLine(JSON.stringify({ type: 'item.completed', item: { type: 'reasoning', text: 'Planning' } }), ctx);
    codexAdapter.handleStdoutLine(JSON.stringify({ type: 'item.started', item: { id: 'cmd-1', type: 'command_execution', command: 'echo hi' } }), ctx);
    codexAdapter.handleStdoutLine(JSON.stringify({ type: 'item.updated', item: { id: 'cmd-1', type: 'command_execution', command: 'echo hi', aggregated_output: 'h' } }), ctx);
    codexAdapter.handleStdoutLine(JSON.stringify({ type: 'item.completed', item: { id: 'cmd-1', type: 'command_execution', command: 'echo hi', aggregated_output: 'hi\n', exit_code: 0, status: 'completed' } }), ctx);
    codexAdapter.handleStdoutLine(JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: 'Done.' } }), ctx);

    expect(ctx.session.sessionId).toBe('session-1');
    expect(ctx.session.metadata?.nativeSessionId).toBe('thread-42');
    expect(ctx.onStatus).toHaveBeenCalledWith(expect.objectContaining({
      type: 'session',
      sessionId: 'session-1',
      nativeSessionId: 'thread-42',
    }));
    expect(ctx.onStatus).toHaveBeenCalledWith({ type: 'thinking', content: 'Planning' });
    expect(ctx.onStatus).toHaveBeenCalledWith(expect.objectContaining({ type: 'tool_start', toolName: 'shell', toolCallId: 'cmd-1' }));
    expect(ctx.onStatus).toHaveBeenCalledWith(expect.objectContaining({ type: 'tool_update', toolResult: 'h', toolCallId: 'cmd-1' }));
    expect(ctx.onStatus).toHaveBeenCalledWith(expect.objectContaining({ type: 'tool_end', toolResult: 'hi\n', toolCallId: 'cmd-1' }));
    expect(ctx.fullText).toBe('Done.');
    expect(ctx.emitChunk).toHaveBeenCalledWith('Done.');
  });

  test('Codex Project sessions retain the Portal key and store the CLI thread as resume metadata', () => {
    const ctx = makeContext();
    ctx.session.executionContext = {
      scope: 'PROJECT_SANDBOX',
      source: 'PORTAL_SERVER',
      userId: 'user-1',
      projectId: 'project-1',
      workspaceOwnerId: 'user-1',
      projectName: 'alpha',
      canonicalRoot: '/tmp',
      rootDevice: '1',
      rootInode: '2',
      rootBirthtimeNs: '3',
      runtimePolicyVersion: 'portal-codex-project-sandbox-v1',
      egressPolicyVersion: 'portal-project-egress-v1',
      runtimeImageDigest: `sha256:${'a'.repeat(64)}`,
      policyFingerprint: 'b'.repeat(64),
    };

    codexAdapter.handleStdoutLine(JSON.stringify({
      type: 'thread.started',
      thread_id: 'thread-project-42',
    }), ctx);

    expect(ctx.session.sessionId).toBe('session-1');
    expect(ctx.session.metadata?.nativeSessionId).toBe('thread-project-42');
    expect(ctx.onStatus).not.toHaveBeenCalledWith(expect.objectContaining({ type: 'session' }));
    expect(codexAdapter.getResultMetadata?.(ctx)).toMatchObject({
      resolvedSessionId: 'session-1',
      nativeSessionId: 'thread-project-42',
    });
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

    const input = await codexAdapter.buildInvocation(ctx);
    expect(input).toEqual({
      command: '/usr/bin/codex',
      args: [
        'exec',
        'resume',
        'thread-approval',
        '--skip-git-repo-check',
        '--json',
        '--dangerously-bypass-approvals-and-sandbox',
        '-c',
        'model_reasoning_effort="medium"',
        '-c',
        'model_reasoning_summary="auto"',
        '-',
      ],
      stdinText: 'hello',
    });
  });

  test('Grok Build legacy headless adapter fails closed in favor of the ACP broker', async () => {
    const ctx = makeContext();
    ctx.session.provider = 'GROK';
    await expect(Promise.resolve().then(() => grokAdapter.buildInvocation(ctx)))
      .rejects.toThrow(/pinned ACP stdio broker/i);
  });

  test('Antigravity streams native deltas once and persists the resumable conversation', async () => {
    const ctx = makeContext();
    geminiAdapter.handleStdoutLine(JSON.stringify({ event: 'init', conversation_id: 'native-conversation-1' }), ctx);
    geminiAdapter.handleStdoutLine(JSON.stringify({ event: 'step_update', step_update: {
      conversation_id: 'native-conversation-1', step_index: 1, state: 'DONE', step_type: 'agent_response', text_delta: '43\n',
    } }), ctx);
    geminiAdapter.handleStdoutRemainder?.(JSON.stringify({ event: 'result', result: {
      conversation_id: 'native-conversation-1', status: 'SUCCESS', response: '43\n',
    } }), ctx);
    await geminiAdapter.finalizeTurn?.(ctx);
    expect(ctx.fullText).toBe('43\n');
    expect(ctx.emitChunk).toHaveBeenCalledTimes(1);
    expect(ctx.session.metadata?.nativeSessionId).toBe('native-conversation-1');
    ctx.message = 'Add 9 to your last answer.';
    ctx.session.messages = [{ id: 'old', role: 'assistant', content: '43', timestamp: new Date().toISOString() }];
    const invocation = await geminiAdapter.buildInvocation(ctx);
    expect(invocation.args).toEqual(expect.arrayContaining(['--output-format', 'stream-json', '--conversation', 'native-conversation-1']));
    expect(invocation.args.at(-1)).toBe(ctx.message);
  });

  test('Antigravity reports actual native tool failures, never tools inferred from prose', async () => {
    const ctx = makeContext();
    geminiAdapter.handleStdoutLine('I will list the current directory.', ctx);
    expect(ctx.emitStatus).not.toHaveBeenCalled();
    const step = { conversation_id: 'native-tools', step_index: 4, step_type: 'tool', tool_name: 'view_file',
      tool_info: { name: 'view_file', parameters: { AbsolutePath: '/tmp/fact.txt' } } };
    geminiAdapter.handleStdoutLine(JSON.stringify({ event: 'step_update', step_update: { ...step, state: 'ACTIVE' } }), ctx);
    const failed = JSON.stringify({ event: 'step_update', step_update: { ...step, state: 'ERROR',
      tool_info: { ...step.tool_info, error: { type: 'TOOL_ERROR', message: 'user denied permission' } } } });
    geminiAdapter.handleStdoutLine(failed, ctx);
    geminiAdapter.handleStdoutLine(failed, ctx);
    expect(ctx.emitStatus).toHaveBeenCalledTimes(2);
    expect(ctx.emitStatus).toHaveBeenNthCalledWith(1, expect.any(String), expect.objectContaining({
      type: 'tool_start', toolName: 'view_file', toolCallId: 'antigravity:native-tools:4',
    }));
    expect(ctx.emitStatus).toHaveBeenNthCalledWith(2, expect.any(String), expect.objectContaining({
      type: 'tool_end', toolCallId: 'antigravity:native-tools:4', isError: true, toolResult: 'user denied permission',
    }));
    geminiAdapter.handleStdoutLine(JSON.stringify({ event: 'result', result: {
      status: 'SUCCESS', response: '', denied_actions: [{ action: 'read_file', display_name: 'ViewFile' }],
    } }), ctx);
    await expect(geminiAdapter.finalizeTurn?.(ctx)).rejects.toMatchObject({ code: 'PERMISSION_DENIED' });
  });

  test('Antigravity requires successful native settlement even when partial text exists', async () => {
    const ctx = makeContext();
    geminiAdapter.handleStdoutLine(JSON.stringify({ event: 'result', result: { status: 'ERROR', response: 'Partial' } }), ctx);
    await expect(geminiAdapter.finalizeTurn?.(ctx)).rejects.toMatchObject({ code: 'PROVIDER_FAILED' });
  });

  test('Antigravity adapter asks before enabling trusted tool execution', async () => {
    const ctx = makeContext();
    ctx.message = 'Write exactly hi to /tmp/antigravity-approval.txt using a command.';
    (ctx.requestApproval as jest.Mock).mockResolvedValueOnce('allow-once');

    const invocation = await geminiAdapter.buildInvocation(ctx);
    geminiAdapter.handleStdoutLine(JSON.stringify({ event: 'result', result: { status: 'SUCCESS', response: 'done' } }), ctx);
    await geminiAdapter.finalizeTurn?.(ctx);

    expect(ctx.requestApproval).toHaveBeenCalledWith(expect.objectContaining({
      command: 'Antigravity tool execution for this turn',
      ask: expect.stringMatching(/Antigravity can run file, shell, or tool actions/i),
      resolvedPath: '/tmp',
    }));
    expect(invocation.command).toBe('agy');
    expect(invocation.args).toContain('--dangerously-skip-permissions');
    // Approval is permission, not evidence that any particular tool ran.
    expect((ctx.emitStatus as jest.Mock).mock.calls.some((call) => call[1]?.type === 'tool_start')).toBe(false);
  });

  test('Antigravity host-operator turns do not attach a raw process environment', async () => {
    // follow-up: the auto-update guard belongs to the sanitized
    // native-CLI environment. Spreading process.env here would hand the child
    // DATABASE_URL and JWT_SECRET, which AntigravityAtMostOnce asserts against.
    const ctx = makeContext();
    const invocation = await geminiAdapter.buildInvocation(ctx);

    expect(invocation.command).toBe('agy');
    expect(invocation.options?.env).toBeUndefined();

    // Dropping `options.env` must not reopen the provider spawns with
    // `invocation.options?.env || buildNativeCliEnvironment(...)`, so the guard
    // has to survive in that fallback, and the secrets must not.
    const spawnEnv = buildNativeCliEnvironment('GEMINI');
    expect(spawnEnv.AGY_CLI_DISABLE_AUTO_UPDATE).toBe('true');
    expect(spawnEnv.DATABASE_URL).toBeUndefined();
    expect(spawnEnv.JWT_SECRET).toBeUndefined();
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

  test('Claude Project transport preserves correlated tool start, update, result, and fail-closed denial', async () => {
    const ctx = makeContext();
    ctx.session.provider = 'CLAUDE_CODE';
    ctx.session.executionContext = {
      scope: 'PROJECT_SANDBOX',
      source: 'PORTAL_SERVER',
      userId: ctx.session.userId,
      projectId: 'project-id',
      workspaceOwnerId: 'owner-id',
      projectName: 'demo',
      canonicalRoot: '/workspace/project',
      rootDevice: '1',
      rootInode: '2',
      rootBirthtimeNs: '3',
      runtimePolicyVersion: 'portal-claude-code-project-sandbox-v1',
      egressPolicyVersion: 'portal-project-egress-v1',
      runtimeImageDigest: `sha256:${'a'.repeat(64)}`,
      policyFingerprint: 'b'.repeat(64),
    };
    claudeCodeAdapter.handleStdoutLine(JSON.stringify({
      type: 'stream_event',
      event: {
        type: 'content_block_start',
        index: 1,
        content_block: { type: 'tool_use', id: 'toolu-project-1', name: 'Read', input: {} },
      },
    }), ctx);
    claudeCodeAdapter.handleStdoutLine(JSON.stringify({
      type: 'stream_event',
      event: {
        type: 'content_block_delta',
        index: 1,
        delta: { type: 'input_json_delta', partial_json: '{"file_path":"index.ts"}' },
      },
    }), ctx);
    claudeCodeAdapter.handleStdoutLine(JSON.stringify({
      type: 'user',
      message: {
        content: [{
          type: 'tool_result',
          tool_use_id: 'toolu-project-1',
          content: 'file contents',
          is_error: false,
        }],
      },
    }), ctx);
    claudeCodeAdapter.handleStdoutLine(JSON.stringify({
      type: 'result',
      permission_denials: [{ tool_use_id: 'toolu-project-2' }],
    }), ctx);
    await claudeCodeAdapter.finalizeTurn?.(ctx);

    expect(ctx.emitStatus).toHaveBeenCalledWith(expect.stringMatching(/using Read/i), expect.objectContaining({
      type: 'tool_start',
      toolCallId: 'toolu-project-1',
      toolName: 'Read',
    }));
    expect(ctx.emitStatus).toHaveBeenCalledWith('Claude tool input updated', expect.objectContaining({
      type: 'tool_update',
      toolCallId: 'toolu-project-1',
    }));
    expect(ctx.emitStatus).toHaveBeenCalledWith('file contents', expect.objectContaining({
      type: 'tool_end',
      toolCallId: 'toolu-project-1',
      toolResult: 'file contents',
    }));
    expect(ctx.requestApproval).not.toHaveBeenCalled();
    expect(ctx.state.retryRequested).not.toBe(true);
    expect(ctx.emitStatus).toHaveBeenCalledWith(
      expect.stringMatching(/outside the confined Project boundary/i),
      expect.objectContaining({ permissionDenials: [{ tool_use_id: 'toolu-project-2' }] }),
    );
  });

  test('Antigravity Project transport maps the native transcript protocol with stable tool IDs and resume identity', async () => {
    const ctx = makeContext();
    ctx.session.provider = 'GEMINI';
    ctx.session.executionContext = {
      scope: 'PROJECT_SANDBOX',
      source: 'PORTAL_SERVER',
      userId: ctx.session.userId,
      projectId: 'project-id',
      workspaceOwnerId: 'owner-id',
      projectName: 'demo',
      canonicalRoot: '/workspace/project',
      rootDevice: '1',
      rootInode: '2',
      rootBirthtimeNs: '3',
      runtimePolicyVersion: 'portal-antigravity-project-sandbox-v1',
      egressPolicyVersion: 'portal-project-egress-v1',
      runtimeImageDigest: `sha256:${'a'.repeat(64)}`,
      policyFingerprint: 'b'.repeat(64),
    };
    const conversationId = '11111111-1111-4111-8111-111111111111';
    const event = (value: Record<string, unknown>) => geminiAdapter.handleStdoutLine(JSON.stringify({
      portalNativeEvent: 1,
      ...value,
    }), ctx);
    event({ type: 'session', conversationId });
    event({ type: 'thinking', content: 'Inspecting the file' });
    event({
      type: 'tool_start',
      toolCallId: `${conversationId}:2:0`,
      toolName: 'view_file',
      toolArgs: '{"path":"index.ts"}',
      content: 'Read index.ts',
    });
    event({
      type: 'tool_update',
      toolCallId: `${conversationId}:2:0`,
      toolName: 'view_file',
      status: 'RUNNING',
      content: 'Reading',
    });
    event({
      type: 'tool_end',
      toolCallId: `${conversationId}:2:0`,
      toolName: 'view_file',
      toolResult: 'source',
      content: 'source',
    });
    event({ type: 'text', content: 'Done.' });
    event({ type: 'result', conversationId, exitCode: 0 });
    await geminiAdapter.finalizeTurn?.(ctx);

    expect(ctx.session.metadata?.nativeSessionId).toBe(conversationId);
    expect(ctx.emitStatus).toHaveBeenCalledWith('Inspecting the file', { type: 'thinking' });
    expect(ctx.emitStatus).toHaveBeenCalledWith('Read index.ts', expect.objectContaining({
      type: 'tool_start',
      toolCallId: `${conversationId}:2:0`,
    }));
    expect(ctx.emitStatus).toHaveBeenCalledWith('Reading', expect.objectContaining({
      type: 'tool_update',
      toolCallId: `${conversationId}:2:0`,
    }));
    expect(ctx.emitStatus).toHaveBeenCalledWith('source', expect.objectContaining({
      type: 'tool_end',
      toolCallId: `${conversationId}:2:0`,
      toolResult: 'source',
    }));
    expect(ctx.emitChunk).toHaveBeenCalledWith('Done.');
    expect(ctx.fullText).toBe('Done.');
  });
});
