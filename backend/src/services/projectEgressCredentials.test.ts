import { createProjectSandboxExecutionContext } from '../agents/executionScope';
import {
  ProjectEgressCredentialError,
  buildProjectEgressConfig,
  deriveProjectEgressProxyToken,
} from './projectEgressCredentials';

const context = createProjectSandboxExecutionContext({
  userId: 'actor-a',
  projectId: 'project-a',
  workspaceOwnerId: 'owner-a',
  projectName: 'demo',
  canonicalRoot: '/srv/projects/owner-a/demo',
  rootDevice: '1',
  rootInode: '2',
  rootBirthtimeNs: '3',
  runtimePolicyVersion: 'portal-project-sandbox-v2',
  egressPolicyVersion: 'portal-project-egress-v1',
  runtimeImageDigest: `sha256:${'1'.repeat(64)}`,
  policyFingerprint: '2'.repeat(64),
});

const secret = Buffer.alloc(32, 7).toString('base64url');
const proxyImageId = `sha256:${'3'.repeat(64)}`;

describe('Project egress credentials', () => {
  test('derives stable credentials that change across actors, projects, and providers', () => {
    const first = deriveProjectEgressProxyToken({ context, provider: 'OPENCLAW', secret });
    const again = deriveProjectEgressProxyToken({ context, provider: 'OPENCLAW', secret });
    const providerChanged = deriveProjectEgressProxyToken({ context, provider: 'CODEX', secret });
    const projectChanged = deriveProjectEgressProxyToken({
      context: { ...context, projectId: 'project-b' },
      provider: 'OPENCLAW',
      secret,
    });

    expect(first).toBe(again);
    expect(first).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(providerChanged).not.toBe(first);
    expect(projectChanged).not.toBe(first);
  });

  test('builds a pinned, actor-bound plane config', () => {
    expect(buildProjectEgressConfig({ context, provider: 'OPENCLAW', secret, proxyImageId }))
      .toEqual({
        identity: { actorId: 'actor-a', projectId: 'project-a', provider: 'OPENCLAW' },
        proxyImage: proxyImageId,
        token: deriveProjectEgressProxyToken({ context, provider: 'OPENCLAW', secret }),
      });
  });

  test.each([
    { secret: '', proxyImageId, code: 'TOKEN_SECRET_UNAVAILABLE' },
    { secret: 'short', proxyImageId, code: 'TOKEN_SECRET_UNAVAILABLE' },
    { secret, proxyImageId: 'bridgesllm-project-egress-proxy:v1', code: 'PROXY_IMAGE_UNAVAILABLE' },
  ])('fails closed for missing or mutable installer state', ({ secret: value, proxyImageId: image, code }) => {
    expect(() => buildProjectEgressConfig({
      context,
      provider: 'OPENCLAW',
      secret: value,
      proxyImageId: image,
    })).toThrow(ProjectEgressCredentialError);
    try {
      buildProjectEgressConfig({ context, provider: 'OPENCLAW', secret: value, proxyImageId: image });
    } catch (error) {
      expect((error as ProjectEgressCredentialError).code).toBe(code);
    }
  });

  test('rejects a host-operator context', () => {
    expect(() => buildProjectEgressConfig({
      context: { ...context, scope: 'HOST_OPERATOR' } as unknown as typeof context,
      provider: 'OPENCLAW',
      secret,
      proxyImageId,
    })).toThrow('server-owned Project Sandbox context');
  });
});
