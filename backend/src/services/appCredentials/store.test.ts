/**
 * Named App credential storage over an in-memory stand-in for the two Prisma
 * models (constraints and cascades are proven against PostgreSQL in
 * store.db.test.ts). Values are obvious dummies.
 */
jest.mock('../../config/env', () => ({ config: { jwtSecret: 'app-credential-test-jwt-secret-not-a-live-secret' } }));

type Row = Record<string, any>;
const db = {
  apps: [] as Row[],
  identities: new Map<string, { lifecycleStatus: string }>(),
  sets: new Map<string, Row>(),
  credentials: new Map<string, Row>(),
  activity: [] as Row[],
  settings: [] as Row[],
};
const key = (appId: string, slot: string) => `${appId}\0${slot}`;
const pick = (row: Row, select?: Row) => (select ? Object.fromEntries(Object.keys(select).filter((name) => select[name] === true).map((name) => [name, row[name]])) : { ...row });
function appMatches(app: Row, where: Row): boolean {
  if (where.id !== undefined && app.id !== where.id) return false;
  if (where.userId !== undefined && app.userId !== where.userId) return false;
  if (where.deployType !== undefined && app.deployType !== where.deployType) return false;
  if (where.isActive !== undefined && app.isActive !== where.isActive) return false;
  if (where.projectIdentityId?.not === null && app.projectIdentityId === null) return false;
  if (typeof where.projectIdentityId === 'string' && app.projectIdentityId !== where.projectIdentityId) return false;
  const lifecycle = where.projectIdentity?.is?.lifecycleStatus;
  if (lifecycle && db.identities.get(app.projectIdentityId)?.lifecycleStatus !== lifecycle) return false;
  return true;
}
const prisma: any = {
  app: { findFirst: async ({ where, select }: Row) => { const app = db.apps.find((row) => appMatches(row, where)); return app ? pick(app, select) : null; } },
  projectAppCredential: {
    findUnique: async ({ where, select }: Row) => { const row = db.credentials.get(key(where.appId_slot.appId, where.appId_slot.slot)); return row ? pick(row, select) : null; },
    findFirst: async ({ select }: Row) => { const row = [...db.credentials.values()][0]; return row ? pick(row, select) : null; },
    findMany: async ({ where, select }: Row) => [...db.credentials.values()].filter((row) => row.appId === where.appId)
      .sort((left, right) => left.slot.localeCompare(right.slot)).map((row) => pick(row, select)),
    count: async ({ where }: Row) => [...db.credentials.values()].filter((row) => row.appId === where.appId).length,
    upsert: async ({ where, create, update, select }: Row) => {
      const id = key(where.appId_slot.appId, where.appId_slot.slot);
      const existing = db.credentials.get(id);
      const row = existing ? { ...existing, ...update, updatedAt: new Date() } : { ...create, updatedAt: new Date() };
      db.credentials.set(id, row);
      return pick(row, select);
    },
    deleteMany: async ({ where }: Row) => {
      const id = key(where.appId, where.slot);
      const row = db.credentials.get(id);
      if (!row || row.revision !== where.revision) return { count: 0 };
      db.credentials.delete(id);
      return { count: 1 };
    },
  },
  projectAppCredentialSet: {
    findUnique: async ({ where, select }: Row) => { const row = db.sets.get(where.appId); return row ? pick(row, select) : null; },
    findFirst: async ({ where }: Row) => {
      const set = db.sets.get(where.appId);
      const app = db.apps.find((row) => row.id === where.appId);
      if (!set || !app || !appMatches(app, where.app.is)) return null;
      const credentials = [...db.credentials.values()].filter((row) => row.appId === where.appId)
        .sort((left, right) => left.slot.localeCompare(right.slot)).map((row) => ({ slot: row.slot, ciphertext: row.ciphertext }));
      return { revision: set.revision, credentials };
    },
    upsert: async ({ where, create, update, select }: Row) => {
      const existing = db.sets.get(where.appId);
      const row = existing ? { ...existing, revision: existing.revision + update.revision.increment } : { ...create };
      db.sets.set(where.appId, row);
      return pick(row, select);
    },
    update: async ({ where, data, select }: Row) => {
      const existing = db.sets.get(where.appId)!;
      const row = { ...existing, revision: existing.revision + data.revision.increment };
      db.sets.set(where.appId, row);
      return pick(row, select);
    },
  },
  activityLog: { create: async ({ data }: Row) => { db.activity.push(data); return data; } },
  systemSetting: { findFirst: async ({ where }: Row) => db.settings.find((row) => row.value.startsWith(where.value.startsWith)) || null },
  $transaction: async (operation: (tx: unknown) => unknown) => operation(prisma),
};
jest.mock('../../config/database', () => ({ prisma }));

