import {
  PROJECT_CHAT_HANDOFF_MESSAGE_LIMIT,
  ProjectChatHandoffCursorError,
  readProjectChatProviderHandoffSuffix,
  type ProjectChatHandoffDatabase,
  type ProjectChatHandoffMessage,
} from './projectChatHandoff';

type StoredMessage = ProjectChatHandoffMessage & {
  id: string;
  timestamp: Date;
};

function message(id: string, provider: string, content: string): StoredMessage {
  return {
    id,
    timestamp: new Date(`2026-07-21T12:00:${id.padStart(2, '0')}.000Z`),
    role: Number(id) % 2 === 0 ? 'assistant' : 'user',
    provider,
    content,
  };
}

function database(source: () => StoredMessage[]) {
  const count = jest.fn(async () => source().length);
  const findMany = jest.fn(async (args: any) => source()
    .slice()
    .sort((left, right) => left.timestamp.getTime() - right.timestamp.getTime()
      || left.id.localeCompare(right.id))
    .slice(args.skip, args.skip + args.take)
    .map(({ role, content, provider }) => ({ role, content, provider })));
  const $transaction = jest.fn(async (operation: (transaction: any) => Promise<unknown>) => operation({
    projectChatMessage: { count, findMany },
  }));
  return {
    database: { $transaction } as unknown as ProjectChatHandoffDatabase,
    count,
    findMany,
    $transaction,
  };
}

test('A to B to A and repeated swaps inject only the exact unseen provider suffix', async () => {
  let transcript = [
    message('1', 'CODEX', 'A first request'),
    message('2', 'CODEX', 'A first answer'),
    message('3', 'OPENCLAW', 'B first request'),
    message('4', 'OPENCLAW', 'B first answer'),
  ];
  const harness = database(() => transcript);

  const firstReturnToA = await readProjectChatProviderHandoffSuffix({
    actorUserId: 'actor-1',
    projectIdentityId: 'project-1',
    handoffCursor: 2,
  }, harness.database);
  expect(firstReturnToA.transcriptCursor).toBe(4);
  expect(firstReturnToA.messages.map((entry) => entry.content)).toEqual([
    'B first request',
    'B first answer',
  ]);
  expect(firstReturnToA.messages.map((entry) => entry.content)).not.toContain('A first answer');

  transcript = transcript.concat([
    message('5', 'CODEX', 'A second request'),
    message('6', 'CODEX', 'A second answer'),
  ]);
  const firstReturnToB = await readProjectChatProviderHandoffSuffix({
    actorUserId: 'actor-1',
    projectIdentityId: 'project-1',
    handoffCursor: 4,
  }, harness.database);
  expect(firstReturnToB.messages.map((entry) => entry.content)).toEqual([
    'A second request',
    'A second answer',
  ]);

  transcript = transcript.concat([
    message('7', 'OPENCLAW', 'B second request'),
    message('8', 'OPENCLAW', 'B second answer'),
  ]);
  const secondReturnToA = await readProjectChatProviderHandoffSuffix({
    actorUserId: 'actor-1',
    projectIdentityId: 'project-1',
    handoffCursor: 6,
  }, harness.database);
  expect(secondReturnToA.messages.map((entry) => entry.content)).toEqual([
    'B second request',
    'B second answer',
  ]);
  expect(secondReturnToA.messages.map((entry) => entry.content)).not.toEqual(expect.arrayContaining([
    'A first request',
    'A first answer',
    'B first request',
    'B first answer',
  ]));
});

test('caps a large unseen suffix to the newest 24 canonical transcript positions', async () => {
  const transcript = Array.from({ length: 40 }, (_, index) => message(
    String(index + 1),
    index % 4 < 2 ? 'CODEX' : 'OPENCLAW',
    `message-${index + 1}`,
  ));
  const harness = database(() => transcript);

  const result = await readProjectChatProviderHandoffSuffix({
    actorUserId: 'actor-1',
    projectIdentityId: 'project-1',
    handoffCursor: 2,
  }, harness.database);

  expect(result.messages).toHaveLength(PROJECT_CHAT_HANDOFF_MESSAGE_LIMIT);
  expect(result.messages[0]?.content).toBe('message-17');
  expect(result.messages.at(-1)?.content).toBe('message-40');
  expect(harness.findMany).toHaveBeenCalledWith(expect.objectContaining({
    orderBy: [{ timestamp: 'asc' }, { sourceSortKey: 'asc' }, { id: 'asc' }],
    skip: 16,
    take: 24,
  }));
});

test('fails closed when a provider cursor is ahead of the authoritative transcript', async () => {
  const transcript = [message('1', 'CODEX', 'only message')];
  const harness = database(() => transcript);

  await expect(readProjectChatProviderHandoffSuffix({
    actorUserId: 'actor-1',
    projectIdentityId: 'project-1',
    handoffCursor: 2,
  }, harness.database)).rejects.toThrow(ProjectChatHandoffCursorError);
  expect(harness.findMany).not.toHaveBeenCalled();
});

test('uses one Serializable transaction for count and canonical suffix selection', async () => {
  const transcript = [
    message('1', 'CODEX', 'seen'),
    message('2', 'OPENCLAW', 'unseen'),
  ];
  const harness = database(() => transcript);

  await readProjectChatProviderHandoffSuffix({
    actorUserId: 'actor-1',
    projectIdentityId: 'project-1',
    handoffCursor: 1,
  }, harness.database);

  expect(harness.$transaction).toHaveBeenCalledWith(
    expect.any(Function),
    { isolationLevel: 'Serializable' },
  );
  expect(harness.count).toHaveBeenCalledWith({
    where: { userId: 'actor-1', projectId: 'project-1' },
  });
});
