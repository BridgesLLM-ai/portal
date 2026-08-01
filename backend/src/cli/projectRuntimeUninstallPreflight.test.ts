import fs from 'fs';
import os from 'os';
import path from 'path';
import type { ProjectIdentityRecord } from '../services/projectIdentity';
import {
  PROJECT_RUNTIME_UNINSTALL_LIMITS,
  ProjectRuntimeUninstallPreflightError,
  preflightFailureDetail,
  cleanupOrphanedProjectRuntimeResiduals,
  assertPortalServiceStopped,
  cleanupKnownProjectFirewallResiduals,
  loadProtectedEnvironmentFile,
  parseProjectRuntimeUninstallArguments,
  projectRuntimeUninstallPreflightMain,
  runProjectRuntimeUninstallPreflight,
  scanKnownProjectRuntimeResiduals,
  type ProjectRuntimeUninstallPreflightDependencies,
  type ProjectRuntimeUninstallReadOnlyCommandRunner,
} from './projectRuntimeUninstallPreflight';

function identity(id: string, projectName = `project-${id}`): ProjectIdentityRecord {
  return {
    id,
    workspaceOwnerId: `owner-${id}`,
    projectName,
    canonicalRoot: `/opt/bridgesllm/projects/owner-${id}/${projectName}`,
    rootDevice: '1',
    rootInode: '2',
    rootBirthtimeNs: '3',
    generation: 1,
    lifecycleStatus: 'ACTIVE',
    deletionStartedAt: null,
    createdAt: new Date('2026-07-20T00:00:00.000Z'),
    updatedAt: new Date('2026-07-20T00:00:00.000Z'),
  };
}

function dependencies(
  overrides: Partial<ProjectRuntimeUninstallPreflightDependencies> = {},
): ProjectRuntimeUninstallPreflightDependencies {
  return {
    listProjectIdentities: async () => [],
    listProjectApps: async () => [],
    stopProjectApp: async () => undefined,
    removeProjectWorkloads: async () => 0,
    cleanupProjectRuntime: async () => ({ removedResourceCount: 0 }),
    cleanupKnownFirewallResiduals: async () => 0,
    cleanupOrphanedResiduals: async () => 0,
    scanKnownResiduals: async () => [],
    disconnect: async () => undefined,
    ...overrides,
  };
}

