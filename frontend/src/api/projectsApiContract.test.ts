import { beforeEach, describe, expect, it, vi } from 'vitest';

const clientMocks = vi.hoisted(() => ({
  get: vi.fn(),
  post: vi.fn(),
  put: vi.fn(),
  patch: vi.fn(),
  delete: vi.fn(),
}));

vi.mock('./client', () => ({ default: clientMocks }));

import { appsAPI, projectsAPI } from './endpoints';

describe('Projects API route contract', () => {
  beforeEach(() => {
    Object.values(clientMocks).forEach((mock) => mock.mockReset());
    clientMocks.get.mockResolvedValue({ data: {} });
    clientMocks.post.mockResolvedValue({ data: {} });
    clientMocks.put.mockResolvedValue({ data: {} });
    clientMocks.patch.mockResolvedValue({ data: {} });
    clientMocks.delete.mockResolvedValue({ data: {} });
  });

  it('encodes project and share identifiers as individual path segments', async () => {
    await projectsAPI.readFile('Project name?#', 'src/main.ts');
    expect(clientMocks.get).toHaveBeenLastCalledWith(
      '/projects/Project%20name%3F%23/file',
      { params: { path: 'src/main.ts' } },
    );

    await projectsAPI.updateShare('Project name?#', 'link/id?#', { isActive: false });
    expect(clientMocks.patch).toHaveBeenLastCalledWith(
      '/projects/Project%20name%3F%23/share/link%2Fid%3F%23',
      { isActive: false },
    );
  });

  it('binds Project deletion to the exact immutable identity when supplied', async () => {
    const identity = { id: '11111111-1111-4111-8111-111111111111', generation: 4 };

    await projectsAPI.delete('Project name?#', identity);
    expect(clientMocks.delete).toHaveBeenLastCalledWith(
      '/projects/Project%20name%3F%23',
      {
        data: {
          projectIdentityId: identity.id,
          projectGeneration: identity.generation,
        },
      },
    );

    await projectsAPI.delete('legacy client');
    expect(clientMocks.delete).toHaveBeenLastCalledWith(
      '/projects/legacy%20client',
      undefined,
    );
  });

  it('passes visitor-slot and shared API throttle policy through project and app share creation', async () => {
    const policy = {
      maxUses: 10,
      rateLimitMaxRequests: 25,
      rateLimitWindowSeconds: 300 as const,
    };

    await projectsAPI.share('alpha', { isPublic: true, ...policy });
    expect(clientMocks.post).toHaveBeenLastCalledWith(
      '/projects/alpha/share',
      { isPublic: true, ...policy },
    );

    await appsAPI.createShareLink('app-1', policy);
    expect(clientMocks.post).toHaveBeenLastCalledWith('/apps/app-1/share', policy);
  });

  it('sends the opaque server recovery proof only on the exact Deploy or process replay request', async () => {
    const deployReplay = {
      proof: 'v1.11111111-1111-4111-8111-111111111111.AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
      action: 'deploy' as const,
      projectIdentity: { id: 'project-alpha', generation: 3 },
      expectedAppId: null,
      expectedDeployType: 'fullstack' as const,
      sourceDigest: 'a'.repeat(64),
    };
    const startReplay = {
      proof: 'v1.22222222-2222-4222-8222-222222222222.BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB',
      action: 'start' as const,
      projectIdentity: { id: 'project-alpha', generation: 3 },
      expectedAppId: 'app-alpha',
    };
    clientMocks.post.mockResolvedValueOnce({
      data: {
        message: 'Deployed',
        appId: 'app-created',
        name: 'alpha beta',
        url: '/hosted/app-created/',
        deployType: 'fullstack',
        port: 5001,
      },
    });
    await projectsAPI.deploy('alpha beta', deployReplay);
    expect(clientMocks.post).toHaveBeenLastCalledWith(
      '/projects/alpha%20beta/deploy',
      { recoveryReplay: deployReplay },
      { _skipNetworkRetry: true },
    );

    clientMocks.post.mockResolvedValueOnce({
      data: {
        status: 'running',
        deployType: 'fullstack',
        runtimeManagement: 'portal-container',
        statusSource: 'portal-manager',
        supportedActions: ['start', 'stop', 'restart', 'status', 'logs'],
        port: 5001,
        logs: [],
        restartCount: 0,
        persistedStatus: 'running',
        recoveryRequired: false,
      },
    });
    await projectsAPI.appProcess('alpha beta', 'start', startReplay);
    expect(clientMocks.post).toHaveBeenLastCalledWith(
      '/projects/alpha%20beta/app-process',
      { action: 'start', recoveryReplay: startReplay },
      { _skipNetworkRetry: true },
    );

    clientMocks.post.mockResolvedValueOnce({
      data: {
        message: 'Deployed',
        appId: 'app-created',
        name: 'alpha beta',
        url: '/hosted/app-created/',
        deployType: 'fullstack',
        port: 5001,
      },
    });
    await projectsAPI.deploy('alpha beta');
    expect(clientMocks.post).toHaveBeenLastCalledWith(
      '/projects/alpha%20beta/deploy',
      undefined,
      { _skipNetworkRetry: true },
    );
  });

  it('accepts only an exact identity-bound Deploy replay completion', async () => {
    const existingReplay = {
      proof: 'v1.11111111-1111-4111-8111-111111111111.AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
      action: 'deploy' as const,
      projectIdentity: { id: 'project-alpha', generation: 3 },
      expectedAppId: 'app-alpha',
      expectedDeployType: 'fullstack' as const,
      sourceDigest: 'a'.repeat(64),
    };
    const completion = {
      success: true,
      action: 'deploy',
      projectIdentityId: 'project-alpha',
      projectIdentityGeneration: 3,
      appId: 'app-alpha',
      deploymentRevision: '8',
    };
    clientMocks.post.mockResolvedValueOnce({ data: completion });
    await expect(projectsAPI.deploy('alpha', existingReplay)).resolves.toEqual(completion);

    for (const malformed of [
      { ...completion, appId: 'stale-app' },
      { ...completion, projectIdentityGeneration: 2 },
      { ...completion, deploymentRevision: 'not-a-revision' },
      { ...completion, extra: true },
      { ok: true },
    ]) {
      clientMocks.post.mockResolvedValueOnce({ data: malformed });
      await expect(projectsAPI.deploy('alpha', existingReplay)).rejects.toThrow(
        /Project deployment response is malformed/i,
      );
    }

    const firstDeployReplay = { ...existingReplay, expectedAppId: null };
    const firstCompletion = { ...completion, appId: 'new-app' };
    clientMocks.post.mockResolvedValueOnce({ data: firstCompletion });
    await expect(projectsAPI.deploy('alpha', firstDeployReplay)).resolves.toEqual(firstCompletion);
  });

  it('validates Remote Desktop deploy success as a distinct response shape', async () => {
    const runtimeSuccess = {
      message: 'Running on Remote Desktop',
      appId: 'runtime-app',
      name: 'desktop-tool',
      deployType: 'runtime',
      buildOutput: 'Running on Remote Desktop',
    };
    clientMocks.post.mockResolvedValueOnce({ data: runtimeSuccess });
    await expect(projectsAPI.deploy('desktop-tool')).resolves.toEqual(runtimeSuccess);

    for (const malformed of [
      { ...runtimeSuccess, message: 'Deployed' },
      { ...runtimeSuccess, url: '/hosted/runtime-app/' },
      { ...runtimeSuccess, port: 5001 },
    ]) {
      clientMocks.post.mockResolvedValueOnce({ data: malformed });
      await expect(projectsAPI.deploy('desktop-tool')).rejects.toThrow(
        /Project deployment response is malformed/i,
      );
    }
  });

  it('turns a durable process completion receipt into a fresh authoritative status read', async () => {
    const replay = {
      proof: 'v1.22222222-2222-4222-8222-222222222222.BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB',
      action: 'start' as const,
      projectIdentity: { id: 'project-alpha', generation: 3 },
      expectedAppId: 'app-alpha',
    };
    const processState = {
      status: 'running',
      deployType: 'fullstack',
      runtimeManagement: 'portal-container',
      statusSource: 'portal-manager',
      supportedActions: ['start', 'stop', 'restart', 'status', 'logs'],
      port: 5001,
      logs: [],
      restartCount: 1,
      persistedStatus: 'running',
      recoveryRequired: false,
    };
    clientMocks.post
      .mockResolvedValueOnce({
        data: {
          success: true,
          action: 'start',
          projectIdentityId: 'project-alpha',
          projectIdentityGeneration: 3,
          appId: 'app-alpha',
          deploymentRevision: '8',
        },
      })
      .mockResolvedValueOnce({ data: processState });

    await expect(projectsAPI.appProcess('alpha', 'start', replay)).resolves.toEqual(processState);
    expect(clientMocks.post).toHaveBeenNthCalledWith(
      1,
      '/projects/alpha/app-process',
      { action: 'start', recoveryReplay: replay },
      { _skipNetworkRetry: true },
    );
    expect(clientMocks.post).toHaveBeenNthCalledWith(
      2,
      '/projects/alpha/app-process',
      { action: 'status' },
    );
  });

  it('keeps upload destinations in query parameters instead of path text', async () => {
    const file = new File(['hello'], 'hello.txt', { type: 'text/plain' });
    await projectsAPI.uploadFiles('alpha beta', [file], 'nested folder');
    expect(clientMocks.post.mock.calls[0][0]).toBe('/projects/alpha%20beta/upload?path=nested%20folder');
    expect(clientMocks.post.mock.calls[0][1]).toBeInstanceOf(FormData);
  });

  it('requires immutable identity proof on project inventory and validates the full tree schema', async () => {
    const identity = { id: '1fcd90ba-8d89-4dc9-b996-62f794779c76', generation: 4 };
    clientMocks.get
      .mockResolvedValueOnce({
        data: {
          projects: [{
            name: 'alpha',
            detectedDeployType: 'fullstack',
            hasGit: true,
            currentBranch: 'main',
            deployedUrl: '',
            createdAt: '2026-07-22T00:00:00.000Z',
            updatedAt: '2026-07-22T00:00:00.000Z',
            identity,
            deployment: {
              appId: 'app-alpha',
              deployType: 'fullstack',
              processStatus: 'running',
              runtimeManagement: 'portal-container',
              statusSource: 'persisted-app',
              supportedLifecycleActions: [
                'redeploy',
                'undeploy',
                'rename-project',
                'delete-project',
              ],
              port: 5001,
              isActive: true,
            },
            destructiveActions: { allowed: true, reason: null },
          }],
        },
      })
      .mockResolvedValueOnce({
        data: {
          tree: [{ name: 'src', type: 'directory', path: 'src' }],
          currentPath: '',
          identity,
        },
      });

    await expect(projectsAPI.list()).resolves.toEqual({
      projects: [expect.objectContaining({
        name: 'alpha',
        detectedDeployType: 'fullstack',
        identity,
        deployment: expect.objectContaining({
          runtimeManagement: 'portal-container',
          statusSource: 'persisted-app',
          supportedLifecycleActions: [
            'redeploy',
            'undeploy',
            'rename-project',
            'delete-project',
          ],
        }),
        destructiveActions: { allowed: true, reason: null },
      })],
    });
    await expect(projectsAPI.getTree('alpha')).resolves.toEqual({
      tree: [{ name: 'src', type: 'directory', path: 'src' }],
      currentPath: '',
      identity,
    });
  });

  it('validates server-owned deployment management and process capabilities', async () => {
    const processState = {
      status: 'running',
      deployType: 'fullstack',
      runtimeManagement: 'external-loopback',
      statusSource: 'external-binding',
      supportedActions: [],
      logs: [],
      restartCount: 0,
      persistedStatus: 'running',
      recoveryRequired: false,
      limitation: 'Portal routes this app but does not manage its service process.',
    };
    clientMocks.post.mockResolvedValueOnce({ data: processState });

    await expect(projectsAPI.appProcess('alpha beta', 'status')).resolves.toEqual(processState);
    expect(clientMocks.post).toHaveBeenLastCalledWith(
      '/projects/alpha%20beta/app-process',
      { action: 'status' },
    );
  });

  it('accepts only the three authoritative Portal process capability states', async () => {
    const liveManager = {
      status: 'running',
      deployType: 'fullstack',
      runtimeManagement: 'portal-container',
      statusSource: 'portal-manager',
      supportedActions: ['start', 'stop', 'restart', 'status', 'logs'],
      port: 5001,
      logs: ['ready'],
      restartCount: 2,
      persistedStatus: 'running',
      recoveryRequired: false,
    };
    const recovery = {
      status: 'unknown',
      deployType: 'fullstack',
      runtimeManagement: 'portal-container',
      statusSource: 'persisted-app',
      supportedActions: ['start', 'stop', 'status'],
      logs: [],
      restartCount: 0,
      persistedStatus: 'running',
      recoveryRequired: true,
    };
    const settled = {
      status: 'stopped',
      deployType: 'fullstack',
      runtimeManagement: 'portal-container',
      statusSource: 'persisted-app',
      supportedActions: ['start', 'status'],
      logs: [],
      restartCount: 0,
      persistedStatus: 'stopped',
      recoveryRequired: false,
    };
    clientMocks.post
      .mockResolvedValueOnce({ data: liveManager })
      .mockResolvedValueOnce({ data: recovery })
      .mockResolvedValueOnce({ data: settled });

    await expect(projectsAPI.appProcess('alpha', 'status')).resolves.toEqual(liveManager);
    await expect(projectsAPI.appProcess('alpha', 'status')).resolves.toEqual(recovery);
    await expect(projectsAPI.appProcess('alpha', 'status')).resolves.toEqual(settled);
  });

  it('accepts only the exact server lifecycle contract for a static external binding', async () => {
    clientMocks.get.mockResolvedValueOnce({
      data: {
        projects: [{
          name: 'static-external',
          detectedDeployType: 'static',
          hasGit: false,
          currentBranch: '',
          deployedUrl: '/hosted/static-external/',
          createdAt: '2026-08-08T00:00:00.000Z',
          updatedAt: '2026-08-08T00:00:00.000Z',
          identity: { id: 'project-static-external', generation: 1 },
          deployment: {
            appId: 'app-static-external',
            deployType: 'static',
            processStatus: 'stopped',
            runtimeManagement: 'external-loopback',
            statusSource: 'external-binding',
            supportedLifecycleActions: ['redeploy'],
            port: null,
            isActive: true,
          },
          destructiveActions: {
            allowed: false,
            reason: 'This Project uses an externally managed service.',
          },
        }],
      },
    });

    await expect(projectsAPI.list()).resolves.toEqual({
      projects: [expect.objectContaining({
        name: 'static-external',
        deployment: expect.objectContaining({
          supportedLifecycleActions: ['redeploy'],
        }),
      })],
    });
  });

  it('removes external redeploy authority when stored static source becomes full-stack', async () => {
    clientMocks.get.mockResolvedValueOnce({
      data: {
        projects: [{
          name: 'static-external-now-fullstack',
          detectedDeployType: 'fullstack',
          hasGit: false,
          currentBranch: '',
          deployedUrl: '/hosted/static-external-now-fullstack/',
          createdAt: '2026-08-08T00:00:00.000Z',
          updatedAt: '2026-08-08T00:00:00.000Z',
          identity: { id: 'project-static-external-now-fullstack', generation: 1 },
          deployment: {
            appId: 'app-static-external-now-fullstack',
            deployType: 'static',
            processStatus: 'stopped',
            runtimeManagement: 'external-loopback',
            statusSource: 'external-binding',
            supportedLifecycleActions: [],
            port: null,
            isActive: true,
          },
          destructiveActions: {
            allowed: false,
            reason: 'This Project uses an externally managed service.',
          },
        }],
      },
    });

    await expect(projectsAPI.list()).resolves.toEqual({
      projects: [expect.objectContaining({
        detectedDeployType: 'fullstack',
        deployment: expect.objectContaining({
          deployType: 'static',
          supportedLifecycleActions: [],
        }),
      })],
    });
  });

  it('accepts an invalid external binding only as a blocked configuration', async () => {
    clientMocks.get.mockResolvedValueOnce({
      data: {
        projects: [{
          name: 'invalid-external',
          detectedDeployType: 'static',
          hasGit: false,
          currentBranch: '',
          deployedUrl: '/hosted/invalid-external/',
          createdAt: '2026-08-08T00:00:00.000Z',
          updatedAt: '2026-08-08T00:00:00.000Z',
          identity: { id: 'project-invalid-external', generation: 1 },
          deployment: {
            appId: 'app-invalid-external',
            deployType: 'static',
            processStatus: 'stopped',
            runtimeManagement: 'external-loopback',
            statusSource: 'external-binding',
            supportedLifecycleActions: [],
            bindingStatus: 'invalid',
            configurationCode: 'PROJECT_RUNTIME_BINDING_INVALID',
            limitation: 'The server-managed target must be repaired.',
            port: null,
            isActive: true,
          },
          destructiveActions: {
            allowed: false,
            reason: 'The server-managed target must be repaired.',
          },
        }],
      },
    });

    await expect(projectsAPI.list()).resolves.toEqual({
      projects: [expect.objectContaining({
        deployment: expect.objectContaining({
          bindingStatus: 'invalid',
          configurationCode: 'PROJECT_RUNTIME_BINDING_INVALID',
          supportedLifecycleActions: [],
        }),
      })],
    });
  });

  it.each([
    ['management/status mismatch', {
      deployType: 'static', runtimeManagement: 'static', statusSource: 'persisted-app',
      supportedLifecycleActions: ['redeploy', 'undeploy', 'rename-project', 'delete-project'],
    }, { allowed: true, reason: null }],
    ['management/deploy-type mismatch', {
      deployType: 'static', runtimeManagement: 'portal-container', statusSource: 'persisted-app',
      supportedLifecycleActions: ['redeploy', 'undeploy', 'rename-project', 'delete-project'],
    }, { allowed: true, reason: null }],
    ['external fullstack mutation capability', {
      deployType: 'fullstack', runtimeManagement: 'external-loopback', statusSource: 'external-binding',
      supportedLifecycleActions: ['redeploy'],
    }, { allowed: false, reason: 'Externally managed.' }],
    ['external binding marked destructive', {
      deployType: 'fullstack', runtimeManagement: 'external-loopback', statusSource: 'external-binding',
      supportedLifecycleActions: [],
    }, { allowed: true, reason: null }],
    ['missing required managed lifecycle action', {
      deployType: 'fullstack', runtimeManagement: 'portal-container', statusSource: 'persisted-app',
      supportedLifecycleActions: ['redeploy', 'rename-project', 'delete-project'],
    }, { allowed: true, reason: null }],
    ['duplicate lifecycle action', {
      deployType: 'fullstack', runtimeManagement: 'portal-container', statusSource: 'persisted-app',
      supportedLifecycleActions: ['redeploy', 'undeploy', 'rename-project', 'delete-project', 'redeploy'],
    }, { allowed: true, reason: null }],
  ])('rejects an incoherent Project deployment inventory row: %s', async (
    _label,
    deployment,
    destructiveActions,
  ) => {
    clientMocks.get.mockResolvedValueOnce({
      data: {
        projects: [{
          name: 'alpha',
          detectedDeployType: 'fullstack',
          hasGit: false,
          currentBranch: '',
          deployedUrl: '/hosted/alpha/',
          createdAt: '2026-08-08T00:00:00.000Z',
          updatedAt: '2026-08-08T00:00:00.000Z',
          identity: { id: 'project-alpha', generation: 1 },
          deployment: {
            appId: 'app-alpha',
            processStatus: 'running',
            port: null,
            isActive: true,
            ...deployment,
          },
          destructiveActions,
        }],
      },
    });

    await expect(projectsAPI.list()).rejects.toThrow(/inventory entry is malformed/i);
  });

  it.each([
    ['missing management mode', {
      status: 'running', deployType: 'fullstack', statusSource: 'portal-manager',
      supportedActions: ['status'], logs: [], restartCount: 0,
    }],
    ['unknown status source', {
      status: 'running', deployType: 'fullstack', runtimeManagement: 'portal-container',
      statusSource: 'guess', supportedActions: ['status'], logs: [], restartCount: 0,
    }],
    ['duplicate action', {
      status: 'running', deployType: 'fullstack', runtimeManagement: 'portal-container',
      statusSource: 'portal-manager', supportedActions: ['status', 'status'], logs: [], restartCount: 0,
    }],
    ['unknown action', {
      status: 'running', deployType: 'fullstack', runtimeManagement: 'portal-container',
      statusSource: 'portal-manager', supportedActions: ['kill'], logs: [], restartCount: 0,
    }],
    ['management/deploy-type mismatch', {
      status: 'deployed', deployType: 'static', runtimeManagement: 'portal-container',
      statusSource: 'portal-manager', supportedActions: ['status'], logs: [], restartCount: 0,
    }],
    ['external/status-source mismatch', {
      status: 'running', deployType: 'fullstack', runtimeManagement: 'external-loopback',
      statusSource: 'persisted-app', supportedActions: [], logs: [], restartCount: 0,
    }],
    ['external action capability', {
      status: 'running', deployType: 'fullstack', runtimeManagement: 'external-loopback',
      statusSource: 'external-binding', supportedActions: ['status'], logs: [], restartCount: 0,
    }],
    ['static/status-source mismatch', {
      status: 'deployed', deployType: 'static', runtimeManagement: 'static',
      statusSource: 'portal-manager', supportedActions: [], logs: [], restartCount: 0,
    }],
    ['portal/external-source mismatch', {
      status: 'running', deployType: 'fullstack', runtimeManagement: 'portal-container',
      statusSource: 'external-binding', supportedActions: ['status'], logs: [], restartCount: 0,
    }],
    ['recovery with live manager source', {
      status: 'unknown', deployType: 'fullstack', runtimeManagement: 'portal-container',
      statusSource: 'portal-manager', supportedActions: ['start', 'stop', 'status'],
      recoveryRequired: true, logs: [], restartCount: 0,
    }],
    ['external target port disclosure', {
      status: 'running', deployType: 'fullstack', runtimeManagement: 'external-loopback',
      statusSource: 'external-binding', supportedActions: [], port: 5010, logs: [], restartCount: 0,
    }],
    ['live manager missing an action', {
      status: 'running', deployType: 'fullstack', runtimeManagement: 'portal-container',
      statusSource: 'portal-manager', supportedActions: ['start', 'stop', 'status'],
      port: 5001, logs: [], restartCount: 0, recoveryRequired: false,
    }],
    ['live manager missing its verified port', {
      status: 'running', deployType: 'fullstack', runtimeManagement: 'portal-container',
      statusSource: 'portal-manager',
      supportedActions: ['start', 'stop', 'restart', 'status', 'logs'],
      logs: [], restartCount: 0, recoveryRequired: false,
    }],
    ['recovery fallback carrying runtime logs', {
      status: 'unknown', deployType: 'fullstack', runtimeManagement: 'portal-container',
      statusSource: 'persisted-app', supportedActions: ['start', 'stop', 'status'],
      logs: ['stale runtime output'], restartCount: 0, recoveryRequired: true,
    }],
    ['recovery fallback carrying a live port', {
      status: 'unknown', deployType: 'fullstack', runtimeManagement: 'portal-container',
      statusSource: 'persisted-app', supportedActions: ['start', 'stop', 'status'],
      port: 5001, logs: [], restartCount: 0, recoveryRequired: true,
    }],
    ['settled fallback retaining stop capability', {
      status: 'stopped', deployType: 'fullstack', runtimeManagement: 'portal-container',
      statusSource: 'persisted-app', supportedActions: ['start', 'stop', 'status'],
      logs: [], restartCount: 0, recoveryRequired: false,
    }],
    ['persisted fallback retaining restart evidence', {
      status: 'stopped', deployType: 'fullstack', runtimeManagement: 'portal-container',
      statusSource: 'persisted-app', supportedActions: ['start', 'status'],
      logs: [], restartCount: 1, recoveryRequired: false,
    }],
    ['external fallback claiming recovery', {
      status: 'unavailable', deployType: 'fullstack', runtimeManagement: 'external-loopback',
      statusSource: 'external-binding', supportedActions: [],
      logs: [], restartCount: 0, recoveryRequired: true,
    }],
    ['external fallback carrying logs', {
      status: 'running', deployType: 'fullstack', runtimeManagement: 'external-loopback',
      statusSource: 'external-binding', supportedActions: [],
      logs: ['target leaked'], restartCount: 0, recoveryRequired: false,
    }],
  ])('rejects malformed deployment process state: %s', async (_label, data) => {
    clientMocks.post.mockResolvedValueOnce({ data });
    await expect(projectsAPI.appProcess('alpha', 'status')).rejects.toThrow(
      /deployment process response is malformed/i,
    );
  });

  it('preserves a server-disabled Project inventory entry and its stable recovery contract', async () => {
    clientMocks.get.mockResolvedValueOnce({
      data: {
        projects: [{
          name: 'restored-project',
          hasGit: true,
          currentBranch: '',
          deployedUrl: '',
          createdAt: '2026-08-06T00:00:00.000Z',
          updatedAt: '2026-08-06T00:00:00.000Z',
          identity: { id: 'project-identity-1', generation: 3 },
          availability: {
            available: false,
            code: 'PROJECT_IDENTITY_RECONCILIATION_REQUIRED',
            message: 'This project directory changed outside Portal.',
            action: 'RECONCILE_PROJECT_IDENTITY',
            retryable: false,
          },
          destructiveActions: {
            allowed: false,
            reason: 'This project directory changed outside Portal.',
          },
        }],
      },
    });

    await expect(projectsAPI.list()).resolves.toEqual({
      projects: [expect.objectContaining({
        name: 'restored-project',
        availability: expect.objectContaining({
          available: false,
          code: 'PROJECT_IDENTITY_RECONCILIATION_REQUIRED',
        }),
      })],
    });
  });

  it('rejects a usable Project row without the server source classification', async () => {
    clientMocks.get.mockResolvedValueOnce({
      data: {
        projects: [{
          name: 'alpha',
          hasGit: false,
          currentBranch: '',
          deployedUrl: '',
          createdAt: '2026-08-08T00:00:00.000Z',
          updatedAt: '2026-08-08T00:00:00.000Z',
          identity: { id: 'project-alpha', generation: 1 },
          deployment: null,
          destructiveActions: { allowed: true, reason: null },
        }],
      },
    });

    await expect(projectsAPI.list()).rejects.toThrow(/inventory entry is malformed/i);
  });

  it.each([
    [{ tree: [], currentPath: '' }, 'missing identity'],
    [{ tree: [{ name: 'src', type: 'folder', path: 'src' }], currentPath: '', identity: { id: 'id', generation: 1 } }, 'invalid entry type'],
    [{ tree: 'not-an-array', currentPath: '', identity: { id: 'id', generation: 1 } }, 'invalid tree container'],
  ])('rejects a malformed project tree readback: %s (%s)', async (data, _label) => {
    clientMocks.get.mockResolvedValueOnce({ data });
    await expect(projectsAPI.getTree('alpha')).rejects.toThrow(/Project (tree|identity proof).*malformed/i);
  });

  it('binds rename admission and response verification to one attempt and immutable identity', async () => {
    const identity = { id: '1fcd90ba-8d89-4dc9-b996-62f794779c76', generation: 4 };
    const renamedIdentity = { ...identity, generation: identity.generation + 1 };
    clientMocks.patch.mockResolvedValueOnce({
      data: {
        name: 'beta',
        attemptId: 'rename_attempt_123456',
        status: 'committed',
        identity: renamedIdentity,
      },
    });

    await expect(projectsAPI.rename('alpha', 'beta', {
      attemptId: 'rename_attempt_123456',
      identity,
    })).resolves.toMatchObject({ name: 'beta', status: 'committed', identity: renamedIdentity });
    expect(clientMocks.patch).toHaveBeenCalledWith('/projects/alpha/rename', {
      newName: 'beta',
      attemptId: 'rename_attempt_123456',
      projectIdentityId: identity.id,
      projectGeneration: identity.generation,
    });

    clientMocks.patch.mockResolvedValueOnce({
      data: {
        name: 'beta',
        attemptId: 'different_attempt_123456',
        status: 'committed',
        identity: renamedIdentity,
      },
    });
    await expect(projectsAPI.rename('alpha', 'beta', {
      attemptId: 'rename_attempt_123456',
      identity,
    })).rejects.toThrow(/does not match the admitted attempt/i);
  });

  it('keeps Project Chat history paging in bounded query parameters', async () => {
    clientMocks.get.mockResolvedValueOnce({
      data: {
        messages: [],
        pagination: { hasMore: false, nextCursor: null, limit: 80 },
        session: {
          status: 'READY',
          model: 'openai/gpt-5.6',
          activeProvider: 'CODEX',
          runtime: 'codex-project-adapter',
          lastActivity: '2026-08-06T14:00:00.000Z',
        },
        activeBinding: {
          provider: 'CODEX',
          runtime: 'codex-project-adapter',
          sessionKey: 'session-1',
          externalSessionId: null,
          model: 'openai/gpt-5.6',
        },
        executionContext: {
          scope: 'PROJECT_SANDBOX',
          projectId: 'project-alpha',
          policyFingerprint: 'policy-v1',
        },
      },
    });

    await expect(projectsAPI.chatHistory('alpha beta', 'CODEX', {
      limit: 80,
      before: 'message-cursor',
    })).resolves.toMatchObject({
      executionContext: { projectId: 'project-alpha' },
    });

    expect(clientMocks.get).toHaveBeenLastCalledWith(
      '/projects/alpha%20beta/chat/history',
      {
        params: {
          provider: 'CODEX',
          limit: 80,
          before: 'message-cursor',
        },
        _silent: true,
      },
    );
  });

  it.each([
    ['missing immutable context', {
      messages: [],
      pagination: { hasMore: false, nextCursor: null, limit: 100 },
      session: {
        status: 'READY', model: null, activeProvider: 'OPENCLAW', runtime: null, lastActivity: null,
      },
      activeBinding: null,
    }],
    ['unbound next cursor', {
      messages: [],
      pagination: { hasMore: true, nextCursor: null, limit: 100 },
      session: {
        status: 'READY', model: null, activeProvider: 'OPENCLAW', runtime: null, lastActivity: null,
      },
      activeBinding: null,
      executionContext: {
        scope: 'PROJECT_SANDBOX', projectId: 'project-alpha', policyFingerprint: 'policy-v1',
      },
    }],
    ['non-project execution scope', {
      messages: [],
      pagination: { hasMore: false, nextCursor: null, limit: 100 },
      session: {
        status: 'READY', model: null, activeProvider: 'OPENCLAW', runtime: null, lastActivity: null,
      },
      activeBinding: null,
      executionContext: {
        scope: 'HOST_OPERATOR', projectId: 'project-alpha', policyFingerprint: 'policy-v1',
      },
    }],
  ])('rejects malformed Project Chat history: %s', async (_label, data) => {
    clientMocks.get.mockResolvedValueOnce({ data });
    await expect(projectsAPI.chatHistory('alpha', 'OPENCLAW')).rejects.toThrow(
      /Project Chat history.*malformed/i,
    );
  });

  it('marks panel-owned Project Chat recovery requests silent for the global error interceptor', async () => {
    await projectsAPI.projectChatProviders('alpha beta');
    expect(clientMocks.get).toHaveBeenLastCalledWith(
      '/projects/alpha%20beta/chat/providers',
      { _silent: true },
    );

    await projectsAPI.selectProjectChatProvider('alpha beta', 'CODEX', 4, 'openai/gpt-5.6');
    expect(clientMocks.post).toHaveBeenLastCalledWith(
      '/projects/alpha%20beta/chat/provider',
      {
        provider: 'CODEX',
        stateVersion: 4,
        model: 'openai/gpt-5.6',
      },
      { _silent: true },
    );

    await projectsAPI.agentAbort('alpha beta', 'CODEX', 4);
    expect(clientMocks.post).toHaveBeenLastCalledWith(
      '/projects/alpha%20beta/assistant/abort',
      { provider: 'CODEX', stateVersion: 4 },
      { _silent: true },
    );
  });

  it('binds destructive Project Chat history clearing to the current state version', async () => {
    await projectsAPI.chatClearHistory('alpha beta', 'CODEX', 17);
    expect(clientMocks.delete).toHaveBeenLastCalledWith(
      '/projects/alpha%20beta/chat/history',
      { params: { provider: 'CODEX', stateVersion: 17 } },
    );
    await expect(projectsAPI.chatClearHistory('alpha beta', 'CODEX', -1)).rejects.toThrow(
      'current Project Chat state version',
    );
  });

  it.each([
    ['OPENCLAW', 'openclaw'],
    ['CODEX', 'codex'],
    ['CLAUDE_CODE', 'claude-code'],
    ['AGENT_ZERO', 'agent-zero'],
    ['GEMINI', 'antigravity'],
    ['OLLAMA', 'ollama'],
  ] as const)('maps %s qualification to its explicit provider route', async (provider, slug) => {
    await projectsAPI.qualifyProjectChatProvider('alpha beta', provider);

    expect(clientMocks.post).toHaveBeenLastCalledWith(
      `/projects/alpha%20beta/chat/providers/${slug}/qualify`,
      {},
      expect.objectContaining({ _skipNetworkRetry: true, _silent: true }),
    );
  });

  it('keeps the legacy OpenClaw qualification wrapper silent and non-retrying', async () => {
    await projectsAPI.qualifyOpenClawProject('alpha beta');

    expect(clientMocks.post).toHaveBeenLastCalledWith(
      '/projects/alpha%20beta/chat/providers/openclaw/qualify',
      {},
      expect.objectContaining({ _skipNetworkRetry: true, _silent: true }),
    );
  });

  it('keeps inline-handled Project Chat model discovery out of the global error panel', async () => {
    await projectsAPI.projectChatModels('alpha beta');

    expect(clientMocks.get).toHaveBeenLastCalledWith(
      '/projects/alpha%20beta/chat/models',
      expect.objectContaining({
        params: { provider: 'OPENCLAW' },
        _silent: true,
      }),
    );
  });

  it('starts legacy project adoption in place without uploading or minting a new project', async () => {
    await projectsAPI.migrateLegacyProjectInPlace('alpha beta');
    expect(clientMocks.post).toHaveBeenLastCalledWith(
      '/projects/alpha%20beta/chat/migrate-legacy',
      {},
    );
  });

  it('binds an explicit Ollama qualification request to the selected local model', async () => {
    await projectsAPI.qualifyProjectChatProvider('alpha beta', 'OLLAMA', 'qwen3.5:0.8b');

    expect(clientMocks.post).toHaveBeenLastCalledWith(
      '/projects/alpha%20beta/chat/providers/ollama/qualify',
      { model: 'qwen3.5:0.8b' },
      expect.objectContaining({ _skipNetworkRetry: true, _silent: true }),
    );
  });

  it('binds Agent Zero qualification to one exact connected OAuth provider/model pair', async () => {
    await projectsAPI.qualifyProjectChatProvider(
      'alpha beta',
      'AGENT_ZERO',
      'codex_oauth/gpt-5.5',
    );

    expect(clientMocks.post).toHaveBeenLastCalledWith(
      '/projects/alpha%20beta/chat/providers/agent-zero/qualify',
      { model: 'codex_oauth/gpt-5.5' },
      expect.objectContaining({ _skipNetworkRetry: true, _silent: true }),
    );
  });

  it('loads Agent Zero model choices through the actor-scoped Project route', async () => {
    await projectsAPI.agentZeroProjectModels('alpha beta');

    // _silent: the provider menu renders on-demand catalog failures inline,
    // so the global error badge must not duplicate them.
    expect(clientMocks.get).toHaveBeenLastCalledWith(
      '/projects/alpha%20beta/chat/providers/agent-zero/models',
      expect.objectContaining({ _silent: true, _skipNetworkRetry: true }),
    );
  });

  it('encodes renamed project names across the complete assistant lifecycle', async () => {
    const projectName = 'alpha #1';

    await projectsAPI.agentPoll(projectName, 6, 20, 'OPENCLAW', 'turn-1');
    expect(clientMocks.get).toHaveBeenLastCalledWith(
      '/projects/alpha%20%231/assistant/poll',
      expect.objectContaining({
        params: {
          after: 6,
          lastSize: 20,
          provider: 'OPENCLAW',
          turnId: 'turn-1',
        },
      }),
    );

    await projectsAPI.agentSend(projectName, {
      provider: 'OPENCLAW',
      stateVersion: 8,
      message: 'hello',
      messageId: 'project-chat-stable-message-id',
      model: 'openai/gpt-5.5',
    });
    expect(clientMocks.post).toHaveBeenLastCalledWith(
      '/projects/alpha%20%231/assistant/send',
      {
        provider: 'OPENCLAW',
        stateVersion: 8,
        message: 'hello',
        model: 'openai/gpt-5.5',
        messageId: 'project-chat-stable-message-id',
      },
    );

    await projectsAPI.agentMessageStatus(projectName, {
      provider: 'OPENCLAW',
      messageId: 'project-chat-stable-message-id',
      messageFingerprint: 'a'.repeat(64),
    });
    expect(clientMocks.post).toHaveBeenLastCalledWith(
      '/projects/alpha%20%231/assistant/message-status',
      {
        provider: 'OPENCLAW',
        messageId: 'project-chat-stable-message-id',
        messageFingerprint: 'a'.repeat(64),
      },
      expect.objectContaining({ _skipNetworkRetry: true, _silent: true }),
    );

    await projectsAPI.agentGetMemory(projectName);
    expect(clientMocks.get).toHaveBeenLastCalledWith('/projects/alpha%20%231/assistant/memory');

    await projectsAPI.agentResetSession(projectName, 'OPENCLAW', 9);
    expect(clientMocks.post).toHaveBeenLastCalledWith(
      '/projects/alpha%20%231/assistant/reset',
      { provider: 'OPENCLAW', stateVersion: 9 },
    );

    await projectsAPI.agentGetActiveModel(projectName);
    expect(clientMocks.get).toHaveBeenLastCalledWith('/projects/alpha%20%231/assistant/active-model');
  });

  it('requires coordination and preserves a caller-owned message ID across retries', async () => {
    const request = {
      provider: 'CODEX' as const,
      stateVersion: 12,
      message: 'retry me',
      messageId: 'stable-message-id',
      model: 'openai/gpt-5.5',
    };
    await projectsAPI.agentSend('alpha', request);
    await projectsAPI.agentSend('alpha', request);

    const requests = clientMocks.post.mock.calls.filter(([url]) => (
      url === '/projects/alpha/assistant/send'
    ));
    expect(requests).toHaveLength(2);
    expect(requests[0]?.[1]).toEqual(request);
    expect(requests[1]?.[1]).toEqual(request);
    await expect(projectsAPI.agentSend('alpha', { ...request, stateVersion: -1 })).rejects.toThrow(
      'current Project Chat state version',
    );
    await expect(projectsAPI.agentSend('alpha', { ...request, messageId: '' })).rejects.toThrow(
      'stable Project Chat message ID',
    );
  });

  it('does not expose retired browser-owned Project Chat write helpers', () => {
    expect(projectsAPI).not.toHaveProperty('chatSaveMessage');
    expect(projectsAPI).not.toHaveProperty('chatSaveMessages');
    expect(projectsAPI).not.toHaveProperty('agentSaveMemory');
  });
});
