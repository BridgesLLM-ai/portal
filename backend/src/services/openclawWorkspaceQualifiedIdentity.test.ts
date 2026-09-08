import crypto from 'crypto';
import {
  buildOpenClawSandboxContainerName,
  computeOpenClaw92SandboxConfigHash,
  formatOpenClawManagedWorkspaceBind,
  formatOpenClawReadOnlySkillMountHashState,
  isOpenClawWorkspaceQualifiedScopeKey,
  normalizeOpenClawHashInput,
  resolveOpenClawReadOnlySkillMounts,
  resolveOpenClawWorkspaceQualifiedRuntime,
  resolveOpenClawWorkspaceScopeKey,
  slugifyOpenClawWorkspaceScopeKey,
} from './openclawWorkspaceQualifiedIdentity';

// Values observed on TEST 2026-09-07 for the live OpenClaw 2026.9.2 runtime the
// model actually executed in (docker inspect labels/name), and reproduced by
// OpenClaw's own dist exports (audit openclaw92-identity-oracle.json).
const AGENT_ID = 'p4oc-68dc6f3e9fc266a910b898a6fabf1a74addface4';
const SESSION_KEY = `agent:${AGENT_ID}:portal-project`;
const AGENT_WORKSPACE_DIR = `/root/.openclaw/project-agents/bb2a596920bf3afc55cf/e3e741d31ba9a28470fd/${AGENT_ID}`;
const SANDBOX_ROOT = `/root/.openclaw/sandboxes/portal-project/bb2a596920bf3afc55cf/e3e741d31ba9a28470fd/${AGENT_ID}`;
const CONTAINER_PREFIX = 'p4oc-792ca6753bb5677d-';
const EXPECTED_SCOPE_KEY = `${SESSION_KEY}:workspace:d4baa0112fa3feb23f2093b1665f1090`;
const EXPECTED_SLUG = 'workspace-ef5c9c092f3a6893e6f2618968de1cc8';
const EXPECTED_NAME = 'p4oc-79-workspace-ef5c9c092f3a6893e6f2618968de1cc8-283ef0d4b775';