describe('project runtime uninstall preflight', () => {
  test('cleans every identity in deterministic order and verifies global residue last', async () => {
    const calls: string[] = [];
    const fixture = dependencies({
      listProjectIdentities: async (limit) => {
        expect(limit).toBe(PROJECT_RUNTIME_UNINSTALL_LIMITS.projectIdentities + 1);
        return [identity('b'), identity('a')];
      },
      listProjectApps: async (project, limit) => {
        calls.push(`apps:${project.id}`);
        expect(limit).toBe(PROJECT_RUNTIME_UNINSTALL_LIMITS.appsPerProject + 1);
        return project.id === 'a'
          ? [{ id: 'app-2', userId: 'owner-a' }, { id: 'app-1', userId: 'owner-a' }]
          : [];
      },
      stopProjectApp: async (project, app) => { calls.push(`stop:${project.id}:${app.id}`); },
      removeProjectWorkloads: async (projectId) => {
        calls.push(`workloads:${projectId}`);
        return projectId === 'a' ? 2 : 1;
      },
      cleanupProjectRuntime: async (project) => {
        calls.push(`cleanup:${project.id}`);
        return { removedResourceCount: project.id === 'a' ? 4 : 3 };
      },
      cleanupKnownFirewallResiduals: async () => {
        calls.push('firewall');
        return 0;
      },
      scanKnownResiduals: async () => {
        calls.push('scan');
        return [];
      },
    });

    await expect(runProjectRuntimeUninstallPreflight(fixture, {
      deadlineMs: Date.now() + 60_000,
    })).resolves.toEqual({
      projectCount: 2,
      appCount: 2,
      workloadCount: 3,
      providerResourceCount: 7,
    });
    expect(calls).toEqual([
      'apps:a',
      'stop:a:app-1',
      'stop:a:app-2',
      'workloads:a',
      'cleanup:a',
      'apps:b',
      'workloads:b',
      'cleanup:b',
      'firewall',
      'scan',
    ]);
  });

  test('is idempotent when the database and known-label scan are already clean', async () => {
    await expect(runProjectRuntimeUninstallPreflight(dependencies(), {
      deadlineMs: Date.now() + 60_000,
    })).resolves.toEqual({
      projectCount: 0,
      appCount: 0,
      workloadCount: 0,
      providerResourceCount: 0,
    });
  });

  test('fails closed on bounded project and app discovery limits', async () => {
    const tooManyProjects = Array.from(
      { length: PROJECT_RUNTIME_UNINSTALL_LIMITS.projectIdentities + 1 },
      (_, index) => identity(`project-${index}`),
    );
    await expect(runProjectRuntimeUninstallPreflight(dependencies({
      listProjectIdentities: async () => tooManyProjects,
    }), { deadlineMs: Date.now() + 60_000 })).rejects.toMatchObject({
      code: 'PROJECT_IDENTITY_LIMIT_EXCEEDED',
    });

    const tooManyApps = Array.from(
      { length: PROJECT_RUNTIME_UNINSTALL_LIMITS.appsPerProject + 1 },
      (_, index) => ({ id: `app-${index}`, userId: 'owner-a' }),
    );
    await expect(runProjectRuntimeUninstallPreflight(dependencies({
      listProjectIdentities: async () => [identity('a')],
      listProjectApps: async () => tooManyApps,
    }), { deadlineMs: Date.now() + 60_000 })).rejects.toMatchObject({
      code: 'PROJECT_APP_LIMIT_EXCEEDED',
      safeIdentifiers: ['a'],
    });
  });

  test('does not propagate provider errors or unsafe identifiers', async () => {
    const error = await runProjectRuntimeUninstallPreflight(dependencies({
      listProjectIdentities: async () => [identity('project\nsecret')],
      cleanupProjectRuntime: async () => {
        throw new Error('cookie=super-secret-provider-value');
      },
    }), { deadlineMs: Date.now() + 60_000 }).catch((failure) => failure);
    expect(error).toBeInstanceOf(ProjectRuntimeUninstallPreflightError);
    expect(error).toMatchObject({ code: 'PROJECT_PROVIDER_CLEANUP_FAILED' });
    expect(JSON.stringify(error)).not.toContain('super-secret-provider-value');
    expect(error.safeIdentifiers[0]).toMatch(/^redacted-[a-f0-9]{16}$/);
  });

  test('fails closed when orphaned known-label resources remain', async () => {
    await expect(runProjectRuntimeUninstallPreflight(dependencies({
      scanKnownResiduals: async () => [
        { kind: 'container', identifier: 'portal-runtime-one' },
        { kind: 'volume', identifier: 'portal-volume-one' },
      ],
    }), { deadlineMs: Date.now() + 60_000 })).rejects.toMatchObject({
      code: 'PROJECT_RUNTIME_RESIDUALS',
      safeIdentifiers: ['container:portal-runtime-one', 'volume:portal-volume-one'],
    });
  });

  test('rejects an expired overall deadline before discovery', async () => {
    const listProjectIdentities = jest.fn(async () => []);
    await expect(runProjectRuntimeUninstallPreflight(dependencies({ listProjectIdentities }), {
      deadlineMs: Date.now() - 1,
    })).rejects.toMatchObject({ code: 'PREFLIGHT_DEADLINE_EXCEEDED' });
    expect(listProjectIdentities).not.toHaveBeenCalled();
  });
});

