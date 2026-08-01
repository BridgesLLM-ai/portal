import { execFileSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import type { ProjectSandboxExecutionContext } from '../../../AgentProvider.interface';
import { PROJECT_EGRESS_POLICY_VERSION } from '../../../../services/projectEgressPolicy';
import {
  CLAUDE_CODE_PROJECT_CLI_PATH,
  CLAUDE_CODE_PROJECT_CREDENTIAL_PATH,
  CLAUDE_CODE_PROJECT_RUNTIME_POLICY_VERSION,
  CLAUDE_CODE_PROJECT_SETTINGS_PATH,
  __claudeCodeProjectSandboxTest,
  buildClaudeCodeProjectInvocation,
  renderClaudeCodeProjectSettings,
} from './ClaudeCodeProjectSandbox';
import {
  ANTIGRAVITY_PROJECT_BRIDGE_PATH,
  ANTIGRAVITY_PROJECT_RUNTIME_POLICY_VERSION,
  ANTIGRAVITY_PROJECT_SETTINGS_PATH,
  ANTIGRAVITY_PROJECT_TOKEN_PATH,
  __antigravityProjectSandboxTest,
  buildAntigravityProjectInvocation,
  normalizeAntigravityProjectModel,
  renderAntigravityProjectSettings,
} from './AntigravityProjectSandbox';
import { renderAntigravityProjectBridge } from './AntigravityProjectBridge';
import type {
  NativeCliProjectEgressRuntimeHandle,
  NativeCliProjectRuntimeProvider,
} from './NativeCliProjectEgressRuntime';

function contextFor(
  projectRoot: string,
  runtimePolicyVersion: string,
): ProjectSandboxExecutionContext {
  const stat = fs.lstatSync(projectRoot, { bigint: true });
  return Object.freeze({
    scope: 'PROJECT_SANDBOX',
    source: 'PORTAL_SERVER',
    userId: 'actor-id',
    projectId: 'project-id',
    workspaceOwnerId: 'owner-id',
    projectName: 'demo',
    canonicalRoot: fs.realpathSync(projectRoot),
    rootDevice: stat.dev.toString(),
    rootInode: stat.ino.toString(),
    rootBirthtimeNs: stat.birthtimeNs.toString(),
    runtimePolicyVersion,
    egressPolicyVersion: PROJECT_EGRESS_POLICY_VERSION,
    runtimeImageDigest: `sha256:${'a'.repeat(64)}`,
    policyFingerprint: 'b'.repeat(64),
  });
}

function runtime(provider: NativeCliProjectRuntimeProvider): NativeCliProjectEgressRuntimeHandle {
  return Object.freeze({
    provider,
    containerId: 'd'.repeat(64),
    containerName: provider === 'CLAUDE_CODE' ? 'p4cc-test' : 'p4ag-test',
    runtimeFingerprint: 'e'.repeat(64),
    egressPolicyFingerprint: 'f'.repeat(64),
    proxyAddress: '172.31.20.2',
    proxyEnvironment: Object.freeze({}),
    startedAt: '2026-07-20T12:00:00Z',
  });
}

describe('Claude Code confined Project provider profile', () => {
  let root: string;
  let projectRoot: string;
  let stateRoot: string;
  let authPath: string;
  let previousStateRoot: string | undefined;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-project-provider-test-'));
    projectRoot = path.join(root, 'project');
    stateRoot = path.join(root, 'state');
    authPath = path.join(root, 'credentials.json');
    fs.mkdirSync(projectRoot, { mode: 0o700 });
    fs.mkdirSync(stateRoot, { mode: 0o700 });
    fs.writeFileSync(authPath, JSON.stringify({
      claudeAiOauth: {
        accessToken: 'access-secret',
        refreshToken: 'refresh-secret',
        expiresAt: 9999999999999,
      },
      unrelatedHostSetting: 'must-not-copy',
    }), { mode: 0o600 });
    previousStateRoot = process.env.PORTAL_NATIVE_CLI_PROJECT_STATE_ROOT;
    process.env.PORTAL_NATIVE_CLI_PROJECT_STATE_ROOT = stateRoot;
  });

  afterEach(() => {
    if (previousStateRoot === undefined) delete process.env.PORTAL_NATIVE_CLI_PROJECT_STATE_ROOT;
    else process.env.PORTAL_NATIVE_CLI_PROJECT_STATE_ROOT = previousStateRoot;
    fs.rmSync(root, { recursive: true, force: true });
  });

  test('renders a fail-closed inner sandbox without bypass, external directories, or MCP', () => {
    const settings = JSON.parse(renderClaudeCodeProjectSettings());
    expect(settings).toMatchObject({
      permissions: { defaultMode: 'dontAsk' },
      sandbox: {
        enabled: true,
        allowUnsandboxedCommands: false,
        failIfUnavailable: true,
      },
      disableBypassPermissionsMode: 'disable',
    });
    expect(settings.sandbox.filesystem.allowWrite).toEqual(['/workspace/project']);
    expect(settings.sandbox.filesystem.denyRead).toContain('/home/project-agent');
    expect(JSON.stringify(settings)).not.toMatch(/dangerously|add-dir|mcpServers/i);
  });

  test('stages OAuth-only credentials and resumes only after an authoritative native init/result', async () => {
    const context = contextFor(projectRoot, CLAUDE_CODE_PROJECT_RUNTIME_POLICY_VERSION);
    const ensureRuntime = jest.fn(async (input: any) => {
      const files = input.prepareManagedState({});
      expect(files.map((file: any) => file.targetPath)).toEqual([
        CLAUDE_CODE_PROJECT_CREDENTIAL_PATH,
        CLAUDE_CODE_PROJECT_SETTINGS_PATH,
      ]);
      const stagedAuth = JSON.parse(fs.readFileSync(files[0].sourcePath, 'utf8'));
      expect(stagedAuth).toHaveProperty('claudeAiOauth.accessToken', 'access-secret');
      expect(stagedAuth).not.toHaveProperty('unrelatedHostSetting');
      return runtime('CLAUDE_CODE');
    });
    const fresh = await buildClaudeCodeProjectInvocation({
      executionContext: context,
      nativeSessionId: null,
      model: 'claude-sonnet-4-5',
      message: 'Inspect and fix the project.',
      turnId: 'turn-one',
    }, {
      ensureRuntime,
      runtime: {},
      authSource: () => authPath,
    });
    const commandIndex = fresh.args.indexOf(CLAUDE_CODE_PROJECT_CLI_PATH);
    const cliArgs = fresh.args.slice(commandIndex + 1);
    expect(commandIndex).toBeGreaterThan(0);
    expect(cliArgs).toEqual(expect.arrayContaining([
      '--safe-mode',
      '--disable-slash-commands',
      '--strict-mcp-config',
      '--permission-mode', 'dontAsk',
      '--session-id', fresh.nativeSessionId,
    ]));
    expect(cliArgs).not.toContain('--add-dir');
    expect(cliArgs.join(' ')).not.toMatch(/dangerously|bypass/i);
    expect(fresh.abort).toEqual(expect.any(Function));

    const preSpawnRetry = await buildClaudeCodeProjectInvocation({
      executionContext: context,
      nativeSessionId: fresh.nativeSessionId,
      message: 'Continue.',
      turnId: 'turn-two',
    }, {
      ensureRuntime,
      runtime: {},
      authSource: () => authPath,
    });
    const preSpawnRetryArgs = preSpawnRetry.args.slice(
      preSpawnRetry.args.indexOf(CLAUDE_CODE_PROJECT_CLI_PATH) + 1,
    );
    expect(preSpawnRetryArgs).toEqual(expect.arrayContaining(['--session-id', fresh.nativeSessionId]));
    expect(preSpawnRetryArgs).not.toContain('--resume');

    const resumed = await buildClaudeCodeProjectInvocation({
      executionContext: context,
      nativeSessionId: fresh.nativeSessionId,
      nativeSessionEstablished: true,
      message: 'Continue after init.',
      turnId: 'turn-three',
    }, {
      ensureRuntime,
      runtime: {},
      authSource: () => authPath,
    });
    const resumedArgs = resumed.args.slice(resumed.args.indexOf(CLAUDE_CODE_PROJECT_CLI_PATH) + 1);
    expect(resumedArgs).toEqual(expect.arrayContaining(['--resume', fresh.nativeSessionId]));
    expect(resumedArgs).not.toContain('--session-id');

    const qualification = await buildClaudeCodeProjectInvocation({
      executionContext: context,
      message: 'Reply with the qualification nonce.',
      qualification: true,
      turnId: 'qualification-turn',
    }, {
      ensureRuntime,
      runtime: {},
      authSource: () => authPath,
    });
    const qualificationArgs = qualification.args.slice(
      qualification.args.indexOf(CLAUDE_CODE_PROJECT_CLI_PATH) + 1,
    );
    expect(qualificationArgs[qualificationArgs.indexOf('--tools') + 1]).toBe('');
  });

  test('rejects malformed or non-OAuth host credential material', () => {
    expect(() => __claudeCodeProjectSandboxTest.sanitizeClaudeCredentials(Buffer.from('{}')))
      .toThrow('OAuth credentials are missing');
    expect(() => __claudeCodeProjectSandboxTest.sanitizeClaudeCredentials(Buffer.from('{bad')))
      .toThrow('not valid JSON');
  });
});

