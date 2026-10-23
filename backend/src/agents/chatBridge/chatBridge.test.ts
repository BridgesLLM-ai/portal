import fs from 'fs';
import os from 'os';
import path from 'path';
import { spawn, type ChildProcessWithoutNullStreams } from 'child_process';
import ts from 'typescript';

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'chat-bridge-test-'));
process.env.PORTAL_NATIVE_AGENT_SESSIONS_DIR = path.join(tempRoot, 'sessions');

/* eslint-disable @typescript-eslint/no-var-requires */
const bridge = require('./index') as typeof import('./index');
const listener = require('./listener') as typeof import('./listener');
const questions = require('./questions') as typeof import('./questions');
const widgetStore = require('./widgetStore') as typeof import('./widgetStore');
const registry = require('./registry') as typeof import('./registry');
const broker = require('../../services/askUserQuestionBroker') as typeof import('../../services/askUserQuestionBroker');
const store = require('../providers/NativeSessionStore') as typeof import('../providers/NativeSessionStore');
/* eslint-enable @typescript-eslint/no-var-requires */

function compileServer(): string {
  const outDir = path.join(tempRoot, 'compiled');
  fs.mkdirSync(outDir, { recursive: true });
  for (const name of ['contract', 'mcpServer']) {
    const source = fs.readFileSync(path.join(__dirname, `${name}.ts`), 'utf8');
    const output = ts.transpileModule(source, {
      compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true },
    }).outputText;
    fs.writeFileSync(path.join(outDir, `${name}.js`), output);
  }
  return path.join(outDir, 'mcpServer.js');
}

class McpClient {
  private nextId = 1;
  private buffer = '';
  private readonly pending = new Map<number, (value: any) => void>();
  constructor(private readonly child: ChildProcessWithoutNullStreams) {
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => {
      this.buffer += chunk;
      let index: number;
      while ((index = this.buffer.indexOf('\n')) >= 0) {
        const line = this.buffer.slice(0, index);
        this.buffer = this.buffer.slice(index + 1);
        if (!line.trim()) continue;
        const message = JSON.parse(line);
        this.pending.get(message.id)?.(message);
        this.pending.delete(message.id);
      }
    });
  }
  request(method: string, params?: unknown): Promise<any> {
    const id = this.nextId++;
    return new Promise((resolve) => {
      this.pending.set(id, resolve);
      this.child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
    });
  }
  close(): void {
    this.child.stdin.end();
  }
}

const binding = {
  provider: 'CODEX' as const,
  portalSessionId: 'codex-user-1-1700000000000-11111111-2222-3333-4444-555555555555',
  runId: 'run-1',
  userId: 'user-1',
  authorizationVersion: 3,
};

let serverPath: string;
let actorAllowed = true;

beforeAll(() => {
  serverPath = compileServer();
  listener.__configureChatBridgeListenerForTests({
    runtimeRoot: path.join(tempRoot, 'run'),
    verifyActor: async () => actorAllowed,
  });
  bridge.__configureChatBridgeForTests({ serverPath });
});

afterEach(() => {
  actorAllowed = true;
  registry.__resetChatBridgeRegistryForTests();
  broker.__resetAskUserQuestionsForTests();
});

afterAll(async () => {
  await listener.closeChatBridgeListener();
  fs.rmSync(tempRoot, { recursive: true, force: true });
});

function startServer(env: Record<string, string>): McpClient {
  const child = spawn(process.execPath, [serverPath], { env: { PATH: process.env.PATH || '', ...env } });
  return new McpClient(child);
}

describe('identifyChatBridgeTool', () => {
  it.each([
    ['mcp__bridgesllm__ask_user', undefined, 'ask_user'],
    ['mcp__bridgesllm__show_widget', undefined, 'show_widget'],
    ['bridgesllm_show_widget', undefined, 'show_widget'],
    ['bridgesllm/ask_user', undefined, 'ask_user'],
    ['bridgesllm: show_widget', undefined, 'show_widget'],
    ['ask_user', 'bridgesllm', 'ask_user'],
  ])('maps %s (server %s)', (name, server, expected) => {
    expect(bridge.identifyChatBridgeTool(name, server)).toEqual({ name: expected });
  });

  it.each([
    ['show_widget', undefined],
    ['mcp__other__show_widget', undefined],
    ['ask_user', 'other'],
    ['mcp__bridgesllm__exec', undefined],
    ['bridgesllm_ask_user_extra', undefined],
  ])('refuses %s (server %s)', (name, server) => {
    expect(bridge.identifyChatBridgeTool(name, server)).toBeNull();
  });
});