describe('known project runtime residual scanner', () => {
  test('uses only read-only Docker list commands, deduplicates, and sanitizes identifiers', async () => {
    const calls: Array<{ file: string; args: readonly string[] }> = [];
    const runner: ProjectRuntimeUninstallReadOnlyCommandRunner = {
      async run(file, args) {
        calls.push({ file, args });
        const kind = args[0];
        const selector = args.find((entry) => entry.startsWith('label=')) || '';
        if (kind === 'container' && selector.includes('runtime-fingerprint')) {
          return { code: 0, stdout: 'abc123\tportal-project-runtime\n' };
        }
        if (kind === 'container' && selector.includes('project-workload')) {
          return { code: 0, stdout: 'abc123\tportal-project-runtime\n' };
        }
        if (kind === 'container' && selector.includes('ollama-project.policy')) {
          return { code: 0, stdout: 'ollama123\torphaned-ollama-project-runtime\n' };
        }
        if (kind === 'volume') return { code: 0, stdout: 'portal-project-volume\n' };
        if (kind === 'network' && selector.includes('agent-zero-project')) {
          return { code: 0, stdout: 'a0-network\tbridgesllm-agent-zero-project-orphan\n' };
        }
        if (kind === 'network') return { code: 0, stdout: 'def456\tbad name with spaces\n' };
        return { code: 0, stdout: '' };
      },
    };

    const result = await scanKnownProjectRuntimeResiduals(runner);
    expect(result).toHaveLength(5);
    expect(result).toContainEqual({ kind: 'container', identifier: 'portal-project-runtime' });
    expect(result).toContainEqual({
      kind: 'container',
      identifier: 'orphaned-ollama-project-runtime',
    });
    expect(result).toContainEqual({ kind: 'volume', identifier: 'portal-project-volume' });
    expect(result).toContainEqual({
      kind: 'network',
      identifier: 'bridgesllm-agent-zero-project-orphan',
    });
    expect(result.some((entry) => entry.kind === 'network'
      && /^redacted-[a-f0-9]{16}$/.test(entry.identifier))).toBe(true);
    expect(calls).toHaveLength(13);
    expect(calls).toContainEqual({
      file: '/usr/bin/docker',
      args: expect.arrayContaining([
        'container',
        'ls',
        'label=com.bridgesllm.ollama-project.policy',
      ]),
    });
    for (const call of calls) {
      expect(call.file).toBe('/usr/bin/docker');
      expect(['container', 'volume', 'network']).toContain(call.args[0]);
      expect(call.args).toContain('ls');
      expect(call.args).not.toContain('rm');
      expect(call.args).not.toContain('remove');
    }
  });

  test('finds running and unlabeled exact product-name orphans across containers, networks, and volumes', async () => {
    const hex20 = 'a'.repeat(20);
    const hex24 = 'b'.repeat(24);
    const exactContainers = [
      `p4e-proxy-${hex20}`,
      `p4ol-${hex24}`,
      `p4cx-${hex24}`,
      `p4cc-${hex24}`,
      `p4ag-${hex24}`,
      `p4oc-${'c'.repeat(16)}-agent-p4oc-${'d'.repeat(21)}-${'e'.repeat(8)}`,
      `p4oc-${'c'.repeat(16)}-custom_session.v2-${'e'.repeat(8)}`,
      `bridgesllm-a0p-${hex24}`,
      `bridgesllm-project-app-${hex20}`,
      `bridgesllm-project-job-${hex20}`,
      `bridgesllm-project-git-${hex20}`,
    ];
    const exactNetworks = [`p4e-in-${hex20}`, `p4e-out-${hex20}`];
    const exactVolume = `bridgesllm-a0p-${hex24}-usr`;
    const unrelatedLookalikes = [
      `p4e-proxy-${'g'.repeat(20)}`,
      `p4ol-${hex20}`,
      `p4cx-${hex24}-extra`,
      `p4cc-${hex24.toUpperCase()}`,
      `p4ag-${hex24.slice(1)}`,
      `p4oc-${'c'.repeat(16)}-custom-session`,
      `bridgesllm-a0p-${hex24}-usr-extra`,
      `customer-p4e-in-${hex20}`,
      'ordinary-container',
    ];
    const runner: ProjectRuntimeUninstallReadOnlyCommandRunner = {
      async run(_file, args) {
        const hasLabelFilter = args.some((entry) => entry.startsWith('label='));
        if (hasLabelFilter) return { code: 0, stdout: '' };
        if (args[0] === 'container') {
          return {
            code: 0,
            // `container ls --all` is authoritative for both running and
            // stopped containers; the first exact entry models a live orphan.
            stdout: [...exactContainers, ...unrelatedLookalikes]
              .map((name, index) => `container-${index}\t${name}`)
              .join('\n'),
          };
        }
        if (args[0] === 'network') {
          return {
            code: 0,
            stdout: [...exactNetworks, ...unrelatedLookalikes]
              .map((name, index) => `network-${index}\t${name}`)
              .join('\n'),
          };
        }
        if (args[0] === 'volume') {
          return { code: 0, stdout: [exactVolume, ...unrelatedLookalikes].join('\n') };
        }
        return { code: 64, stdout: '' };
      },
    };

    const result = await scanKnownProjectRuntimeResiduals(runner);
    expect(result).toHaveLength(exactContainers.length + exactNetworks.length + 1);
    for (const identifier of exactContainers) {
      expect(result).toContainEqual({ kind: 'container', identifier });
    }
    for (const identifier of exactNetworks) {
      expect(result).toContainEqual({ kind: 'network', identifier });
    }
    expect(result).toContainEqual({ kind: 'volume', identifier: exactVolume });
    for (const identifier of unrelatedLookalikes) {
      expect(result.some((entry) => entry.identifier === identifier)).toBe(false);
    }
  });

  test('global exact-name discovery fails closed on Docker errors', async () => {
    await expect(scanKnownProjectRuntimeResiduals({
      async run(_file, args) {
        if (args.some((entry) => entry.startsWith('label='))) return { code: 0, stdout: '' };
        return args[0] === 'network'
          ? { code: 1, stdout: '' }
          : { code: 0, stdout: '' };
      },
    })).rejects.toMatchObject({ code: 'DOCKER_RESIDUAL_SCAN_FAILED' });
  });

  test('fails closed on Docker errors and excessive residual counts', async () => {
    await expect(scanKnownProjectRuntimeResiduals({
      run: async () => ({ code: 1, stdout: '' }),
    })).rejects.toMatchObject({ code: 'DOCKER_RESIDUAL_SCAN_FAILED' });

    const output = Array.from(
      { length: PROJECT_RUNTIME_UNINSTALL_LIMITS.residualResources + 1 },
      (_, index) => `id-${index}\tcontainer-${index}`,
    ).join('\n');
    await expect(scanKnownProjectRuntimeResiduals({
      run: async () => ({ code: 0, stdout: output }),
    })).rejects.toMatchObject({ code: 'PROJECT_RESIDUAL_LIMIT_EXCEEDED' });
  });
});

