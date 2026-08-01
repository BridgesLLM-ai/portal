import crypto from 'crypto';
import fs from 'fs';
import os from 'os';
import path from 'path';
import type { ProjectSandboxExecutionContext } from '../../../AgentProvider.interface';
import type { ProjectEgressCommandExecutor, ProjectEgressCommandResult } from '../../../../services/projectEgressPlane';
import { PROJECT_EGRESS_POLICY_VERSION } from '../../../../services/projectEgressPolicy';
import {
  CODEX_PROJECT_CONTAINER_ROOT,
  CODEX_PROJECT_RUNTIME_POLICY_VERSION,
  buildPreviousCodexProjectExecutionContext,
  type CodexProjectEgressRuntimeHandle,
} from './CodexProjectEgressRuntime';
import {
  CODEX_PROJECT_BWRAP_SUPPORTED_RANGE,
  CODEX_PROJECT_CLI_VERSION,
  CODEX_PROJECT_PERMISSION_PROFILE,
  CODEX_PROJECT_PROFILE_NAME,
  assertCodexProjectSandboxPathSeparation,
  buildCodexProjectInvocation,
  clearCodexProjectSandboxProbeCacheForTests,
  ensureCodexProjectQualifiedRuntime,
  isSupportedBubblewrapVersionOutput,
  probeCodexProjectSandboxRuntime,
  renderCodexProjectProfile,
  retireCodexProjectManagedStateForContext,
  type CodexProjectInvocationDependencies,
} from './CodexProjectSandbox';

const PROXY_ENV = Object.freeze({
  HTTP_PROXY: 'http://portal:token@172.31.10.2:3128',
  HTTPS_PROXY: 'http://portal:token@172.31.10.2:3128',
  http_proxy: 'http://portal:token@172.31.10.2:3128',
  https_proxy: 'http://portal:token@172.31.10.2:3128',
  NO_PROXY: '',
  no_proxy: '',
});

interface Fixture {
  root: string;
  projectRoot: string;
  authPath: string;
  stateRoot: string;
  context: ProjectSandboxExecutionContext;
  runtime: CodexProjectEgressRuntimeHandle;
}

function makeFixture(): Fixture {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-project-sandbox-test-'));
  const projectRoot = path.join(root, 'project');
  const stateRoot = path.join(root, 'state');
  const authPath = path.join(root, 'source-auth.json');
  fs.mkdirSync(projectRoot, { mode: 0o700 });
  fs.writeFileSync(authPath, '{}', { mode: 0o600 });
  fs.chmodSync(authPath, 0o600);
  const stat = fs.lstatSync(projectRoot, { bigint: true });
  const context: ProjectSandboxExecutionContext = Object.freeze({
    scope: 'PROJECT_SANDBOX',
    source: 'PORTAL_SERVER',
    userId: 'codex-test-user',
    projectId: 'codex-test-project',
    workspaceOwnerId: 'codex-test-owner',
    projectName: 'demo',
    canonicalRoot: fs.realpathSync(projectRoot),
    rootDevice: stat.dev.toString(),
    rootInode: stat.ino.toString(),
    rootBirthtimeNs: stat.birthtimeNs.toString(),
    runtimePolicyVersion: CODEX_PROJECT_RUNTIME_POLICY_VERSION,
    egressPolicyVersion: PROJECT_EGRESS_POLICY_VERSION,
    runtimeImageDigest: `sha256:${'a'.repeat(64)}`,
    policyFingerprint: 'b'.repeat(64),
  });
  const runtime: CodexProjectEgressRuntimeHandle = Object.freeze({
    containerId: 'c'.repeat(64),
    containerName: 'p4cx-test',
    runtimeFingerprint: 'd'.repeat(64),
    egressPolicyFingerprint: 'e'.repeat(64),
    proxyAddress: '172.31.10.2',
    proxyEnvironment: PROXY_ENV,
    startedAt: '2026-07-19T12:00:00Z',
  });
  return { root, projectRoot, authPath, stateRoot, context, runtime };
}