describe('Antigravity confined Project provider profile', () => {
  let root: string;
  let projectRoot: string;
  let stateRoot: string;
  let authPath: string;
  let previousStateRoot: string | undefined;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'antigravity-project-provider-test-'));
    projectRoot = path.join(root, 'project');
    stateRoot = path.join(root, 'state');
    authPath = path.join(root, 'antigravity-oauth-token');
    fs.mkdirSync(projectRoot, { mode: 0o700 });
    fs.mkdirSync(stateRoot, { mode: 0o700 });
    fs.writeFileSync(authPath, 'oauth-token-material\n', { mode: 0o600 });
    previousStateRoot = process.env.PORTAL_NATIVE_CLI_PROJECT_STATE_ROOT;
    process.env.PORTAL_NATIVE_CLI_PROJECT_STATE_ROOT = stateRoot;
  });

  afterEach(() => {
    if (previousStateRoot === undefined) delete process.env.PORTAL_NATIVE_CLI_PROJECT_STATE_ROOT;
    else process.env.PORTAL_NATIVE_CLI_PROJECT_STATE_ROOT = previousStateRoot;
    fs.rmSync(root, { recursive: true, force: true });
  });

  test('renders official sandbox permissions with deny precedence and no trusted mode', () => {
    const settings = JSON.parse(renderAntigravityProjectSettings());
    expect(settings).toMatchObject({
      toolPermission: 'proceed-in-sandbox',
      agentMode: 'accept-edits',
      allowNonWorkspaceAccess: false,
      enableTerminalSandbox: true,
      enableTelemetry: false,
      permissions: { ask: [] },
    });
    expect(settings.permissions.allow).toContain('write_file(/workspace/project)');
    expect(settings.permissions.deny).toEqual(expect.arrayContaining([
      'read_file(/home/project-agent)',
      'unsandboxed(*)',
      'mcp(*)',
      'execute_url(*)',
    ]));
    expect(JSON.stringify(settings)).not.toMatch(/dangerously|skip-permissions/i);
  });

  test('the transcript bridge is syntactically valid, bounded, fixed-binary, and sandbox-only', () => {
    const bridge = renderAntigravityProjectBridge();
    const bridgePath = path.join(root, 'bridge.cjs');
    fs.writeFileSync(bridgePath, bridge, { mode: 0o600 });
    expect(() => execFileSync(process.execPath, ['--check', bridgePath])).not.toThrow();
    expect(bridge).toContain('const AGY = "/usr/local/bin/agy"');
    expect(bridge).toContain("'--sandbox'");
    expect(bridge).toContain("'--mode', 'accept-edits'");
    expect(bridge).toContain('MAX_TRANSCRIPT_BYTES');
    expect(bridge).toContain('toolCallId');
    expect(bridge).toContain("emit('session'");
    expect(bridge).not.toMatch(/dangerously-skip-permissions|--continue/);
  });

  test('the transcript bridge tails only the current resumed turn and correlates real transcript tool phases', () => {
    const conversation = '11111111-1111-4111-8111-111111111111';
    const brainRoot = path.join(root, 'brain');
    const transcriptDir = path.join(brainRoot, conversation, '.system_generated', 'logs');
    const transcriptPath = path.join(transcriptDir, 'transcript.jsonl');
    fs.mkdirSync(transcriptDir, { recursive: true });
    fs.writeFileSync(transcriptPath, `${JSON.stringify({
      source: 'MODEL',
      type: 'PLANNER_RESPONSE',
      status: 'DONE',
      step_index: 1,
      tool_calls: [{ name: 'old_tool', args: {} }],
    })}\n`);
    const fakeAgyPath = path.join(root, 'fake-agy.cjs');
    fs.writeFileSync(fakeAgyPath, `#!/usr/bin/env node
const fs = require('fs');
const path = require('path');
const args = process.argv.slice(2);
const conversation = args[args.indexOf('--conversation') + 1];
const transcript = path.join(process.env.FAKE_ANTIGRAVITY_BRAIN, conversation, '.system_generated', 'logs', 'transcript.jsonl');
const append = (record) => fs.appendFileSync(transcript, JSON.stringify(record) + '\\n');
setTimeout(() => append({
  source: 'MODEL', type: 'PLANNER_RESPONSE', status: 'DONE', step_index: 2,
  thinking: 'Checking the Project.',
  tool_calls: [{ name: 'list_dir', args: { DirectoryPath: '/workspace/project', toolSummary: 'List files' } }],
}), 20);
setTimeout(() => append({
  source: 'MODEL', type: 'LIST_DIRECTORY', status: 'DONE', step_index: 3,
  content: 'index.html\\nmain.js',
}), 45);
setTimeout(() => { process.stdout.write('Project inspected.\\n'); }, 65);
`, { mode: 0o755 });
    const bridgePath = path.join(root, 'bridge-runtime.cjs');
    fs.writeFileSync(bridgePath, renderAntigravityProjectBridge({
      agyPath: fakeAgyPath,
      projectPath: projectRoot,
      brainPath: brainRoot,
      pollIntervalMs: 10,
    }), { mode: 0o600 });

    const output = execFileSync(process.execPath, [
      bridgePath,
      '--message-base64', Buffer.from('Inspect the Project.', 'utf8').toString('base64url'),
      '--conversation', conversation,
    ], {
      encoding: 'utf8',
      timeout: 5_000,
      env: { ...process.env, FAKE_ANTIGRAVITY_BRAIN: brainRoot },
    });
    const events = output.trim().split(/\r?\n/).map((line) => JSON.parse(line));
    expect(events).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: 'session', conversationId: conversation }),
      expect.objectContaining({ type: 'thinking', content: 'Checking the Project.' }),
      expect.objectContaining({
        type: 'tool_start',
        toolCallId: `${conversation}:2:0`,
        toolName: 'list_dir',
        toolArgs: expect.objectContaining({ DirectoryPath: '/workspace/project' }),
      }),
      expect.objectContaining({
        type: 'tool_end',
        toolCallId: `${conversation}:2:0`,
        toolResult: 'index.html\nmain.js',
      }),
      expect.objectContaining({ type: 'text', content: 'Project inspected.' }),
      expect.objectContaining({ type: 'result', exitCode: 0, conversationId: conversation }),
    ]));
    expect(events.some((event) => event.toolCallId === `${conversation}:1:0`)).toBe(false);
    expect(events.filter((event) => event.type === 'tool_start')).toHaveLength(1);
    expect(events.filter((event) => event.type === 'tool_end')).toHaveLength(1);
  });

  test('qualification mode runs Antigravity from private tmpfs without the Project tool grant', () => {
    const fakeAgyPath = path.join(root, 'fake-qualification-agy.cjs');
    fs.writeFileSync(fakeAgyPath, `#!/usr/bin/env node
process.stdout.write(JSON.stringify({ cwd: process.cwd(), args: process.argv.slice(2) }) + '\\n');
`, { mode: 0o755 });
    const bridgePath = path.join(root, 'qualification-bridge.cjs');
    fs.writeFileSync(bridgePath, renderAntigravityProjectBridge({
      agyPath: fakeAgyPath,
      projectPath: projectRoot,
      brainPath: path.join(root, 'qualification-brain'),
      pollIntervalMs: 10,
    }), { mode: 0o600 });

    const output = execFileSync(process.execPath, [
      bridgePath,
      '--message-base64', Buffer.from('Qualification nonce.', 'utf8').toString('base64url'),
      '--qualification', '1',
    ], { encoding: 'utf8', timeout: 5_000 });
    const events = output.trim().split(/\r?\n/).map((line) => JSON.parse(line));
    const text = events.find((event) => event.type === 'text')?.content;
    const observed = JSON.parse(text);
    expect(observed.cwd).toBe('/tmp');
    expect(observed.args).toContain('--sandbox');
    expect(observed.args).not.toEqual(expect.arrayContaining(['--add-dir', projectRoot]));
    expect(observed.args).not.toContain('--mode');
  });

  test('stages token, settings, and bridge then builds a native-resumed structured invocation', async () => {
    const context = contextFor(projectRoot, ANTIGRAVITY_PROJECT_RUNTIME_POLICY_VERSION);
    const ensureRuntime = jest.fn(async (input: any) => {
      const files = input.prepareManagedState({});
      expect(files.map((file: any) => file.targetPath)).toEqual([
        ANTIGRAVITY_PROJECT_TOKEN_PATH,
        ANTIGRAVITY_PROJECT_SETTINGS_PATH,
        ANTIGRAVITY_PROJECT_BRIDGE_PATH,
      ]);
      expect(fs.readFileSync(files[0].sourcePath, 'utf8')).toBe('oauth-token-material\n');
      expect(fs.readFileSync(files[2].sourcePath, 'utf8')).toContain('portalNativeEvent');
      return runtime('GEMINI');
    });
    const nativeSessionId = '11111111-1111-4111-8111-111111111111';
    const invocation = await buildAntigravityProjectInvocation({
      executionContext: context,
      nativeSessionId,
      model: 'google-antigravity/gemini-3-flash-preview',
      message: 'Read the project and fix the bug.',
      turnId: 'turn-one',
    }, {
      ensureRuntime,
      runtime: {},
      authSource: () => authPath,
    });
    const nodeIndex = invocation.args.indexOf('/usr/local/bin/node');
    const bridgeArgs = invocation.args.slice(nodeIndex + 1);
    expect(nodeIndex).toBeGreaterThan(0);
    expect(bridgeArgs).toEqual(expect.arrayContaining([
      ANTIGRAVITY_PROJECT_BRIDGE_PATH,
      '--model', 'gemini-3.5-flash',
      '--conversation', nativeSessionId,
    ]));
    expect(bridgeArgs.join(' ')).not.toMatch(/dangerously|trusted|skip-permissions/i);
    const encoded = bridgeArgs[bridgeArgs.indexOf('--message-base64') + 1];
    expect(Buffer.from(encoded, 'base64url').toString('utf8')).toBe('Read the project and fix the bug.');
    expect(invocation.abort).toEqual(expect.any(Function));

    const qualification = await buildAntigravityProjectInvocation({
      executionContext: context,
      message: 'Reply with the qualification nonce.',
      qualification: true,
      turnId: 'qualification-turn',
    }, {
      ensureRuntime,
      runtime: {},
      authSource: () => authPath,
    });
    const qualificationArgs = qualification.args.slice(qualification.args.indexOf('/usr/local/bin/node') + 1);
    expect(qualificationArgs).toEqual(expect.arrayContaining(['--qualification', '1']));
  });

  test('normalizes known models and rejects argument-shaped model identifiers', () => {
    expect(normalizeAntigravityProjectModel('google/gemini-3.1-pro-preview')).toBe('gemini-3.1-pro-high');
    expect(() => normalizeAntigravityProjectModel('../../bin/sh')).toThrow('model identity is invalid');
    expect(() => __antigravityProjectSandboxTest.sanitizeAntigravityToken(Buffer.from(' \n')))
      .toThrow('OAuth token is invalid');
  });
});