describe('global managed project firewall cleanup', () => {
  function statefulFirewallRunner(initial: Readonly<Record<string, readonly string[]>>) {
    const states = new Map(Object.entries(initial).map(([file, lines]) => [file, [...lines]]));
    const calls: Array<{ file: string; args: readonly string[] }> = [];
    const runner: ProjectRuntimeUninstallReadOnlyCommandRunner = {
      async run(file, args) {
        calls.push({ file, args: [...args] });
        const lines = states.get(file);
        if (!lines) return { code: 127, stdout: '' };
        if (args[0] === '-w' && args[1] === '-S') {
          return { code: 0, stdout: `${lines.join('\n')}\n` };
        }
        if (args[0] === '-w' && args[1] === '-D') {
          const statement = ['-A', args[2], ...args.slice(3)].join(' ');
          const index = lines.indexOf(statement);
          if (index < 0) return { code: 1, stdout: '' };
          lines.splice(index, 1);
          return { code: 0, stdout: '' };
        }
        if (args[0] === '-w' && args[1] === '-F') {
          const prefix = `-A ${args[2]} `;
          states.set(file, lines.filter((line) => !line.startsWith(prefix)));
          return { code: 0, stdout: '' };
        }
        if (args[0] === '-w' && args[1] === '-X') {
          const current = states.get(file)!;
          const chain = args[2];
          if (current.some((line) => line.startsWith(`-A ${chain} `)
            || line.includes(` -j ${chain}`) || line.includes(` -g ${chain}`))) {
            return { code: 1, stdout: '' };
          }
          states.set(file, current.filter((line) => line !== `-N ${chain}`));
          return { code: 0, stdout: '' };
        }
        return { code: 64, stdout: '' };
      },
    };
    return { runner, states, calls };
  }

  test('removes only exact orphaned P4E/A0P signatures in IPv4/IPv6 and verifies shared chains absent', async () => {
    const project = 'a'.repeat(64);
    const p4eIdentity = 'b'.repeat(64);
    const a0pIdentity = 'c'.repeat(64);
    const p4eChain = `P4E-${p4eIdentity.slice(0, 23).toUpperCase()}`;
    const a0pChain = `A0P-${a0pIdentity.slice(0, 24).toUpperCase()}`;
    const p4eComment = `p4e-v1:${project}:${p4eIdentity}`;
    const a0pComment = `a0p-v3:${project}:${a0pIdentity}`;
    const fixture = statefulFirewallRunner({
      '/usr/sbin/iptables': [
        '-P INPUT ACCEPT',
        '-P FORWARD ACCEPT',
        '-P OUTPUT ACCEPT',
        '-N DOCKER-USER',
        '-N P4E-MASTER-V1',
        '-N P4E-HOST-V1',
        `-N ${p4eChain}`,
        `-N ${a0pChain}`,
        '-A INPUT -j P4E-HOST-V1',
        `-A INPUT -s 172.30.0.9/32 -m comment --comment ${a0pComment} -j ${a0pChain}`,
        '-A DOCKER-USER -j P4E-MASTER-V1',
        `-A DOCKER-USER -s 172.30.0.9/32 -m comment --comment ${a0pComment} -j ${a0pChain}`,
        `-A P4E-MASTER-V1 -s 172.31.0.4/32 -m comment --comment ${p4eComment} -j ${p4eChain}`,
        `-A P4E-HOST-V1 -s 172.31.0.0/24 -m comment --comment ${p4eComment} -j REJECT`,
        `-A ${p4eChain} -d 10.0.0.0/8 -m comment --comment ${p4eComment} -j REJECT`,
        `-A ${p4eChain} -p tcp -m multiport --dports 80,443 -m comment --comment ${p4eComment} -j RETURN`,
        `-A ${p4eChain} -m comment --comment ${p4eComment} -j REJECT`,
        `-A ${a0pChain} -m conntrack --ctstate RELATED,ESTABLISHED -m comment --comment ${a0pComment} -j ACCEPT`,
        `-A ${a0pChain} -d 172.31.0.4/32 -p tcp -m tcp --dport 3128 -m comment --comment ${a0pComment} -j ACCEPT`,
        `-A ${a0pChain} -d 172.30.0.1/32 -p tcp -m tcp --dport 50110 -m comment --comment ${a0pComment} -j ACCEPT`,
        `-A ${a0pChain} -m comment --comment ${a0pComment} -j REJECT`,
      ],
      '/usr/sbin/ip6tables': [
        '-P INPUT ACCEPT',
        '-P FORWARD ACCEPT',
        '-P OUTPUT ACCEPT',
        '-N DOCKER-USER',
        '-N P4E-MASTER-V1',
        '-N P4E-HOST-V1',
        `-N ${p4eChain}`,
        '-A INPUT -j P4E-HOST-V1',
        '-A DOCKER-USER -j P4E-MASTER-V1',
        `-A P4E-MASTER-V1 -s fd00::4/128 -m comment --comment ${p4eComment} -j ${p4eChain}`,
        `-A P4E-HOST-V1 -s fd00::/64 -m comment --comment ${p4eComment} -j REJECT`,
        `-A ${p4eChain} -d fc00::/7 -m comment --comment ${p4eComment} -j REJECT`,
        `-A ${p4eChain} -d 2000::/3 -p tcp -m multiport --dports 80,443 -m comment --comment ${p4eComment} -j RETURN`,
        `-A ${p4eChain} -m comment --comment ${p4eComment} -j REJECT`,
      ],
    });

    await expect(cleanupKnownProjectFirewallResiduals(fixture.runner)).resolves.toBe(9);
    expect(fixture.states.get('/usr/sbin/iptables')).toEqual([
      '-P INPUT ACCEPT', '-P FORWARD ACCEPT', '-P OUTPUT ACCEPT', '-N DOCKER-USER',
    ]);
    expect(fixture.states.get('/usr/sbin/ip6tables')).toEqual([
      '-P INPUT ACCEPT', '-P FORWARD ACCEPT', '-P OUTPUT ACCEPT', '-N DOCKER-USER',
    ]);
    expect(fixture.calls.some(({ args }) => args[1] === '-F'
      && ['INPUT', 'DOCKER-USER'].includes(String(args[2])))).toBe(false);
    expect(fixture.calls.every(({ args }) => !args.includes('*'))).toBe(true);
  });

  test('fails before mutation on ambiguous chains and on enumeration errors', async () => {
    const identity = 'd'.repeat(64);
    const chain = `P4E-${identity.slice(0, 23).toUpperCase()}`;
    const ambiguous = statefulFirewallRunner({
      '/usr/sbin/iptables': [`-N ${chain}`, `-A ${chain} -j ACCEPT`],
      '/usr/sbin/ip6tables': [],
    });
    await expect(cleanupKnownProjectFirewallResiduals(ambiguous.runner)).rejects.toMatchObject({
      code: 'PROJECT_FIREWALL_AMBIGUOUS_CHAIN',
    });
    expect(ambiguous.calls.every(({ args }) => args[1] === '-S')).toBe(true);

    await expect(cleanupKnownProjectFirewallResiduals({
      run: async () => ({ code: 4, stdout: '' }),
    })).rejects.toMatchObject({ code: 'PROJECT_FIREWALL_COMMAND_FAILED' });
  });
});