function installFixtureEnvironment(fixture: Fixture): () => void {
  const previousStateRoot = process.env.PORTAL_CODEX_PROJECT_STATE_ROOT;
  const previousAuthPath = process.env.PORTAL_CODEX_AUTH_PATH;
  process.env.PORTAL_CODEX_PROJECT_STATE_ROOT = fixture.stateRoot;
  process.env.PORTAL_CODEX_AUTH_PATH = fixture.authPath;
  return () => {
    if (previousStateRoot === undefined) delete process.env.PORTAL_CODEX_PROJECT_STATE_ROOT;
    else process.env.PORTAL_CODEX_PROJECT_STATE_ROOT = previousStateRoot;
    if (previousAuthPath === undefined) delete process.env.PORTAL_CODEX_AUTH_PATH;
    else process.env.PORTAL_CODEX_AUTH_PATH = previousAuthPath;
  };
}

function stateDirectoryFor(
  fixture: Fixture,
  context: ProjectSandboxExecutionContext,
): string {
  const key = crypto.createHash('sha256').update(JSON.stringify({
    userId: context.userId,
    projectId: context.projectId,
    canonicalRoot: context.canonicalRoot,
    policyFingerprint: context.policyFingerprint,
  })).digest('hex');
  return path.join(fixture.stateRoot, key);
}

function createManagedPredecessorState(fixture: Fixture): {
  context: ProjectSandboxExecutionContext;
  stateDir: string;
  authPath: string;
  profilePath: string;
} {
  const context = buildPreviousCodexProjectExecutionContext(fixture.context);
  fs.mkdirSync(fixture.stateRoot, { recursive: true, mode: 0o700 });
  fs.chmodSync(fixture.stateRoot, 0o700);
  const stateDir = stateDirectoryFor(fixture, context);
  fs.mkdirSync(stateDir, { mode: 0o700 });
  const authPath = path.join(stateDir, 'auth.json');
  const profilePath = path.join(stateDir, 'portal-project.config.toml');
  fs.writeFileSync(authPath, '{}', { mode: 0o600 });
  fs.writeFileSync(profilePath, 'profile', { mode: 0o600 });
  for (const target of [authPath, profilePath]) {
    fs.chownSync(target, 1000, 1000);
    fs.chmodSync(target, 0o400);
  }
  fs.chownSync(stateDir, 1000, 1000);
  fs.chmodSync(stateDir, 0o500);
  return { context, stateDir, authPath, profilePath };
}

function dependenciesFor(
  fixture: Fixture,
  overrides: Partial<CodexProjectInvocationDependencies> = {},
): Partial<CodexProjectInvocationDependencies> {
  const ensureRuntime = jest.fn(async (input: Parameters<CodexProjectInvocationDependencies['ensureRuntime']>[0]) => {
    const state = input.prepareManagedState(PROXY_ENV);
    expect(fs.statSync(state.authPath).uid).toBe(1000);
    expect(fs.statSync(state.profilePath).mode & 0o777).toBe(0o400);
    return fixture.runtime;
  });
  return {
    ensureRuntime,
    qualifyRuntime: jest.fn(async () => undefined),
    now: () => 1000,
    ...overrides,
  };
}

