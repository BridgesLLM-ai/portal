import { readFileSync, type Stats } from 'fs';
import path from 'path';
import {
  AGENT_ZERO_CONTAINER_NAME,
  AGENT_ZERO_IMAGE_DIGESTS,
  getAgentZeroImageRef,
  normalizeAgentZeroArchitecture,
  probeAgentZeroRuntime,
} from '../agents/providers/agentZero/AgentZeroRuntime';
import {
  AGENT_ZERO_HOST_GATEWAY_ARCHIVE_SHA256,
  AGENT_ZERO_HOST_GATEWAY_BUILD_CONSTRAINTS_SHA256,
  AGENT_ZERO_HOST_GATEWAY_CLI_COMMIT,
  AGENT_ZERO_HOST_GATEWAY_RUNTIME_CONSTRAINTS_SHA256,
} from '../agents/providers/agentZero/AgentZeroHostGateway';
import {
  AGENT_ZERO_PROJECT_IMAGE_RUNTIME_USER,
  AGENT_ZERO_PROJECT_SOURCE_COMMITS,
  AGENT_ZERO_PROJECT_UPSTREAM_IMAGE_DIGESTS,
} from '../agents/providers/agentZero/AgentZeroProjectImage';
import { getToolAdapter, SAFE_INSTALL_ALLOWLIST } from '../config/toolAdapters';
import { PORTAL_TOOL_VERSIONS } from '../config/toolVersions';
import { getNativeCliAuthStatus } from '../agents/nativeCliAuth';

const AUTH_FILE = '/etc/bridgesllm/agent-zero.env';

function protectedAuthStats(mode = 0o100600): Stats {
  return {
    isFile: () => true,
    isSymbolicLink: () => false,
    uid: 0,
    mode,
  } as Stats;
}

function managedInspect(overrides: Record<string, any> = {}): Record<string, any> {
  return {
    Config: {
      Image: getAgentZeroImageRef('amd64'),
    },
    State: { Running: true },
    HostConfig: {
      PortBindings: {
        '80/tcp': [{ HostIp: '127.0.0.1', HostPort: '50001' }],
      },
      RestartPolicy: { Name: 'unless-stopped' },
    },
    Mounts: [
      {
        Type: 'volume',
        Name: 'bridgesllm-agent-zero-usr',
        Destination: '/a0/usr',
        RW: true,
      },
      {
        Type: 'bind',
        Source: AUTH_FILE,
        Destination: '/a0/.env',
        RW: false,
      },
    ],
    ...overrides,
  };
}

function capabilities(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    protocol: 'a0-connector.v1',
    version: '0.1.0',
    agent_zero_version: 'v2.5',
    auth: ['session'],
    auth_required: true,
    transports: ['http', 'websocket'],
    websocket_namespace: '/ws',
    websocket_handlers: ['plugins/_a0_connector/ws_connector'],
    features: ['launcher_gateway', 'launcher_gateway_file_write'],
    ...overrides,
  });
}

function probe(overrides: {
  inspect?: Record<string, any>;
  capabilities?: string;
  auth?: string;
  stats?: Stats;
} = {}) {
  const calls: Array<{ command: string; args: string[] }> = [];
  const result = probeAgentZeroRuntime({
    architecture: 'amd64',
    authFilePath: AUTH_FILE,
    runCommand: (command, args) => {
      calls.push({ command, args });
      if (command === 'docker') return JSON.stringify([overrides.inspect || managedInspect()]);
      if (command === 'curl') return overrides.capabilities || capabilities();
      throw new Error(`Unexpected command: ${command}`);
    },
    readAuthFile: () => overrides.auth || 'AUTH_LOGIN=portal\nAUTH_PASSWORD=correct-horse-battery-staple\n',
    statAuthFile: () => overrides.stats || protectedAuthStats(),
  });
  return { result, calls };
}

