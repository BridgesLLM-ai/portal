import net from 'net';
import {
  assertProjectRuntimeLifecycleMutable,
  probeExternalLoopbackRuntime,
  projectExternalRuntimeConflict,
  projectInvalidRuntimeBindingConflict,
  ProjectExternalRuntimeLifecycleError,
  ProjectInvalidRuntimeBindingError,
  projectRuntimeManagement,
  projectRuntimeStatusSource,
  projectSupportedLifecycleActions,
} from '../services/projectRuntimeManagement';

function app(id: string, deployType: string) {
  return { id, deployType } as any;
}

describe('Project runtime management authority', () => {
  test('derives one authoritative management mode from deploy type and external binding', () => {
    const environment = {
      APP_API_TARGET_STATIC_EXTERNAL: 'http://127.0.0.1:5002',
      APP_API_TARGET_FULLSTACK_EXTERNAL: 'http://localhost:5003',
    } as NodeJS.ProcessEnv;

    expect(projectRuntimeManagement(app('portal', 'fullstack'), environment))
      .toBe('portal-container');
    expect(projectRuntimeManagement(app('desktop', 'runtime'), environment))
      .toBe('desktop-session');
    expect(projectRuntimeManagement(app('plain', 'static'), environment))
      .toBe('static');
    expect(projectRuntimeManagement(app('static-external', 'static'), environment))
      .toBe('external-loopback');
    expect(projectRuntimeManagement(app('fullstack-external', 'fullstack'), environment))
      .toBe('external-loopback');
    expect(projectRuntimeStatusSource(app('static-external', 'static'), environment))
      .toBe('external-binding');
    expect(projectRuntimeManagement(app('invalid', 'fullstack'), {
      APP_API_TARGET_INVALID: '   ',
    } as NodeJS.ProcessEnv)).toBe('invalid-external-binding');
  });

  test('invalid binding conflicts are safe and keep the public ownership enum compatible', () => {
    const environment = { APP_API_TARGET_INVALID_APP: 'https://unsafe.example' } as NodeJS.ProcessEnv;
    expect(() => assertProjectRuntimeLifecycleMutable(
      app('invalid-app', 'fullstack'),
      'start',
      environment,
    )).toThrow(ProjectInvalidRuntimeBindingError);
    const payload = projectInvalidRuntimeBindingConflict(
      new ProjectInvalidRuntimeBindingError('start'),
    );
    expect(payload).toMatchObject({
      code: 'PROJECT_RUNTIME_BINDING_INVALID',
      runtimeManagement: 'external-loopback',
      bindingStatus: 'invalid',
      supportedActions: [],
      retryable: false,
    });
    expect(JSON.stringify(payload)).not.toContain('unsafe.example');
  });

  test('external lifecycle conflicts are structured, actionable, and target-secret safe', () => {
    const environment = {
      APP_API_TARGET_EXTERNAL_APP: 'http://127.0.0.1:54321/private-base',
    } as NodeJS.ProcessEnv;

    expect(() => assertProjectRuntimeLifecycleMutable(
      app('external-app', 'fullstack'),
      'delete-project',
      environment,
    )).toThrow(ProjectExternalRuntimeLifecycleError);

    const payload = projectExternalRuntimeConflict(
      new ProjectExternalRuntimeLifecycleError('delete-project'),
    );
    expect(payload).toMatchObject({
      code: 'PROJECT_RUNTIME_EXTERNALLY_MANAGED',
      runtimeManagement: 'external-loopback',
      supportedActions: [],
      action: 'delete-project',
      retryable: false,
    });
    expect(payload.limitation).toContain('externally managed service');
    expect(payload.detail).toContain('Remove the server-managed external API binding');
    expect(JSON.stringify(payload)).not.toContain('54321');
    expect(JSON.stringify(payload)).not.toContain('private-base');
  });

  test('publishes only lifecycle actions the authoritative runtime owner can perform', () => {
    const environment = {
      APP_API_TARGET_STATIC_EXTERNAL: 'http://127.0.0.1:5002',
      APP_API_TARGET_FULLSTACK_EXTERNAL: 'http://127.0.0.1:5003',
    } as NodeJS.ProcessEnv;

    expect(projectSupportedLifecycleActions(app('portal', 'fullstack'), 'fullstack', true, environment))
      .toEqual(['redeploy', 'undeploy', 'rename-project', 'delete-project']);
    expect(projectSupportedLifecycleActions(app('portal', 'fullstack'), 'fullstack', false, environment))
      .toEqual(['redeploy', 'undeploy']);
    expect(projectSupportedLifecycleActions(app('static-external', 'static'), 'static', true, environment))
      .toEqual(['redeploy']);
    expect(projectSupportedLifecycleActions(app('static-external', 'static'), 'fullstack', true, environment))
      .toEqual([]);
    expect(projectSupportedLifecycleActions(app('static-external', 'static'), 'runtime', true, environment))
      .toEqual([]);
    expect(projectSupportedLifecycleActions(app('fullstack-external', 'fullstack'), 'fullstack', true, environment))
      .toEqual([]);
  });

  test('availability probe opens only a bounded TCP connection and sends no application bytes', async () => {
    const received: Buffer[] = [];
    const server = net.createServer((socket) => {
      socket.on('data', (chunk) => received.push(Buffer.from(chunk)));
    });
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen({ host: '127.0.0.1', port: 0 }, resolve);
    });
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('TCP test server did not bind');
    const environment = {
      APP_API_TARGET_PROBED: `http://127.0.0.1:${address.port}`,
    } as NodeJS.ProcessEnv;

    try {
      await expect(probeExternalLoopbackRuntime(app('probed', 'static'), environment, 250))
        .resolves.toBe('running');
      await new Promise((resolve) => setImmediate(resolve));
      expect(Buffer.concat(received)).toHaveLength(0);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }

    await expect(probeExternalLoopbackRuntime(app('probed', 'static'), environment, 100))
      .resolves.toBe('unavailable');
  });
});
