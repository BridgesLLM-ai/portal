import crypto from 'crypto';
import { prisma } from '../config/database';
import {
  __shareConcurrentUseTest,
  claimShareConcurrentUse,
  releaseShareConcurrentUse,
  renewShareConcurrentUse,
} from '../services/shareConcurrentUse';
import {
  buildShareLinkPage,
  decodeShareLinkCursor,
  shareLinkCursorWhere,
} from '../utils/shareLinkPagination';

const describePostgres = process.env.RUN_SHARE_CONCURRENCY_POSTGRES === '1'
  ? describe
  : describe.skip;

function visitor(label: string): string {
  return crypto.createHash('sha256').update(label).digest('hex');
}

describePostgres('durable public-share concurrent-use admission (PostgreSQL)', () => {
  const suffix = `${process.pid}-${Date.now()}-${crypto.randomUUID()}`;
  const ownerId = crypto.randomUUID();
  const appId = crypto.randomUUID();
  const shareLinkId = crypto.randomUUID();
  const visitorA = visitor(`visitor-a-${suffix}`);
  const visitorB = visitor(`visitor-b-${suffix}`);
  const visitorC = visitor(`visitor-c-${suffix}`);

  beforeAll(async () => {
    await prisma.user.create({
      data: {
        id: ownerId,
        email: `share-concurrency-${suffix}@example.invalid`,
        username: `share-concurrency-${suffix}`,
        passwordHash: 'integration-test-only',
      },
    });
    await prisma.app.create({
      data: {
        id: appId,
        userId: ownerId,
        name: `share-concurrency-${suffix}`,
        zipPath: `/tmp/share-concurrency-${suffix}.zip`,
      },
    });
    await prisma.appShareLink.create({
      data: {
        id: shareLinkId,
        appId,
        userId: ownerId,
        token: crypto.randomBytes(32).toString('base64url'),
        maxConcurrentVisitors: 2,
      },
    });
  });

  afterAll(async () => {
    await prisma.user.deleteMany({ where: { id: ownerId } });
    await prisma.$disconnect();
  });

  test('serializes real contenders, treats one signed visitor as one place, releases, and expires', async () => {
    const startedAt = Date.now();
    const racers = await Promise.all([
      visitorA,
      visitorB,
      visitorC,
      visitor('visitor-d'),
      visitor('visitor-e'),
      visitor('visitor-f'),
    ].map((visitorIdHash) => claimShareConcurrentUse({ shareLinkId, visitorIdHash }, startedAt)));

    const acquired = racers.filter((claim) => claim.status === 'acquired');
    const limited = racers.filter((claim) => claim.status === 'limited');
    expect(acquired).toHaveLength(2);
    expect(limited).toHaveLength(4);
    expect(await prisma.appShareRequestLease.count({ where: { shareLinkId } })).toBe(2);

    const first = acquired[0];
    if (first.status !== 'acquired') throw new Error('expected an acquired lease');
    const firstRow = await prisma.appShareRequestLease.findUniqueOrThrow({
      where: {
        leaseTokenHash: crypto.createHash('sha256').update(first.leaseToken).digest('hex'),
      },
    });
    expect(firstRow.leaseTokenHash).not.toBe(first.leaseToken);

    const sameVisitor = await Promise.all(Array.from({ length: 5 }, () => (
      claimShareConcurrentUse({
        shareLinkId,
        visitorIdHash: firstRow.visitorIdHash,
      }, startedAt + 1)
    )));
    expect(sameVisitor.every((claim) => claim.status === 'acquired')).toBe(true);
    expect(await prisma.appShareRequestLease.count({
      where: { shareLinkId, visitorIdHash: firstRow.visitorIdHash },
    })).toBe(6);

    await expect(claimShareConcurrentUse({
      shareLinkId,
      visitorIdHash: firstRow.visitorIdHash,
      leaseToken: first.leaseToken,
    }, startedAt + 2)).resolves.toEqual(first);

    const leasesForFirstVisitor = await prisma.appShareRequestLease.findMany({
      where: { shareLinkId, visitorIdHash: firstRow.visitorIdHash },
      select: { leaseTokenHash: true },
    });
    expect(leasesForFirstVisitor).toHaveLength(6);

    expect(await releaseShareConcurrentUse({
      shareLinkId,
      visitorIdHash: firstRow.visitorIdHash,
      leaseToken: first.leaseToken,
    })).toEqual({ status: 'released' });
    expect(await releaseShareConcurrentUse({
      shareLinkId,
      visitorIdHash: firstRow.visitorIdHash,
      leaseToken: first.leaseToken,
    })).toEqual({ status: 'already_released' });

    await prisma.appShareRequestLease.deleteMany({
      where: { shareLinkId, visitorIdHash: firstRow.visitorIdHash },
    });
    await expect(claimShareConcurrentUse({ shareLinkId, visitorIdHash: visitorC }, startedAt + 3))
      .resolves.toEqual(expect.objectContaining({ status: 'acquired' }));

    const afterCrashWindow = startedAt + __shareConcurrentUseTest.LEASE_TTL_MS + 10;
    await expect(claimShareConcurrentUse({
      shareLinkId,
      visitorIdHash: visitor('visitor-after-expiry'),
    }, afterCrashWindow)).resolves.toEqual(expect.objectContaining({ status: 'acquired' }));
    const remaining = await prisma.appShareRequestLease.findMany({ where: { shareLinkId } });
    expect(remaining).toHaveLength(1);
    expect(remaining[0].visitorIdHash).toBe(visitor('visitor-after-expiry'));
  });

  test('enforces the per-visitor row bound in the database', async () => {
    await prisma.appShareRequestLease.deleteMany({ where: { shareLinkId } });
    await prisma.appShareLink.update({
      where: { id: shareLinkId },
      data: { maxConcurrentVisitors: 100 },
    });
    const now = Date.now();
    const claims: Awaited<ReturnType<typeof claimShareConcurrentUse>>[] = [];
    for (let index = 0; index < __shareConcurrentUseTest.MAX_REQUESTS_PER_VISITOR + 1; index += 1) {
      claims.push(await claimShareConcurrentUse({ shareLinkId, visitorIdHash: visitorA }, now + index));
    }
    expect(claims.filter((claim) => claim.status === 'acquired'))
      .toHaveLength(__shareConcurrentUseTest.MAX_REQUESTS_PER_VISITOR);
    expect(claims.at(-1)).toEqual(expect.objectContaining({ status: 'limited' }));
    expect(await prisma.appShareRequestLease.count({ where: { shareLinkId } }))
      .toBe(__shareConcurrentUseTest.MAX_REQUESTS_PER_VISITOR);
  });

  test('renews a real lease beyond its original window while preserving the bounded-expiry constraint', async () => {
    await prisma.appShareRequestLease.deleteMany({ where: { shareLinkId } });
    await prisma.appShareLink.update({
      where: { id: shareLinkId },
      data: { maxConcurrentVisitors: 1 },
    });
    const startedAt = Date.now();
    const claim = await claimShareConcurrentUse({ shareLinkId, visitorIdHash: visitorA }, startedAt);
    if (claim.status !== 'acquired') throw new Error('expected acquired lease');
    const renewalAt = startedAt + 4 * 60_000;
    await expect(renewShareConcurrentUse({
      shareLinkId,
      visitorIdHash: visitorA,
      leaseToken: claim.leaseToken,
    }, renewalAt)).resolves.toEqual({
      status: 'renewed',
      leaseExpiresAt: new Date(renewalAt + __shareConcurrentUseTest.LEASE_TTL_MS),
    });
    const row = await prisma.appShareRequestLease.findUniqueOrThrow({
      where: { leaseTokenHash: crypto.createHash('sha256').update(claim.leaseToken).digest('hex') },
    });
    expect(row.createdAt).toEqual(new Date(renewalAt));
    expect(row.leaseExpiresAt).toEqual(new Date(renewalAt + __shareConcurrentUseTest.LEASE_TTL_MS));
  });

  test('pages equal-timestamp share rows without gaps or duplicates', async () => {
    const historyAppId = crypto.randomUUID();
    await prisma.app.create({
      data: {
        id: historyAppId,
        userId: ownerId,
        name: `share-history-${suffix}`,
        zipPath: `/tmp/share-history-${suffix}.zip`,
      },
    });
    const createdAt = new Date('2026-08-20T22:00:00.000Z');
    const expectedIds = Array.from({ length: 205 }, (_, index) => `history-${String(index).padStart(4, '0')}`)
      .sort((a, b) => b.localeCompare(a));
    await prisma.appShareLink.createMany({
      data: expectedIds.map((id, index) => ({
        id,
        appId: historyAppId,
        userId: ownerId,
        token: crypto.createHash('sha256').update(`${suffix}-history-${index}`).digest('base64url'),
        createdAt,
      })),
    });

    const observed: string[] = [];
    let cursor: ReturnType<typeof decodeShareLinkCursor> | null = null;
    for (let pageIndex = 0; pageIndex < 10; pageIndex += 1) {
      const rows = await prisma.appShareLink.findMany({
        where: { appId: historyAppId, userId: ownerId, ...shareLinkCursorWhere(cursor) },
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        take: 38,
      });
      const page = buildShareLinkPage(rows, 37);
      observed.push(...page.rows.map(row => row.id));
      if (!page.pagination.hasMore) break;
      cursor = decodeShareLinkCursor(page.pagination.nextCursor!);
    }
    expect(observed).toEqual(expectedIds);
    expect(new Set(observed).size).toBe(205);
  });

  test('enforces migration bounds and cascades lease cleanup with the link', async () => {
    await expect(prisma.appShareLink.update({
      where: { id: shareLinkId },
      data: { maxConcurrentVisitors: 0 },
    })).rejects.toThrow();

    const cascadeLinkId = crypto.randomUUID();
    await prisma.appShareLink.create({
      data: {
        id: cascadeLinkId,
        appId,
        userId: ownerId,
        token: crypto.randomBytes(32).toString('base64url'),
        maxConcurrentVisitors: 1,
      },
    });
    const createdAt = new Date();
    await expect(prisma.appShareRequestLease.create({
      data: {
        leaseTokenHash: 'not-a-digest',
        shareLinkId: cascadeLinkId,
        visitorIdHash: visitorA,
        createdAt,
        leaseExpiresAt: new Date(createdAt.getTime() + 60_000),
      },
    })).rejects.toThrow();
    await expect(prisma.appShareRequestLease.create({
      data: {
        leaseTokenHash: visitor('overlong-lease-token'),
        shareLinkId: cascadeLinkId,
        visitorIdHash: visitorA,
        createdAt,
        leaseExpiresAt: new Date(createdAt.getTime() + 7 * 60_000),
      },
    })).rejects.toThrow();

    await prisma.appShareRequestLease.create({
      data: {
        leaseTokenHash: visitor('cascade-lease-token'),
        shareLinkId: cascadeLinkId,
        visitorIdHash: visitorA,
        createdAt,
        leaseExpiresAt: new Date(createdAt.getTime() + 60_000),
      },
    });
    await prisma.appShareLink.delete({ where: { id: cascadeLinkId } });
    expect(await prisma.appShareRequestLease.count({ where: { shareLinkId: cascadeLinkId } })).toBe(0);
  });
});
