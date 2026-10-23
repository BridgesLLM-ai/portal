import fs from 'fs';
import os from 'os';
import path from 'path';
import { EventEmitter } from 'events';
import { PassThrough } from 'stream';
import type { ChildProcessWithoutNullStreams } from 'child_process';

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'acp-chat-bridge-'));
process.env.PORTAL_NATIVE_AGENT_SESSIONS_DIR = path.join(tempRoot, 'sessions');

/* eslint-disable @typescript-eslint/no-var-requires */
const bridge = require('../../../chatBridge') as typeof import('../../../chatBridge');
const listener = require('../../../chatBridge/listener') as typeof import('../../../chatBridge/listener');
const registry = require('../../../chatBridge/registry') as typeof import('../../../chatBridge/registry');
const { NativeChatTurnTools } = require('../NativeChatTurnTools') as typeof import('../NativeChatTurnTools');
const { AcpStdioBroker } = require('./AcpStdioBroker') as typeof import('./AcpStdioBroker');
const { OPENCODE_ACP_PROFILE, OPENCODE_ACP_VERSION } = require('./AcpHarnessProfiles') as typeof import('./AcpHarnessProfiles');
const { acpBridgeMcpServers, acpBridgeToolResolver } = require('./AcpChatBridge') as typeof import('./AcpChatBridge');
/* eslint-enable @typescript-eslint/no-var-requires */

const SESSION_ID = 'ses_bridge_1';

function fakeAgent(options: { image: boolean; onPrompt?: (send: (payload: unknown) => void, sessionId: string) => void }) {
  const emitter = new EventEmitter() as ChildProcessWithoutNullStreams;
  const stdin = new PassThrough();
  const stdout = new PassThrough();
  const received: Array<Record<string, any>> = [];
  const send = (payload: unknown) => stdout.write(`${JSON.stringify(payload)}\n`);
  Object.assign(emitter, {
    stdin,
    stdout,
    stderr: new PassThrough(),
    pid: undefined,
    kill: jest.fn(() => {
      queueMicrotask(() => emitter.emit('close', 0, null));
      return true;
    }),
  });
  let input = '';
  stdin.on('data', (chunk) => {
    input += chunk.toString('utf8');
    let newline = input.indexOf('\n');
    while (newline >= 0) {
      const message = JSON.parse(input.slice(0, newline));
      input = input.slice(newline + 1);
      received.push(message);
      queueMicrotask(() => {
        if (message.method === 'initialize') {
          send({ jsonrpc: '2.0', id: message.id, result: {
            protocolVersion: 1,
            agentInfo: { name: 'OpenCode', version: OPENCODE_ACP_VERSION },
            agentCapabilities: {
              loadSession: true,
              sessionCapabilities: { close: {}, list: {}, resume: {}, fork: {} },
              promptCapabilities: { image: options.image, embeddedContext: true },
            },
            authMethods: [{ id: 'opencode-login' }],
          } });
        } else if (message.method === 'authenticate') {
          send({ jsonrpc: '2.0', id: message.id, result: {} });
        } else if (message.method === 'session/new' || message.method === 'session/load') {
          send({ jsonrpc: '2.0', id: message.id, result: { sessionId: SESSION_ID, configOptions: [] } });
        } else if (message.method === 'session/prompt') {
          options.onPrompt?.(send, SESSION_ID);
          send({ jsonrpc: '2.0', id: message.id, result: { stopReason: 'end_turn' } });
        }
      });
      newline = input.indexOf('\n');
    }
  });
  return { child: emitter, received };
}

const fakeServer = path.join(tempRoot, 'mcpServer.js');
fs.writeFileSync(fakeServer, '// stand-in\n');

beforeAll(() => {
  bridge.__configureChatBridgeForTests({ serverPath: fakeServer, listener: async () => path.join(tempRoot, 'bridge.sock') });
  listener.__configureChatBridgeListenerForTests({ verifyActor: async () => true });
});

afterEach(() => registry.__resetChatBridgeRegistryForTests());

afterAll(() => {
  bridge.__configureChatBridgeForTests({ serverPath: null, listener: null });
  fs.rmSync(tempRoot, { recursive: true, force: true });
});

async function openTools(runId: string) {
  return NativeChatTurnTools.open({
    provider: 'OPENCODE',
    portalSessionId: `opencode-owner-1-1700000000000-${runId}`,
    runId,
    sender: { label: 'owner', userId: 'owner-1', authorizationVersion: 1, requestId: runId },
    bridge: true,
  });
}

