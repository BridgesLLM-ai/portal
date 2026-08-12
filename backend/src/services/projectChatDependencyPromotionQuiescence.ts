import { ProjectChatTurnStatus } from '@prisma/client';
import { prisma } from '../config/database';

export interface ProjectChatDependencyPromotionQuiescence {
  activeTurnCount: number;
  activeStateCount: number;
}

/**
 * Provider-neutral durable residual check for the dependency-promotion writer
 * fence. In-memory broker settlement must run first; this check then refuses
 * promotion while any durable turn or coordination pointer could still publish
 * Project Chat state or represent an untracked provider writer.
 *
 * The global workspace admission fence is already closed when this runs. A
 * pre-drain check may therefore observe an older admitted request in flight;
 * the caller repeats the same check after the global mutation drain.
 */
export async function attestProjectChatsQuiescentForProjectDependencyPromotion(
): Promise<ProjectChatDependencyPromotionQuiescence> {
  const [activeTurnCount, activeStateCount] = await Promise.all([
    prisma.projectChatTurn.count({
      where: {
        status: {
          in: [ProjectChatTurnStatus.RUNNING, ProjectChatTurnStatus.ABORTING],
        },
      },
    }),
    prisma.projectChatState.count({
      where: { activeTurnId: { not: null } },
    }),
  ]);
  if (activeTurnCount !== 0 || activeStateCount !== 0) {
    throw new Error(
      `Durable Project Chat state remained active before dependency promotion `
      + `(turns=${activeTurnCount}, states=${activeStateCount})`,
    );
  }
  return Object.freeze({ activeTurnCount, activeStateCount });
}
