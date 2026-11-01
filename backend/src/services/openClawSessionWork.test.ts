import {
  projectSessionWorkRow,
  readSessionWork,
  resolveSessionOwnershipRoot,
  sessionIsSpawnedChild,
  sessionParentKey,
  sessionSpawnParentKey,
  type WorkRpc,
} from './openClawSessionWork';

// OpenClaw 10.6 stores a chat the Portal creates like this (TEST receipt
// native/sessions-after-restore.json): a direct chat that records where it was
// created from, not a spawned child.
const directChat = {
  key: 'agent:main:portal-user-chat',
  kind: 'direct',
  chatType: 'direct',
  parentSessionKey: 'agent:main:main',
  spawnedBy: null,
  spawnDepth: 0,
  label: 'Planning',
  updatedAt: 3,
};
const spawnedChild = {
  key: 'agent:main:subagent:7f3c',
  kind: 'direct',
  parentSessionKey: 'agent:main:portal-user-chat',
  spawnedBy: 'agent:main:portal-user-chat',
  spawnDepth: 1,
  subagentRole: 'worker',
  label: 'Research worker',
  updatedAt: 2,
};
// 9.9 child rows carry only spawnedBy.
const legacySpawnedChild = { key: 'agent:main:subagent:legacy', spawnedBy: 'agent:main:main', updatedAt: 1 };

describe('OpenClaw session work classification', () => {
  test('a direct operator chat with parentSessionKey is not a sub-agent and keeps its controls', () => {
    expect(sessionIsSpawnedChild(directChat)).toBe(false);
    expect(sessionSpawnParentKey(directChat)).toBeNull();
    expect(projectSessionWorkRow(directChat)).toMatchObject({ kind: 'session', parentKey: null, key: directChat.key });
  });

  test('a spawned child is a sub-agent of the session that spawned it', () => {
    expect(sessionIsSpawnedChild(spawnedChild)).toBe(true);
    expect(projectSessionWorkRow(spawnedChild)).toMatchObject({ kind: 'subagent', parentKey: 'agent:main:portal-user-chat', subagentRole: 'worker' });
    expect(projectSessionWorkRow(legacySpawnedChild)).toMatchObject({ kind: 'subagent', parentKey: 'agent:main:main' });
  });

  test.each([
    [{ key: 'agent:main:x', spawnDepth: 2, parentSessionKey: 'agent:main:p' }, 'agent:main:p'],
    [{ key: 'agent:main:x', kind: 'subagent', parentSessionKey: 'agent:main:p' }, 'agent:main:p'],
    [{ key: 'agent:main:x', createdVia: 'agent', parentSessionKey: 'agent:main:p' }, 'agent:main:p'],
    [{ key: 'agent:main:subagent:x' }, null],
  ])('recognizes the other spawn markers: %j', (row, parent) => {
    expect(sessionIsSpawnedChild(row)).toBe(true);
    expect(sessionSpawnParentKey(row)).toBe(parent);
  });

  test('ownership lineage still follows parentSessionKey for both shapes', async () => {
    // Ownership inheritance is unchanged here; whether a direct chat created
    // outside the Portal may inherit from agent:main:main is a security ruling.
    expect(sessionParentKey(directChat)).toBe('agent:main:main');
    const rows: Record<string, any> = { [directChat.key]: directChat, [spawnedChild.key]: spawnedChild };
    const owned = new Set(['agent:main:main']);
    await expect(resolveSessionOwnershipRoot(spawnedChild.key, {
      hasOwner: async (key) => owned.has(key),
      describe: async (key) => rows[key] ?? null,
    })).resolves.toEqual({ root: 'agent:main:main', inherited: true });
  });

  test('a root lists only its spawned children, never direct chats created from it', async () => {
    const rows = [directChat, spawnedChild, legacySpawnedChild];
    const rpc = (async (method: string, params: Record<string, any>) => {
      if (method === 'sessions.describe') return { ok: true, data: { session: rows.find((row) => row.key === params.key) ?? { key: params.key } } };
      if (method === 'sessions.list') return { ok: true, data: { sessions: rows } };
      return { ok: false, error: `unexpected ${method}` };
    }) as unknown as WorkRpc;
    const authorize = jest.fn(async () => undefined);

    const main = await readSessionWork('agent:main:main', authorize, rpc);
    expect(main?.children.map((child: any) => child.key)).toEqual([legacySpawnedChild.key]);

    const direct = await readSessionWork(directChat.key, authorize, rpc);
    expect(direct?.session).toMatchObject({ kind: 'session', parentKey: null });
    expect(direct?.children.map((child: any) => child.key)).toEqual([spawnedChild.key]);
  });
});
