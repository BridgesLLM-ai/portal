import fs from 'fs';
import path from 'path';

const projectRoutesPath = path.resolve(__dirname, '../routes/projects.ts');
const serverPath = path.resolve(__dirname, '../server.ts');

function routeBlock(start: string, end: string): string {
  const source = fs.readFileSync(projectRoutesPath, 'utf8');
  const startIndex = source.indexOf(start);
  expect(startIndex).toBeGreaterThanOrEqual(0);
  const endIndex = source.indexOf(end, startIndex + start.length);
  expect(endIndex).toBeGreaterThan(startIndex);
  return source.slice(startIndex, endIndex);
}

describe('Project deployment control contract', () => {
  test('the built-in Node API binds the assigned HOST and PORT', () => {
    const templates = routeBlock(
      'const TEMPLATES:',
      '// GET /api/projects - list projects',
    );
    expect(templates).toContain("const host = process.env.HOST || '127.0.0.1'");
    expect(templates).toContain("const port = Number.parseInt(process.env.PORT || '3000', 10)");
    expect(templates).toContain('server.listen(port, host');
    expect(templates).not.toContain('server.listen(3000');
  });

  test('static dependency installation is networked but the build itself is offline', () => {
    const deploy = routeBlock(
      "router.post('/:name/deploy'",
      "router.delete('/:name/deploy'",
    );
    const install = deploy.indexOf("nameHint: `${deployId}:static-install`");
    const build = deploy.indexOf("nameHint: `${deployId}:static-build`");
    expect(install).toBeGreaterThanOrEqual(0);
    expect(build).toBeGreaterThan(install);
    expect(deploy.slice(install, build)).toContain('network: true');
    expect(deploy.slice(build, build + 220)).toContain('network: false');
  });

  test('Remote Desktop Python deployment survives a relocated lifecycle venv', () => {
    const deploy = routeBlock(
      "router.post('/:name/deploy'",
      "router.delete('/:name/deploy'",
    );
    expect(deploy).toContain('copyDesktopRuntimeDeploymentTree(projectDir, runtimeDir);');
    expect(deploy).toContain(
      'desktopExec(`python3 -m venv ${shellEscape(runtimeVenv)}`, { timeout: 30000 });',
    );
    expect(deploy).toContain(
      'installCommand = `${shellEscape(runtimeVenvPython)} -m pip install -r requirements.txt 2>&1`;',
    );
    expect(deploy).toContain('if (installCommand && !runtimeError)');
    expect(deploy).not.toContain('rsync -a --exclude=node_modules');
    expect(deploy).not.toContain('fs.existsSync(runtimeVenvPython)');
    expect(deploy).not.toContain('runtimeVenvPip');
    expect(deploy).not.toContain('shellEscape(usePip)');
    expect(deploy).not.toContain("runtimeVenvPython : 'python3'");
  });

  test('undeploy removes the attested App runtime without deleting Project source or identity', () => {
    const undeploy = routeBlock(
      "router.delete('/:name/deploy'",
      "router.post('/:name/app-process'",
    );
    expect(undeploy).toContain('getExistingProjectPathReadOnly(ownerId, appName)');
    expect(undeploy).toContain('forgetAppRuntime(app.id, deployId');
    expect(undeploy).toContain('stopProjectDesktopRuntimesForLifecycle');
    expect(undeploy).toContain('removeDirectoryThroughAttestedQuarantine');
    expect(undeploy).toContain('projectIdentityId: projectIdentity.id');
    expect(undeploy).toContain('await prisma.app.deleteMany');
    expect(undeploy).toContain('sourcePreserved: true');
    expect(undeploy).not.toContain('projectIdentity.delete');
    expect(undeploy).not.toContain('fs.promises.rm(projectDir');
  });

  test('process control includes atomic restart and tells non-fullstack deployments the truth', () => {
    const control = routeBlock(
      "router.post('/:name/app-process'",
      "// POST /api/projects/:name/doc-update",
    );
    expect(control).toContain("['start', 'stop', 'restart', 'status', 'logs']");
    expect(control).toContain("if (app.deployType !== 'fullstack')");
    expect(control).toContain('PROJECT_PROCESS_CONTROL_UNSUPPORTED');
    expect(control).toContain('Remote Desktop Project runtimes are launched as desktop sessions');
    expect(control).toContain('await restartApp(');
  });

  test('hosted API proxy preserves application bearer authorization', () => {
    const server = fs.readFileSync(serverPath, 'utf8');
    const allowlistStart = server.indexOf('const upstreamHeaderAllowlist = new Set([');
    expect(allowlistStart).toBeGreaterThanOrEqual(0);
    expect(server.slice(allowlistStart, allowlistStart + 420)).toContain("'authorization'");
  });
});
