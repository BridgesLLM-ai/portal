import { Prisma } from '@prisma/client';
import { prisma } from '../config/database';

export const PROJECT_CHAT_HANDOFF_MESSAGE_LIMIT = 24;

export type ProjectChatHandoffMessage = {
  role: string;
  content: string;
  provider: string | null;
};

type ProjectChatHandoffTransaction = {
  projectChatMessage: {
    count(args: unknown): Promise<number>;
    findMany(args: unknown): Promise<ProjectChatHandoffMessage[]>;
  };
};

export type ProjectChatHandoffDatabase = {
  $transaction<T>(
    operation: (transaction: ProjectChatHandoffTransaction) => Promise<T>,
    options?: { isolationLevel?: Prisma.TransactionIsolationLevel },
  ): Promise<T>;
};

export class ProjectChatHandoffCursorError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ProjectChatHandoffCursorError';
  }
}

function requiredIdentifier(value: unknown, label: string): string {
  const normalized = String(value || '').trim();
  if (!normalized) throw new ProjectChatHandoffCursorError(`${label} is required`);
  return normalized;
}

function cursor(value: unknown, label: string): number {
  const normalized = Number(value);
  if (!Number.isSafeInteger(normalized) || normalized < 0) {
    throw new ProjectChatHandoffCursorError(`${label} must be a non-negative integer`);
  }
  return normalized;
}

/**
 * Reads only the transcript positions a provider binding has not consumed.
 *
 * Provider handoff cursors are counts over the canonical transcript order.
 * Settlement advances them to the authoritative message count, while legacy
 * repair locates rows using the same timestamp/id ordering below. Keeping the
 * count and suffix read in one Serializable transaction prevents a provider
 * swap from observing a cursor from one transcript and rows from another.
 */
export async function readProjectChatProviderHandoffSuffix(input: {
  actorUserId: string;
  projectIdentityId: string;
  handoffCursor: number;
  limit?: number;
}, database: ProjectChatHandoffDatabase = prisma as unknown as ProjectChatHandoffDatabase): Promise<{
  transcriptCursor: number;
  messages: ProjectChatHandoffMessage[];
}> {
  const actorUserId = requiredIdentifier(input.actorUserId, 'actor user ID');
  const projectIdentityId = requiredIdentifier(input.projectIdentityId, 'project identity ID');
  const handoffCursor = cursor(input.handoffCursor, 'handoff cursor');
  const limit = input.limit == null
    ? PROJECT_CHAT_HANDOFF_MESSAGE_LIMIT
    : cursor(input.limit, 'handoff message limit');
  if (limit === 0) {
    throw new ProjectChatHandoffCursorError('handoff message limit must be greater than zero');
  }

  return database.$transaction(async (transaction) => {
    const where = { userId: actorUserId, projectId: projectIdentityId };
    const transcriptCursor = await transaction.projectChatMessage.count({ where });
    if (handoffCursor > transcriptCursor) {
      throw new ProjectChatHandoffCursorError(
        'Provider handoff cursor is ahead of the authoritative Portal transcript',
      );
    }

    const firstUnseenPosition = handoffCursor;
    const firstRetainedPosition = Math.max(firstUnseenPosition, transcriptCursor - limit);
    const expectedMessageCount = transcriptCursor - firstRetainedPosition;
    const messages = expectedMessageCount === 0
      ? []
      : await transaction.projectChatMessage.findMany({
          where,
          orderBy: [{ timestamp: 'asc' }, { sourceSortKey: 'asc' }, { id: 'asc' }],
          skip: firstRetainedPosition,
          take: expectedMessageCount,
          select: { role: true, content: true, provider: true },
        });
    if (messages.length !== expectedMessageCount) {
      throw new ProjectChatHandoffCursorError(
        'Portal transcript changed while the provider handoff suffix was being read',
      );
    }
    return { transcriptCursor, messages };
  }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
}
