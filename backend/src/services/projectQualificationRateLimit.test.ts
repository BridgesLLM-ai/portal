import {
  PROJECT_QUALIFICATION_WINDOW_MS,
  projectQualificationRateLimitKey,
  projectQualificationRetryAt,
} from './projectQualificationRateLimit';

describe('Project qualification rate-limit contract', () => {
  const identity = Object.freeze({
    actorUserId: 'actor-1',
    workspaceOwnerId: 'workspace-1',
    projectIdentityId: 'project-immutable-1',
  });

  test('keys actor, workspace, immutable Project identity, and provider without a mutable name', () => {
    const first = projectQualificationRateLimitKey({
      provider: 'OPENCLAW',
      identity,
    });
    const afterRename = projectQualificationRateLimitKey({
      provider: 'OPENCLAW',
      identity,
    });

    expect(first).toMatch(/^[a-f0-9]{64}$/);
    expect(afterRename).toBe(first);
    expect(projectQualificationRateLimitKey({
      provider: 'CODEX',
      identity,
    })).not.toBe(first);
    expect(projectQualificationRateLimitKey({
      provider: 'OPENCLAW',
      identity: { ...identity, actorUserId: 'actor-2' },
    })).not.toBe(first);
    expect(projectQualificationRateLimitKey({
      provider: 'OPENCLAW',
      identity: { ...identity, workspaceOwnerId: 'workspace-2' },
    })).not.toBe(first);
    expect(projectQualificationRateLimitKey({
      provider: 'OPENCLAW',
      identity: { ...identity, projectIdentityId: 'project-immutable-2' },
    })).not.toBe(first);
  });

  test.each([
    ['', 'workspace-1', 'project-1'],
    ['actor-1', '', 'project-1'],
    ['actor-1', 'workspace-1', ''],
    ['actor\0other', 'workspace-1', 'project-1'],
  ])('rejects malformed identity input before hashing', (
    actorUserId,
    workspaceOwnerId,
    projectIdentityId,
  ) => {
    expect(() => projectQualificationRateLimitKey({
      provider: 'OPENCLAW',
      identity: { actorUserId, workspaceOwnerId, projectIdentityId },
    })).toThrow(/Project qualification/);
  });

  test('uses a valid express-rate-limit reset time inside the bounded window', () => {
    const now = Date.parse('2026-07-27T22:00:00.000Z');
    const reset = new Date(now + 5 * 60_000);
    expect(projectQualificationRetryAt(reset, now)).toBe(reset.toISOString());
  });

  test.each([
    undefined,
    null,
    '2026-07-27T22:05:00.000Z',
    new Date('invalid'),
    new Date(Date.parse('2026-07-27T21:59:59.999Z')),
    new Date(Date.parse('2026-07-27T22:15:01.001Z')),
  ])('falls back to one exact 15-minute window for an invalid reset time', (resetTime) => {
    const now = Date.parse('2026-07-27T22:00:00.000Z');
    expect(projectQualificationRetryAt(resetTime, now)).toBe(
      new Date(now + PROJECT_QUALIFICATION_WINDOW_MS).toISOString(),
    );
  });

  test('accepts the documented reset-time skew boundary but nothing beyond it', () => {
    const now = Date.parse('2026-07-27T22:00:00.000Z');
    const boundary = new Date(now + PROJECT_QUALIFICATION_WINDOW_MS + 1_000);
    expect(projectQualificationRetryAt(boundary, now)).toBe(boundary.toISOString());
    expect(projectQualificationRetryAt(new Date(boundary.getTime() + 1), now)).toBe(
      new Date(now + PROJECT_QUALIFICATION_WINDOW_MS).toISOString(),
    );
  });
});
