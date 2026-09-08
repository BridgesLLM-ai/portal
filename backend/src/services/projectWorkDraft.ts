import { prisma } from '../config/database';

/** A native draft acquires its real conversation ID at first host dispatch.
 * Only navigation links move; execution identity, request ID and prompt do not. */
export async function adoptProjectWorkDraft(input: {
  actorUserId: string; provider: string; draftSession: string; session: string;
}) {
  if (!input.draftSession || !input.session || input.draftSession === input.session) return;
  if (input.draftSession !== 'main' && !input.draftSession.startsWith('new-') && !input.draftSession.startsWith('agent:')) return;
  await prisma.projectWorkCard.updateMany({ where: {
    actorUserId: input.actorUserId, originProvider: input.provider, originSessionKey: input.draftSession,
  }, data: { originSessionKey: input.session } });
}
