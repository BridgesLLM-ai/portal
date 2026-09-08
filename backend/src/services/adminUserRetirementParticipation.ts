export const ADMIN_USER_RETIREMENT_PARTICIPANT_ACTIVE_CODE =
  'ADMIN_USER_RETIREMENT_PARTICIPANT_ACTIVE';

function participantIds(userIds: readonly string[]): string[] {
  return [...new Set(
    userIds.map((userId) => String(userId || '').trim()).filter(Boolean),
  )].sort();
}

const retirementParticipantSelection = {
  id: true,
  targetUserId: true,
  requestedByUserId: true,
  status: true,
} as const;

/**
 * Target-owned residue writers care only about the identity being retired.
 * They must not freeze unrelated state owned by the requesting Owner.
 */
export async function findUnfinishedAdminUserRetirementTarget(
  database: any,
  userIds: readonly string[],
): Promise<{
  id: string;
  targetUserId: string;
  requestedByUserId: string;
  status: string;
} | null> {
  const targetUserIds = participantIds(userIds);
  if (targetUserIds.length === 0) return null;

  return database.adminUserRetirement.findFirst({
    where: {
      targetUserId: { in: targetUserIds },
      status: { not: 'COMPLETE' },
    },
    orderBy: { createdAt: 'asc' },
    select: retirementParticipantSelection,
  });
}

/**
 * Return an unfinished durable retirement involving one of the supplied user
 * identities as either its target or requesting Owner. Callers perform this
 * read inside the same serializable transaction as an authority mutation: a
 * requester demotion could otherwise strand crash recovery after the
 * USER_RETIREMENT transition releases its in-memory fence.
 */
export async function findUnfinishedAdminUserRetirementParticipant(
  database: any,
  userIds: readonly string[],
): Promise<{
  id: string;
  targetUserId: string;
  requestedByUserId: string;
  status: string;
} | null> {
  const authorityUserIds = participantIds(userIds);
  if (authorityUserIds.length === 0) return null;

  return database.adminUserRetirement.findFirst({
    where: {
      status: { not: 'COMPLETE' },
      OR: [
        { targetUserId: { in: authorityUserIds } },
        { requestedByUserId: { in: authorityUserIds } },
      ],
    },
    orderBy: { createdAt: 'asc' },
    select: retirementParticipantSelection,
  });
}
