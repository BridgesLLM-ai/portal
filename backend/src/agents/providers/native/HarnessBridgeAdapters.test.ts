import fs from 'fs';
import os from 'os';
import path from 'path';
import type { NativeCliTurnContext } from './types';

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'harness-bridge-adapters-'));
process.env.PORTAL_NATIVE_AGENT_SESSIONS_DIR = path.join(tempRoot, 'sessions');

/* eslint-disable @typescript-eslint/no-var-requires */
const bridge = require('../../chatBridge') as typeof import('../../chatBridge');
const listener = require('../../chatBridge/listener') as typeof import('../../chatBridge/listener');
const registry = require('../../chatBridge/registry') as typeof import('../../chatBridge/registry');
const { NativeChatTurnTools, WIDGET_UNBOUND_RESULT } = require('./NativeChatTurnTools') as typeof import('./NativeChatTurnTools');
const imageFiles = require('./NativeChatImageFiles') as typeof import('./NativeChatImageFiles');
const { claudeCodeAdapter, encodeClaudeHostStdin, CLAUDE_BRIDGE_ALLOWED_TOOLS } = require('./adapters/claude') as typeof import('./adapters/claude');
const { codexAdapter } = require('./adapters/codex') as typeof import('./adapters/codex');
const { createHostOperatorExecutionContext } = require('../../executionScope') as typeof import('../../executionScope');
/* eslint-enable @typescript-eslint/no-var-requires */

const FIXTURES = path.join(__dirname, 'adapters', '__fixtures__');
const USER_ID = 'owner-1';
const fakeServer = path.join(tempRoot, 'mcpServer.js');
fs.writeFileSync(fakeServer, '// compiled bridge server stand-in\n');

function fixtureLines(name: string): string[] {
  return fs.readFileSync(path.join(FIXTURES, name), 'utf8').split('\n').filter((line) => line.trim());
}

let runCounter = 0;
async function openTools(provider: 'CLAUDE_CODE' | 'CODEX', options: { scope?: boolean } = {}) {
  runCounter += 1;
  const portalSessionId = `${provider.toLowerCase()}-${USER_ID}-1700000000000-${String(runCounter).padStart(8, '0')}-2222-3333-4444-555555555555`;
  const tools = await NativeChatTurnTools.open({
    provider,
    portalSessionId,
    runId: `run-${runCounter}`,
    sender: { label: 'owner', userId: USER_ID, authorizationVersion: 2, requestId: `run-${runCounter}` },
    bridge: true,
    scopeToolCallIds: options.scope,
  });
  return { tools, portalSessionId };
}

function context(input: {
  provider: 'CLAUDE_CODE' | 'CODEX';
  tools?: InstanceType<any> | null;
  message?: string;
  images?: Array<{ content: string }>;
  state?: Record<string, any>;
  metadata?: Record<string, unknown>;
}): { ctx: NativeCliTurnContext; events: Array<Record<string, any>> } {
  const events: Array<Record<string, any>> = [];
  const tools = input.tools || NativeChatTurnTools.withoutBridge();
  const images = (input.images || []).map((image) => ({
    type: 'image' as const, mimeType: 'image/jpeg' as const, content: image.content, fileName: 'p.jpg', sizeBytes: 3, width: 1, height: 1,
  }));
  const ctx: NativeCliTurnContext = {
    session: {
      sessionId: 'native-session',
      userId: USER_ID,
      provider: input.provider,
      cwd: tempRoot,
      createdAt: new Date().toISOString(),
      messages: [],
      executionContext: createHostOperatorExecutionContext(USER_ID),
      metadata: input.metadata || (input.provider === 'CLAUDE_CODE' ? { nativeSessionId: 'claude-session-1' } : {}),
    } as any,
    originalSessionId: 'native-session',
    message: input.message || 'hello',
    fullText: '',
    lastAssistantMessage: '',
    stderr: '',
    exitCode: null,
    state: input.state || { portalRunId: 'run-x' },
    emitChunk: () => undefined,
    emitStatus: (content, extra) => { events.push(tools.project({ type: 'status', content, ...(extra || {}) })); },
    setFullText: (text) => { ctx.fullText = text; },
    appendFullText: (text) => { ctx.fullText += text; },
    setLastAssistantMessage: (text) => { ctx.lastAssistantMessage = text; },
    appendStderr: () => undefined,
    requestApproval: async () => 'deny',
    updateSessionMetadata: () => undefined,
    stripAnsi: (text) => text,
    chatBridge: tools.bridgeOpen ? tools.bridge : null,
    chatImages: images,
    materializeChatImageFiles: () => imageFiles.writeNativeChatImageFiles(String(input.state?.portalRunId || 'run-x'), images),
  };
  ctx.onStatus = (event) => ctx.emitStatus(typeof event.content === 'string' ? event.content : '', event as any);
  return { ctx, events };
}

