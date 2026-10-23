import { randomUUID } from 'crypto';
import { Prisma, type PrismaClient } from '@prisma/client';

const describePostgres = process.env.RUN_BACKEND_CURRENT_POSTGRES === '1' ? describe : describe.skip;
describePostgres('current generated client over PostgreSQL', () => {
  let client: PrismaClient;
  const prefix = `current-fixture:${randomUUID()}:`;
  beforeAll(async () => { client = (await import('./database')).prisma; });
  afterAll(async () => {
    if (client) {
      await client.systemSetting.deleteMany({ where: { key: { startsWith: prefix } } });
      await client.$disconnect();
    }
  });
  test('commits parameterized reads/writes and maps timestamps without interpreting SQL data', async () => {
    const key = prefix + 'commit'; const value = "'; DROP TABLE \"SystemSetting\"; --";
    const row = await client.$transaction(async tx => {
      await tx.systemSetting.create({ data: { key, value } });
      return tx.systemSetting.findUniqueOrThrow({ where: { key } });
    }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
    expect(row.value).toBe(value); expect(row.updatedAt).toBeInstanceOf(Date);
    expect(await client.systemSetting.count({ where: { key } })).toBe(1);
  });
  test('interactive transaction rollback leaves no partial writes', async () => {
    const key = prefix + 'rollback';
    await expect(client.$transaction(async tx => {
      await tx.systemSetting.create({ data: { key, value: 'uncommitted' } });
      throw new Error('fixture rollback');
    })).rejects.toThrow('fixture rollback');
    expect(await client.systemSetting.findUnique({ where: { key } })).toBeNull();
  });
  test('array transaction is atomic and the real unique error keeps the public P2002 contract', async () => {
    const key = prefix + 'duplicate';
    let failure: unknown;
    try {
      await client.$transaction([
        client.systemSetting.create({ data: { key, value: 'first' } }),
        client.systemSetting.create({ data: { key, value: 'duplicate' } }),
      ]);
    } catch (error) { failure = error; }
    expect(failure).toBeInstanceOf(Prisma.PrismaClientKnownRequestError);
    expect(failure).toMatchObject({ code: 'P2002' });
    expect(await client.systemSetting.findUnique({ where: { key } })).toBeNull();
  });
});