import { decryptSecret, encryptPlaintextSecret } from '../../utils/authSecrets';
import { APP_CREDENTIAL_MAX_BYTES, AppCredentialError } from './policy';
import {
  listAppCredentials,
  readAppCredentialsForProjection,
  removeAppCredential,
  setAppCredential,
  verifyPortalEncryptionKey,
} from './store';

const APP = '11111111-2222-4333-8444-555555555555';
const OTHER_APP = '66666666-7777-4888-8999-000000000000';
const OWNER = { kind: 'user' as const, userId: 'owner-1' };
const VALUE = '{"username":"dummy-user","password":"DUMMY-NOT-A-REAL-SECRET"}';

beforeEach(() => {
  db.apps.length = 0;
  db.identities.clear();
  db.sets.clear();
  db.credentials.clear();
  db.activity.length = 0;
  db.settings.length = 0;
  db.apps.push(
    { id: APP, name: 'demo-app', userId: 'owner-1', projectIdentityId: 'project-1', deployType: 'fullstack', isActive: true },
    { id: OTHER_APP, name: 'static-site', userId: 'owner-1', projectIdentityId: 'project-2', deployType: 'static', isActive: true },
  );
  db.identities.set('project-1', { lifecycleStatus: 'ACTIVE' });
  db.identities.set('project-2', { lifecycleStatus: 'ACTIVE' });
});

function everythingStored(): string {
  return JSON.stringify({ sets: [...db.sets.values()], credentials: [...db.credentials.values()], activity: db.activity });
}

