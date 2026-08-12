const mockPrisma = {
  projectChatTurn: { count: jest.fn() },
  projectChatState: { count: jest.fn() },
};

jest.mock('../config/database', () => ({ prisma: mockPrisma }));

import { ProjectChatTurnStatus } from '@prisma/client';
import { attestProjectChatsQuiescentForProjectDependencyPromotion } from './projectChatDependencyPromotionQuiescence';

beforeEach(() => {
  jest.clearAllMocks();
  mockPrisma.projectChatTurn.count.mockResolvedValue(0);
  mockPrisma.projectChatState.count.mockResolvedValue(0);
});

test('proves both provider-neutral durable Project Chat residual sets empty', async () => {
  await expect(attestProjectChatsQuiescentForProjectDependencyPromotion()).resolves.toEqual({
    activeTurnCount: 0,
    activeStateCount: 0,
  });
  expect(mockPrisma.projectChatTurn.count).toHaveBeenCalledWith({
    where: {
      status: {
        in: [ProjectChatTurnStatus.RUNNING, ProjectChatTurnStatus.ABORTING],
      },
    },
  });
  expect(mockPrisma.projectChatState.count).toHaveBeenCalledWith({
    where: { activeTurnId: { not: null } },
  });
});

test('refuses an orphan persisted active turn not represented by the broker or active state', async () => {
  mockPrisma.projectChatTurn.count.mockResolvedValue(1);

  await expect(attestProjectChatsQuiescentForProjectDependencyPromotion()).rejects.toThrow(
    'turns=1, states=0',
  );
});

test('refuses a stale activeTurnId even when no active turn row remains', async () => {
  mockPrisma.projectChatState.count.mockResolvedValue(1);

  await expect(attestProjectChatsQuiescentForProjectDependencyPromotion()).rejects.toThrow(
    'turns=0, states=1',
  );
});
