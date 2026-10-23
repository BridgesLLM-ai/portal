/**
 * Real local smoke for the Portal Chat Bridge through the actual Claude Code
 * and Codex adapter code: the adapters build argv/env/stdin, the real CLI runs
 * (cheapest settings), the compiled bridge MCP server talks to the real
 * listener, a question is answered through the broker, a widget is bound and
 * a photo is described. Skipped unless PORTAL_REAL_HARNESS_SMOKE is
 * `claude`, `codex` or `all`; it spends real (small) model usage.
 */
import fs from 'fs';
import os from 'os';
import path from 'path';
import { randomUUID } from 'crypto';
import { spawn } from 'child_process';
import ts from 'typescript';
import type { NativeCliProviderAdapter, NativeCliTurnContext } from './types';
import type { NativeChatTurnTools as NativeChatTurnToolsType } from './NativeChatTurnTools';

const selected = String(process.env.PORTAL_REAL_HARNESS_SMOKE || '').trim();
const runClaude = selected === 'claude' || selected === 'all';
const runCodex = selected === 'codex' || selected === 'all';
const describeSmoke = runClaude || runCodex ? describe : describe.skip;

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'harness-bridge-smoke-'));
process.env.PORTAL_NATIVE_AGENT_SESSIONS_DIR = path.join(tempRoot, 'sessions');
const evidenceDir = process.env.PORTAL_REAL_HARNESS_SMOKE_OUT || path.join(tempRoot, 'evidence');

/* eslint-disable @typescript-eslint/no-var-requires */
const bridge = require('../../chatBridge') as typeof import('../../chatBridge');
const listener = require('../../chatBridge/listener') as typeof import('../../chatBridge/listener');
const questions = require('../../chatBridge/questions') as typeof import('../../chatBridge/questions');
const widgetStore = require('../../chatBridge/widgetStore') as typeof import('../../chatBridge/widgetStore');
const { NativeChatTurnTools } = require('./NativeChatTurnTools') as typeof import('./NativeChatTurnTools');
const imageFiles = require('./NativeChatImageFiles') as typeof import('./NativeChatImageFiles');
const { claudeCodeAdapter, encodeClaudeHostStdin } = require('./adapters/claude') as typeof import('./adapters/claude');
const { codexAdapter } = require('./adapters/codex') as typeof import('./adapters/codex');
const { createHostOperatorExecutionContext } = require('../../executionScope') as typeof import('../../executionScope');
/* eslint-enable @typescript-eslint/no-var-requires */

const USER_ID = 'smoke-owner';

function compileServer(): string {
  const outDir = path.join(tempRoot, 'compiled');
  fs.mkdirSync(outDir, { recursive: true });
  for (const name of ['contract', 'mcpServer']) {
    const source = fs.readFileSync(path.join(__dirname, '../../chatBridge', `${name}.ts`), 'utf8');
    const output = ts.transpileModule(source, {
      compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true },
    }).outputText;
    fs.writeFileSync(path.join(outDir, `${name}.js`), output);
  }
  return path.join(outDir, 'mcpServer.js');
}

/** A 96x96 solid blue baseline JPEG (the shape prepareChatImages produces). */
function blueJpegBase64(): string {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const sharp = require('sharp');
  return sharp({ create: { width: 96, height: 96, channels: 3, background: { r: 0, g: 90, b: 255 } } })
    .jpeg({ quality: 85 })
    .toBuffer()
    .then((buffer: Buffer) => buffer.toString('base64'));
}

const PROMPT = [
  'This is a Portal integration test. Do exactly these steps in order:',
  '1. Use the ask_user tool (from the bridgesllm MCP server) to ask me "Which colour do you prefer?" with the options Red and Blue.',
  '2. Use the show_widget tool (bridgesllm MCP server) with title "Colour choice" and widget_code set to a tiny HTML fragment that shows my answer in large text.',
  '3. Use the get_goal tool (bridgesllm MCP server) once.',
  '4. Reply with one short sentence that states my answer and names the dominant colour of the attached photo.',
  'Do not use any other tools.',
].join('\n');

interface SmokeResult {
  events: Array<Record<string, unknown>>;
  fullText: string;
  exitCode: number | null;
  stderrTail: string;
  argv: string[];
  questionsAnswered: string[];
}