describe('uninstall preflight CLI guards', () => {
  test('requires an inactive, known Portal service state', async () => {
    await expect(assertPortalServiceStopped({
      run: async () => ({ code: 0, stdout: '' }),
    })).rejects.toMatchObject({ code: 'PORTAL_SERVICE_ACTIVE' });
    await expect(assertPortalServiceStopped({
      run: async () => ({ code: 4, stdout: '' }),
    })).rejects.toMatchObject({ code: 'PORTAL_SERVICE_STATE_UNKNOWN' });
    await expect(assertPortalServiceStopped({
      run: async () => ({ code: 3, stdout: '' }),
    })).resolves.toBeUndefined();
  });

  test('accepts only bounded arguments and absolute environment paths', () => {
    expect(parseProjectRuntimeUninstallArguments([
      '--env-file', '/opt/bridgesllm/portal/backend/.env.production',
      '--max-runtime-seconds', '1740',
    ])).toEqual({
      envFile: '/opt/bridgesllm/portal/backend/.env.production',
      maxRuntimeSeconds: 1740,
    });
    expect(() => parseProjectRuntimeUninstallArguments(['--env-file', 'relative.env']))
      .toThrow(ProjectRuntimeUninstallPreflightError);
    expect(() => parseProjectRuntimeUninstallArguments(['--max-runtime-seconds', '59']))
      .toThrow(ProjectRuntimeUninstallPreflightError);
    expect(() => parseProjectRuntimeUninstallArguments(['--unknown']))
      .toThrow(ProjectRuntimeUninstallPreflightError);
  });

  test('loads only a root-owned, non-writable, complete production environment file', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'portal-uninstall-env-'));
    const envFile = path.join(root, '.env.production');
    const prior = {
      NODE_ENV: process.env.NODE_ENV,
      DATABASE_URL: process.env.DATABASE_URL,
      JWT_SECRET: process.env.JWT_SECRET,
      JWT_REFRESH_SECRET: process.env.JWT_REFRESH_SECRET,
      PROJECT_EGRESS_TOKEN_SECRET: process.env.PROJECT_EGRESS_TOKEN_SECRET,
    };
    try {
      fs.writeFileSync(envFile, [
        'NODE_ENV=production',
        'DATABASE_URL=postgresql://portal.invalid/portal',
        'JWT_SECRET=test-jwt',
        'JWT_REFRESH_SECRET=test-refresh',
        `PROJECT_EGRESS_TOKEN_SECRET=${'a'.repeat(43)}`,
      ].join('\n'), { mode: 0o600 });
      loadProtectedEnvironmentFile(envFile);
      expect(process.env.DATABASE_URL).toBe('postgresql://portal.invalid/portal');

      fs.chmodSync(envFile, 0o622);
      expect(() => loadProtectedEnvironmentFile(envFile)).toThrow(
        expect.objectContaining({ code: 'DEPLOYED_ENV_UNSAFE' }),
      );
    } finally {
      for (const [key, value] of Object.entries(prior)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  test('refuses non-root execution before touching the environment or database', async () => {
    const loadEnvironment = jest.fn();
    const loadDependencies = jest.fn();
    let stderr = '';
    const code = await projectRuntimeUninstallPreflightMain([], {
      stdout: { write: () => true },
      stderr: { write: (value) => { stderr += String(value); return true; } },
    }, {
      getUid: () => 1000,
      loadEnvironment,
      loadDependencies,
    });
    expect(code).toBe(1);
    expect(stderr).toBe('Portal project-runtime uninstall preflight failed: ROOT_REQUIRED\n');
    expect(loadEnvironment).not.toHaveBeenCalled();
    expect(loadDependencies).not.toHaveBeenCalled();
  });

  test('disconnects after success and emits only bounded aggregate output', async () => {
    const disconnect = jest.fn(async () => undefined);
    let stdout = '';
    let stderr = '';
    const code = await projectRuntimeUninstallPreflightMain([], {
      stdout: { write: (value) => { stdout += String(value); return true; } },
      stderr: { write: (value) => { stderr += String(value); return true; } },
    }, {
      getUid: () => 0,
      loadEnvironment: () => undefined,
      assertServiceStopped: async () => undefined,
      loadDependencies: async () => dependencies({ disconnect }),
    });
    expect(code).toBe(0);
    expect(disconnect).toHaveBeenCalledTimes(1);
    expect(stderr).toBe('');
    expect(stdout).toBe(
      'Portal project-runtime uninstall preflight complete: projects=0 apps=0 workloads=0 resources=0\n',
    );
  });
});

describe('preflight failure detail redaction', () => {
  test('keeps human-readable prose that aids diagnosis', () => {
    expect(preflightFailureDetail(new Error('OPENCLAW Project runtime cleanup failed')))
      .toBe('OPENCLAW Project runtime cleanup failed');
  });

  test('redacts assignments, URLs, and opaque blobs', () => {
    const detail = preflightFailureDetail(new Error(
      'cleanup failed cookie=super-secret-provider-value at https://provider.example/x '
      + 'token AKIAIOSFODNN7EXAMPLEEXAMPLE authorization: Bearer abcdef',
    ));
    expect(detail).not.toContain('super-secret-provider-value');
    expect(detail).not.toContain('provider.example');
    expect(detail).not.toContain('AKIAIOSFODNN7EXAMPLEEXAMPLE');
    expect(detail).toContain('cleanup failed');
  });

  test('bounds length and normalizes newlines', () => {
    const detail = preflightFailureDetail(new Error('a\nb\n' + 'x'.repeat(500)));
    expect(detail.length).toBeLessThanOrEqual(300);
    expect(detail).not.toContain('\n');
  });

  test('handles non-Error throws without throwing', () => {
    expect(preflightFailureDetail('plain string failure')).toBe('plain string failure');
    expect(preflightFailureDetail(null)).toBe('');
    expect(preflightFailureDetail(undefined)).toBe('');
    expect(preflightFailureDetail({ weird: true })).toBe('');
  });
});

describe('orphaned managed residual cleanup', () => {
  test('removes managed resources whose project row is gone, and only those', async () => {
    // The scan searches by Docker label but per-project cleanup iterates
    // database identities, so an orphan is detected and never removed --
    // which made clean-slate uninstall permanently impossible.
    const commands: Array<{ file: string; args: readonly string[] }> = [];
    const runner: ProjectRuntimeUninstallReadOnlyCommandRunner = {
      async run(file, args) {
        commands.push({ file, args });
        // List calls return one managed resource; removals succeed.
        if (args.includes('ls')) {
          if (args.some((a) => String(a).includes('agent-zero-project'))) {
            return { code: 0, stdout: 'bridgesllm-a0p-deadbeef-usr\n' };
          }
          return { code: 0, stdout: '' };
        }
        return { code: 0, stdout: '' };
      },
    };

    const removed = await cleanupOrphanedProjectRuntimeResiduals(runner);
    expect(removed).toBeGreaterThan(0);

    const removals = commands.filter((entry) => (
      entry.args.includes('rm')
    ));
    expect(removals.length).toBeGreaterThan(0);
    // Every removal targets the labelled resource we listed - never a wildcard,
    // never a prune, never an unlabelled name.
    for (const removal of removals) {
      expect(removal.file).toBe('/usr/bin/docker');
      expect(removal.args).toContain('bridgesllm-a0p-deadbeef-usr');
      expect(removal.args).not.toContain('prune');
      expect(removal.args).not.toContain('--all');
    }
  });

  test('reports zero and issues no removals when nothing is labelled', async () => {
    const commands: Array<readonly string[]> = [];
    const runner: ProjectRuntimeUninstallReadOnlyCommandRunner = {
      async run(_file, args) {
        commands.push(args);
        return { code: 0, stdout: '' };
      },
    };
    await expect(cleanupOrphanedProjectRuntimeResiduals(runner)).resolves.toBe(0);
    expect(commands.every((args) => !args.includes('rm'))).toBe(true);
  });

  test('fails closed when the label scan itself errors', async () => {
    const runner: ProjectRuntimeUninstallReadOnlyCommandRunner = {
      async run() {
        return { code: 1, stdout: '' };
      },
    };
    await expect(cleanupOrphanedProjectRuntimeResiduals(runner))
      .rejects.toMatchObject({ code: 'DOCKER_RESIDUAL_SCAN_FAILED' });
  });
});
