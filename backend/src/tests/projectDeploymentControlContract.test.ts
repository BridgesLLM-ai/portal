import fs from 'fs';
import path from 'path';

const projectRoutesPath = path.resolve(__dirname, '../routes/projects.ts');
const serverPath = path.resolve(__dirname, '../server.ts');
const appsPath = path.resolve(__dirname, '../routes/apps.ts');

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

  test('Project deletion forgets a Portal-managed fullstack runtime before removing durable rows', () => {
    const completion = routeBlock(
      'async function completeAdmittedProjectDeletion',
      '// DELETE /api/projects/:name',
    );
    const runtimeForget = completion.indexOf(
      'await forgetAppRuntime(externalProjectApp.id, deployId',
    );
    const workloadCleanup = completion.indexOf(
      'await removePortalProjectWorkloadsForProject(projectIdentity.id)',
    );

    expect(completion).toContain("externalProjectApp?.deployType === 'fullstack'");
    expect(completion.slice(runtimeForget, runtimeForget + 420)).toContain(
      "{ settleStatus: 'stopped' }",
    );
    expect(runtimeForget).toBeGreaterThanOrEqual(0);
    expect(runtimeForget).toBeLessThan(workloadCleanup);
    expect(completion).toContain('await stopApp(deployId);');

    const deletion = routeBlock(
      "router.delete('/:name'",
      "router.patch('/:name/rename'",
    );
    expect(deletion).toContain('error instanceof ProjectRuntimeStateAttestationError');
    expect(deletion).toContain("recoveryAction: 'REVIEW_RUNTIME_STATE'");
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
    expect(control).toContain("runtimeManagement === 'external-loopback'");
    expect(control).toContain('PROJECT_RUNTIME_RECOVERY_REQUIRED');
    expect(control).toContain("? 'unknown'");
    expect(control).toContain("{ settleStatus: 'stopped' }");
    expect(control).not.toContain('const settled = await prisma.app.updateMany');
    expect(control).not.toContain("app.processStatus === 'starting' ? 'starting' : 'stopped'");
  });

  test('external runtime ownership fences manager and lifecycle mutations before they begin', () => {
    const deploy = routeBlock(
      "router.post('/:name/deploy'",
      "router.delete('/:name/deploy'",
    );
    const deployFence = deploy.indexOf("existingManagement === 'external-loopback'");
    const deployPreflightFence = deploy.indexOf("preflightManagement === 'external-loopback'");
    expect(deployPreflightFence).toBeGreaterThanOrEqual(0);
    expect(deployPreflightFence).toBeLessThan(deploy.indexOf('const projectIdentity = await ensureProjectIdentity({'));
    expect(deployFence).toBeGreaterThanOrEqual(0);
    expect(deploy).toContain("existingProjectApp.deployType === 'static' && deployType === 'static'");
    expect(deployFence).toBeLessThan(deploy.indexOf('copyStaticDeploymentTree(sourceDir, deployPath)'));
    expect(deployFence).toBeLessThan(deploy.indexOf('prepareFullstackDeploymentTree('));

    const undeploy = routeBlock(
      "router.delete('/:name/deploy'",
      "router.post('/:name/app-process'",
    );
    const undeployFence = undeploy.indexOf("sendRuntimeOwnershipMutationConflict(res, app, 'undeploy')");
    const undeployPreflightFence = undeploy.indexOf("sendRuntimeOwnershipMutationConflict(res, preflightProjectApp, 'undeploy')");
    expect(undeployPreflightFence).toBeGreaterThanOrEqual(0);
    expect(undeployPreflightFence).toBeLessThan(undeploy.indexOf('const projectIdentity = await ensureProjectIdentity({'));
    expect(undeployFence).toBeGreaterThanOrEqual(0);
    expect(undeployFence).toBeLessThan(undeploy.indexOf('forgetAppRuntime(app.id, deployId'));
    expect(undeployFence).toBeLessThan(undeploy.indexOf('removeDirectoryThroughAttestedQuarantine'));

    const control = routeBlock(
      "router.post('/:name/app-process'",
      '// POST /api/projects/:name/doc-update',
    );
    const controlFence = control.indexOf("runtimeManagement === 'external-loopback'");
    expect(controlFence).toBeGreaterThanOrEqual(0);
    for (const mutation of ['await forgetAppRuntime(', 'await startApp(', 'await restartApp(']) {
      expect(controlFence).toBeLessThan(control.indexOf(mutation));
    }

    const source = fs.readFileSync(projectRoutesPath, 'utf8');
    const renameStart = source.indexOf("router.patch('/:name/rename'");
    const renameEnd = source.indexOf("router.post('/:name/check'", renameStart);
    const rename = source.slice(renameStart, renameEnd);
    expect(rename.indexOf("sendRuntimeOwnershipMutationConflict(res, lifecycleApp, 'rename-project')"))
      .toBeLessThan(rename.indexOf('renameGrant = await beginProjectIdentityRename({'));

    const deleteStart = source.indexOf("router.delete('/:name'");
    const deleteEnd = source.indexOf("router.", deleteStart + 10);
    const deletion = source.slice(deleteStart, deleteEnd);
    expect(deletion.indexOf("sendRuntimeOwnershipMutationConflict(res, currentProjectApp, 'delete-project')"))
      .toBeLessThan(deletion.indexOf('await beginProjectIdentityDeletion({'));
  });

  test('fullstack recovery claims durable ownership before promoting prepared code', () => {
    const deploy = routeBlock(
      "router.post('/:name/deploy'",
      "router.delete('/:name/deploy'",
    );
    const prepare = deploy.indexOf('prepareFullstackDeploymentTree(');
    const imagePreflight = deploy.indexOf('await assertProjectRuntimeImageAvailable()', prepare);
    const claim = deploy.indexOf('await claimProjectRuntimeRecoveryProof(', imagePreflight);
    const promote = deploy.indexOf('fullstackPromotion.promote()', claim);
    const appMutation = deploy.indexOf('app = await prisma.app.update({', promote);

    expect(prepare).toBeGreaterThan(-1);
    expect(imagePreflight).toBeGreaterThan(prepare);
    expect(claim).toBeGreaterThan(imagePreflight);
    expect(promote).toBeGreaterThan(claim);
    expect(appMutation).toBeGreaterThan(promote);
  });

  test('runtime mutations share the Project lifecycle lock and re-read identity under it', () => {
    const deploy = routeBlock(
      "router.post('/:name/deploy'",
      "router.delete('/:name/deploy'",
    );
    const undeploy = routeBlock(
      "router.delete('/:name/deploy'",
      "router.post('/:name/app-process'",
    );
    const control = routeBlock(
      "router.post('/:name/app-process'",
      '// POST /api/projects/:name/doc-update',
    );
    const source = fs.readFileSync(projectRoutesPath, 'utf8');
    const deletion = source.slice(
      source.indexOf("router.delete('/:name'"),
      source.indexOf('\nrouter.', source.indexOf("router.delete('/:name'") + 10),
    );
    const rename = source.slice(
      source.indexOf("router.patch('/:name/rename'"),
      source.indexOf("router.post('/:name/check'", source.indexOf("router.patch('/:name/rename'")),
    );

    for (const [block, keyExpression, reread] of [
      [deploy, 'projectDeletionLockKey(ownerId, req.params.name)', 'getExistingProjectPathReadOnly(ownerId, req.params.name)'],
      [undeploy, 'projectDeletionLockKey(ownerId, appName)', 'getExistingProjectPathReadOnly(ownerId, appName)'],
      [control, 'projectDeletionLockKey(ownerId, appName)', 'const preflightProjectApp = await findProjectAppBeforeIdentityMutation({'],
    ] as const) {
      const lock = block.indexOf('await acquireProjectDeletionLock(');
      expect(lock).toBeGreaterThanOrEqual(0);
      expect(block.slice(lock, lock + 180)).toContain(keyExpression);
      expect(block.indexOf(reread, lock)).toBeGreaterThan(lock);
      expect(block.indexOf('const projectIdentity =', lock)).toBeGreaterThan(lock);
      expect(block).toContain('releaseProjectNameLock?.()');
    }

    expect(deletion).toContain('projectDeletionLockKey(ownerId, req.params.name)');
    expect(deletion).toContain('const currentRequestedIdentity = await prisma.projectIdentity.findUnique({');
    expect(rename).toContain('projectDeletionLockKey(ownerId, req.params.name)');
    expect(rename).toContain('projectDeletionLockKey(ownerId, sanitized)');
  });

  test('rename removes the old fullstack recovery lane before moving runtime identity', () => {
    const rename = routeBlock(
      "router.patch('/:name/rename'",
      "router.post('/:name/check'",
    );
    const runtimeForget = rename.indexOf('await forgetAppRuntime(app.id, oldDeployId');
    const deploymentMove = rename.indexOf('moveAttestedDirectoryNoReplace({\n        sourceRoot: oldDeployPath');

    expect(runtimeForget).toBeGreaterThanOrEqual(0);
    expect(runtimeForget).toBeLessThan(deploymentMove);
    expect(rename.slice(runtimeForget, runtimeForget + 360)).toContain(
      "{ settleStatus: 'stopped' }",
    );
    expect(rename).not.toContain('stopApp(oldDeployId)');
  });

  test('hosted API proxy preserves application bearer authorization', () => {
    const server = fs.readFileSync(serverPath, 'utf8');
    const allowlistStart = server.indexOf('const upstreamHeaderAllowlist = new Set([');
    expect(allowlistStart).toBeGreaterThanOrEqual(0);
    expect(server.slice(allowlistStart, allowlistStart + 420)).toContain("'authorization'");
  });

  test('invalid app API bindings cannot fall back to a Portal-managed target', () => {
    const server = fs.readFileSync(serverPath, 'utf8');
    const apps = fs.readFileSync(appsPath, 'utf8');
    for (const source of [server, apps]) {
      const binding = source.indexOf('const configuredBinding = configuredAppApiTargetBinding(');
      const invalid = source.indexOf("configuredBinding.status === 'invalid'", binding);
      const fallback = source.indexOf(': registeredTarget || undefined', binding);
      expect(binding).toBeGreaterThanOrEqual(0);
      expect(invalid).toBeGreaterThan(binding);
      expect(invalid).toBeLessThan(fallback);
      expect(source.slice(invalid, fallback)).toContain('invalidAppApiTargetResponse()');
      const managerLookup = source.indexOf('getAppTarget(deployId)', binding);
      expect(managerLookup).toBeGreaterThan(invalid);
      expect(source.slice(binding, managerLookup)).toContain("configuredBinding.status === 'absent'");
    }
    expect(server).toContain("configuredBinding.status === 'absent'\n    ? getAppTarget(deployId)\n    : null");
  });

  test('Project inventory publishes server-detected deploy type and runtime ownership', () => {
    const inventory = routeBlock(
      "router.get('/', authenticateToken",
      "router.post('/', authenticateToken",
    );
    expect(inventory).toContain('const detectedDeployType = detectDeployType(pDir)');
    expect(inventory).toContain('detectedDeployType,');
    expect(inventory).toContain('const authoritativeRuntimeManagement = app ? projectRuntimeManagement(app) : null');
    expect(inventory).toContain("const invalidRuntimeBinding = authoritativeRuntimeManagement === 'invalid-external-binding'");
    expect(inventory).toContain('runtimeManagement,');
    expect(inventory).toContain('statusSource: projectRuntimeStatusSource(app)');
    expect(inventory).toContain('supportedLifecycleActions: projectSupportedLifecycleActions(');
    expect(inventory).toContain("authoritativeRuntimeManagement === 'external-loopback'");
  });
});
