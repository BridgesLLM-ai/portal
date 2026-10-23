/**
 * Durable named App credentials (ProjectAppCredential / ProjectAppCredentialSet).
 *
 * - Values are encrypted with the Portal's authenticated encryption
 *   (portal-secret:v1, the mechanism that protects the Portal's other
 *   stored secrets) and are write-only: listing returns names and metadata only,
 *   and only the App runtime projection decrypts.
 * - Every set, replace, removal and import bumps the App's set revision and
 *   writes its audit row in the same transaction; a change without an audit
 *   row cannot commit. Audit rows carry actor, App, slot and revision, never a
 *   value, a length or a digest.
 * - Rows are removed with their App (foreign-key cascade), so every App
 *   deletion and retirement path removes its credentials.
 */
import { Prisma } from '@prisma/client';
import { prisma } from '../../config/database';
import { decryptSecret, encryptPlaintextSecret, isEncryptedSecret } from '../../utils/authSecrets';
import {
  APP_CREDENTIAL_MAX_BYTES,
  APP_CREDENTIAL_MAX_SLOTS,
  AppCredentialError,
  decodeAppCredentialBytes,
  requireAppCredentialAppId,
  requireAppCredentialSlot,
  requireAppCredentialValue,
} from './policy';

export type AppCredentialActor = { kind: 'user'; userId: string } | { kind: 'operator' };

export type AppCredentialAuditAction =
  | 'APP_CREDENTIAL_SET'
  | 'APP_CREDENTIAL_REPLACED'
  | 'APP_CREDENTIAL_REMOVED'
  | 'APP_CREDENTIAL_IMPORTED';

export const APP_CREDENTIAL_AUDIT_RESOURCE = 'project-app-credential';

export interface CredentialApp {
  id: string;
  name: string;
  userId: string;
  projectIdentityId: string;
}

export interface AppCredentialSlotRecord {
  slot: string;
  revision: number;
  updatedAt: Date;
  updatedByUserId: string | null;
  updatedByOperator: boolean;
}

export interface AppCredentialListing {
  app: CredentialApp;
  /** Bumped by every change (including removals); 0 when never set. */
  revision: number;
  slots: AppCredentialSlotRecord[];
}

export interface AppCredentialWriteReceipt {
  appId: string;
  slot: string;
  revision: number;
  storedAt: string;
  replaced: boolean;
}

type CredentialClient = Pick<Prisma.TransactionClient, 'app' | 'projectAppCredential' | 'projectAppCredentialSet'>;

/** A live, Portal-managed fullstack Project App, or APP_CREDENTIAL_APP_NOT_FOUND. */
export async function requireCredentialApp(appIdInput: unknown, client: CredentialClient = prisma): Promise<CredentialApp> {
  const appId = requireAppCredentialAppId(appIdInput);
  const app = await client.app.findFirst({
    where: {
      id: appId,
      deployType: 'fullstack',
      isActive: true,
      projectIdentityId: { not: null },
      projectIdentity: { is: { lifecycleStatus: 'ACTIVE' } },
    },
    select: { id: true, name: true, userId: true, projectIdentityId: true },
  });
  if (!app || !app.projectIdentityId) {
    throw new AppCredentialError('APP_CREDENTIAL_APP_NOT_FOUND', 'No live full-stack Project App has that ID.', 404);
  }
  return { id: app.id, name: app.name, userId: app.userId, projectIdentityId: app.projectIdentityId };
}

const SLOT_METADATA = {
  slot: true,
  revision: true,
  updatedAt: true,
  updatedByUserId: true,
  updatedByOperator: true,
} as const;

/** Names and metadata only: this query never selects ciphertext. */
export async function listAppCredentials(appIdInput: unknown): Promise<AppCredentialListing> {
  const app = await requireCredentialApp(appIdInput);
  const [set, slots] = await Promise.all([
    prisma.projectAppCredentialSet.findUnique({ where: { appId: app.id }, select: { revision: true } }),
    prisma.projectAppCredential.findMany({ where: { appId: app.id }, select: SLOT_METADATA, orderBy: { slot: 'asc' } }),
  ]);
  return { app, revision: set?.revision ?? 0, slots };
}

function auditMessage(action: AppCredentialAuditAction, slot: string, app: CredentialApp, revision: number): string {
  const verb = action === 'APP_CREDENTIAL_REMOVED' ? 'Removed' : action === 'APP_CREDENTIAL_REPLACED' ? 'Replaced'
    : action === 'APP_CREDENTIAL_IMPORTED' ? 'Imported' : 'Stored';
  return `${verb} App credential "${slot}" for ${app.name} (revision ${revision}). It applies on the next App start or redeploy.`.slice(0, 500);
}

