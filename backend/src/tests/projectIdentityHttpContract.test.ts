import fs from 'fs';
import path from 'path';

const routeSource = fs.readFileSync(path.resolve(__dirname, '../routes/projects.ts'), 'utf8');

function routeBlock(startMarker: string, endMarker: string): string {
  const start = routeSource.indexOf(startMarker);
  const end = routeSource.indexOf(endMarker, start + startMarker.length);
  expect(start).toBeGreaterThanOrEqual(0);
  expect(end).toBeGreaterThan(start);
  return routeSource.slice(start, end);
}

describe('project identity HTTP proof contract', () => {
  it('attaches immutable identity and generation proof to list and tree responses', () => {
    const list = routeBlock("router.get('/', authenticateToken", 'const projectSearchLimiter');
    const tree = routeBlock("router.get('/:name/tree'", "router.get('/:name/raw'");

    expect(list).toContain('await Promise.all');
    expect(list).toContain('identity: serializeProjectIdentityProof(identity)');
    expect(tree).toContain('identity: serializeProjectIdentityProof(projectIdentity)');
    expect(routeSource).toContain("return { id: identity.id, generation: identity.generation }");
  });

  it('requires one response-bound attempt and exact identity proof before rename admission', () => {
    const rename = routeBlock("router.patch('/:name/rename'", "router.post('/:name/check'");
    const admission = rename.indexOf('renameGrant = await beginProjectIdentityRename({');

    expect(rename).toContain('attemptId: rawAttemptId');
    expect(rename).toContain("'PROJECT_RENAME_ATTEMPT_REQUIRED'");
    expect(rename).toContain('identityBeforeRenameBarrier.id !== requestedProjectIdentityId');
    expect(rename).toContain('identityBeforeRenameBarrier.generation !== requestedProjectGeneration');
    expect(rename).toContain('requestedIdentityMatchesSource');
    expect(rename).toContain('requestedIdentityMatchesCompletedRename');
    expect(rename).toContain('requestedIdentity.lastRenameSourceName === req.params.name');
    expect(rename).toContain('requestedIdentity.lastRenameCompletedAt instanceof Date');
    expect(rename.indexOf('requestedIdentityMatchesSource')).toBeLessThan(admission);
    expect(rename.indexOf('requestedIdentityMatchesCompletedRename')).toBeLessThan(admission);
    expect(rename.indexOf('identityBeforeRenameBarrier.id !== requestedProjectIdentityId'))
      .toBeLessThan(admission);
    expect(rename.indexOf('identityBeforeRenameBarrier.generation !== requestedProjectGeneration'))
      .toBeLessThan(admission);
    expect(rename).toContain("status: 'committed'");
    expect(rename).toContain('identity: serializeProjectIdentityProof(renamedIdentity)');
    expect(rename).toContain('identity: serializeProjectIdentityProof(recovered)');
    expect(rename).toContain('identity: serializeProjectIdentityProof(completed)');
    expect(rename).not.toContain('fs.renameSync(oldDir, newDir)');
  });

  it('marks identity-scoped pre-admission rejections as authoritative non-admission', () => {
    const rename = routeBlock("router.patch('/:name/rename'", "router.post('/:name/check'");
    const admission = rename.indexOf('renameGrant = await beginProjectIdentityRename({');
    const beforeAdmission = rename.slice(0, admission);
    const currentIdentityGate = rename.indexOf('requireCurrentProjectDestructiveIdentity(requestedIdentity)');
    const scopedMigrationGate = rename.indexOf(
      'assertLegacyOpenClawProjectMigrationInactive(requestedIdentity.id)',
    );

    expect(routeSource).toContain("status: 'not_admitted'");
    expect(routeSource).toContain('admitted: false');
    expect(routeSource).toContain('...(attemptId ? { attemptId } : {})');
    expect(beforeAdmission).toContain("'PROJECT_RENAME_SOURCE_NOT_FOUND'");
    expect(beforeAdmission).toContain("'PROJECT_RENAME_IDENTITY_CHANGED'");
    expect(beforeAdmission).toContain("'PROJECT_RENAME_TARGET_EXISTS'");
    expect(beforeAdmission).toContain("'PROJECT_RENAME_DEPLOYMENT_TARGET_EXISTS'");
    expect(currentIdentityGate).toBeGreaterThan(-1);
    expect(scopedMigrationGate).toBeGreaterThan(currentIdentityGate);
    expect(scopedMigrationGate).toBeLessThan(admission);
    expect(rename).toContain('if (error instanceof ProjectMoveRequiredError)');
    expect(rename).toContain('sendProjectRenameNotAdmitted(res, 409, attemptId, error.code, error.message)');
    expect(rename).not.toContain('rejectDestructiveProjectChatResetRouteForRelease');
  });

  it('uses an optional exact identity proof to fence Project deletion before mutation', () => {
    const deletion = routeBlock("router.delete('/:name'", "router.patch('/:name/rename'");
    const admission = deletion.indexOf('await beginProjectIdentityDeletion({');

    expect(deletion).toContain('parseProjectDeleteIdentityRequest(req.body)');
    expect(deletion).toContain("'PROJECT_DELETE_IDENTITY_REQUIRED'");
    expect(routeSource).toContain("code: 'PROJECT_DELETE_IDENTITY_MISMATCH'");
    expect(deletion).toContain('projectDeleteIdentityMatches(requestedIdentity, deletionIdentityProof)');
    expect(deletion).toContain('projectDeleteIdentityMatches(currentRequestedIdentity, deletionIdentityProof)');
    expect(deletion).toContain('projectDeleteIdentityMatches(identityBeforeBarrier, deletionIdentityProof)');
    expect(deletion.indexOf('projectDeleteIdentityMatches(requestedIdentity, deletionIdentityProof)'))
      .toBeLessThan(admission);
    expect(deletion.indexOf('projectDeleteIdentityMatches(currentRequestedIdentity, deletionIdentityProof)'))
      .toBeLessThan(admission);
    expect(deletion.indexOf('projectDeleteIdentityMatches(identityBeforeBarrier, deletionIdentityProof)'))
      .toBeLessThan(admission);
  });
});