const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xd9]).toString('base64');

beforeAll(() => {
  bridge.__configureChatBridgeForTests({ serverPath: fakeServer, listener: async () => path.join(tempRoot, 'bridge.sock') });
  listener.__configureChatBridgeListenerForTests({ verifyActor: async () => true });
  imageFiles.__configureNativeChatImageFilesForTests(path.join(tempRoot, 'images'));
});

afterEach(() => registry.__resetChatBridgeRegistryForTests());

afterAll(() => {
  bridge.__configureChatBridgeForTests({ serverPath: null, listener: null });
  imageFiles.__configureNativeChatImageFilesForTests(null);
  fs.rmSync(tempRoot, { recursive: true, force: true });
});

describe('Claude Code bridge adapter (real 2.1.295 capture)', () => {
  test('replays the captured MCP call and photo turn into tool events, text and a durable record', async () => {
    const { tools } = await openTools('CLAUDE_CODE');
    const { ctx, events } = context({ provider: 'CLAUDE_CODE', tools });
    for (const line of fixtureLines('claude-2.1.295-bridge-photo.jsonl')) claudeCodeAdapter.handleStdoutLine(line, ctx);
    const ends = events.filter((event) => event.type === 'tool_end');
    expect(ends.map((event) => event.toolName)).toEqual(['ToolSearch', 'mcp__bridgesllm__echo_marker']);
    expect(ends[1].toolResult).toBe('ECHO:CL1:TOKEN=present');
    expect(ctx.fullText).toBe('Blue');
    const calls = tools.toolCalls()!;
    expect(calls.map((call) => [call.name, call.status])).toEqual([['ToolSearch', 'done'], ['mcp__bridgesllm__echo_marker', 'done']]);
    expect(calls[1].arguments).toEqual({ marker: 'CL1' });
    tools.revoke();
  });

  test('canonicalises a captured bridge call and binds only a widget this turn minted', async () => {
    const { tools, portalSessionId } = await openTools('CLAUDE_CODE');
    const minted = await tools.bridge!.call('show_widget', { title: 'Colour choice', widget_code: '<p>blue</p>' });
    expect(minted.isError).toBe(false);
    const lines = fixtureLines('claude-2.1.295-bridge-photo.jsonl').map((line) => line
      .replace(/mcp__bridgesllm__echo_marker/g, 'mcp__bridgesllm__show_widget')
      .replace('"text":"ECHO:CL1:TOKEN=present"', `"text":${JSON.stringify(minted.text)}`));
    const { ctx, events } = context({ provider: 'CLAUDE_CODE', tools });
    for (const line of lines) claudeCodeAdapter.handleStdoutLine(line, ctx);
    const start = events.find((event) => event.type === 'tool_start' && event.toolName === 'show_widget');
    const end = events.find((event) => event.type === 'tool_end' && event.toolName === 'show_widget');
    expect(start).toBeDefined();
    // Widget HTML never travels the bus: argument deltas are dropped.
    expect(events.some((event) => event.toolCallId === end?.toolCallId && event.toolArgsDelta !== undefined)).toBe(false);
    expect(JSON.parse(end!.toolResult)).toEqual({
      schema: 'bridgesllm.widget-ref.v1', toolCallId: end!.toolCallId, title: 'Colour choice', mode: 'inline',
    });
    const record = tools.toolCalls()!.find((call) => call.name === 'show_widget')!;
    expect(record).toMatchObject({ status: 'done', arguments: { title: 'Colour choice' } });
    // A forged result (a widget id this turn never minted) is refused.
    const forged = tools.project({
      type: 'tool_end', toolCallId: 'toolu_forged', toolName: 'mcp__bridgesllm__show_widget',
      toolResult: JSON.stringify({ bridgesllm: 'widget', widgetId: `w_${'a'.repeat(32)}`, title: 'x' }),
    });
    expect(forged).toMatchObject({ toolName: 'show_widget', isError: true, toolResult: WIDGET_UNBOUND_RESULT });
    // A user's own tool that merely calls itself show_widget is not canonicalised.
    expect(tools.project({ type: 'tool_start', toolCallId: 't2', toolName: 'mcp__other__show_widget' }).toolName)
      .toBe('mcp__other__show_widget');
    tools.revoke();
    expect(portalSessionId).toBeTruthy();
  });

  test('replaces --safe-mode with explicit isolation only when the bridge is open', async () => {
    const { tools } = await openTools('CLAUDE_CODE');
    const open = context({ provider: 'CLAUDE_CODE', tools, state: { approvedAllowedTools: ['Read'] } });
    const invocation = await claudeCodeAdapter.buildInvocation(open.ctx);
    expect(invocation.args).not.toContain('--safe-mode');
    expect(invocation.args).toEqual(expect.arrayContaining([
      '--setting-sources', '', '--strict-mcp-config', '--disable-slash-commands',
      '--settings', '{"autoMemoryEnabled":false}', '--permission-mode', 'dontAsk',
      '--disallowedTools', 'AskUserQuestion',
    ]));
    const allowed = invocation.args[invocation.args.indexOf('--allowedTools') + 1].split(' ');
    expect(allowed).toEqual(expect.arrayContaining([...CLAUDE_BRIDGE_ALLOWED_TOOLS, 'Read']));
    // dontAsk denies anything ungranted, so goal tools must be granted too.
    expect(allowed).toEqual(expect.arrayContaining([
      'mcp__bridgesllm__ask_user', 'mcp__bridgesllm__show_widget',
      'mcp__bridgesllm__get_goal', 'mcp__bridgesllm__update_goal',
    ]));
    const mcpConfig = JSON.parse(invocation.args[invocation.args.indexOf('--mcp-config') + 1]);
    expect(mcpConfig).toEqual({ mcpServers: { bridgesllm: { type: 'stdio', command: process.execPath, args: [fakeServer] } } });
    const token = tools.bridge!.launch.env.BRIDGESLLM_CHAT_BRIDGE_TOKEN;
    expect(JSON.stringify(invocation.args)).not.toContain(token);
    expect(invocation.options?.env).toMatchObject({
      BRIDGESLLM_CHAT_BRIDGE_TOKEN: token,
      CLAUDE_CODE_DISABLE_AUTO_MEMORY: '1',
      MCP_TOOL_TIMEOUT: String(15 * 60_000),
      PATH: '/usr/bin:/bin',
    });
    expect(invocation.stdinText).toBe('hello');

    const closed = context({ provider: 'CLAUDE_CODE', tools: null, state: { approvedAllowedTools: ['Read'] } });
    const legacy = await claudeCodeAdapter.buildInvocation(closed.ctx);
    expect(legacy.args).toEqual([
      '-p', '--verbose', '--output-format', 'stream-json', '--include-partial-messages',
      '--safe-mode', '--disable-slash-commands', '--strict-mcp-config', '--mcp-config', '{"mcpServers":{}}',
      '--setting-sources', '', '--permission-mode', 'dontAsk', '--allowedTools', 'Read',
      '--session-id', 'claude-session-1',
    ]);
    expect(legacy.options).toBeUndefined();
    tools.revoke();
  });

  test('sends photos as one stream-json user message that the provider can recompute', async () => {
    const { ctx } = context({ provider: 'CLAUDE_CODE', images: [{ content: JPEG }, { content: JPEG }], message: 'What colour?' });
    const invocation = await claudeCodeAdapter.buildInvocation(ctx);
    expect(invocation.args).toEqual(expect.arrayContaining(['--input-format', 'stream-json']));
    expect(invocation.stdinText).toBe(encodeClaudeHostStdin(ctx));
    expect(invocation.stdinText!.endsWith('\n')).toBe(true);
    expect(JSON.parse(invocation.stdinText!)).toEqual({
      type: 'user',
      message: {
        role: 'user',
        content: [
          { type: 'text', text: 'What colour?' },
          { type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: JPEG } },
          { type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: JPEG } },
        ],
      },
    });
  });

  test('admits photos only for models Claude Code declares', async () => {
    const session = (model?: string) => ({ model, executionContext: createHostOperatorExecutionContext(USER_ID) }) as any;
    await expect(claudeCodeAdapter.assertChatImageModel!(session())).resolves.toBe('claude-code-default');
    await expect(claudeCodeAdapter.assertChatImageModel!(session('haiku'))).resolves.toBe('haiku');
    await expect(claudeCodeAdapter.assertChatImageModel!(session('claude-sonnet-5-5'))).resolves.toBe('claude-sonnet-5-5');
    await expect(claudeCodeAdapter.assertChatImageModel!(session('my-custom-text-model'))).rejects.toMatchObject({ code: 'IMAGE_MODEL_UNSUPPORTED' });
  });
});