describe('Portal Chat Bridge end to end', () => {
  it('lists tools, renders a widget, binds it to the harness call and serves the document', async () => {
    const turn = await bridge.openChatBridgeTurn(binding);
    expect(turn).not.toBeNull();
    expect(turn!.launch.command).toBe(process.execPath);
    expect(turn!.launch.args).toEqual([serverPath]);
    expect(JSON.stringify(turn!.launch.args)).not.toContain(turn!.launch.env.BRIDGESLLM_CHAT_BRIDGE_TOKEN);
    const client = startServer(turn!.launch.env as Record<string, string>);
    try {
      const init = await client.request('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 't', version: '1' } });
      expect(init.result.protocolVersion).toBe('2025-06-18');
      expect(init.result.serverInfo.name).toBe('bridgesllm');
      const tools = await client.request('tools/list', {});
      expect(tools.result.tools.map((tool: any) => tool.name)).toEqual(['ask_user', 'show_widget', 'get_goal', 'update_goal']);
      const noGoal = await client.request('tools/call', { name: 'get_goal', arguments: {} });
      expect(noGoal.result.content[0].text).toMatch(/No Portal goal/);

      const html = '<div id="x">Hello widget</div><script>document.getElementById("x").textContent="ok"</script>';
      const call = await client.request('tools/call', { name: 'show_widget', arguments: { title: 'Demo', widget_code: html } });
      expect(call.result.isError).toBeUndefined();
      const payload = JSON.parse(call.result.content[0].text);
      expect(payload).toMatchObject({ bridgesllm: 'widget', title: 'Demo', status: 'rendered' });

      // A harness reports the MCP result in its own envelope (Codex shape).
      const ref = turn!.bindWidgetResult('item_7', { content: call.result.content, structured_content: null });
      expect(JSON.parse(ref!)).toEqual({ schema: 'bridgesllm.widget-ref.v1', toolCallId: 'item_7', title: 'Demo', mode: 'inline' });
      // Re-binding the same widget to another call is refused.
      expect(turn!.bindWidgetResult('item_8', call.result.content[0].text)).toBeNull();
      expect(widgetStore.readChatBridgeWidgetDocument({ provider: 'CODEX', portalSessionId: binding.portalSessionId, toolCallId: 'item_7' }))
        .toEqual({ title: 'Demo', html });
      expect(widgetStore.readChatBridgeWidgetDocument({ provider: 'CODEX', portalSessionId: binding.portalSessionId, toolCallId: 'nope' }))
        .toBeNull();
    } finally {
      client.close();
      turn!.revoke();
    }
  });

  it('refuses forged widget results and unbound widgets disappear on revoke', async () => {
    const turn = await bridge.openChatBridgeTurn({ ...binding, runId: 'run-forge' });
    const client = startServer(turn!.launch.env as Record<string, string>);
    try {
      await client.request('initialize', { protocolVersion: '2025-03-26' });
      expect(turn!.bindWidgetResult('call-1', JSON.stringify({ bridgesllm: 'widget', widgetId: 'w_'.padEnd(34, 'a') }))).toBeNull();
      const call = await client.request('tools/call', { name: 'show_widget', arguments: { title: 'Orphan', widget_code: '<p>x</p>' } });
      const { widgetId } = JSON.parse(call.result.content[0].text);
      const file = path.join(store.nativeChatBridgeWidgetDirectory('CODEX', binding.portalSessionId), `${widgetId}.html`);
      expect(fs.existsSync(file)).toBe(true);
      turn!.revoke();
      expect(fs.existsSync(file)).toBe(false);
      const after = await client.request('tools/call', { name: 'show_widget', arguments: { title: 'Late', widget_code: '<p>y</p>' } });
      expect(after.result.isError).toBe(true);
      expect(after.result.content[0].text).toMatch(/no longer available/);
    } finally {
      client.close();
    }
  });

  it('holds ask_user open until the owner answers in the Portal', async () => {
    const turn = await bridge.openChatBridgeTurn({ ...binding, runId: 'run-ask' });
    const client = startServer(turn!.launch.env as Record<string, string>);
    try {
      await client.request('initialize', { protocolVersion: '2025-06-18' });
      const pendingCall = client.request('tools/call', {
        name: 'ask_user',
        arguments: { questions: [{ question: 'Deploy now?', header: 'Deploy', options: [{ label: 'Yes' }, { label: 'No' }] }] },
      });
      let open: ReturnType<typeof questions.listBridgeQuestions> = [];
      for (let attempt = 0; attempt < 50 && open.length === 0; attempt += 1) {
        await new Promise((resolve) => setTimeout(resolve, 20));
        open = questions.listBridgeQuestions('user-1', binding.portalSessionId);
      }
      expect(open).toHaveLength(1);
      expect(open[0].questions[0]).toMatchObject({ id: 'q1', question: 'Deploy now?', isOther: true });
      // Another actor cannot see or answer it.
      expect(questions.listBridgeQuestions('user-2', binding.portalSessionId)).toHaveLength(0);
      expect(() => questions.answerBridgeQuestion({ id: open[0].id, actorUserId: 'user-2', answers: { q1: 'Yes' } })).toThrow();
      // OpenClaw runtime reconciliation never cancels a bridge question.
      broker.reconcilePendingAskUserQuestions({ actorUserId: 'user-1', activeCalls: [] });
      expect(questions.listBridgeQuestions('user-1')).toHaveLength(1);

      questions.answerBridgeQuestion({ id: open[0].id, actorUserId: 'user-1', answers: { q1: 'Yes' } });
      const answered = await pendingCall;
      expect(answered.result).toEqual({ content: [{ type: 'text', text: 'Yes' }] });
    } finally {
      client.close();
      turn!.revoke();
    }
  });

  it('withdraws an open question when the turn ends', async () => {
    const turn = await bridge.openChatBridgeTurn({ ...binding, runId: 'run-withdraw' });
    const client = startServer(turn!.launch.env as Record<string, string>);
    try {
      await client.request('initialize', {});
      const pendingCall = client.request('tools/call', { name: 'ask_user', arguments: { questions: [{ question: 'Which one?' }] } });
      for (let attempt = 0; attempt < 50 && questions.listBridgeQuestions('user-1').length === 0; attempt += 1) {
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      turn!.revoke();
      const result = await pendingCall;
      expect(result.result.isError).toBe(true);
      expect(questions.listBridgeQuestions('user-1')).toHaveLength(0);
    } finally {
      client.close();
    }
  });

  it('rejects calls once the actor authorization changed', async () => {
    const turn = await bridge.openChatBridgeTurn({ ...binding, runId: 'run-authz' });
    const client = startServer(turn!.launch.env as Record<string, string>);
    try {
      await client.request('initialize', {});
      actorAllowed = false;
      const call = await client.request('tools/call', { name: 'show_widget', arguments: { title: 'T', widget_code: '<p/>' } });
      expect(call.result.isError).toBe(true);
    } finally {
      client.close();
      turn!.revoke();
    }
  });

  it('refuses a second capability for the same run', async () => {
    const first = await bridge.openChatBridgeTurn({ ...binding, runId: 'run-dup' });
    await expect(bridge.openChatBridgeTurn({ ...binding, runId: 'run-dup' })).rejects.toThrow();
    first!.revoke();
  });
});

describe('native transcript tool activity', () => {
  it('records, bounds and persists tool calls on assistant messages only', () => {
    const recorder = new bridge.NativeToolCallRecorder();
    recorder.observe({ type: 'tool_start', toolCallId: 'toolu_1', toolName: 'Bash', toolArgs: {} });
    recorder.observe({ type: 'tool_update', toolCallId: 'toolu_1', toolArgsDelta: '{"command":' });
    recorder.observe({ type: 'tool_update', toolCallId: 'toolu_1', toolArgsDelta: '"ls -la"}' });
    recorder.observe({ type: 'tool_end', toolCallId: 'toolu_1', toolName: 'Bash', toolResult: 'x'.repeat(40_000) });
    recorder.observe({ type: 'tool_start', toolCallId: 'toolu_2', toolName: 'show_widget', toolArgs: { title: 'T' } });
    recorder.observe({ type: 'status', content: 'ignored' });
    const calls = recorder.snapshot()!;
    expect(calls).toHaveLength(2);
    expect(calls[0]).toMatchObject({ id: 'toolu_1', name: 'Bash', status: 'done', arguments: { command: 'ls -la' } });
    expect(Buffer.byteLength(calls[0].result!)).toBeLessThanOrEqual(16 * 1024);
    expect(calls[1]).toMatchObject({ id: 'toolu_2', status: 'error' });

    const session = store.createNativeSession('CODEX', 'user-1', {
      executionContext: { scope: 'HOST_OPERATOR', source: 'PORTAL_SERVER', userId: 'user-1' },
      metadata: { cwd: tempRoot },
    });
    store.appendNativeMessages(session, [
      { id: 'u1', role: 'user', content: 'hi', timestamp: new Date().toISOString(), toolCalls: calls },
      { id: 'a1', role: 'assistant', content: 'done', timestamp: new Date().toISOString(), toolCalls: calls },
    ]);
    const history = store.readAllNativeSessionHistory('CODEX', session.sessionId);
    expect(history[0].toolCalls).toBeUndefined();
    expect(history[1].toolCalls).toHaveLength(2);
    // Runtime context never carries tool activity.
    expect(store.loadNativeSession('CODEX', session.sessionId)!.messages.every((message) => !message.toolCalls)).toBe(true);
    store.deleteNativeSession('CODEX', session.sessionId);
  });

  it('drops malformed persisted records', () => {
    expect(bridge.sanitizeNativeToolCalls([{ id: '../x', name: 'a' }, { id: 'ok', name: 'b\u0000c', status: 'weird' }, 'junk']))
      .toEqual([{ id: 'ok', name: 'bc', status: 'done' }]);
  });
});