describe('OpenClaw 9.2 workspace-qualified sandbox identity', () => {
  test('derives the exact scope key, slug, container name and sandbox dir the 9.2 Gateway used', () => {
    const identity = resolveOpenClawWorkspaceQualifiedRuntime({
      sessionKey: SESSION_KEY,
      agentWorkspaceDir: AGENT_WORKSPACE_DIR,
      sandboxWorkspaceRoot: SANDBOX_ROOT,
      containerPrefix: CONTAINER_PREFIX,
    });
    expect(identity.scopeKey).toBe(EXPECTED_SCOPE_KEY);
    expect(identity.slug).toBe(EXPECTED_SLUG);
    expect(identity.containerName).toBe(EXPECTED_NAME);
    expect(identity.containerName).toHaveLength(63);
    expect(identity.sandboxWorkspaceDir).toBe(`${SANDBOX_ROOT}/${EXPECTED_SLUG}`);
    expect(isOpenClawWorkspaceQualifiedScopeKey(identity.scopeKey)).toBe(true);
    expect(isOpenClawWorkspaceQualifiedScopeKey(SESSION_KEY)).toBe(false);
  });

  test('a short prefix keeps the full name; a long one truncates only the prefix and appends the name hash', () => {
    const slug = slugifyOpenClawWorkspaceScopeKey(EXPECTED_SCOPE_KEY);
    expect(buildOpenClawSandboxContainerName('p4-', slug)).toBe(`p4-${slug}`);
    const long = buildOpenClawSandboxContainerName(CONTAINER_PREFIX, slug);
    const expectedSuffix = `-${slug}-${crypto.createHash('sha256').update(`${CONTAINER_PREFIX}${slug}`).digest('hex').slice(0, 12)}`;
    expect(long.endsWith(expectedSuffix)).toBe(true);
    expect(long.startsWith(CONTAINER_PREFIX.slice(0, 63 - expectedSuffix.length))).toBe(true);
  });

  test('rejects already-qualified keys, relative workspaces and non-qualified slugs', () => {
    expect(() => resolveOpenClawWorkspaceScopeKey(EXPECTED_SCOPE_KEY, AGENT_WORKSPACE_DIR)).toThrow('already workspace-qualified');
    expect(() => resolveOpenClawWorkspaceScopeKey(SESSION_KEY, 'relative/workspace')).toThrow('must be absolute');
    expect(() => slugifyOpenClawWorkspaceScopeKey(SESSION_KEY)).toThrow('not workspace-qualified');
    expect(() => buildOpenClawSandboxContainerName(CONTAINER_PREFIX, 'agent-p4oc-68dc6f3e9fc266a910b89-16c889f5')).toThrow('not workspace-qualified');
  });

  test('skill overlays include only existing skills/.agents/skills directories below the workdir', () => {
    const sandboxWorkspaceDir = `${SANDBOX_ROOT}/${EXPECTED_SLUG}`;
    const mounts = resolveOpenClawReadOnlySkillMounts({
      sandboxWorkspaceDir,
      workdir: '/workspace',
      isDirectory: (hostPath) => hostPath === `${sandboxWorkspaceDir}/skills`,
    });
    expect(mounts).toEqual([{ hostPath: `${sandboxWorkspaceDir}/skills`, containerPath: '/workspace/skills' }]);
    expect(formatOpenClawReadOnlySkillMountHashState(mounts)).toEqual([`${sandboxWorkspaceDir}/skills:/workspace/skills:ro`]);
    expect(formatOpenClawManagedWorkspaceBind(sandboxWorkspaceDir, '/workspace', false)).toBe(`${sandboxWorkspaceDir}:/workspace:z`);
    expect(formatOpenClawManagedWorkspaceBind(`${sandboxWorkspaceDir}/skills`, '/workspace/skills', true)).toBe(`${sandboxWorkspaceDir}/skills:/workspace/skills:ro,z`);
    expect(resolveOpenClawReadOnlySkillMounts({ sandboxWorkspaceDir, workdir: '/workspace/', isDirectory: () => true }))
      .toEqual([
        { hostPath: `${sandboxWorkspaceDir}/skills`, containerPath: '/workspace/skills' },
        { hostPath: `${sandboxWorkspaceDir}/.agents/skills`, containerPath: '/workspace/.agents/skills' },
      ]);
  });

  test('config hash normalizes like OpenClaw: sorted keys, undefined dropped, arrays preserved', () => {
    expect(normalizeOpenClawHashInput({ b: 1, a: [undefined, { z: undefined, y: 2 }], c: undefined }))
      .toEqual({ a: [{ y: 2 }], b: 1 });
    const docker = { image: 'sha256:abc', env: { LANG: 'C.UTF-8' }, binds: ['/p:/workspace/project:rw'], workdir: '/workspace' };
    const base = {
      docker,
      workspaceAccess: 'none' as const,
      workspaceDir: `${SANDBOX_ROOT}/${EXPECTED_SLUG}`,
      agentWorkspaceDir: AGENT_WORKSPACE_DIR,
      readOnlyWorkspaceSkillMounts: [`${SANDBOX_ROOT}/${EXPECTED_SLUG}/skills:/workspace/skills:ro`],
    };
    const hash = computeOpenClaw92SandboxConfigHash(base);
    expect(hash).toMatch(/^[a-f0-9]{64}$/);
    // Key order and an explicit undefined epoch do not change the hash.
    expect(computeOpenClaw92SandboxConfigHash({ ...base, dockerEnvPolicyEpoch: undefined, docker: { workdir: '/workspace', binds: docker.binds, env: docker.env, image: docker.image } })).toBe(hash);
    // Anything OpenClaw hashes does: the 9.2 workspace dir, skill mounts, docker policy, epoch.
    expect(computeOpenClaw92SandboxConfigHash({ ...base, workspaceDir: `${SANDBOX_ROOT}/agent-p4oc-68dc6f3e9fc266a910b89-16c889f5` })).not.toBe(hash);
    expect(computeOpenClaw92SandboxConfigHash({ ...base, readOnlyWorkspaceSkillMounts: [] })).not.toBe(hash);
    expect(computeOpenClaw92SandboxConfigHash({ ...base, docker: { ...docker, readOnlyRoot: true } })).not.toBe(hash);
    expect(computeOpenClaw92SandboxConfigHash({ ...base, dockerEnvPolicyEpoch: 'explicit-config-env-v1' })).not.toBe(hash);
    // Exact payload OpenClaw serializes.
    const expected = crypto.createHash('sha256').update(JSON.stringify({
      agentWorkspaceDir: AGENT_WORKSPACE_DIR,
      createArgsEpoch: '2026-08-25-container-env-file',
      docker: { binds: docker.binds, env: { LANG: 'C.UTF-8' }, image: 'sha256:abc', workdir: '/workspace' },
      mountFormatVersion: 4,
      readOnlyWorkspaceSkillMounts: base.readOnlyWorkspaceSkillMounts,
      workspaceAccess: 'none',
      workspaceDir: base.workspaceDir,
    })).digest('hex');
    expect(hash).toBe(expected);
  });
});