describe('App credential store', () => {
  test('encrypts at rest with the Portal authenticated encryption and round-trips only into the projection', async () => {
    const receipt = await setAppCredential({ appId: APP, slot: 'api-token', value: VALUE, actor: OWNER, expectedRevision: null });
    expect(receipt).toMatchObject({ appId: APP, slot: 'api-token', revision: 1, replaced: false, bytes: Buffer.byteLength(VALUE) });
    const row = db.credentials.get(key(APP, 'api-token'))!;
    expect(row.ciphertext).toMatch(/^portal-secret:v1:/);
    expect(decryptSecret(row.ciphertext)).toBe(VALUE);
    expect(Object.keys(row).sort()).toEqual(['appId', 'ciphertext', 'revision', 'slot', 'updatedAt', 'updatedByOperator', 'updatedByUserId']);
    expect(everythingStored()).not.toContain('DUMMY-NOT-A-REAL-SECRET');

    // The same value again gets a fresh IV: storage never acts as a value fingerprint.
    await setAppCredential({ appId: APP, slot: 'api-token', value: VALUE, actor: OWNER, expectedRevision: 1 });
    expect(db.credentials.get(key(APP, 'api-token'))!.ciphertext).not.toBe(row.ciphertext);

    const projected = await readAppCredentialsForProjection({ appId: APP, actorId: 'owner-1', projectId: 'project-1' });
    expect(projected).toEqual({ revision: 2, entries: [{ slot: 'api-token', value: VALUE }] });
  });

  test('listing returns names and metadata only, never values or ciphertext', async () => {
    await setAppCredential({ appId: APP, slot: 'legacy-key', value: VALUE, actor: OWNER });
    await setAppCredential({ appId: APP, slot: 'api-token', value: Buffer.from(VALUE), actor: { kind: 'operator' } });
    const listing = await listAppCredentials(APP);
    expect(listing.slots.map((slot) => slot.slot)).toEqual(['api-token', 'legacy-key']);
    expect(listing.slots[0]).toMatchObject({ revision: 2, updatedByOperator: true, updatedByUserId: null });
    expect(listing.slots[1]).toMatchObject({ revision: 1, updatedByOperator: false, updatedByUserId: 'owner-1' });
    const serialized = JSON.stringify(listing);
    expect(serialized).not.toContain('DUMMY-NOT-A-REAL-SECRET');
    expect(serialized).not.toContain('portal-secret');
    expect(serialized).not.toContain('ciphertext');
  });

  test('revisions are monotonic across set, replace, removal and re-adding a removed slot', async () => {
    const first = await setAppCredential({ appId: APP, slot: 'service-login', value: 'URL=https://service.invalid', actor: OWNER, expectedRevision: null });
    const replaced = await setAppCredential({ appId: APP, slot: 'service-login', value: 'URL=https://service.invalid/2', actor: OWNER, expectedRevision: first.revision });
    const removed = await removeAppCredential({ appId: APP, slot: 'service-login', actor: OWNER, expectedRevision: replaced.revision });
    const again = await setAppCredential({ appId: APP, slot: 'service-login', value: 'URL=https://service.invalid/3', actor: OWNER, expectedRevision: null });
    expect([first.revision, replaced.revision, removed.revision, again.revision]).toEqual([1, 2, 3, 4]);
    expect(replaced.replaced).toBe(true);
    expect((await listAppCredentials(APP)).revision).toBe(4);
  });

  test('compare-and-swap: add refuses an existing slot, replace and remove refuse a stale revision', async () => {
    await setAppCredential({ appId: APP, slot: 'api-token', value: VALUE, actor: OWNER });
    await expect(setAppCredential({ appId: APP, slot: 'api-token', value: VALUE, actor: OWNER, expectedRevision: null }))
      .rejects.toMatchObject({ code: 'APP_CREDENTIAL_CONFLICT', status: 409 });
    await expect(setAppCredential({ appId: APP, slot: 'api-token', value: VALUE, actor: OWNER, expectedRevision: 7 }))
      .rejects.toMatchObject({ code: 'APP_CREDENTIAL_CONFLICT' });
    await expect(removeAppCredential({ appId: APP, slot: 'api-token', actor: OWNER, expectedRevision: 7 }))
      .rejects.toMatchObject({ code: 'APP_CREDENTIAL_CONFLICT' });
    await expect(removeAppCredential({ appId: APP, slot: 'missing', actor: OWNER }))
      .rejects.toMatchObject({ code: 'APP_CREDENTIAL_NOT_FOUND', status: 404 });
    expect(db.credentials.size).toBe(1);
  });

  test('bounds slot names, value size and text, and the number of slots per App', async () => {
    for (const slot of ['', 'Upper', '1starts-digit', 'has_underscore', 'a'.repeat(64), '../escape', 'with space']) {
      await expect(setAppCredential({ appId: APP, slot, value: VALUE, actor: OWNER })).rejects.toMatchObject({ code: 'APP_CREDENTIAL_INVALID' });
    }
    expect((await setAppCredential({ appId: APP, slot: 'a'.repeat(63), value: 'x', actor: OWNER })).revision).toBe(1);
    await expect(setAppCredential({ appId: APP, slot: 'big', value: 'x'.repeat(APP_CREDENTIAL_MAX_BYTES + 1), actor: OWNER }))
      .rejects.toMatchObject({ code: 'APP_CREDENTIAL_TOO_LARGE', status: 413 });
    await expect(setAppCredential({ appId: APP, slot: 'wide', value: 'é'.repeat(APP_CREDENTIAL_MAX_BYTES / 2 + 1), actor: OWNER }))
      .rejects.toMatchObject({ code: 'APP_CREDENTIAL_TOO_LARGE' });
    expect((await setAppCredential({ appId: APP, slot: 'exact', value: 'x'.repeat(APP_CREDENTIAL_MAX_BYTES), actor: OWNER })).bytes).toBe(APP_CREDENTIAL_MAX_BYTES);
    for (const value of ['', 'nul\0inside', '\ud800lone surrogate', 42, null]) {
      await expect(setAppCredential({ appId: APP, slot: 'bad', value, actor: OWNER })).rejects.toMatchObject({ code: 'APP_CREDENTIAL_INVALID' });
    }
    await expect(setAppCredential({ appId: APP, slot: 'bytes', value: Buffer.from([0xc3, 0x28]), actor: { kind: 'operator' } }))
      .rejects.toMatchObject({ code: 'APP_CREDENTIAL_INVALID' });
    for (let index = db.credentials.size; index < 16; index += 1) {
      await setAppCredential({ appId: APP, slot: `slot-${index}`, value: 'x', actor: OWNER });
    }
    await expect(setAppCredential({ appId: APP, slot: 'seventeenth', value: 'x', actor: OWNER }))
      .rejects.toMatchObject({ code: 'APP_CREDENTIAL_LIMIT', status: 409 });
    // Replacing an existing slot at the limit is still allowed.
    await expect(setAppCredential({ appId: APP, slot: 'exact', value: 'y', actor: OWNER })).resolves.toMatchObject({ replaced: true });
  });

  test('only a live full-stack Project App can hold credentials', async () => {
    db.apps.push({ id: 'aaaaaaaa-2222-4333-8444-555555555555', name: 'old', userId: 'owner-1', projectIdentityId: 'project-3', deployType: 'fullstack', isActive: false });
    db.apps.push({ id: 'bbbbbbbb-2222-4333-8444-555555555555', name: 'deleting', userId: 'owner-1', projectIdentityId: 'project-4', deployType: 'fullstack', isActive: true });
    db.apps.push({ id: 'cccccccc-2222-4333-8444-555555555555', name: 'standalone', userId: 'owner-1', projectIdentityId: null, deployType: 'fullstack', isActive: true });
    db.identities.set('project-4', { lifecycleStatus: 'DELETING' });
    for (const appId of [OTHER_APP, 'aaaaaaaa-2222-4333-8444-555555555555', 'bbbbbbbb-2222-4333-8444-555555555555',
      'cccccccc-2222-4333-8444-555555555555', 'dddddddd-2222-4333-8444-555555555555']) {
      await expect(setAppCredential({ appId, slot: 'api-token', value: VALUE, actor: OWNER }))
        .rejects.toMatchObject({ code: 'APP_CREDENTIAL_APP_NOT_FOUND', status: 404 });
    }
    await expect(listAppCredentials('not-a-uuid')).rejects.toMatchObject({ code: 'APP_CREDENTIAL_INVALID', status: 400 });
    expect(db.credentials.size).toBe(0);
    expect(db.activity).toHaveLength(0);
  });

  test('every change is audited with actor, App, slot and revision, never the value or its size', async () => {
    await setAppCredential({ appId: APP, slot: 'api-token', value: VALUE, actor: OWNER });
    await setAppCredential({ appId: APP, slot: 'api-token', value: VALUE, actor: OWNER });
    await setAppCredential({ appId: APP, slot: 'legacy-key', value: Buffer.from(VALUE), actor: { kind: 'operator' } });
    await removeAppCredential({ appId: APP, slot: 'api-token', actor: OWNER });
    expect(db.activity.map((row) => row.action)).toEqual([
      'APP_CREDENTIAL_SET', 'APP_CREDENTIAL_REPLACED', 'APP_CREDENTIAL_IMPORTED', 'APP_CREDENTIAL_REMOVED',
    ]);
    expect(db.activity[2]).toMatchObject({ userId: null, resource: 'project-app-credential', resourceId: APP,
      metadata: { appId: APP, slot: 'legacy-key', revision: 3, actor: 'operator', replaced: false } });
    expect(db.activity[0]).toMatchObject({ userId: 'owner-1', metadata: { actor: 'user' } });
    const audit = JSON.stringify(db.activity);
    expect(audit).not.toContain('DUMMY-NOT-A-REAL-SECRET');
    expect(audit).not.toContain('portal-secret');
    expect(audit).not.toContain(String(Buffer.byteLength(VALUE)));
  });

  test('dry run validates everything and writes nothing', async () => {
    const dry = await setAppCredential({ appId: APP, slot: 'api-token', value: Buffer.from(VALUE), actor: { kind: 'operator' }, expectedRevision: null, dryRun: true });
    expect(dry).toMatchObject({ slot: 'api-token', replaced: false, bytes: Buffer.byteLength(VALUE) });
    expect(db.credentials.size).toBe(0);
    expect(db.sets.size).toBe(0);
    expect(db.activity).toHaveLength(0);
    await setAppCredential({ appId: APP, slot: 'api-token', value: VALUE, actor: OWNER });
    await expect(setAppCredential({ appId: APP, slot: 'api-token', value: VALUE, actor: { kind: 'operator' }, expectedRevision: null, dryRun: true }))
      .rejects.toMatchObject({ code: 'APP_CREDENTIAL_CONFLICT' });
  });

  test('projection is bound to the exact App identity and fails closed on unreadable rows', async () => {
    await setAppCredential({ appId: APP, slot: 'api-token', value: VALUE, actor: OWNER });
    expect(await readAppCredentialsForProjection({ appId: APP, actorId: 'someone-else', projectId: 'project-1' })).toBeNull();
    expect(await readAppCredentialsForProjection({ appId: APP, actorId: 'owner-1', projectId: 'project-2' })).toBeNull();
    expect(await readAppCredentialsForProjection({ appId: OTHER_APP, actorId: 'owner-1', projectId: 'project-2' })).toBeNull();

    const row = db.credentials.get(key(APP, 'api-token'))!;
    const tampered = `${row.ciphertext.slice(0, -2)}${row.ciphertext.endsWith('AA') ? 'BB' : 'AA'}`;
    db.credentials.set(key(APP, 'api-token'), { ...row, ciphertext: tampered });
    const failure = await readAppCredentialsForProjection({ appId: APP, actorId: 'owner-1', projectId: 'project-1' }).catch((error) => error);
    expect(failure).toBeInstanceOf(AppCredentialError);
    expect(failure).toMatchObject({ code: 'APP_CREDENTIAL_UNREADABLE', status: 503 });
    expect(failure.message).toContain('"api-token"');
    expect(failure.message).not.toContain('portal-secret');

    // A plaintext row (never written by this store) is refused, not passed through.
    db.credentials.set(key(APP, 'api-token'), { ...row, ciphertext: VALUE });
    await expect(readAppCredentialsForProjection({ appId: APP, actorId: 'owner-1', projectId: 'project-1' }))
      .rejects.toMatchObject({ code: 'APP_CREDENTIAL_UNREADABLE' });
  });

  test('the import key check proves the process holds the Portal encryption key', async () => {
    expect(await verifyPortalEncryptionKey()).toBe('no-existing-secret');
    db.settings.push({ key: 'example.credential.x', value: encryptPlaintextSecret('{"kind":"client_secret"}') });
    expect(await verifyPortalEncryptionKey()).toBe('verified');
    db.settings.push({ key: 'smtp.password', value: 'portal-secret:v1:AAAAAAAAAAAAAAAA.AAAAAAAAAAAAAAAAAAAAAA.AAAA' });
    db.settings.reverse();
    await expect(verifyPortalEncryptionKey()).rejects.toMatchObject({ code: 'APP_CREDENTIAL_UNREADABLE' });
  });
});
