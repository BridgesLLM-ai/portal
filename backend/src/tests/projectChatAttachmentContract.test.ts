import fs from 'fs';
import path from 'path';

describe('Project Chat attachment boundary', () => {
  it('materializes scanned files into the attested project and returns only a relative path', () => {
    const source = fs.readFileSync(path.join(__dirname, '../routes/projects.ts'), 'utf8');
    const start = source.indexOf("'/:name/assistant/attachments'");
    const end = source.indexOf('// POST /api/projects/:name/upload', start);
    expect(start).toBeGreaterThanOrEqual(0);
    expect(end).toBeGreaterThan(start);
    const route = source.slice(start, end);

    expect(route).toContain("fileUpload.single('file')");
    expect(route).toContain('resolveProjectChatOperationContext(');
    expect(route).toContain('actorUserId');
    expect(route).toContain('requireSelectedProjectChatState({');
    expect(route).toContain('coordination.activeTurn');
    expect(route).toContain('scanFile(uploadedFile.path)');
    const firstContext = route.indexOf('const { provider, executionContext, projectIdentity } = await resolveProjectChatOperationContext(');
    const scan = route.indexOf('scanFile(uploadedFile.path)');
    const lock = route.indexOf('await acquireProjectDeletionLock(', scan);
    const lockedWorkspace = route.indexOf('const lockedWorkspace = resolveActorProjectChatWorkspace', lock);
    const lockedContext = route.indexOf('const lockedContext = await resolveProjectChatOperationContext(', lockedWorkspace);
    const generationAttestation = route.indexOf(
      'lockedContext.projectIdentity.generation !== projectIdentity.generation',
      lockedContext,
    );
    const coordinationAdmission = route.indexOf(
      'const admittedCoordination = await requireSelectedProjectChatState({',
      generationAttestation,
    );
    const materialize = route.indexOf("path.posix.join('.portal', 'attachments'", coordinationAdmission);
    expect(firstContext).toBeGreaterThanOrEqual(0);
    expect(firstContext).toBeLessThan(scan);
    expect(route.slice(firstContext, scan)).toContain('{ readOnly: true }');
    expect(lock).toBeGreaterThan(scan);
    expect(lockedWorkspace).toBeGreaterThan(lock);
    expect(lockedContext).toBeGreaterThan(lockedWorkspace);
    expect(generationAttestation).toBeGreaterThan(lockedContext);
    expect(coordinationAdmission).toBeGreaterThan(generationAttestation);
    expect(materialize).toBeGreaterThan(coordinationAdmission);
    expect(route.slice(lockedContext, generationAttestation)).not.toContain('{ readOnly: true }');
    expect(route).toContain('releaseProjectNameLock?.()');
    expect(route).toContain("path.posix.join('.portal', 'attachments', crypto.randomUUID())");
    expect(route).toContain('resolveContainedPath(attachmentDir, safeOriginalName');
    expect(route).toContain('projectPath,');
    expect(route).not.toMatch(/\b(?:diskPath|originalDiskPath|serverPath|toolUrl)\b/);
    expect(route).not.toMatch(/(?:server_path|tool_url|portal_url):/);
  });
});
