import fs from 'fs';
import path from 'path';

const routes = fs.readFileSync(path.resolve(__dirname, '../routes/projects.ts'), 'utf8');
const legacyRuntimeCleanup = fs.readFileSync(path.resolve(
  __dirname,
  '../services/projectChatLegacyRuntimeCleanup.ts',
), 'utf8');
const schema = fs.readFileSync(path.resolve(__dirname, '../../prisma/schema.prisma'), 'utf8');
const migration = fs.readFileSync(path.resolve(
  __dirname,
  '../../prisma/migrations/20260721_project_identity_rename_lifecycle/migration.sql',
), 'utf8');

function routeBlock(signature: string): string {
  const start = routes.indexOf(signature);
  expect(start).toBeGreaterThan(-1);
  const next = routes.indexOf('\nrouter.', start + signature.length);
  return routes.slice(start, next === -1 ? routes.length : next);
}

function functionBlock(signature: string): string {
  const start = routes.indexOf(signature);
  expect(start).toBeGreaterThan(-1);
  const candidates = [
    routes.indexOf('\nasync function ', start + signature.length),
    routes.indexOf('\nfunction ', start + signature.length),
  ].filter((index) => index !== -1);
  const next = candidates.length > 0 ? Math.min(...candidates) : -1;
  return routes.slice(start, next === -1 ? routes.length : next);
}

