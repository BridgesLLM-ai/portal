import fs from 'fs';
import os from 'os';
import path from 'path';

jest.mock('./native/projectSandbox/CodexProjectEgressRuntime', () => ({
  ...jest.requireActual('./native/projectSandbox/CodexProjectEgressRuntime'),
  stopCodexProjectRuntimesForContext: jest.fn(async () => []),
}));

const previousSessionsDir = process.env.PORTAL_NATIVE_AGENT_SESSIONS_DIR;
const testRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-provider-termination-'));
const sessionsDir = path.join(testRoot, 'sessions');
const projectRoot = path.join(testRoot, 'project');
fs.mkdirSync(projectRoot, { recursive: true });
process.env.PORTAL_NATIVE_AGENT_SESSIONS_DIR = sessionsDir;

const { CodexProvider } = require('./CodexProvider') as typeof import('./CodexProvider');
const sessionStore = require('./NativeSessionStore') as typeof import('./NativeSessionStore');
const executionScope = require('../executionScope') as typeof import('../executionScope');
const runtime = require('./native/projectSandbox/CodexProjectEgressRuntime') as typeof import('./native/projectSandbox/CodexProjectEgressRuntime');
const stopRuntimes = runtime.stopCodexProjectRuntimesForContext as jest.MockedFunction<
  typeof runtime.stopCodexProjectRuntimesForContext
>;

function projectContext() {
  const stat = fs.lstatSync(projectRoot, { bigint: true });
  return executionScope.createProjectSandboxExecutionContext({
    userId: 'owner-1',
    projectId: 'project-1',
    workspaceOwnerId: 'owner-1',
    projectName: 'demo',
    canonicalRoot: fs.realpathSync(projectRoot),
    rootDevice: stat.dev.toString(),
    rootInode: stat.ino.toString(),
    rootBirthtimeNs: stat.birthtimeNs.toString(),
    runtimePolicyVersion: runtime.CODEX_PROJECT_RUNTIME_POLICY_VERSION,
    egressPolicyVersion: 'portal-project-egress-v1',
    runtimeImageDigest: `sha256:${'a'.repeat(64)}`,
    policyFingerprint: 'b'.repeat(64),
  });
}

describe('Codex provider Project session termination', () => {
  afterEach(() => {
    stopRuntimes.mockReset();
    stopRuntimes.mockResolvedValue([]);
    fs.rmSync(sessionsDir, { recursive: true, force: true });
  });

  afterAll(() => {
    if (previousSessionsDir === undefined) delete process.env.PORTAL_NATIVE_AGENT_SESSIONS_DIR;
    else process.env.PORTAL_NATIVE_AGENT_SESSIONS_DIR = previousSessionsDir;
    fs.rmSync(testRoot, { recursive: true, force: true });
  });

  test('stops actor/project-bound orphan runtimes before deleting the Project session', async () => {
    const context = projectContext();
    const session = sessionStore.createNativeSession('CODEX', 'owner-1', { executionContext: context });

    await expect(new CodexProvider().terminateSession(session.sessionId)).resolves.toBeUndefined();

    expect(stopRuntimes).toHaveBeenCalledWith(context);
    expect(sessionStore.loadNativeSession('CODEX', session.sessionId)).toBeNull();
  });

  test('keeps durable session state when orphan hard-stop proof fails', async () => {
    const context = projectContext();
    const session = sessionStore.createNativeSession('CODEX', 'owner-1', { executionContext: context });
    stopRuntimes.mockRejectedValueOnce(new Error('runtime remained active'));

    await expect(new CodexProvider().terminateSession(session.sessionId)).rejects.toThrow('runtime remained active');

    expect(sessionStore.loadNativeSession('CODEX', session.sessionId)).not.toBeNull();
  });

  test('does not inspect Project containers for a host-operator session', async () => {
    const session = sessionStore.createNativeSession('CODEX', 'owner-1', {
      executionContext: executionScope.createHostOperatorExecutionContext('owner-1'),
    });

    await expect(new CodexProvider().terminateSession(session.sessionId)).resolves.toBeUndefined();

    expect(stopRuntimes).not.toHaveBeenCalled();
    expect(sessionStore.loadNativeSession('CODEX', session.sessionId)).toBeNull();
  });
});
