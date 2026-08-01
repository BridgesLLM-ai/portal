import fs from 'fs';
import path from 'path';

/**
 * Before 4.0 a fullstack app ran as a host process and the Portal proxied to
 * 127.0.0.1, so `listen(port, '127.0.0.1')` was correct and extremely common.
 * In 4.0's isolated runtime the Portal reaches the app on the container's
 * address, so a loopback-only listener is invisible and the deploy dies with a
 * 15s timeout that names no cause.
 *
 * Compatibility testing confirms that listen(PORT,'127.0.0.1') is unreachable
 * without the bridge while listen(PORT,'0.0.0.0') remains reachable. Existing
 * loopback-bound apps therefore need the bridge during an upgrade.
 */
describe('loopback-bound apps survive the isolated runtime', () => {
  const lifecycle = fs.readFileSync(
    path.resolve(__dirname, '../services/project-lifecycle.service.ts'), 'utf8',
  );
  const appProcess = fs.readFileSync(
    path.resolve(__dirname, '../services/app-process.service.ts'), 'utf8',
  );

  test('a bridge from the container address to its own loopback exists', () => {
    expect(lifecycle).toContain('export function bridgeContainerLoopbackPort(');
    expect(lifecycle).toContain('TCP:127.0.0.1:${port}');
  });

  test('the bridge validates every value it interpolates into a shell', () => {
    const body = lifecycle.slice(
      lifecycle.indexOf('export function bridgeContainerLoopbackPort('),
      lifecycle.indexOf('export function inspectProjectAppContainer('),
    );
    expect(body).toContain("/^[A-Za-z0-9_.-]+$/.test(containerName)");
    expect(body).toContain("/^[0-9a-fA-F:.]+$/.test(networkAddress)");
    expect(body).toContain('Number.isInteger(port)');
  });

  test('the bridge listens only inside the container namespace', () => {
    // It must never publish a host port; isolation is the whole point.
    const body = lifecycle.slice(lifecycle.indexOf('export function bridgeContainerLoopbackPort('));
    expect(body).toContain("'exec', '-d', containerName");
    expect(body).not.toContain('--publish');
    expect(body).not.toContain('-p ');
  });

  test('readiness attempts the bridge once, partway through the budget', () => {
    expect(appProcess).toContain('if (!app.loopbackBridgeAttempted && Date.now() > app.startupDeadlineAt - STARTUP_TIMEOUT_MS / 2)');
    expect(appProcess).toContain('app.loopbackBridgeAttempted = true;');
    expect(appProcess).toContain('bridgeContainerLoopbackPort(app.containerName, app.networkAddress, app.port)');
  });

  test('the timeout now names the actual cause and the fix', () => {
    expect(appProcess).toContain('process.env.PORT');
    expect(appProcess).toContain("'0.0.0.0'");
    expect(appProcess).toContain('rather than only on localhost');
  });
});