describe('ACP Portal Chat Bridge wiring', () => {
  test('offers the bridge in session/new and session/load with the token only in the JSON-RPC env field', async () => {
    const tools = await openTools('run-acp-1');
    const agent = fakeAgent({ image: true });
    const broker = new AcpStdioBroker({
      profile: OPENCODE_ACP_PROFILE,
      cwd: tempRoot,
      environment: { PATH: '/usr/bin:/bin' },
      mcpServers: acpBridgeMcpServers(tools),
      spawnImpl: (() => agent.child) as any,
      controlTimeoutMs: 2_000,
    });
    await broker.start();
    const created = agent.received.find((message) => message.method === 'session/new');
    expect(created?.params.mcpServers).toEqual([{
      name: 'bridgesllm',
      command: process.execPath,
      args: [fakeServer],
      env: [
        { name: 'BRIDGESLLM_CHAT_BRIDGE_SOCKET', value: path.join(tempRoot, 'bridge.sock') },
        { name: 'BRIDGESLLM_CHAT_BRIDGE_TOKEN', value: tools.bridge!.launch.env.BRIDGESLLM_CHAT_BRIDGE_TOKEN },
      ],
    }]);
    await broker.dispose();

    const reloaded = fakeAgent({ image: true });
    const loadBroker = new AcpStdioBroker({
      profile: OPENCODE_ACP_PROFILE,
      cwd: tempRoot,
      environment: { PATH: '/usr/bin:/bin' },
      nativeSessionId: SESSION_ID,
      mcpServers: acpBridgeMcpServers(tools),
      spawnImpl: (() => reloaded.child) as any,
      controlTimeoutMs: 2_000,
    });
    await loadBroker.start();
    expect(reloaded.received.find((message) => message.method === 'session/load')?.params.mcpServers).toHaveLength(1);
    await loadBroker.dispose();
    tools.revoke();
    // Without an open bridge nothing is offered.
    expect(acpBridgeMcpServers(tools)).toEqual([]);
  });

  test('recognises bridge calls from the agent report and binds the structured widget result', async () => {
    const tools = await openTools('run-acp-2');
    const minted = await tools.bridge!.call('show_widget', { title: 'Plan', widget_code: '<p>plan</p>' });
    const events: Array<Record<string, any>> = [];
    const agent = fakeAgent({
      image: true,
      onPrompt: (send, sessionId) => {
        const update = (value: Record<string, unknown>) => send({ jsonrpc: '2.0', method: 'session/update', params: { sessionId, update: value } });
        // Hermes-style report: kind "other", title is the prefixed MCP tool name.
        update({ sessionUpdate: 'tool_call', toolCallId: 'call_w1', title: 'mcp__bridgesllm__show_widget', kind: 'other', status: 'pending', rawInput: { title: 'Plan', widget_code: '<p>plan</p>' } });
        update({ sessionUpdate: 'tool_call_update', toolCallId: 'call_w1', status: 'completed', content: [{ type: 'content', content: { type: 'text', text: minted.text } }] });
        update({ sessionUpdate: 'tool_call', toolCallId: 'call_r1', title: 'Read file', kind: 'read', status: 'pending' });
        update({ sessionUpdate: 'tool_call_update', toolCallId: 'call_r1', status: 'completed', rawOutput: 'contents' });
        update({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'Shown.' } });
      },
    });
    const broker = new AcpStdioBroker({
      profile: OPENCODE_ACP_PROFILE,
      cwd: tempRoot,
      environment: { PATH: '/usr/bin:/bin' },
      mcpServers: acpBridgeMcpServers(tools),
      resolveToolName: acpBridgeToolResolver(tools),
      onStatus: (event) => events.push(tools.project(event)),
      spawnImpl: (() => agent.child) as any,
      controlTimeoutMs: 2_000,
    });
    const result = await broker.prompt('show it');
    expect(result.fullText).toBe('Shown.');
    const widgetEnd = events.find((event) => event.type === 'tool_end' && event.toolCallId === 'call_w1');
    expect(widgetEnd).toMatchObject({ toolName: 'show_widget', isError: false });
    expect(widgetEnd!.rawResult).toBeUndefined();
    expect(JSON.parse(widgetEnd!.toolResult)).toEqual({ schema: 'bridgesllm.widget-ref.v1', toolCallId: 'call_w1', title: 'Plan', mode: 'inline' });
    expect(events.find((event) => event.type === 'tool_start' && event.toolCallId === 'call_w1')?.toolArgs).toEqual({ title: 'Plan' });
    expect(events.find((event) => event.type === 'tool_end' && event.toolCallId === 'call_r1')?.toolName).toBe('read');
    expect(tools.toolCalls()!.map((call) => call.name)).toEqual(['show_widget', 'read']);
    await broker.dispose();
    tools.revoke();
  });

  test('sends image prompt blocks only when initialize advertised promptCapabilities.image', async () => {
    const image = { type: 'image' as const, mimeType: 'image/jpeg' as const, content: '/9j/2Q==', fileName: 'p.jpg', sizeBytes: 3, width: 1, height: 1 };
    const capable = fakeAgent({ image: true });
    const broker = new AcpStdioBroker({
      profile: OPENCODE_ACP_PROFILE, cwd: tempRoot, environment: { PATH: '/usr/bin:/bin' },
      spawnImpl: (() => capable.child) as any, controlTimeoutMs: 2_000,
    });
    await broker.prompt('what colour?', [image]);
    expect(broker.supportsPromptImages).toBe(true);
    expect(capable.received.find((message) => message.method === 'session/prompt')?.params.prompt).toEqual([
      { type: 'text', text: 'what colour?' },
      { type: 'image', mimeType: 'image/jpeg', data: '/9j/2Q==' },
    ]);
    await broker.dispose();

    const textOnly = fakeAgent({ image: false });
    const refusing = new AcpStdioBroker({
      profile: OPENCODE_ACP_PROFILE, cwd: tempRoot, environment: { PATH: '/usr/bin:/bin' },
      spawnImpl: (() => textOnly.child) as any, controlTimeoutMs: 2_000,
    });
    await expect(refusing.prompt('what colour?', [image])).rejects.toMatchObject({ code: 'IMAGE_MODEL_UNSUPPORTED' });
    expect(textOnly.received.some((message) => message.method === 'session/prompt')).toBe(false);
    await expect(refusing.attest()).resolves.toMatchObject({ promptImages: false });
    await refusing.dispose();
  });
});