describe('Codex Project sandbox contract', () => {
  const fixtures: Fixture[] = [];
  const restoreEnvironment: Array<() => void> = [];

  beforeEach(() => clearCodexProjectSandboxProbeCacheForTests());

  afterEach(() => {
    clearCodexProjectSandboxProbeCacheForTests();
    for (const restore of restoreEnvironment.splice(0).reverse()) restore();
    for (const fixture of fixtures.splice(0)) fs.rmSync(fixture.root, { recursive: true, force: true });
  });

  test('removes only the exact sealed predecessor state and is idempotent when absent', () => {
    const fixture = makeFixture();
    fixtures.push(fixture);
    restoreEnvironment.push(installFixtureEnvironment(fixture));
    const predecessor = createManagedPredecessorState(fixture);

    expect(() => retireCodexProjectManagedStateForContext(predecessor.context)).not.toThrow();
    expect(fs.existsSync(predecessor.stateDir)).toBe(false);
    expect(fs.existsSync(fixture.stateRoot)).toBe(true);
    expect(() => retireCodexProjectManagedStateForContext(predecessor.context)).not.toThrow();

    const absent = makeFixture();
    fixtures.push(absent);
    restoreEnvironment.push(installFixtureEnvironment(absent));
    const absentContext = buildPreviousCodexProjectExecutionContext(absent.context);
    expect(() => retireCodexProjectManagedStateForContext(absentContext)).not.toThrow();
  });

  test.each([
    ['wrong owner', (state: ReturnType<typeof createManagedPredecessorState>) => {
      fs.chownSync(state.stateDir, 0, 0);
    }],
    ['wrong mode', (state: ReturnType<typeof createManagedPredecessorState>) => {
      fs.chmodSync(state.stateDir, 0o700);
    }],
    ['unmanaged entry', (state: ReturnType<typeof createManagedPredecessorState>) => {
      fs.writeFileSync(path.join(state.stateDir, 'foreign'), 'no');
    }],
  ])('fails closed without unlinking predecessor state with %s', (_label, mutate) => {
    const fixture = makeFixture();
    fixtures.push(fixture);
    restoreEnvironment.push(installFixtureEnvironment(fixture));
    const predecessor = createManagedPredecessorState(fixture);
    mutate(predecessor);

    expect(() => retireCodexProjectManagedStateForContext(predecessor.context)).toThrow();
    expect(fs.existsSync(predecessor.authPath)).toBe(true);
    expect(fs.existsSync(predecessor.profilePath)).toBe(true);
  });

  test('fails closed without following a predecessor state-directory symlink', () => {
    const fixture = makeFixture();
    fixtures.push(fixture);
    restoreEnvironment.push(installFixtureEnvironment(fixture));
    const context = buildPreviousCodexProjectExecutionContext(fixture.context);
    fs.mkdirSync(fixture.stateRoot, { mode: 0o700 });
    const target = path.join(fixture.root, 'symlink-target');
    fs.mkdirSync(target, { mode: 0o700 });
    const sentinel = path.join(target, 'sentinel');
    fs.writeFileSync(sentinel, 'keep');
    const stateDir = stateDirectoryFor(fixture, context);
    fs.symlinkSync(target, stateDir);

    expect(() => retireCodexProjectManagedStateForContext(context)).toThrow();
    expect(fs.readFileSync(sentinel, 'utf8')).toBe('keep');
    expect(fs.lstatSync(stateDir).isSymbolicLink()).toBe(true);
  });

  test('fails closed without unlinking a hard-linked predecessor state file', () => {
    const fixture = makeFixture();
    fixtures.push(fixture);
    restoreEnvironment.push(installFixtureEnvironment(fixture));
    const predecessor = createManagedPredecessorState(fixture);
    const secondLink = path.join(fixture.root, 'auth-hardlink');
    fs.linkSync(predecessor.authPath, secondLink);

    expect(() => retireCodexProjectManagedStateForContext(predecessor.context)).toThrow();
    expect(fs.existsSync(predecessor.authPath)).toBe(true);
    expect(fs.existsSync(predecessor.profilePath)).toBe(true);
    expect(fs.existsSync(secondLink)).toBe(true);
  });

  test('fails closed without unlinking when predecessor state inventory races', () => {
    const fixture = makeFixture();
    fixtures.push(fixture);
    restoreEnvironment.push(installFixtureEnvironment(fixture));
    const predecessor = createManagedPredecessorState(fixture);
    const original = fs.readdirSync.bind(fs);
    let stateReads = 0;
    const readdir = jest.spyOn(fs, 'readdirSync').mockImplementation(((target: fs.PathLike) => {
      if (path.resolve(String(target)) === predecessor.stateDir) {
        stateReads += 1;
        if (stateReads === 2) {
          return ['auth.json', 'portal-project.config.toml', 'raced'];
        }
      }
      return original(target) as any;
    }) as any);
    try {
      expect(() => retireCodexProjectManagedStateForContext(predecessor.context)).toThrow(
        'inventory changed',
      );
    } finally {
      readdir.mockRestore();
    }
    expect(fs.existsSync(predecessor.authPath)).toBe(true);
    expect(fs.existsSync(predecessor.profilePath)).toBe(true);
  });

  test('enables network only behind the Portal plane and writes an exact non-inheriting proxy environment', () => {
    const profile = renderCodexProjectProfile(PROXY_ENV);
    expect(profile).toContain(`default_permissions = "${CODEX_PROJECT_PERMISSION_PROFILE}"`);
    expect(profile).toContain('[permissions.portal_project.network]\nenabled = true');
    expect(profile).toContain('inherit = "none"');
    expect(profile).toContain('HTTP_PROXY = "http://portal:token@172.31.10.2:3128"');
    expect(profile).toContain('NO_PROXY = ""');
    expect(profile).toContain('no_proxy = ""');
    expect(profile).toContain('hooks = false');
    expect(profile).toContain('plugins = false');
    expect(profile).toContain('browser_use = false');
    expect(profile).toContain('multi_agent = false');
    expect(() => renderCodexProjectProfile({ ...PROXY_ENV, NO_PROXY: 'localhost' })).toThrow('invalid');
    expect(() => renderCodexProjectProfile({ ...PROXY_ENV, AWS_SECRET: 'secret' })).toThrow('exactly');
  });

  test('retains the bounded legacy bubblewrap parser for upgrade diagnostics without using bwrap to launch', () => {
    expect(CODEX_PROJECT_BWRAP_SUPPORTED_RANGE).toBe('>=0.6.1 <0.12.0');
    expect(isSupportedBubblewrapVersionOutput('bubblewrap 0.6.0')).toBe(false);
    expect(isSupportedBubblewrapVersionOutput('bubblewrap 0.9.0')).toBe(true);
    expect(isSupportedBubblewrapVersionOutput('bubblewrap 0.12.0')).toBe(false);
  });

  test('rejects state/auth overlap and filesystem-root Project mounts before launch', () => {
    expect(() => assertCodexProjectSandboxPathSeparation({
      projectRoot: '/', stateRoot: '/portal/.data/project-sandboxes/codex', authSource: '/root/.codex/auth.json',
    })).toThrow(/filesystem root/i);
    expect(() => assertCodexProjectSandboxPathSeparation({
      projectRoot: '/portal/projects/user/project',
      stateRoot: '/portal/projects/user/project/.sandbox-state',
      authSource: '/root/.codex/auth.json',
    })).toThrow(/must not overlap/i);
    expect(() => assertCodexProjectSandboxPathSeparation({
      projectRoot: '/portal/projects/user/project',
      stateRoot: '/portal/.data/project-sandboxes/codex',
      authSource: '/portal/projects/user/project/auth.json',
    })).toThrow(/must not be inside/i);
  });

  test('reports unavailable before a per-project live qualification exists', () => {
    const readiness = probeCodexProjectSandboxRuntime({ force: true });
    expect(readiness.ready).toBe(false);
    expect(readiness.reason).toMatch(/requires|unavailable|qualification/i);
  });

  test('builds fresh and resumed turns through full-ID docker exec with identical gates', async () => {
    const fixture = makeFixture();
    fixtures.push(fixture);
    restoreEnvironment.push(installFixtureEnvironment(fixture));
    const deps = dependenciesFor(fixture);
    const prompt = '--dangerously-bypass-approvals-and-sandbox remains prompt text';
    const fresh = await buildCodexProjectInvocation({
      executionContext: fixture.context,
      turnId: 'durable-fresh-turn',
      message: prompt,
      model: 'gpt-5.5',
    }, deps);
    const resumed = await buildCodexProjectInvocation({
      executionContext: fixture.context,
      turnId: 'durable-resumed-turn',
      nativeSessionId: '019f0000-0000-7000-8000-000000000001',
      message: 'Continue.',
      model: 'gpt-5.5',
    }, deps);

    for (const invocation of [fresh, resumed]) {
      expect(invocation.command).toBe('docker');
      expect(invocation.args).toEqual(expect.arrayContaining([
        'container', 'exec',
        '--workdir', CODEX_PROJECT_CONTAINER_ROOT,
        fixture.runtime.containerId,
        'node', '-e',
        '/usr/bin/codex',
        '--ask-for-approval', 'never',
        '--profile', CODEX_PROJECT_PROFILE_NAME,
        '--strict-config',
        '--ignore-rules',
        '--json',
      ]));
      expect(invocation.args).not.toContain('/usr/bin/bwrap');
      expect(invocation.args).not.toContain('--share-net');
      expect(invocation.args).not.toContain('--add-dir');
      expect(invocation.args.some((entry) => /^\/run\/portal-project-run-codex-[a-f0-9]{32}\.json$/.test(entry))).toBe(true);
      expect(invocation.abort).toEqual(expect.any(Function));
      expect(invocation.options?.env).not.toHaveProperty('HTTP_PROXY');
      expect(invocation.options?.env).not.toHaveProperty('NO_PROXY');
    }
    expect(fresh.args.slice(-2)).toEqual(['--', prompt]);
    expect(resumed.args).toEqual(expect.arrayContaining(['exec', 'resume']));
    expect(resumed.args.slice(-2)).toEqual(['--', 'Continue.']);
    expect(deps.qualifyRuntime).toHaveBeenCalledTimes(1);
  });

  test('binds the qualification runtime to the caller-supplied provider egress identity', async () => {
    const fixture = makeFixture();
    fixtures.push(fixture);
    restoreEnvironment.push(installFixtureEnvironment(fixture));
    const deps = dependenciesFor(fixture);
    const egress = {
      identity: {
        actorId: fixture.context.userId,
        projectId: fixture.context.projectId,
        provider: 'CODEX',
      },
      proxyImage: `sha256:${'f'.repeat(64)}`,
      token: Buffer.alloc(32, 41).toString('base64url'),
    };

    await expect(ensureCodexProjectQualifiedRuntime({
      context: fixture.context,
      egress,
    }, deps)).resolves.toBe(fixture.runtime);
    expect(deps.ensureRuntime).toHaveBeenCalledWith(
      expect.objectContaining({ context: fixture.context, egress }),
      expect.anything(),
    );
    expect(deps.qualifyRuntime).toHaveBeenCalledTimes(1);
  });

  test('actively qualifies public HTTPS and both direct and proxied private/metadata denial', async () => {
    const fixture = makeFixture();
    fixtures.push(fixture);
    restoreEnvironment.push(installFixtureEnvironment(fixture));
    const calls: Array<{ command: string; args: readonly string[] }> = [];
    const executor: ProjectEgressCommandExecutor = {
      run: jest.fn(async (command: string, args: readonly string[]): Promise<ProjectEgressCommandResult> => {
        calls.push({ command, args });
        const isVersion = args.includes('/usr/bin/codex') && args.includes('--version');
        return { stdout: isVersion ? `codex-cli ${CODEX_PROJECT_CLI_VERSION}\n` : '', stderr: '', exitCode: 0 };
      }),
    };
    const deps = dependenciesFor(fixture, { runtime: { executor } });
    delete deps.qualifyRuntime;
    await buildCodexProjectInvocation({
      executionContext: fixture.context,
      turnId: 'qualification-turn',
      message: 'Qualify and run.',
    }, deps);
    const qualification = calls.find(({ args }) => args.includes('node') && args.some((arg) => arg.includes('169.254.169.254')));
    expect(qualification).toBeDefined();
    const encoded = qualification!.args.join('\n');
    expect(encoded).toContain('https://example.com/');
    expect(encoded).toContain('--proxy');
    expect(encoded).toContain('--noproxy');
    expect(encoded).toContain('127.0.0.1');
    expect(encoded).toContain('10.255.255.1');
    expect(encoded).toContain('169.254.169.254');
    expect(encoded).toContain('192.168.255.254');
  });

  test('fails closed when live qualification fails and does not return an invocation', async () => {
    const fixture = makeFixture();
    fixtures.push(fixture);
    restoreEnvironment.push(installFixtureEnvironment(fixture));
    const ensureRuntime = jest.fn(async (input: Parameters<CodexProjectInvocationDependencies['ensureRuntime']>[0]) => {
      input.prepareManagedState(PROXY_ENV);
      return fixture.runtime;
    });
    await expect(buildCodexProjectInvocation({
      executionContext: fixture.context,
      turnId: 'failed-qualification-turn',
      message: 'Do not run.',
    }, {
      ensureRuntime,
      qualifyRuntime: jest.fn(async () => { throw new Error('private-network denial probe failed'); }),
      now: () => 1000,
    })).rejects.toThrow('private-network denial probe failed');
    expect(probeCodexProjectSandboxRuntime().ready).toBe(false);
  });

  test('rejects option-like session and model identities before provisioning', async () => {
    const fixture = makeFixture();
    fixtures.push(fixture);
    const deps = dependenciesFor(fixture);
    await expect(buildCodexProjectInvocation({
      executionContext: fixture.context, turnId: 'bad-session-turn', nativeSessionId: '--last', message: 'Do not run.',
    }, deps)).rejects.toThrow(/session identity/i);
    await expect(buildCodexProjectInvocation({
      executionContext: fixture.context, turnId: 'bad-model-turn', model: '--dangerously-bypass-approvals-and-sandbox', message: 'Do not run.',
    }, deps)).rejects.toThrow(/model identity/i);
    await expect(buildCodexProjectInvocation({
      executionContext: fixture.context, turnId: '', message: 'Do not run.',
    }, deps)).rejects.toThrow(/turn identity/i);
    expect(deps.ensureRuntime).not.toHaveBeenCalled();
  });
});
