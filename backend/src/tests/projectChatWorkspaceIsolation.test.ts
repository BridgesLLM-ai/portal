import fs from 'fs';
import path from 'path';

const projectsRoute = fs.readFileSync(
  path.resolve(__dirname, '../routes/projects.ts'),
  'utf8',
);
const frontendEndpoints = fs.readFileSync(
  path.resolve(__dirname, '../../../frontend/src/api/endpoints.ts'),
  'utf8',
);

function routeBlock(signature: string): string {
  const start = projectsRoute.indexOf(signature);
  expect(start).toBeGreaterThanOrEqual(0);
  const next = projectsRoute.indexOf('\nrouter.', start + signature.length);
  return projectsRoute.slice(start, next === -1 ? projectsRoute.length : next);
}

describe('Project Chat authenticated-actor workspace isolation', () => {
  it('keeps the sandbox principal separate from shared SUB_ADMIN workspace mapping', () => {
    const start = projectsRoute.indexOf('function resolveActorProjectChatWorkspace');
    const end = projectsRoute.indexOf('\nfunction sendProjectFileMutationError', start);
    const helper = projectsRoute.slice(start, end);

    expect(helper).toContain('const actorUserId = req.user?.userId');
    expect(helper).toContain('workspaceOwnerId: actorUserId');
    expect(helper).toContain('getProjectPath(actorUserId, projectName)');
    expect(helper).not.toContain('getScopedOwnerId');
  });

  it.each([
    "router.get('/:name/chat/providers'",
    "router.post('/:name/chat/provider'",
    "router.get('/:name/chat/history'",
    "router.delete('/:name/chat/history'",
    "router.get('/:name/chat/session-status'",
    "router.post('/:name/assistant/ensure-session'",
    "router.get('/:name/assistant/active-model'",
    "router.get('/:name/assistant/memory'",
    "router.post('/:name/assistant/reset'",
    "router.post('/:name/assistant/message-status'",
    "router.get('/:name/assistant/poll'",
    "router.post('/:name/assistant/abort'",
    "router.post('/:name/assistant/send'",
    "router.post('/:name/assistant/read-file'",
  ])('%s resolves only the authenticated actor workspace', (signature) => {
    const block = routeBlock(signature);
    expect(block).toContain('resolveActorProjectChatWorkspace');
    expect(block).not.toContain('getScopedOwnerId');
  });

  it.each([
    "router.post('/:name/chat/message'",
    "router.post('/:name/chat/messages'",
  ])('%s is an authenticated fixed tombstone with no mutation path', (signature) => {
    const routeAndFollowingHelpers = routeBlock(signature);
    const routeEnd = routeAndFollowingHelpers.indexOf('\n});');
    const block = routeAndFollowingHelpers.slice(0, routeEnd + 4);
    expect(block).toContain('authenticateToken');
    expect(block).toContain('requireApproved');
    expect(block).toContain('status(410)');
    expect(block).toContain('PROJECT_CHAT_DIRECT_TRANSCRIPT_WRITE_RETIRED');
    expect(block).not.toContain('resolveActorProjectChatWorkspace');
    expect(block).not.toContain('prisma.');
  });

  it('retires browser-written Project memory while preserving the read-only provider-owned view', () => {
    const block = routeBlock("router.post('/:name/assistant/memory'");
    expect(block).toContain('authenticateToken');
    expect(block).toContain('status(410)');
    expect(block).toContain('PROJECT_MEMORY_PROVIDER_OWNED');
    expect(block).not.toContain('resolveActorProjectChatWorkspace');
    expect(block).not.toContain('fs.writeFileSync');
    expect(frontendEndpoints).not.toContain('agentSaveMemory:');
    expect(frontendEndpoints).not.toContain('chatSaveMessage:');
    expect(frontendEndpoints).not.toContain('chatSaveMessages:');
  });

  it('serves Agent Zero model choices through the approved actor project without exposing OAuth account labels', () => {
    const block = routeBlock("router.get(\n  '/:name/chat/providers/agent-zero/models'");

    expect(block).toContain('authenticateToken');
    expect(block).toContain('requireApproved');
    expect(block).toContain('resolveActorProjectChatWorkspace');
    expect(block).toContain("provider.connectionState === 'connected'");
    expect(block).toContain('filterAgentZeroOAuthModelsForProjectQualification');
    expect(block).toContain('models.length > 0');
    expect(block).toContain('providerId: provider.providerId');
    expect(block).toContain('displayName: provider.displayName');
    expect(block).not.toContain('accountLabel');
    expect(block).not.toContain('requireOwner');
    expect(frontendEndpoints).toContain('/chat/providers/agent-zero/models`');
  });

  it('actor-binds materialized Project Chat attachments before scanning or copying', () => {
    const block = routeBlock("router.post(\n  '/:name/assistant/attachments'");
    expect(block).toContain('resolveActorProjectChatWorkspace');
    expect(block).not.toContain('getScopedOwnerId');
    expect(block.indexOf('resolveActorProjectChatWorkspace')).toBeLessThan(block.indexOf('scanFile('));
  });

  it('retires the client-written legacy transcript endpoints', () => {
    const readBlock = routeBlock("router.get('/:name/assistant/history'");
    const writeBlock = routeBlock("router.post('/:name/assistant/history'");

    expect(readBlock).toContain("status(410)");
    expect(writeBlock).toContain("status(410)");
    expect(writeBlock).not.toContain('fs.writeFileSync');
    expect(writeBlock).toContain('Client-written Project Chat transcripts are not accepted');
  });

  it('pages Project Chat history with an actor/project-bound stable cursor', () => {
    const block = routeBlock("router.get('/:name/chat/history'");
    expect(block).toContain('requestedLimit < 1 || requestedLimit > 100');
    expect(block).toContain('where: { id: beforeId, userId, projectId: executionContext.projectId }');
    expect(block).toContain(
      "orderBy: [{ timestamp: 'desc' }, { sourceSortKey: 'desc' }, { id: 'desc' }]",
    );
    expect(block).toContain('take: requestedLimit + 1');
    expect(block).toContain('nextCursor: hasMore ? messages[0]?.id || null : null');
    expect(frontendEndpoints).toContain("page?: { limit?: number; before?: string | null }");
  });

  it('retires the duplicate browser-owned Project checkpoint endpoint', () => {
    const block = routeBlock("router.post('/:name/assistant/auto-commit'");
    expect(block).toContain('status(410)');
    expect(block).toContain('PROJECT_CHECKPOINT_SERVER_OWNED');
    expect(block).not.toContain('autoCommitProjectChanges(');
    expect(frontendEndpoints).not.toContain('autoCommit: async');
  });

  it('uses one server-owned checkpoint boundary per provider and keeps notice failure non-terminal', () => {
    const block = routeBlock("router.post('/:name/assistant/send'");
    expect(block).not.toContain('void autoCommitProjectChanges');
    expect(block.match(/await checkpointProjectAfterProviderTurn\(/g)).toHaveLength(2);
    expect(block).not.toContain('await persistProjectCheckpointNotice');
    expect(projectsRoute.match(/createCheckpoint: \(\) => autoCommitProjectChangesWithRetry\(/g)).toHaveLength(1);
    expect(projectsRoute).toContain('runProjectCheckpointBoundary');
    expect(projectsRoute).toContain('Project checkpoint failed after one automatic retry.');
  });

  it('holds workspace authorization through both fire-and-forget provider settlements', () => {
    const block = routeBlock("router.post('/:name/assistant/send'");
    expect(block.match(/acquireWorkspaceAuthorizationMutationLease\(/g)).toHaveLength(2);
    expect(block.match(/finally \{\s+releaseWorkspaceMutation\(\);\s+\}/g)).toHaveLength(2);
    expect(block.match(/if \(!providerRunStarted\) releaseWorkspaceMutation\(\);/g)).toHaveLength(2);
  });

  it('fails the checkpoint before staging when transient shelving fails', () => {
    const start = projectsRoute.indexOf('async function autoCommitProjectChanges(');
    const end = projectsRoute.indexOf('\nasync function autoCommitProjectChangesWithRetry', start);
    const helper = projectsRoute.slice(start, end);

    expect(helper).toContain('transientShelved = await shelveTransientProjectState(git, transientPaths)');
    expect(helper).toContain('await git(projectGitAddAllArgs())');
    expect(helper).toContain('assertNoTransientProjectStateStaged(stagedFiles)');
    expect(helper).not.toContain('Failed to shelve transient project state');
    expect(helper).not.toContain("await git(['add', '-A'])");
  });

  it('never replays a runtime-admission lease as the latest user turn', () => {
    const block = routeBlock("router.get('/:name/assistant/poll'");
    expect(block).toContain('PROJECT_CHAT_RUNTIME_ADMISSION_REQUEST_PREFIX');
    expect(block).toContain('NOT: { requestId: { startsWith: PROJECT_CHAT_RUNTIME_ADMISSION_REQUEST_PREFIX } }');
  });

  it('quarantines ambiguous dispatch replay and persists acceptance only after provider start', () => {
    const block = routeBlock("router.post('/:name/assistant/send'");
    expect(block).toContain('PROJECT_CHAT_DISPATCH_UNCONFIRMED');
    expect(block).toContain('PROJECT_CHAT_DISPATCH_UNKNOWN');
    expect(block).toContain('recoveryRequired: true');
    expect(block).toContain("admissionStatus: 'unknown'");
    expect(block).toContain("admissionOutcome: 'unknown'");
    expect(block.match(/startProjectNativeRun\(/g)).toHaveLength(2);
    expect(block.match(/markProjectChatTurnProviderDispatchAccepted\(/g)).toHaveLength(2);
    expect(block.match(/waitForProjectNativeRunSettlement\(/g)).toHaveLength(2);
    const starts = Array.from(block.matchAll(/startProjectNativeRun\(/g), (match) => match.index!);
    const acceptances = Array.from(
      block.matchAll(/markProjectChatTurnProviderDispatchAccepted\(/g),
      (match) => match.index!,
    );
    expect(acceptances[0]).toBeGreaterThan(starts[0]);
    expect(acceptances[1]).toBeGreaterThan(starts[1]);
    expect(block).toContain('if (dispatchAcceptanceFailed && !dispatchQuiescedAfterAcceptanceFailure) throw error');
    expect(block).toContain('providerDispatchObserved: true');
    expect(block.indexOf('PROJECT_CHAT_DISPATCH_UNCONFIRMED')).toBeLessThan(
      block.indexOf('sent: true'),
    );
  });

  it('labels send failures as never admitted only after proving the runtime admission detached', () => {
    const block = routeBlock("router.post('/:name/assistant/send'");
    expect(block).toContain("admissionStatus: 'never_admitted'");
    expect(block).toContain("admissionOutcome: 'not_admitted'");
    expect(block).toContain('runtimeAdmissionFinalizedAfterFailure = true');
    expect(block).toContain('!runtimeAdmissionPromoted && runtimeAdmissionFinalizedAfterFailure');
  });

  it('reconciles stable message IDs through an authenticated POST without leaking fingerprints into URLs', () => {
    const block = routeBlock("router.post('/:name/assistant/message-status'");
    expect(block).toContain('authenticateToken');
    expect(block).toContain('resolveActorProjectChatWorkspace');
    expect(block).toContain('req.body?.messageId');
    expect(block).toContain('req.body?.messageFingerprint');
    expect(block).toContain('req.body?.provider');
    expect(block).toContain("res.setHeader('Cache-Control', 'no-store')");
    expect(block).toContain('crypto.timingSafeEqual');
    expect(block).toContain('userId: actorUserId, projectId: executionContext.projectId, messageId');
    expect(block).not.toContain('req.query.messageFingerprint');
    expect(projectsRoute).not.toContain("router.get('/:name/assistant/message-status'");
  });

  it('attests every destructive-reset session before mutation and verifies exact artifact cleanup', () => {
    const start = projectsRoute.indexOf('async function terminateProjectChatBindingsForDestructiveReset');
    const end = projectsRoute.indexOf('\nasync function performProjectChatDestructiveReset', start);
    const helper = projectsRoute.slice(start, end);
    const firstTermination = helper.indexOf('await retireLegacyOpenClawProjectRuntime');

    expect(start).toBeGreaterThanOrEqual(0);
    expect(firstTermination).toBeGreaterThanOrEqual(0);
    expect(helper.indexOf('listNativeProjectSessions(provider, nativeQuery)')).toBeLessThan(firstTermination);
    expect(helper).toContain('prisma.projectIdentity.findUnique');
    expect(helper).toContain('projectIdentity.rootBirthtimeNs !== input.executionContext.rootBirthtimeNs');
    expect(helper).toContain('projectIdentity: Object.freeze(projectIdentity)');
    expect(helper).not.toContain('createdAt: new Date(0)');
    expect(helper.indexOf('binding.runtime !== getProjectChatProviderRuntimeDescriptor(provider).runtime'))
      .toBeLessThan(firstTermination);
    expect(helper.indexOf('session.userId !== input.actorUserId')).toBeLessThan(firstTermination);
    expect(helper).toContain('deriveOpenClawProjectSessionKey(input.executionContext)');
    expect(helper).toContain('nativeSessionArtifactsPresent(provider, session.sessionId)');
    expect((helper.match(/listNativeProjectSessions\(provider, nativeQuery\)/g) || []).length)
      .toBeGreaterThanOrEqual(2);
    expect(helper).toContain('PROJECT_CHAT_ROUTE_PROVIDERS.map(async (provider)');
    expect(helper).toContain('PROJECT_RUNTIME_CLEANUP_ADAPTERS[provider].enumerate(cleanupScope)');
    expect(helper.indexOf('PROJECT_RUNTIME_CLEANUP_ADAPTERS[provider].enumerate(cleanupScope)'))
      .toBeLessThan(firstTermination);
    expect(helper).toContain('assertProjectRuntimeCleanupResourcesForReset');
    expect(helper).toContain('cleanupProjectRuntimeAdapterMatrixForDestructiveReset');
    expect(helper).toContain('snapshots: cleanupSnapshots');
    expect(helper).toContain('targetProjectIds: projectIds');
    expect(helper).toContain('adapterOwnedSessionKeys: [openClawSessionKey]');
    // Retry after external cleanup but before the Serializable reset must
    // accept only an exact binding whose native artifacts are now wholly absent.
    expect(helper).toContain('!nativeSessionArtifactsPresent(provider, sessionId)');
  });

  it('uses the full auth-independent cleanup matrix before confirming a stale turn after restart', () => {
    const convergeStart = projectsRoute.indexOf('async function convergeProjectChatTurnForDestructiveReset');
    const convergeEnd = projectsRoute.indexOf('\nasync function terminateProjectChatBindingsForDestructiveReset', convergeStart);
    const converge = projectsRoute.slice(convergeStart, convergeEnd);

    expect(convergeStart).toBeGreaterThanOrEqual(0);
    expect(converge).toContain('terminateProjectChatBindingsForDestructiveReset');
    expect(converge).toContain('exactServerOwnedOpenClawSessionKeys');
    expect(converge).not.toContain("if (provider === 'AGENT_ZERO' || provider === 'OLLAMA')");
    expect(converge.indexOf('terminateProjectChatBindingsForDestructiveReset'))
      .toBeLessThan(converge.indexOf('confirmProjectChatTurnAbort'));
  });

  it('clears transcript projection before commit but session status only after commit', () => {
    const start = projectsRoute.indexOf('async function performProjectChatDestructiveReset');
    const end = projectsRoute.indexOf("\n// DELETE /api/projects/:name/chat/history", start);
    const helper = projectsRoute.slice(start, end);
    const historyWrite = helper.indexOf("'.agent-history.json'");
    const sessionWrite = helper.indexOf("'.agent-session.json'");
    const resetCommit = helper.indexOf('commitProjectChatDestructiveReset');

    expect(historyWrite).toBeGreaterThanOrEqual(0);
    expect(resetCommit).toBeGreaterThan(historyWrite);
    expect(sessionWrite).toBeGreaterThan(resetCommit);
    expect(helper).toContain('database-derived projection');
    expect(helper).toContain('failed transaction cannot falsely advertise an uninitialized session');
    expect(helper).toContain('JSON.stringify({ messages: [], model: \'\' })');
  });

  it.each([
    "router.post('/:name/chat/provider'",
    "router.post('/:name/assistant/ensure-session'",
    "router.post('/:name/assistant/send'",
  ])('%s repairs terminal projections only inside its runtime admission', (signature) => {
    const block = routeBlock(signature);
    const acquireIndex = block.indexOf('withProjectChatRuntimeAdmission') >= 0
      ? block.indexOf('withProjectChatRuntimeAdmission')
      : block.indexOf('acquireProjectChatRuntimeAdmission');
    expect(acquireIndex).toBeGreaterThanOrEqual(0);
    expect(block.indexOf('repairTerminalProjectChatPresentations')).toBeGreaterThan(acquireIndex);
  });
});
