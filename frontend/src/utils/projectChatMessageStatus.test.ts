import { describe, expect, it, vi } from 'vitest';
import type { ProjectChatMessageStatusResponse } from '../api/endpoints';
import { resolveProjectChatPendingMessageStatus } from './projectChatMessageStatus';
import type { PendingProjectChatSend, ProjectChatSendScope } from './projectChatPendingSend';

const scope: ProjectChatSendScope = {
  actorUserId: 'user-1',
  projectId: 'project-immutable-1',
  provider: 'OPENCLAW',
};

const pending: PendingProjectChatSend = {
  schema: 2,
  actorUserId: scope.actorUserId,
  projectId: scope.projectId,
  provider: scope.provider,
  messageId: 'project-chat-aaaaaaaaaaaa4aaa8aaaaaaaaaaaaaaa',
  draftFingerprint: 'a'.repeat(64),
  payloadFingerprint: 'b'.repeat(64),
  model: 'openai/gpt-5.5',
  attemptStartedAt: 1_000,
  createdAt: new Date(1_000).toISOString(),
};

function response(overrides: Partial<ProjectChatMessageStatusResponse>): ProjectChatMessageStatusResponse {
  return {
    found: false,
    status: 'absent',
    provider: scope.provider,
    messageId: pending.messageId,
    projectId: scope.projectId,
    stateVersion: 1,
    ...overrides,
  };
}

describe('Project Chat message-status reconciliation', () => {
  it('confirms only an authenticated accepted dispatch', async () => {
    await expect(resolveProjectChatPendingMessageStatus({
      scope,
      pending,
      probe: async () => response({
        found: true,
        status: 'terminal',
        dispatchStatus: 'accepted',
        turnStatus: 'completed',
        turnId: 'turn-1',
        recoveryRequired: false,
      }),
    })).resolves.toBe('confirmed');
  });

  it('preserves admitted but unconfirmed or unknown turns as ambiguous', async () => {
    await expect(resolveProjectChatPendingMessageStatus({
      scope,
      pending,
      probe: async () => response({
        found: true,
        status: 'active',
        dispatchStatus: 'unknown',
        recoveryRequired: true,
        turnStatus: 'running',
        turnId: 'turn-unknown',
      }),
    })).resolves.toBe('ambiguous');
  });

  it('does not trust an immediate absent result and catches a delayed commit during the quiet window', async () => {
    const sleep = vi.fn(async () => {});
    const probe = vi.fn()
      .mockResolvedValueOnce(response({}))
      .mockResolvedValueOnce(response({}))
      .mockResolvedValueOnce(response({
        found: true,
        status: 'admitted',
        dispatchStatus: 'accepted',
        turnStatus: 'running',
        recoveryRequired: false,
        turnId: 'turn-delayed',
      }));

    await expect(resolveProjectChatPendingMessageStatus({
      scope,
      pending,
      probe,
      now: () => 2_000,
      sleep,
      minimumAgeMs: 10_000,
      recheckDelaysMs: [500, 1_500],
    })).resolves.toBe('confirmed');
    expect(sleep).toHaveBeenNthCalledWith(1, 9_000);
    expect(sleep).toHaveBeenNthCalledWith(2, 500);
    expect(sleep).toHaveBeenNthCalledWith(3, 1_500);
    expect(probe).toHaveBeenCalledTimes(3);
  });

  it('returns never-admitted only after every bounded quiet-window observation is absent', async () => {
    const probe = vi.fn(async () => response({}));
    await expect(resolveProjectChatPendingMessageStatus({
      scope,
      pending,
      probe,
      now: () => 20_000,
      sleep: async () => {},
      recheckDelaysMs: [0, 0],
    })).resolves.toBe('never-admitted');
    expect(probe).toHaveBeenCalledTimes(3);
  });

  it('fails closed when the status endpoint returns a different project identity', async () => {
    await expect(resolveProjectChatPendingMessageStatus({
      scope,
      pending,
      probe: async () => response({ projectId: 'other-project' }),
    })).rejects.toThrow(/mismatched identity/i);
  });
});