describe('Agent Zero managed runtime contract', () => {
  test('maps supported architectures to immutable v2.5 manifest digests', () => {
    expect(normalizeAgentZeroArchitecture('x86_64')).toBe('amd64');
    expect(normalizeAgentZeroArchitecture('aarch64')).toBe('arm64');
    expect(normalizeAgentZeroArchitecture('riscv64')).toBeNull();
    expect(getAgentZeroImageRef('amd64')).toBe(`agent0ai/agent-zero@${AGENT_ZERO_IMAGE_DIGESTS.amd64}`);
    expect(getAgentZeroImageRef('arm64')).toBe(`agent0ai/agent-zero@${AGENT_ZERO_IMAGE_DIGESTS.arm64}`);
  });

  test('accepts only the pinned, loopback, persistent, protected, protocol-ready runtime', () => {
    const { result, calls } = probe();
    expect(result).toMatchObject({
      installed: true,
      running: true,
      ready: true,
      version: '2.5',
      pinnedImage: true,
      loopbackOnly: true,
      persistentData: true,
      protectedAuth: true,
      restartPolicy: true,
      protocolCompatible: true,
    });
    expect(calls[0]).toEqual({ command: 'docker', args: ['inspect', AGENT_ZERO_CONTAINER_NAME] });
    expect(calls[1].command).toBe('curl');
    expect(calls[1].args).toContain('http://127.0.0.1:50001/api/plugins/_a0_connector/v1/capabilities');
  });

  test('fails closed before protocol access when Docker exposure or auth drifts', () => {
    const publicInspect = managedInspect({
      HostConfig: {
        PortBindings: { '80/tcp': [{ HostIp: '0.0.0.0', HostPort: '50001' }] },
        RestartPolicy: { Name: 'unless-stopped' },
      },
    });
    const publicProbe = probe({ inspect: publicInspect });
    expect(publicProbe.result).toMatchObject({ ready: false, loopbackOnly: false });
    expect(publicProbe.result.reason).toMatch(/127\.0\.0\.1:50001/);
    expect(publicProbe.calls).toHaveLength(1);

    const looseAuth = probe({ stats: protectedAuthStats(0o100644) });
    expect(looseAuth.result).toMatchObject({ ready: false, protectedAuth: false });
    expect(looseAuth.calls).toHaveLength(1);

    const duplicateAuth = probe({
      auth: 'AUTH_LOGIN=portal\nAUTH_LOGIN=second\nAUTH_PASSWORD=secret\n',
    });
    expect(duplicateAuth.result).toMatchObject({ ready: false, protectedAuth: false });
    expect(duplicateAuth.calls).toHaveLength(1);

    const injectedSetting = probe({
      auth: 'AUTH_LOGIN=portal\nAUTH_PASSWORD=secret\nDISABLE_AUTH=true\n',
    });
    expect(injectedSetting.result).toMatchObject({ ready: false, protectedAuth: false });
    expect(injectedSetting.calls).toHaveLength(1);
  });

  test('rejects unprotected or version-drifted connector capabilities', () => {
    expect(probe({ capabilities: capabilities({ auth_required: false }) }).result)
      .toMatchObject({ ready: false, protocolCompatible: false });
    expect(probe({ capabilities: capabilities({ version: '1.4' }) }).result)
      .toMatchObject({ ready: false, protocolCompatible: false });
    expect(probe({ capabilities: capabilities({ agent_zero_version: '2.6' }) }).result)
      .toMatchObject({ ready: false, protocolCompatible: false });
    expect(probe({ capabilities: capabilities({ websocket_handlers: [] }) }).result)
      .toMatchObject({ ready: false, protocolCompatible: false });
    expect(probe({ capabilities: capabilities({ features: [] }) }).result)
      .toMatchObject({ ready: false, protocolCompatible: false });
  });

  test('reports a missing container without invoking readiness', () => {
    const calls: string[] = [];
    const result = probeAgentZeroRuntime({
      architecture: 'amd64',
      runCommand: (command) => {
        calls.push(command);
        throw new Error('not found');
      },
    });
    expect(result).toMatchObject({ installed: false, ready: false });
    expect(result.reason).toMatch(/not installed/i);
    expect(calls).toEqual(['docker']);
  });

  test('installer contract is pinned, private, persistent, authenticated, and rollback-aware', () => {
    const scriptPath = path.resolve(process.cwd(), '../installer/agent-zero-runtime.sh');
    const script = readFileSync(scriptPath, 'utf8');
    expect(script).toContain(AGENT_ZERO_IMAGE_DIGESTS.amd64);
    expect(script).toContain(AGENT_ZERO_IMAGE_DIGESTS.arm64);
    expect(script).toContain('--publish "${A0_HOST}:${host_port}:80"');
    expect(script).toContain('type=volume,src=${data_volume},dst=/a0/usr');
    expect(script).toContain('type=bind,src=${A0_AUTH_FILE},dst=/a0/.env,readonly');
    expect(script).toContain('auth_required');
    expect(script).toContain('backup_data_volume');
    expect(script).toContain('rollback_runtime');
    expect(script).toContain(AGENT_ZERO_HOST_GATEWAY_CLI_COMMIT);
    expect(script).toContain(AGENT_ZERO_HOST_GATEWAY_ARCHIVE_SHA256);
    expect(script).toContain(AGENT_ZERO_HOST_GATEWAY_RUNTIME_CONSTRAINTS_SHA256);
    expect(script).toContain(AGENT_ZERO_HOST_GATEWAY_BUILD_CONSTRAINTS_SHA256);
    expect(script).toContain('--no-deps --require-hashes');
    expect(script).toContain('host-bridge-reconcile');
    expect(script).toContain('host-bridge-rollback');
    expect(script).toContain('readonly A0_CONNECTOR_VERSION="0.1.0"');
    expect(script).toContain(`readonly A0_CODEX_CLIENT_VERSION="${PORTAL_TOOL_VERSIONS.codexCli}"`);
    expect(script).toContain('configure_agent_zero_codex_client_version');
    expect(script).toContain('agent_zero_codex_client_version_ok');
    expect(script).toContain('credentials-reload');
    expect(script).not.toMatch(/agent0ai\/agent-zero:(?:latest|2\.5)/);
    expect(script).not.toContain('-p 50001:80');
    expect(script).not.toMatch(/curl[^\n]*\|\s*(?:ba)?sh/);
  });

  test('Project model bridge is packaged, installed fail-closed, and reconciled through stdin-only secrets', () => {
    const portalRoot = path.resolve(process.cwd(), '..');
    const lifecycle = readFileSync(
      path.join(portalRoot, 'installer/agent-zero-project-model-bridge.sh'),
      'utf8',
    );
    const installer = readFileSync(path.join(portalRoot, 'installer/install.sh'), 'utf8');
    const inventory = readFileSync(
      path.join(portalRoot, 'installer/release-required-members.txt'),
      'utf8',
    );

    expect(lifecycle).toContain('install) install_bridge_service');
    expect(lifecycle).toContain('User=${BRIDGE_USER}');
    expect(lifecycle).toContain('NoNewPrivileges=true');
    expect(lifecycle).toContain('ProtectSystem=strict');
    expect(lifecycle).toContain('CapabilityBoundingSet=');
    expect(lifecycle).toContain("for provider in codex github-copilot gemini-api xai-grok");
    expect(lifecycle).toContain("[[ \"$status\" == '401' ]] || return 1");
    expect(lifecycle).toContain("printf '%s\\n%s' \"$token\" \"$A0_CODEX_CLIENT_VERSION\" | docker exec -i --workdir /a0");
    expect(lifecycle).toContain('/opt/venv-a0/bin/python -c');
    expect(lifecycle).toContain(`readonly A0_CODEX_CLIENT_VERSION='${PORTAL_TOOL_VERSIONS.codexCli}'`);
    expect(lifecycle).toContain('codex["codex_version"] = codex_version');
    expect(lifecycle).toContain('codex["require_proxy_token"] = False');
    expect(lifecycle).not.toContain('codex["require_proxy_token"] = True');
    expect(lifecycle).not.toMatch(/docker exec[^\n]*(?:\$token|AGENT_ZERO_PROJECT_MODEL_BRIDGE_UPSTREAM_TOKEN)/);

    expect(installer.match(/ensure_agent_zero_project_model_bridge/g)?.length).toBeGreaterThanOrEqual(3);
    expect(installer).toContain('lifecycle_command="reconcile"');
    expect(installer).toContain('docker container inspect bridgesllm-agent-zero');
    expect(installer).toContain('bash "$lifecycle" "$lifecycle_command"');
    expect(inventory).toContain('portal/installer/agent-zero-project-model-bridge.sh');
    expect(inventory).toContain(
      'portal/backend/dist/agents/providers/agentZero/AgentZeroProjectModelBridge.js',
    );
    expect(inventory).toContain(
      'portal/backend/dist/agents/providers/agentZero/AgentZeroProjectModelBridgeCredential.js',
    );
  });

  test('Project sandbox image recipe is non-root, direct-launch, pinned, and release-packaged', () => {
    const portalRoot = path.resolve(process.cwd(), '..');
    const dockerfile = readFileSync(
      path.join(portalRoot, 'installer/agent-zero-project-sandbox.Dockerfile'),
      'utf8',
    );
    const installer = readFileSync(path.join(portalRoot, 'installer/install.sh'), 'utf8');
    const inventory = readFileSync(
      path.join(portalRoot, 'installer/release-required-members.txt'),
      'utf8',
    );

    expect(AGENT_ZERO_PROJECT_SOURCE_COMMITS.amd64).toMatch(/^[a-f0-9]{40}$/);
    expect(AGENT_ZERO_PROJECT_SOURCE_COMMITS.arm64).toBe(AGENT_ZERO_PROJECT_SOURCE_COMMITS.amd64);
    expect(dockerfile).toContain(AGENT_ZERO_PROJECT_UPSTREAM_IMAGE_DIGESTS.amd64);
    expect(dockerfile).toContain('test "$(git -C /git/agent-zero rev-parse HEAD)" = "${A0_SOURCE_COMMIT}"');
    expect(dockerfile).toContain('cp -a /git/agent-zero/. /a0/');
    expect(dockerfile).toContain('test -f /git/agent-zero/plugins/_a0_connector/api/ws_connector.py');
    expect(dockerfile).toContain(`USER ${AGENT_ZERO_PROJECT_IMAGE_RUNTIME_USER}`);
    expect(dockerfile).toContain('ENTRYPOINT []');
    expect(dockerfile).toContain(
      'CMD ["/opt/venv-a0/bin/python", "/a0/run_ui.py", "--dockerized=true", "--port=80", "--host=0.0.0.0"]',
    );
    expect(dockerfile).not.toMatch(/supervisord|sshd|cron|tunnel|apt(?:-get)?\s|update[_ -]?manager/i);

    expect(installer).toContain('ensure_agent_zero_project_sandbox_image');
    expect(installer).toContain('AGENT_ZERO_PROJECT_SANDBOX_IMAGE_ID');
    expect(inventory).toContain('portal/installer/agent-zero-project-sandbox.Dockerfile');
    expect(inventory).toContain(
      'portal/backend/dist/agents/providers/agentZero/AgentZeroProjectImage.js',
    );
  });

  test('generic tool installation cannot bypass the managed authenticated lifecycle', () => {
    const adapter = getToolAdapter('agent-zero');
    expect(adapter).toMatchObject({
      authRequired: true,
      install: [],
      detect: {
        command: 'bash /opt/bridgesllm/portal/installer/agent-zero-runtime.sh status',
      },
    });
    expect([...SAFE_INSTALL_ALLOWLIST].some((command) => /agent0ai\/agent-zero/.test(command))).toBe(false);
  });

  test('native CLI auth probing is not used for connector session readiness', () => {
    expect(getNativeCliAuthStatus('AGENT_ZERO')).toMatchObject({
      status: 'unknown',
      requiresSeparateLogin: true,
      message: expect.stringMatching(/not been checked/i),
    });
  });
});