async function audit(
  tx: Prisma.TransactionClient,
  input: { action: AppCredentialAuditAction; actor: AppCredentialActor; app: CredentialApp; slot: string; revision: number; replaced?: boolean },
): Promise<void> {
  await tx.activityLog.create({
    data: {
      userId: input.actor.kind === 'user' ? input.actor.userId : null,
      action: input.action,
      resource: APP_CREDENTIAL_AUDIT_RESOURCE,
      resourceId: input.app.id,
      severity: 'INFO',
      translatedMessage: auditMessage(input.action, input.slot, input.app, input.revision),
      metadata: {
        appId: input.app.id,
        slot: input.slot,
        revision: input.revision,
        actor: input.actor.kind,
        ...(input.replaced === undefined ? {} : { replaced: input.replaced }),
      },
    },
  });
}

function conflict(message: string): AppCredentialError {
  return new AppCredentialError('APP_CREDENTIAL_CONFLICT', message, 409);
}

/** Concurrent writers to one App surface as a retryable conflict. */
function mapTransactionError(error: unknown): unknown {
  const code = (error as { code?: unknown })?.code;
  if (code === 'P2034' || code === 'P2002') {
    return conflict('The App credentials changed at the same time. Reload and try again.');
  }
  return error;
}

export interface SetAppCredentialInput {
  appId: unknown;
  slot: unknown;
  /** Text (Owner API) or raw file bytes (operator import). */
  value: unknown;
  actor: AppCredentialActor;
  /**
   * undefined: create or replace. null: create only (refuse an existing slot).
   * A number: replace exactly that revision.
   */
  expectedRevision?: number | null;
  /** Validate everything, including the App and slot limits, without writing. */
  dryRun?: boolean;
}

