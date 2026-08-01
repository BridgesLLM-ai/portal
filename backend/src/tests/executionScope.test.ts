import fs from 'fs';
import os from 'os';
import path from 'path';
import {
  assertExecutionContextBinding,
  assertProviderSupportsExecutionScope,
  createHostOperatorExecutionContext,
  createProjectSandboxExecutionContext,
} from '../agents/executionScope';

describe('server-assigned agent execution contexts', () => {
  test('host operator context is immutable and bound to its principal', () => {
    const context = createHostOperatorExecutionContext('owner-1');
    expect(context).toEqual({ scope: 'HOST_OPERATOR', source: 'PORTAL_SERVER', userId: 'owner-1' });
    expect(Object.isFrozen(context)).toBe(true);
    expect(() => assertExecutionContextBinding(context, 'different-user')).toThrow(/does not match its owner/);
  });

  test('project context is canonicalized and fails closed on incomplete or unsupported scope', () => {
    const context = createProjectSandboxExecutionContext({
      userId: 'user-1',
      projectId: 'project-1',
      workspaceOwnerId: 'user-1',
      projectName: 'project-1',
      canonicalRoot: '/srv/projects/project-1/../project-1',
      rootDevice: '8',
      rootInode: '101',
      rootBirthtimeNs: '1000000000',
      runtimePolicyVersion: 'project-runtime-v1',
      egressPolicyVersion: 'project-egress-v1',
      runtimeImageDigest: 'sha256:test-runtime',
      policyFingerprint: 'policy-sha256',
    });
    expect(context.canonicalRoot).toBe('/srv/projects/project-1');
    expect(() => assertProviderSupportsExecutionScope('CODEX', ['HOST_OPERATOR'], context)).toThrow(/does not support PROJECT_SANDBOX/);
    expect(() => assertExecutionContextBinding({
      ...context,
      canonicalRoot: 'relative/path',
    }, 'user-1')).toThrow(/incomplete/);
  });

  test('native session scope can be bound once but cannot be reassigned', () => {
    const sessionsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'portal-native-scope-'));
    const previous = process.env.PORTAL_NATIVE_AGENT_SESSIONS_DIR;
    process.env.PORTAL_NATIVE_AGENT_SESSIONS_DIR = sessionsDir;
    jest.resetModules();

    try {
      const store = require('../agents/providers/NativeSessionStore') as typeof import('../agents/providers/NativeSessionStore');
      const hostContext = createHostOperatorExecutionContext('owner-1');
      const created = store.createNativeSession('CODEX', 'owner-1', {
        executionContext: hostContext,
        metadata: { requestedBy: 'owner@example.com' },
      });

      store.updateNativeSessionMetadata('CODEX', created.sessionId, {
        executionContext: createProjectSandboxExecutionContext({
          userId: 'owner-1',
          projectId: 'spoofed',
          workspaceOwnerId: 'owner-1',
          projectName: 'spoofed',
          canonicalRoot: '/tmp/spoofed',
          rootDevice: '8',
          rootInode: '102',
          rootBirthtimeNs: '1000000001',
          runtimePolicyVersion: 'project-runtime-v1',
          egressPolicyVersion: 'project-egress-v1',
          runtimeImageDigest: 'sha256:test-runtime',
          policyFingerprint: 'spoofed',
        }),
      });
      expect(store.loadNativeSession('CODEX', created.sessionId)?.executionContext).toEqual(hostContext);

      expect(() => store.ensureNativeSessionExecutionContext(
        'CODEX',
        created.sessionId,
        createProjectSandboxExecutionContext({
          userId: 'owner-1',
          projectId: 'project-1',
          workspaceOwnerId: 'owner-1',
          projectName: 'project-1',
          canonicalRoot: '/srv/project-1',
          rootDevice: '8',
          rootInode: '103',
          rootBirthtimeNs: '1000000002',
          runtimePolicyVersion: 'project-runtime-v1',
          egressPolicyVersion: 'project-egress-v1',
          runtimeImageDigest: 'sha256:test-runtime',
          policyFingerprint: 'policy-1',
        }),
      )).toThrow(/immutable/);
    } finally {
      if (previous === undefined) delete process.env.PORTAL_NATIVE_AGENT_SESSIONS_DIR;
      else process.env.PORTAL_NATIVE_AGENT_SESSIONS_DIR = previous;
      fs.rmSync(sessionsDir, { recursive: true, force: true });
    }
  });

  test('native Project session discovery is UUID/root-bound and rejects identity drift', () => {
    const sessionsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'portal-native-project-scan-'));
    const previous = process.env.PORTAL_NATIVE_AGENT_SESSIONS_DIR;
    process.env.PORTAL_NATIVE_AGENT_SESSIONS_DIR = sessionsDir;
    jest.resetModules();

    try {
      const store = require('../agents/providers/NativeSessionStore') as typeof import('../agents/providers/NativeSessionStore');
      const context = createProjectSandboxExecutionContext({
        userId: 'actor-1',
        projectId: 'immutable-project-uuid',
        workspaceOwnerId: 'owner-1',
        projectName: 'demo',
        canonicalRoot: '/srv/projects/demo',
        rootDevice: '8',
        rootInode: '404',
        rootBirthtimeNs: '1000000042',
        runtimePolicyVersion: 'project-runtime-v1',
        egressPolicyVersion: 'project-egress-v1',
        runtimeImageDigest: `sha256:${'a'.repeat(64)}`,
        policyFingerprint: 'policy-1',
      });
      const created = store.createNativeSession('CODEX', 'actor-1', { executionContext: context });
      store.createNativeSession('CODEX', 'actor-1', { executionContext: createHostOperatorExecutionContext('actor-1') });

      expect(store.listNativeProjectSessions('CODEX', {
        projectIdentityId: context.projectId,
        canonicalRoot: context.canonicalRoot,
        rootDevice: context.rootDevice,
        rootInode: context.rootInode,
        rootBirthtimeNs: context.rootBirthtimeNs,
      }).map((session) => session.sessionId)).toEqual([created.sessionId]);

      expect(() => store.listNativeProjectSessions('CODEX', {
        projectIdentityId: context.projectId,
        canonicalRoot: context.canonicalRoot,
        rootDevice: context.rootDevice,
        rootInode: 'different',
        rootBirthtimeNs: context.rootBirthtimeNs,
      })).toThrow(/root identity drifted/);
    } finally {
      if (previous === undefined) delete process.env.PORTAL_NATIVE_AGENT_SESSIONS_DIR;
      else process.env.PORTAL_NATIVE_AGENT_SESSIONS_DIR = previous;
      fs.rmSync(sessionsDir, { recursive: true, force: true });
    }
  });
});