async function runSmoke(adapter: NativeCliProviderAdapter, provider: 'CLAUDE_CODE' | 'CODEX', model: string | undefined): Promise<SmokeResult & { tools: NativeChatTurnToolsType; portalSessionId: string }> {
  const portalSessionId = `${provider.toLowerCase()}-${USER_ID}-${Date.now()}-${randomUUID()}`;
  const runId = randomUUID();
  const tools = await NativeChatTurnTools.open({
    provider,
    portalSessionId,
    runId,
    sender: { label: 'smoke', userId: USER_ID, authorizationVersion: 1, requestId: runId },
    bridge: true,
    scopeToolCallIds: adapter.scopeToolCallIds === true,
  });
  expect(tools.bridgeOpen).toBe(true);
  const cwd = fs.mkdtempSync(path.join(tempRoot, `${provider.toLowerCase()}-cwd-`));
  const images = [{ type: 'image' as const, mimeType: 'image/jpeg' as const, content: await blueJpegBase64(), fileName: 'photo.jpg', sizeBytes: 0, width: 96, height: 96 }];
  const events: Array<Record<string, unknown>> = [];
  const ctx: NativeCliTurnContext = {
    session: {
      sessionId: portalSessionId,
      userId: USER_ID,
      provider,
      cwd,
      createdAt: new Date().toISOString(),
      messages: [],
      executionContext: createHostOperatorExecutionContext(USER_ID),
      ...(model ? { model } : {}),
      metadata: provider === 'CLAUDE_CODE' ? { nativeSessionId: randomUUID() } : {},
    } as any,
    originalSessionId: portalSessionId,
    message: PROMPT,
    fullText: '',
    lastAssistantMessage: '',
    stderr: '',
    exitCode: null,
    state: { portalRunId: runId },
    emitChunk: () => undefined,
    emitStatus: (content, extra) => {
      events.push(tools.project({ type: 'status', content, ...(extra || {}) }));
    },
    setFullText: (text) => { ctx.fullText = text; },
    appendFullText: (text) => { ctx.fullText += text; },
    setLastAssistantMessage: (text) => { ctx.lastAssistantMessage = text; },
    appendStderr: (text) => { ctx.stderr = (ctx.stderr + text).slice(-16_384); },
    requestApproval: async () => 'deny',
    updateSessionMetadata: (metadata) => { ctx.session.metadata = { ...(ctx.session.metadata || {}), ...metadata }; },
    stripAnsi: (text) => text,
    chatBridge: tools.bridge,
    chatImages: images,
    materializeChatImageFiles: () => imageFiles.writeNativeChatImageFiles(runId, images),
  };
  ctx.onStatus = (event) => ctx.emitStatus(typeof event.content === 'string' ? event.content : '', event as any);

  const invocation = await adapter.buildInvocation(ctx);
  if (adapter.encodeHostStdin) expect(invocation.stdinText).toBe(adapter.encodeHostStdin(ctx));
  else expect(invocation.stdinText).toBe(ctx.message);
  const args = [...invocation.args];
  if (provider === 'CODEX') {
    // Cheapest setting for the smoke only; the adapter's own argv is unchanged.
    args.splice(args.length - 1, 0, '-c', 'model_reasoning_effort="low"');
  }
  expect(JSON.stringify(args)).not.toContain(tools.bridge!.launch.env.BRIDGESLLM_CHAT_BRIDGE_TOKEN);

  const questionsAnswered: string[] = [];
  const answerTimer = setInterval(() => {
    for (const open of questions.listBridgeQuestions(USER_ID, portalSessionId)) {
      const first = open.questions[0] as any;
      const choice = (first?.options || []).find((option: any) => /blue/i.test(String(option?.label))) || first?.options?.[0];
      const answer = String(choice?.label || 'Blue');
      questions.answerBridgeQuestion({ id: open.id, actorUserId: USER_ID, answers: { [first.id]: answer } });
      questionsAnswered.push(answer);
    }
  }, 250);
  const result = await new Promise<{ code: number | null }>((resolve, reject) => {
    const child = spawn(invocation.command, args, {
      cwd,
      env: invocation.options?.env as NodeJS.ProcessEnv,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let buffer = '';
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => {
      buffer += chunk;
      let index: number;
      while ((index = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, index).replace(/\r$/, '');
        buffer = buffer.slice(index + 1);
        if (line.trim()) adapter.handleStdoutLine(line, ctx);
      }
    });
    child.stderr.on('data', (chunk: Buffer) => ctx.appendStderr(chunk.toString()));
    child.once('error', reject);
    child.once('close', (code) => {
      if (buffer.trim()) adapter.handleStdoutLine(buffer, ctx);
      resolve({ code });
    });
    child.stdin.end(invocation.stdinText);
  }).finally(() => clearInterval(answerTimer));
  ctx.exitCode = result.code;
  await adapter.finalizeTurn?.(ctx);
  const fullText = (adapter.getResultText?.(ctx) || ctx.fullText || ctx.lastAssistantMessage || '').trim();
  return { events, fullText, exitCode: result.code, stderrTail: ctx.stderr.slice(-2_000), argv: args, questionsAnswered, tools, portalSessionId };
}

function writeEvidence(name: string, value: unknown): void {
  fs.mkdirSync(evidenceDir, { recursive: true });
  fs.writeFileSync(path.join(evidenceDir, name), `${JSON.stringify(value, null, 2)}\n`);
}

function assertBridgeTurn(provider: 'CLAUDE_CODE' | 'CODEX', result: Awaited<ReturnType<typeof runSmoke>>): void {
  const ends = result.events.filter((event) => event.type === 'tool_end');
  const askEnd = ends.find((event) => event.toolName === 'ask_user');
  const widgetEnd = ends.find((event) => event.toolName === 'show_widget');
  expect(result.exitCode).toBe(0);
  expect(result.questionsAnswered).toEqual(['Blue']);
  expect(String(askEnd?.toolResult || '')).toMatch(/blue/i);
  expect(widgetEnd?.isError).not.toBe(true);
  const reference = JSON.parse(String(widgetEnd?.toolResult));
  expect(reference).toMatchObject({ schema: 'bridgesllm.widget-ref.v1', toolCallId: widgetEnd?.toolCallId, mode: 'inline' });
  const document = widgetStore.readChatBridgeWidgetDocument({ provider, portalSessionId: result.portalSessionId, toolCallId: String(widgetEnd?.toolCallId) });
  expect(document?.html).toMatch(/blue/i);
  expect(result.fullText).toMatch(/blue/i);
  const persisted = result.tools.toolCalls() || [];
  // Goal tools are granted like the rest of the bridge (dontAsk denies anything ungranted).
  const goalEnd = ends.find((event) => event.toolName === 'get_goal' || /get_goal$/.test(String(event.toolName)));
  expect(goalEnd?.isError).not.toBe(true);
  expect(String(goalEnd?.toolResult || '')).toMatch(/No Portal goal is set/);
  expect(persisted.map((call) => call.name)).toEqual(expect.arrayContaining(['ask_user', 'show_widget']));
}

describeSmoke('Portal Chat Bridge real harness smoke', () => {
  jest.setTimeout(6 * 60_000);

  beforeAll(() => {
    listener.__configureChatBridgeListenerForTests({ runtimeRoot: path.join(tempRoot, 'run'), verifyActor: async () => true });
    bridge.__configureChatBridgeForTests({ serverPath: compileServer() });
    imageFiles.__configureNativeChatImageFilesForTests(path.join(tempRoot, 'images'));
  });

  afterAll(async () => {
    await listener.closeChatBridgeListener();
    fs.rmSync(tempRoot, { recursive: true, force: true });
  });

  (runClaude ? test : test.skip)('Claude Code: question, widget and photo through the adapter', async () => {
    const result = await runSmoke(claudeCodeAdapter, 'CLAUDE_CODE', 'haiku');
    writeEvidence('claude-smoke.json', { argv: result.argv, exitCode: result.exitCode, fullText: result.fullText, questionsAnswered: result.questionsAnswered, events: result.events, toolCalls: result.tools.toolCalls(), stderrTail: result.stderrTail });
    expect(result.argv).not.toContain('--safe-mode');
    expect(result.argv).toEqual(expect.arrayContaining(['--input-format', 'stream-json', '--strict-mcp-config', '--disallowedTools', 'AskUserQuestion']));
    expect(encodeClaudeHostStdin).toBeDefined();
    assertBridgeTurn('CLAUDE_CODE', result);
    result.tools.revoke();
  });

  (runCodex ? test : test.skip)('Codex: question, widget and photo through the adapter', async () => {
    const result = await runSmoke(codexAdapter, 'CODEX', undefined);
    writeEvidence('codex-smoke.json', { argv: result.argv, exitCode: result.exitCode, fullText: result.fullText, questionsAnswered: result.questionsAnswered, events: result.events, toolCalls: result.tools.toolCalls(), stderrTail: result.stderrTail });
    expect(result.argv).toEqual(expect.arrayContaining(['--image']));
    assertBridgeTurn('CODEX', result);
    result.tools.revoke();
  });
});
