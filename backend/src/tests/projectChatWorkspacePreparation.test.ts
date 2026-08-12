import fs from 'fs';
import path from 'path';

describe('Project Chat workspace ownership preparation contract', () => {
  const routeSource = fs.readFileSync(path.resolve(__dirname, '../routes/projects.ts'), 'utf8');
  const filesRouteSource = fs.readFileSync(path.resolve(__dirname, '../routes/files.ts'), 'utf8');

  test('migrates legacy ownership once and keeps warm reuse constant-time', () => {
    expect(routeSource).not.toContain('prepareProjectLifecycleWorkspace(');
    expect(routeSource).not.toContain('prepareProjectChatLifecycleWorkspace(');
    expect(routeSource.match(/await ensureProjectChatWorkspaceOwnership\(/g)).toHaveLength(5);

    const sendStart = routeSource.indexOf("router.post('/:name/assistant/send'");
    const sendEnd = routeSource.indexOf("router.post('/:name/assistant/read-file'", sendStart);
    const sendRoute = routeSource.slice(sendStart, sendEnd);
    expect(sendRoute).toContain('await ensureProjectChatWorkspaceOwnership(executionContext, projectDir)');
    expect(sendRoute).toContain('Warm sends never traverse the repository');
    expect(sendRoute).toContain('Warm OpenClaw');
    expect(routeSource).toContain('runPreparedProjectGitCommand({');
  });

  test('atomically selects the provider whose explicit qualification succeeded', () => {
    const qualifyStart = routeSource.indexOf('function qualifyProjectChatProviderRoute(');
    const qualifyEnd = routeSource.indexOf("router.post(\n  '/:name/chat/providers/openclaw/qualify'", qualifyStart);
    const qualificationRoute = routeSource.slice(qualifyStart, qualifyEnd);
    expect(qualificationRoute).toContain(
      'requestedProviderAfterSuccess: toPersistedProjectChatProvider(provider)',
    );
    expect(qualificationRoute).toContain('withProjectChatRuntimeAdmission({');
    expect(qualificationRoute.indexOf('requestedProviderAfterSuccess')).toBeLessThan(
      qualificationRoute.indexOf('}, async () => {'),
    );
  });

  test('assigns runtime ownership at exact Project mutation boundaries', () => {
    expect(routeSource).toContain('writeProjectRuntimeOwnedFileAtomic(projectDir, filePath, content');
    expect(routeSource).toContain(
      'ensureProjectRuntimeOwnedDirectory(\n        lockedWorkspace.projectDir,\n        attachmentSubdirectory',
    );
    expect(routeSource).toContain(
      "assignProjectRuntimeOwnership(lockedWorkspace.projectDir, destination, 'file')",
    );
    expect(routeSource).toContain("assignProjectRuntimeOwnership(projectDir, resolvedDest, 'file')");
    expect(routeSource).toContain("writeProjectRuntimeTextFile(projectDir, '.deps-installed'");
    expect(filesRouteSource).toContain('ensureProjectRuntimeOwnedDirectory(projectDir, relativeDestDir)');
    expect(filesRouteSource).toContain("assignProjectRuntimeOwnership(projectDir, destPath, 'file')");
  });

  test('maps bounded workspace preparation failures to a retryable service response', () => {
    expect(routeSource).toContain('error instanceof ProjectLifecycleWorkspacePreparationError');
    expect(routeSource).toContain("code: error.code");
    expect(routeSource).toContain('retryable: error.retryable');
    expect(routeSource).toContain('res.status(503).json({');
    expect(routeSource).not.toContain("res.status(403).json({ error: error.message, code: 'PROJECT_WORKSPACE_PREPARATION_FAILED'");
    expect(routeSource).toContain('error instanceof ProjectRuntimeOwnershipError');
    expect(routeSource).toContain("error: 'Project storage is temporarily unavailable. Try again.'");
  });
});