describe('Codex bridge adapter (real 0.159.0 captures)', () => {
  test('maps captured mcp_tool_call and web_search items with run-scoped ids', async () => {
    const { tools } = await openTools('CODEX', { scope: true });
    const { ctx, events } = context({ provider: 'CODEX', tools });
    for (const line of fixtureLines('codex-0.159.0-exec-bridge-search.jsonl')) codexAdapter.handleStdoutLine(line, ctx);
    const mcpStart = events.find((event) => event.type === 'tool_start' && event.toolName === 'mcp__bridgesllm__echo_marker');
    const mcpEnd = events.find((event) => event.type === 'tool_end' && event.toolName === 'mcp__bridgesllm__echo_marker');
    expect(mcpStart).toMatchObject({ toolArgs: { marker: 'FIX1' } });
    expect(mcpStart!.toolCallId).toMatch(/^item_6@[0-9a-f]{12}$/);
    expect(mcpEnd).toMatchObject({ toolResult: 'ECHO:FIX1:TOKEN=present', isError: false, toolCallId: mcpStart!.toolCallId });
    const searchStart = events.find((event) => event.type === 'tool_start' && event.toolName === 'web_search');
    const searchEnd = events.find((event) => event.type === 'tool_end' && event.toolName === 'web_search');
    expect(searchStart).toMatchObject({ toolArgs: { query: '' } });
    expect(searchEnd).toMatchObject({ toolArgs: { query: 'BridgesLLM Portal' } });
    expect(searchEnd!.toolResult).toMatch(/github\.com/);
    expect(ctx.fullText).toBe('done');
    const calls = tools.toolCalls()!;
    expect(calls.map((call) => call.name)).toEqual(['shell', 'mcp__bridgesllm__echo_marker', 'web_search']);
    expect(calls[2].arguments).toEqual({ query: 'BridgesLLM Portal' });
    tools.revoke();
  });

  test('projects captured todo_list states to update_plan cards and file_change to path/kind changes', async () => {
    const { tools } = await openTools('CODEX', { scope: true });
    const { ctx, events } = context({ provider: 'CODEX', tools });
    for (const line of fixtureLines('codex-0.159.0-exec-plan-patch.jsonl')) codexAdapter.handleStdoutLine(line, ctx);
    const plans = events.filter((event) => event.type === 'tool_start' && event.toolName === 'update_plan');
    // started (pending) and updated (completed); the identical completed item is not a new card.
    expect(plans.map((event) => event.toolArgs)).toEqual([
      { plan: [{ step: 'create notes.txt', status: 'pending' }, { step: 'edit existing.txt', status: 'pending' }] },
      { plan: [{ step: 'create notes.txt', status: 'completed' }, { step: 'edit existing.txt', status: 'completed' }] },
    ]);
    expect(new Set(plans.map((event) => event.toolCallId)).size).toBe(2);
    const changes = events.filter((event) => event.type === 'tool_end' && event.toolName === 'file_change');
    expect(changes.map((event) => event.toolArgs)).toEqual([
      { changes: [{ path: '/work/notes.txt', kind: 'add' }] },
      { changes: [{ path: '/work/existing.txt', kind: 'update' }] },
    ]);
    expect(changes.every((event) => event.isError === false)).toBe(true);
    expect(tools.toolCalls()!.filter((call) => call.name === 'update_plan')).toHaveLength(2);
    tools.revoke();
  });

  test('configures the bridge with approve mode and env_vars only, and passes photos as --image files', async () => {
    const { tools } = await openTools('CODEX');
    const { ctx } = context({ provider: 'CODEX', tools, images: [{ content: JPEG }], state: { portalRunId: 'run-images' } });
    const invocation = await codexAdapter.buildInvocation(ctx);
    const token = tools.bridge!.launch.env.BRIDGESLLM_CHAT_BRIDGE_TOKEN;
    expect(JSON.stringify(invocation.args)).not.toContain(token);
    expect(invocation.args).toEqual(expect.arrayContaining([
      '-c', `mcp_servers.bridgesllm.command=${JSON.stringify(process.execPath)}`,
      '-c', `mcp_servers.bridgesllm.args=[${JSON.stringify(fakeServer)}]`,
      '-c', 'mcp_servers.bridgesllm.env_vars=["BRIDGESLLM_CHAT_BRIDGE_SOCKET","BRIDGESLLM_CHAT_BRIDGE_TOKEN"]',
      '-c', 'mcp_servers.bridgesllm.tool_timeout_sec=900',
      '-c', 'mcp_servers.bridgesllm.default_tools_approval_mode="approve"',
      '-c', 'tools.update_plan.enabled=true',
    ]));
    expect(invocation.options?.env).toMatchObject({ BRIDGESLLM_CHAT_BRIDGE_TOKEN: token, PATH: '/usr/bin:/bin' });
    const imageIndex = invocation.args.indexOf('--image');
    const file = invocation.args[imageIndex + 1];
    // The variadic --image never swallows the '-' prompt marker.
    expect(invocation.args[imageIndex + 2]).toMatch(/^-c$|^--/);
    expect(invocation.args[invocation.args.length - 1]).toBe('-');
    expect(fs.statSync(file).mode & 0o777).toBe(0o600);
    expect(fs.statSync(path.dirname(file)).mode & 0o777).toBe(0o700);
    expect(fs.readFileSync(file).equals(Buffer.from(JPEG, 'base64'))).toBe(true);
    imageFiles.removeNativeChatImageFiles('run-images');
    expect(fs.existsSync(file)).toBe(false);
    tools.revoke();
  });

  test('admits photos only from Codex model metadata input_modalities', async () => {
    const home = fs.mkdtempSync(path.join(tempRoot, 'codex-home-'));
    const previous = process.env.CODEX_HOME;
    process.env.CODEX_HOME = home;
    try {
      fs.writeFileSync(path.join(home, 'models_cache.json'), JSON.stringify({ models: [
        { slug: 'gpt-vision', input_modalities: ['text', 'image'], visibility: 'list' },
        { slug: 'gpt-text', input_modalities: ['text'], visibility: 'list' },
      ] }));
      const session = (model?: string) => ({ model, executionContext: createHostOperatorExecutionContext(USER_ID) }) as any;
      await expect(codexAdapter.assertChatImageModel!(session('gpt-vision'))).resolves.toBe('gpt-vision');
      await expect(codexAdapter.assertChatImageModel!(session('gpt-text'))).rejects.toMatchObject({ code: 'IMAGE_MODEL_UNSUPPORTED' });
      await expect(codexAdapter.assertChatImageModel!(session('gpt-unknown'))).rejects.toMatchObject({ code: 'IMAGE_MODEL_UNAVAILABLE' });
      // No session model: the configured default decides; with none, every listed model must accept images.
      await expect(codexAdapter.assertChatImageModel!(session())).rejects.toMatchObject({ code: 'IMAGE_MODEL_UNSUPPORTED' });
      fs.writeFileSync(path.join(home, 'config.toml'), 'model = "gpt-vision"\n[profiles.x]\nmodel = "gpt-text"\n');
      await expect(codexAdapter.assertChatImageModel!(session())).resolves.toBe('gpt-vision');
    } finally {
      if (previous === undefined) delete process.env.CODEX_HOME;
      else process.env.CODEX_HOME = previous;
    }
  });
});

describe('NativeChatTurnTools', () => {
  test('runs without the bridge when sender evidence is incomplete and still records tool events', async () => {
    const tools = await NativeChatTurnTools.open({ provider: 'CODEX', portalSessionId: 's', runId: 'r', sender: { label: 'x', userId: '' }, bridge: true });
    expect(tools.bridgeOpen).toBe(false);
    const projected = tools.project({ type: 'tool_start', toolCallId: 'a1', toolName: 'mcp__bridgesllm__show_widget' });
    expect(projected.toolName).toBe('mcp__bridgesllm__show_widget');
    expect(tools.toolCalls()).toHaveLength(1);
  });

  test('revokes exactly once and refuses bridge calls afterwards', async () => {
    const { tools } = await openTools('CODEX');
    const turn = tools.bridge!;
    tools.revoke();
    tools.revoke();
    expect(tools.bridgeOpen).toBe(false);
    await expect(turn.call('show_widget', { title: 't', widget_code: '<p/>' })).resolves.toMatchObject({ isError: true });
    expect(registry.resolveChatBridgeToken(turn.launch.env.BRIDGESLLM_CHAT_BRIDGE_TOKEN)).toBeNull();
  });
});