export async function setAppCredential(input: SetAppCredentialInput): Promise<AppCredentialWriteReceipt & { bytes: number }> {
  const slot = requireAppCredentialSlot(input.slot);
  const value = Buffer.isBuffer(input.value) ? decodeAppCredentialBytes(input.value) : requireAppCredentialValue(input.value);
  const bytes = Buffer.byteLength(value, 'utf8');
  if (bytes > APP_CREDENTIAL_MAX_BYTES) throw new AppCredentialError('APP_CREDENTIAL_TOO_LARGE', `A credential value is at most ${APP_CREDENTIAL_MAX_BYTES} bytes.`, 413);
  if (input.expectedRevision !== undefined && input.expectedRevision !== null
    && (!Number.isSafeInteger(input.expectedRevision) || input.expectedRevision < 1)) {
    throw new AppCredentialError('APP_CREDENTIAL_INVALID', 'The expected credential revision is invalid.', 400);
  }
  try {
    return await prisma.$transaction(async (tx) => {
      const app = await requireCredentialApp(input.appId, tx);
      const existing = await tx.projectAppCredential.findUnique({
        where: { appId_slot: { appId: app.id, slot } },
        select: { revision: true },
      });
      if (input.expectedRevision === null && existing) {
        throw conflict(`The credential "${slot}" already exists (revision ${existing.revision}). Replace it instead.`);
      }
      if (typeof input.expectedRevision === 'number' && existing?.revision !== input.expectedRevision) {
        throw conflict(`The credential "${slot}" changed since it was loaded. Reload and try again.`);
      }
      if (!existing) {
        const count = await tx.projectAppCredential.count({ where: { appId: app.id } });
        if (count >= APP_CREDENTIAL_MAX_SLOTS) {
          throw new AppCredentialError('APP_CREDENTIAL_LIMIT', `An App can hold at most ${APP_CREDENTIAL_MAX_SLOTS} credentials. Remove one first.`, 409);
        }
      }
      if (input.dryRun) {
        return { appId: app.id, slot, revision: 0, storedAt: '', replaced: Boolean(existing), bytes };
      }
      const set = await tx.projectAppCredentialSet.upsert({
        where: { appId: app.id },
        create: { appId: app.id, revision: 1 },
        update: { revision: { increment: 1 } },
        select: { revision: true },
      });
      const ciphertext = encryptPlaintextSecret(value);
      const by = input.actor.kind === 'user'
        ? { updatedByUserId: input.actor.userId, updatedByOperator: false }
        : { updatedByUserId: null, updatedByOperator: true };
      const row = await tx.projectAppCredential.upsert({
        where: { appId_slot: { appId: app.id, slot } },
        create: { appId: app.id, slot, ciphertext, revision: set.revision, ...by },
        update: { ciphertext, revision: set.revision, ...by },
        select: { revision: true, updatedAt: true },
      });
      const action: AppCredentialAuditAction = input.actor.kind === 'operator'
        ? 'APP_CREDENTIAL_IMPORTED'
        : existing ? 'APP_CREDENTIAL_REPLACED' : 'APP_CREDENTIAL_SET';
      await audit(tx, { action, actor: input.actor, app, slot, revision: row.revision, replaced: Boolean(existing) });
      return { appId: app.id, slot, revision: row.revision, storedAt: row.updatedAt.toISOString(), replaced: Boolean(existing), bytes };
    }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
  } catch (error) {
    throw mapTransactionError(error);
  }
}

export async function removeAppCredential(input: {
  appId: unknown;
  slot: unknown;
  actor: AppCredentialActor;
  expectedRevision?: number;
}): Promise<{ appId: string; slot: string; revision: number }> {
  const slot = requireAppCredentialSlot(input.slot);
  if (input.expectedRevision !== undefined && (!Number.isSafeInteger(input.expectedRevision) || input.expectedRevision < 1)) {
    throw new AppCredentialError('APP_CREDENTIAL_INVALID', 'The expected credential revision is invalid.', 400);
  }
  try {
    return await prisma.$transaction(async (tx) => {
      const app = await requireCredentialApp(input.appId, tx);
      const existing = await tx.projectAppCredential.findUnique({
        where: { appId_slot: { appId: app.id, slot } },
        select: { revision: true },
      });
      if (!existing) throw new AppCredentialError('APP_CREDENTIAL_NOT_FOUND', `The App has no credential named "${slot}".`, 404);
      if (input.expectedRevision !== undefined && existing.revision !== input.expectedRevision) {
        throw conflict(`The credential "${slot}" changed since it was loaded. Reload and try again.`);
      }
      const removed = await tx.projectAppCredential.deleteMany({ where: { appId: app.id, slot, revision: existing.revision } });
      if (removed.count !== 1) throw conflict(`The credential "${slot}" changed while it was being removed. Reload and try again.`);
      const set = await tx.projectAppCredentialSet.update({
        where: { appId: app.id },
        data: { revision: { increment: 1 } },
        select: { revision: true },
      });
      await audit(tx, { action: 'APP_CREDENTIAL_REMOVED', actor: input.actor, app, slot, revision: set.revision });
      return { appId: app.id, slot, revision: set.revision };
    }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
  } catch (error) {
    throw mapTransactionError(error);
  }
}

export interface ProjectedAppCredentials {
  revision: number;
  entries: Array<{ slot: string; value: string }>;
}

/**
 * Decrypt one App's credentials for its resident container, bound to the
 * exact runtime identity (App, workspace owner, Project). Returns null when
 * the App has none. Fails closed on any unreadable value: the App does not
 * start with a silently missing or plaintext credential.
 */
export async function readAppCredentialsForProjection(identity: {
  appId: string;
  actorId: string;
  projectId: string;
}): Promise<ProjectedAppCredentials | null> {
  const set = await prisma.projectAppCredentialSet.findFirst({
    where: {
      appId: identity.appId,
      app: { is: { id: identity.appId, userId: identity.actorId, projectIdentityId: identity.projectId, deployType: 'fullstack' } },
    },
    select: { revision: true, credentials: { select: { slot: true, ciphertext: true }, orderBy: { slot: 'asc' } } },
  });
  if (!set || set.credentials.length === 0) return null;
  if (set.credentials.length > APP_CREDENTIAL_MAX_SLOTS) {
    throw new AppCredentialError('APP_CREDENTIAL_UNREADABLE', 'The App has more stored credentials than allowed. Remove the extra ones.', 503);
  }
  const entries = set.credentials.map(({ slot, ciphertext }) => {
    const unreadable = new AppCredentialError(
      'APP_CREDENTIAL_UNREADABLE',
      `The App credential "${slot}" could not be decrypted with this Portal's encryption key. Replace or remove it, then start the App again.`,
      503,
    );
    if (!isAppCredentialSlotSafe(slot) || !isEncryptedSecret(ciphertext)) throw unreadable;
    let value: string;
    try { value = decryptSecret(ciphertext); } catch { throw unreadable; }
    if (!value || Buffer.byteLength(value, 'utf8') > APP_CREDENTIAL_MAX_BYTES) throw unreadable;
    return { slot, value };
  });
  return { revision: set.revision, entries };
}

function isAppCredentialSlotSafe(slot: string): boolean {
  try { requireAppCredentialSlot(slot); return true; } catch { return false; }
}

/**
 * Prove this process holds the running Portal's encryption key before it
 * encrypts anything: an existing Portal ciphertext must authenticate. Returns
 * 'no-existing-secret' when there is nothing to prove against.
 */
export async function verifyPortalEncryptionKey(): Promise<'verified' | 'no-existing-secret'> {
  const [credential, setting] = await Promise.all([
    prisma.projectAppCredential.findFirst({ select: { ciphertext: true } }),
    prisma.systemSetting.findFirst({ where: { value: { startsWith: 'portal-secret:v1:' } }, select: { value: true } }),
  ]);
  const samples = [credential?.ciphertext, setting?.value].filter((value): value is string => Boolean(value));
  if (samples.length === 0) return 'no-existing-secret';
  for (const sample of samples) {
    try { decryptSecret(sample); }
    catch {
      throw new AppCredentialError(
        'APP_CREDENTIAL_UNREADABLE',
        'This process does not hold the Portal encryption key (an existing Portal secret did not decrypt). Run it from the installed Portal backend folder so its .env is loaded.',
        503,
      );
    }
  }
  return 'verified';
}