describe('Project rename lifecycle route contract', () => {
  test.each([
    ["router.post('/', authenticateToken", 'createProjectCreationStagingDirectory()'],
    ["router.post('/clone', authenticateToken", 'createProjectCreationStagingDirectory()'],
    ["router.post('/upload-zip', authenticateToken", 'createProjectCreationStagingDirectory()'],
    ["router.post('/create-from-upload', authenticateToken", 'createProjectCreationStagingDirectory()'],
  ])('%s serializes and checks the durable target reservation before claiming a root', (signature, claim) => {
    const block = routeBlock(signature);
    expect(block).toContain('acquireProjectDeletionLock');
    expect(block).toContain('projectDeletionLockKey(ownerId');
    expect(block).toContain('assertProjectIdentityNameAvailable');
    expect(block.indexOf('acquireProjectDeletionLock')).toBeLessThan(block.indexOf(claim));
    expect(block.indexOf('assertProjectIdentityNameAvailable')).toBeLessThan(block.indexOf(claim));
  });

  test('closes admission, settles callbacks, retires every runtime, and marks cleanup before moving the root', () => {
    const block = routeBlock("router.patch('/:name/rename'");
    const currentIdentityGate = block.indexOf('requireCurrentProjectDestructiveIdentity(requestedIdentity)');
    const initialLegacyProof = block.indexOf(
      'assertLegacyOpenClawProjectMigrationInactive(requestedIdentity.id)',
    );
    const begin = block.indexOf('renameGrant = await beginProjectIdentityRename');
    const boundaryLegacyProof = block.indexOf(
      'assertLegacyOpenClawProjectMigrationInactive(requestedProjectIdentityId)',
      begin,
    );
    const activeTurnPreflight = block.indexOf('activeDurableTurn');
    const cleanAdmissionRollback = block.indexOf('abandonProjectIdentityRenameBeforeCleanup');
    const cleanupStarted = block.indexOf('markProjectIdentityRenameCleanupStarted');
    const quiesce = block.indexOf('quiesceProjectChatBrokerCallbacksForDestructiveReset');
    const genericCleanup = block.indexOf('cleanupProjectRuntime');
    const legacyCleanup = block.indexOf('retireLegacyOpenClawRuntimesForProject');
    const portalCleanup = block.indexOf('removePortalProjectWorkloadsForProject');
    const bindingReset = block.indexOf('projectChatProviderBinding.deleteMany');
    const marker = block.indexOf('markProjectIdentityRenameRuntimeCleaned');
    const desktopStop = block.indexOf('stopProjectDesktopRuntimesForLifecycle', portalCleanup);
    const rootMove = block.indexOf('moveAttestedDirectoryNoReplace({\n      sourceRoot: oldDir');
    const identityCommit = block.indexOf('renameProjectIdentity');
    const pendingResume = block.indexOf('if (pendingRename) {\n      oldDeployAttestation');
    const pendingResumeGate = block.indexOf(
      'assertLegacyOpenClawProjectMigrationInactive(requestedProjectIdentityId)',
      pendingResume,
    );
    const pendingDeployConvergence = block.indexOf(
      'convergeInterruptedProjectDeployment',
      pendingResume,
    );

    for (const index of [
      begin,
      currentIdentityGate,
      initialLegacyProof,
      boundaryLegacyProof,
      activeTurnPreflight,
      cleanAdmissionRollback,
      cleanupStarted,
      quiesce,
      genericCleanup,
      legacyCleanup,
      portalCleanup,
      desktopStop,
      bindingReset,
      marker,
      rootMove,
      identityCommit,
      pendingResume,
      pendingResumeGate,
      pendingDeployConvergence,
    ]) {
      expect(index).toBeGreaterThan(-1);
    }
    expect(currentIdentityGate).toBeLessThan(initialLegacyProof);
    expect(initialLegacyProof).toBeLessThan(begin);
    expect(begin).toBeLessThan(activeTurnPreflight);
    expect(activeTurnPreflight).toBeLessThan(cleanAdmissionRollback);
    expect(cleanAdmissionRollback).toBeLessThan(boundaryLegacyProof);
    expect(boundaryLegacyProof).toBeLessThan(cleanupStarted);
    expect(cleanupStarted).toBeLessThan(quiesce);
    expect(quiesce).toBeLessThan(genericCleanup);
    expect(genericCleanup).toBeLessThan(legacyCleanup);
    expect(legacyCleanup).toBeLessThan(portalCleanup);
    expect(portalCleanup).toBeLessThan(desktopStop);
    expect(desktopStop).toBeLessThan(bindingReset);
    expect(bindingReset).toBeLessThan(marker);
    expect(marker).toBeLessThan(rootMove);
    expect(rootMove).toBeLessThan(identityCommit);
    expect(pendingResume).toBeLessThan(pendingResumeGate);
    expect(pendingResumeGate).toBeLessThan(pendingDeployConvergence);
    expect(block).toContain('listProjectLifecycleActorIds');
    expect(block).toContain('migrateLegacyProjectChatState');
    expect(block).toContain('if (actorUserId === ownerId)');
    expect(block).toContain('legacyProjectName: req.params.name');
    expect(block).toContain('projectChatSession.deleteMany');
    expect(block).toContain('{ userId: ownerId, projectId: req.params.name }');
    expect(block).not.toContain('projectChatMessage.deleteMany');
    expect(block).toContain("code: 'PROJECT_RENAME_TURN_ACTIVE'");
    expect(block).toContain('renameGrant.identity.renameCleanupStartedAt instanceof Date');
    expect(block).toContain('&& !renameGrant.resumed');
    expect(block).toContain('retargetProjectAppsForRename(transaction');
    expect(block).toContain('readCompletedProjectIdentityRename');
    expect(block).toContain('interrupted.projectName !== req.params.name');
    expect(block).toContain('interrupted.renameTargetName !== sanitized');
    expect(block).toContain('preserveTranscriptFiles: true');
    expect(block).toContain('!projectPathMoved');
    expect(block).toContain('!deployPathMoved');
  });

  test('rename recovery preserves legacy transcript files and converges partial deployment moves', () => {
    const convergenceStart = routes.indexOf(
      'async function convergeInterruptedProjectRenameForDestructiveOperation',
    );
    const convergenceEnd = routes.indexOf('\nasync function ensureOpenClawProjectChatBinding', convergenceStart);
    const convergence = routes.slice(convergenceStart, convergenceEnd);
    expect(convergence.match(/preserveTranscriptFiles: true/g)).toHaveLength(2);
    expect(convergence).toContain("mode: 'complete'");
    expect(convergence).toContain("mode: 'cancel'");

    const deployConvergenceStart = routes.indexOf('function convergeInterruptedProjectDeployment');
    const deployConvergenceEnd = routes.indexOf(
      '\nasync function completeInterruptedProjectRenameWithApps',
      deployConvergenceStart,
    );
    const deployment = routes.slice(deployConvergenceStart, deployConvergenceEnd);
    expect(deployment).toContain('if (oldExists === newExists)');
    expect(deployment).toContain('moveAttestedDirectoryNoReplace');
    expect(deployment).toContain('attestProjectRoot(oldExists ? input.oldDeployPath : input.newDeployPath)');

    expect(legacyRuntimeCleanup).toContain('{ deleteTranscript: false }');
    expect(legacyRuntimeCleanup).toContain('{ deleteFiles: false }');
  });

  test('deletion converges an expired rename and retires legacy and process-local execution before files', () => {
    const block = routeBlock("router.delete('/:name'");
    const currentIdentityGate = block.indexOf('requireCurrentProjectDestructiveIdentity(');
    const initialLegacyProof = block.indexOf(
      'assertLegacyOpenClawProjectMigrationInactive(requestedIdentity.id)',
    );
    const identityEnrollment = block.indexOf('ensureProjectIdentity');
    const convergence = block.indexOf('convergeInterruptedProjectRenameForDestructiveOperation');
    const barrier = block.indexOf('beginProjectIdentityDeletion');
    const boundaryLegacyProof = block.indexOf(
      'assertLegacyOpenClawProjectMigrationInactive(projectIdentity.id)',
      barrier,
    );
    const completion = block.indexOf('completeAdmittedProjectDeletion({', boundaryLegacyProof);
    expect(convergence).toBeGreaterThan(-1);
    expect(currentIdentityGate).toBeGreaterThan(-1);
    expect(initialLegacyProof).toBeGreaterThan(-1);
    expect(identityEnrollment).toBeGreaterThan(-1);
    expect(boundaryLegacyProof).toBeGreaterThan(-1);
    expect(currentIdentityGate).toBeLessThan(initialLegacyProof);
    expect(initialLegacyProof).toBeLessThan(convergence);
    expect(convergence).toBeLessThan(barrier);
    expect(initialLegacyProof).toBeLessThan(identityEnrollment);
    expect(barrier).toBeLessThan(boundaryLegacyProof);
    expect(boundaryLegacyProof).toBeLessThan(completion);
    expect(block.match(/listProjectLifecycleActorIds/g)).toHaveLength(1);
    const retryRead = block.indexOf('const currentRequestedIdentity = await prisma.projectIdentity.findUnique');
    const retryCompletion = block.indexOf(
      "if (currentRequestedIdentity.lifecycleStatus === 'DELETING')",
    );
    expect(retryRead).toBeGreaterThan(-1);
    expect(retryCompletion).toBeGreaterThan(retryRead);
    expect(retryCompletion).toBeLessThan(convergence);
    expect(block.slice(retryCompletion, convergence)).toContain(
      'completeAdmittedProjectDeletion({',
    );
    expect(block.slice(retryCompletion, convergence)).toContain('resumed: true');

    // Everything after the DELETING admission barrier lives in the shared
    // completion function so automatic lifecycle-residue recovery resumes the
    // identical sequence a crashed route left behind.
    const completionStart = routes.indexOf('async function completeAdmittedProjectDeletion');
    const completionBlock = routes.slice(
      completionStart,
      routes.indexOf("router.delete('/:name'", completionStart),
    );
    const quiesce = completionBlock.indexOf('quiesceProjectChatBrokerCallbacksForDestructiveReset');
    const cleanup = completionBlock.indexOf('cleanupProjectRuntime');
    const legacyCleanup = completionBlock.indexOf('retireLegacyOpenClawRuntimesForProject');
    const rootRemoval = completionBlock.indexOf("quarantineKey: `project:${projectIdentity.id}`");
    expect(quiesce).toBeGreaterThan(-1);
    expect(quiesce).toBeLessThan(cleanup);
    expect(cleanup).toBeLessThan(legacyCleanup);
    expect(legacyCleanup).toBeLessThan(rootRemoval);
    expect(completionBlock.match(/listProjectLifecycleActorIds/g)).toHaveLength(1);
    expect(completionBlock).toContain('{ userId: ownerId, projectId: projectName }');
    expect(completionBlock).not.toContain('userId: { in: actorIds }, projectId: projectName');
    expect(completionBlock).toContain('initialDeployAttestation');
    expect(completionBlock).toContain('stopProjectDesktopRuntimesForLifecycle');
    expect(completionBlock).not.toContain('fs.promises.rm(projectDir');
    expect(block).not.toContain('fs.promises.rm(projectDir');
  });

  test('database namespace and rename receipts survive independent processes and lost responses', () => {
    expect(schema).toContain('model ProjectNameReservation');
    expect(schema).toContain('@@id([workspaceOwnerId, projectName])');
    expect(schema).toMatch(/lastRenameSourceName\s+String\?/);
    expect(schema).toMatch(/lastRenameCompletedAt\s+DateTime\?/);
    expect(migration).toContain('CREATE TABLE "ProjectNameReservation"');
    expect(migration).toContain('ProjectIdentity_sync_name_reservations');
    expect(migration).toContain('AFTER INSERT OR UPDATE OF "workspaceOwnerId", "projectName", "renameTargetName"');
    expect(schema).toContain('model ProjectRuntimeCleanupActor');
    expect(schema).toContain('@@id([projectIdentityId, provider, actorUserId, sessionId])');
    expect(migration).toContain('CREATE TABLE "ProjectRuntimeCleanupActor"');
  });

  test.each([
    ["router.delete('/:name/chat/history'", 'req.query.provider || req.body?.provider'],
    ["router.post('/:name/assistant/reset'", 'req.body?.provider'],
  ])('%s holds the name lock and converges rename lifecycle before destructive reset admission', (signature, providerInput) => {
    const block = routeBlock(signature);
    const legacyProof = block.indexOf('assertLegacyOpenClawProjectDestructiveMutationSafe');
    const lock = block.indexOf('acquireProjectDeletionLock');
    const convergence = block.indexOf('convergeInterruptedProjectRenameForDestructiveOperation');
    const operationContext = block.indexOf('resolveProjectChatOperationContext');
    const reset = block.indexOf('performProjectChatDestructiveReset');
    const release = block.indexOf('releaseProjectNameLock?.()');
    for (const index of [legacyProof, lock, convergence, operationContext, reset, release]) {
      expect(index).toBeGreaterThan(-1);
    }
    expect(legacyProof).toBeLessThan(lock);
    expect(lock).toBeLessThan(convergence);
    expect(convergence).toBeLessThan(operationContext);
    expect(operationContext).toBeLessThan(reset);
    expect(block).toContain(providerInput);
    expect(block).toContain("code: 'PROJECT_RENAMED'");
    expect(block).toContain('finally');
  });

  test('CURRENT project CRUD is identity-scoped while chat resets retain the sticky global evidence gate', () => {
    const globalGate = functionBlock(
      'async function assertLegacyOpenClawProjectDestructiveMutationSafe',
    );
    const migrationGate = globalGate.indexOf(
      'await assertLegacyOpenClawProjectMigrationInactive();',
    );
    const evidenceGate = globalGate.indexOf(
      'await assertNoLegacyOpenClawProjectEvidence();',
    );
    expect(migrationGate).toBeGreaterThan(-1);
    expect(evidenceGate).toBeGreaterThan(migrationGate);

    const convergence = functionBlock(
      'async function convergeInterruptedProjectRenameForDestructiveOperation',
    );
    const scopedBranch = convergence.indexOf(
      'if (input.currentProjectIdentityId)',
    );
    const identityFence = convergence.indexOf(
      'assertLegacyOpenClawProjectMigrationInactive(input.currentProjectIdentityId)',
    );
    const globalFallback = convergence.indexOf(
      'assertLegacyOpenClawProjectDestructiveMutationSafe()',
    );
    expect(scopedBranch).toBeGreaterThan(-1);
    expect(identityFence).toBeGreaterThan(scopedBranch);
    expect(globalFallback).toBeGreaterThan(identityFence);
    expect(convergence).toContain('projectIdentityId !== input.currentProjectIdentityId');
    for (const operation of [
      'readProjectIdentityRenameJournal',
      'beginProjectIdentityRename',
      'completeInterruptedProjectRenameWithApps',
    ]) {
      const index = convergence.indexOf(operation);
      expect(index).toBeGreaterThan(-1);
      expect(identityFence).toBeLessThan(index);
    }

    for (const signature of [
      "router.delete('/:name'",
      "router.patch('/:name/rename'",
    ]) {
      const block = routeBlock(signature);
      const currentGate = block.indexOf('requireCurrentProjectDestructiveIdentity(');
      const scopedGate = block.indexOf('assertLegacyOpenClawProjectMigrationInactive(');
      expect(currentGate).toBeGreaterThan(-1);
      expect(scopedGate).toBeGreaterThan(currentGate);
      expect(block).not.toContain('assertLegacyOpenClawProjectDestructiveMutationSafe');
      for (const operation of [
        'await acquireProjectDeletionLock(',
        'await convergeInterruptedProjectRenameForDestructiveOperation({',
        'await beginProjectIdentityDeletion({',
        'renameGrant = await beginProjectIdentityRename({',
      ]) {
        const index = block.indexOf(operation);
        if (index !== -1) expect(scopedGate).toBeLessThan(index);
      }
    }

    for (const signature of [
      "router.delete('/:name/chat/history'",
      "router.post('/:name/assistant/reset'",
    ]) {
      const block = routeBlock(signature);
      const releaseGate = block.indexOf('rejectDestructiveProjectChatResetRouteForRelease(res)');
      const globalEvidenceGate = block.indexOf('assertLegacyOpenClawProjectDestructiveMutationSafe');
      expect(releaseGate).toBeGreaterThan(-1);
      expect(globalEvidenceGate).toBeGreaterThan(releaseGate);
    }
    expect(routes).not.toContain('assertLegacyOpenClawProjectMigrationInactiveOrResetRecovery');
  });

  test('Portal 4.0 gates chat resets but admits only CURRENT identity-scoped rename and delete', () => {
    expect(routes).toContain(
      'const PORTAL_4_DESTRUCTIVE_CHAT_RESET_ROUTES_ENABLED = false as const;',
    );
    expect(routes).not.toMatch(
      /PORTAL_4_DESTRUCTIVE_CHAT_RESET_ROUTES_ENABLED\s*=\s*process\.env/,
    );
    expect(routes).toContain("code: 'LEGACY_OPENCLAW_PROJECT_RETIREMENT_PENDING'");
    const rejection = functionBlock('function rejectDestructiveProjectChatResetRouteForRelease');
    expect(rejection).toContain('res.status(409).json(PROJECT_DESTRUCTIVE_RETIREMENT_PENDING_RESPONSE)');

    for (const signature of [
      "router.delete('/:name/chat/history'",
      "router.post('/:name/assistant/reset'",
    ]) {
      const block = routeBlock(signature);
      const releaseGuard = block.indexOf(
        'if (rejectDestructiveProjectChatResetRouteForRelease(res)) return;',
      );
      expect(releaseGuard).toBeGreaterThan(-1);
      for (const operation of [
        'getScopedOwnerId(req)',
        'resolveActorProjectChatWorkspace(req',
        'await acquireProjectDeletionLock(',
        'await convergeInterruptedProjectRenameForDestructiveOperation({',
        'await ensureProjectIdentity({',
        'renameGrant = await beginProjectIdentityRename({',
        'await resolveProjectChatOperationContext(',
        'await performProjectChatDestructiveReset({',
      ]) {
        const index = block.indexOf(operation);
        if (index !== -1) expect(releaseGuard).toBeLessThan(index);
      }
    }

    const rename = routeBlock("router.patch('/:name/rename'");
    const attemptValidation = rename.indexOf("if (!attemptId) {");
    const renameCurrentGate = rename.indexOf('requireCurrentProjectDestructiveIdentity(requestedIdentity)');
    const renameScopedGate = rename.indexOf(
      'assertLegacyOpenClawProjectMigrationInactive(requestedIdentity.id)',
    );
    const renameAdmission = rename.indexOf('renameGrant = await beginProjectIdentityRename({');
    expect(attemptValidation).toBeGreaterThan(-1);
    expect(renameCurrentGate).toBeGreaterThan(attemptValidation);
    expect(renameScopedGate).toBeGreaterThan(renameCurrentGate);
    expect(renameScopedGate).toBeLessThan(renameAdmission);
    expect(rename).toContain('sendProjectRenameNotAdmitted(res, 409, attemptId, error.code, error.message)');
    expect(rename).not.toContain('rejectDestructiveProjectChatResetRouteForRelease');

    const deletion = routeBlock("router.delete('/:name'");
    const deleteCurrentGate = deletion.indexOf('requireCurrentProjectDestructiveIdentity(');
    const deleteScopedGate = deletion.indexOf(
      'assertLegacyOpenClawProjectMigrationInactive(requestedIdentity.id)',
    );
    const deleteAdmission = deletion.indexOf('beginProjectIdentityDeletion({');
    expect(deleteCurrentGate).toBeGreaterThan(-1);
    expect(deleteScopedGate).toBeGreaterThan(deleteCurrentGate);
    expect(deleteScopedGate).toBeLessThan(deleteAdmission);
    expect(deletion).toContain('if (error instanceof ProjectMoveRequiredError)');
    expect(deletion).not.toContain('rejectDestructiveProjectChatResetRouteForRelease');
  });

  test('same-named private sandboxes never become legacy cleanup targets for another workspace owner', () => {
    const actors = functionBlock('async function listProjectLifecycleActorIds');
    const legacyCleanup = functionBlock('async function retireLegacyOpenClawRuntimesForProject');
    const rename = routeBlock("router.patch('/:name/rename'");

    // Actor discovery is UUID-only. A coincidentally same mutable name is not
    // evidence that another actor ever participated in this Project.
    expect(actors).toContain('projectId: input.projectIdentityId');
    expect(actors).not.toContain('legacyProjectName');
    expect(actors).not.toContain('projectName');

    // Only the historical workspace owner is allowed to contribute 3.x
    // name-keyed rows or Gateway sessions. Every other discovered actor is
    // cleaned strictly by the immutable Project UUID.
    expect(legacyCleanup).toContain('actorUserId === input.legacyProjectOwnerId');
    expect(legacyCleanup).toContain('? [input.projectIdentityId, input.legacyProjectName]');
    expect(legacyCleanup).toContain(': [input.projectIdentityId]');
    expect(rename).toContain('if (actorUserId === ownerId)');
    const deletionCompletionStart = routes.indexOf('async function completeAdmittedProjectDeletion');
    const deletionCompletion = routes.slice(
      deletionCompletionStart,
      routes.indexOf("router.delete('/:name'", deletionCompletionStart),
    );
    expect(deletionCompletion).toContain('if (actorId === ownerId)');
    expect(rename).toContain('{ userId: ownerId, projectId: req.params.name }');
    expect(deletionCompletion).toContain('{ userId: ownerId, projectId: projectName }');
  });
});
