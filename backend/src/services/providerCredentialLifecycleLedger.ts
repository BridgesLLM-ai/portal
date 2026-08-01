import fs from 'fs';
import os from 'os';
import path from 'path';
import { createHmac, randomBytes, randomUUID, timingSafeEqual } from 'crypto';

const { DatabaseSync } = require('node:sqlite') as {
  DatabaseSync: new (filename: string, options?: { open?: boolean; readOnly?: boolean }) => {
    exec: (sql: string) => void;
    prepare: (sql: string) => {
      all: (...values: unknown[]) => Array<Record<string, unknown>>;
      run: (...values: unknown[]) => unknown;
    };
    close: () => void;
  };
};

export type ProviderCredentialLifecycleState = 'active' | 'committed' | 'indeterminate';
export type ProviderCredentialLifecycleBindingState = 'unbound' | 'owned-child' | 'attested-processless';
export type ProviderCredentialLifecycleCredentialScope =
  | 'openclaw-auth-store'
  | 'portal-json'
  | 'native-cli'
  | 'agent-zero'
  | 'openclaw-and-portal'
  | 'combined-domain';

export interface ProviderCredentialLifecycleRecord {
  namespace: string;
  lifecycleKind: string;
  credentialScope: ProviderCredentialLifecycleCredentialScope;
  leaseId: string;
  ownerDigest: string;
  requestDigest: string;
  sessionDigest: string | null;
  processPid: number | null;
  processStartTicks: string | null;
  bindingState: ProviderCredentialLifecycleBindingState;
  baselineDigest: string | null;
  currentDigest: string | null;
  /** Exact lifecycle superseded only by an authoritative removal fence. */
  removalTargetLeaseId: string | null;
  /** Credential surface owned by the exact snapshotted target lifecycle. */
  removalTargetCredentialScope: ProviderCredentialLifecycleCredentialScope | null;
  state: ProviderCredentialLifecycleState;
  admittedAt: string;
  updatedAt: string;
  reviewAfter: string;
}

interface ProviderCredentialLifecycleLedgerFile {
  version: 1;
  records: Record<string, ProviderCredentialLifecycleRecord>;
}

export class DurableCredentialLifecycleConflictError extends Error {
  readonly statusCode = 409;
  readonly code: string = 'PROVIDER_CREDENTIAL_LIFECYCLE_CONFLICT';
}

export class DurableCredentialOperationEnvelopeMismatchError extends DurableCredentialLifecycleConflictError {
  readonly code = 'PROVIDER_CREDENTIAL_OPERATION_ENVELOPE_MISMATCH';
}

export class DurableCredentialLifecycleRecoveryRequiredError extends Error {
  readonly statusCode = 409;
  readonly code: string = 'PROVIDER_CREDENTIAL_LIFECYCLE_RECOVERY_REQUIRED';
}

/**
 * The client reused an operation UUID with a different request while the
 * original write still owns a live or parked fence. Unlike a mismatch against
 * a permanent completion receipt, this is not authoritative non-admission:
 * retiring the UUID would strand the only identity that can recover the
 * retained fence.
 */
export class DurableCredentialOperationRetainedEnvelopeMismatchError
  extends DurableCredentialLifecycleRecoveryRequiredError {
  readonly code: string = 'PROVIDER_CREDENTIAL_OPERATION_RETAINED_ENVELOPE_MISMATCH';
}

export class DurableCredentialLifecycleUnavailableError extends Error {
  readonly statusCode = 503;
  readonly code = 'PROVIDER_CREDENTIAL_LIFECYCLE_UNAVAILABLE';
}

let testLedgerPath: string | null = null;

function defaultLedgerPath(): string {
  if (testLedgerPath) return testLedgerPath;
  if (process.env.PORTAL_CREDENTIAL_LIFECYCLE_LEDGER_PATH) {
    return path.resolve(process.env.PORTAL_CREDENTIAL_LIFECYCLE_LEDGER_PATH);
  }
  if (process.env.NODE_ENV === 'test') {
    return path.join(os.tmpdir(), 'bridgesllm-provider-lifecycle-tests', `${process.pid}.sqlite3`);
  }
  const portalRoot = path.resolve(process.env.PORTAL_DATA_ROOT || process.env.PORTAL_ROOT || '/portal');
  return path.join(portalRoot, 'backend', '.data', 'provider-credential-lifecycles.sqlite3');
}

function validateLedgerDirectory(targetPath: string): void {
  const directoryPath = path.dirname(targetPath);
  // `mode` only applies to directories this call creates. `backend/.data` ships
  // in the release tree and is extracted under the installer's umask, so on a
  // real install it already exists at 0755 -- and every provider OAuth attempt
  // then died on "permissions are too broad" with no way for the operator to
  // know which directory was meant.
  fs.mkdirSync(directoryPath, { recursive: true, mode: 0o700 });
  let directory = fs.lstatSync(directoryPath);
  if (!directory.isDirectory() || directory.isSymbolicLink()) {
    throw new Error('credential lifecycle directory is not a real directory');
  }
  if (typeof process.getuid === 'function' && directory.uid !== process.getuid()) {
    throw new Error('credential lifecycle directory is owned by another account');
  }
  if ((directory.mode & 0o077) !== 0) {
    // A directory we own that was never writable by anyone else can be
    // narrowed in place: nothing untrusted could have planted content in it.
    // One that is group- or world-writable cannot, because its contents are no
    // longer trustworthy and this path holds credential material.
    if ((directory.mode & 0o022) !== 0) {
      throw new Error('credential lifecycle directory is group- or world-writable');
    }
    const descriptor = fs.openSync(directoryPath, fs.constants.O_RDONLY);
    try {
      const opened = fs.fstatSync(descriptor);
      if (opened.dev !== directory.dev || opened.ino !== directory.ino) {
        throw new Error('credential lifecycle directory was replaced while being secured');
      }
      fs.fchmodSync(descriptor, 0o700);
      directory = fs.fstatSync(descriptor);
    } finally {
      fs.closeSync(descriptor);
    }
    if ((directory.mode & 0o077) !== 0) {
      throw new Error('credential lifecycle directory permissions are too broad');
    }
  }
}

function readSmallRegularFile(targetPath: string, maxBytes: number): Buffer | null {
  try {
    const stat = fs.lstatSync(targetPath);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > maxBytes) {
      throw new Error('credential lifecycle file is not a bounded regular file');
    }
    if ((stat.mode & 0o077) !== 0) throw new Error('credential lifecycle file permissions are too broad');
    if (typeof process.getuid === 'function' && stat.uid !== process.getuid()) {
      throw new Error('credential lifecycle file is owned by another account');
    }
    return fs.readFileSync(targetPath);
  } catch (error: any) {
    if (error?.code === 'ENOENT') return null;
    throw error;
  }
}

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const DIGEST_PATTERN = /^[0-9a-f]{64}$/;
const SQLITE_HEADER = Buffer.from('SQLite format 3\0', 'utf8');
const LEDGER_SCHEMA_VERSION = 1;
const MAX_LEDGER_BYTES = 16 * 1024 * 1024;
const MAX_SQLITE_SIDECAR_BYTES = 32 * 1024 * 1024;
const CREDENTIAL_SCOPES: readonly ProviderCredentialLifecycleCredentialScope[] = [
  'openclaw-auth-store',
  'portal-json',
  'native-cli',
  'agent-zero',
  'openclaw-and-portal',
  'combined-domain',
];
const RECORD_KEYS = [
  'namespace', 'lifecycleKind', 'credentialScope', 'leaseId', 'ownerDigest', 'requestDigest',
  'sessionDigest', 'processPid', 'processStartTicks', 'bindingState',
  'baselineDigest', 'currentDigest', 'removalTargetLeaseId', 'removalTargetCredentialScope', 'state',
  'admittedAt', 'updatedAt', 'reviewAfter',
] as const;

function validDigest(value: unknown, nullable = false): boolean {
  return value === null ? nullable : typeof value === 'string' && DIGEST_PATTERN.test(value);
}

function validateLifecycleRecord(raw: unknown): ProviderCredentialLifecycleRecord {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error('credential lifecycle ledger contains an invalid record');
  }
  const record = raw as Record<string, unknown>;
  const keys = Object.keys(record).sort();
  const expectedKeys = [...RECORD_KEYS].sort();
  if (keys.length !== expectedKeys.length || keys.some((key, index) => key !== expectedKeys[index])) {
    throw new Error('credential lifecycle ledger contains unknown or missing record fields');
  }
  const bindingState = record.bindingState;
  const credentialScope = record.credentialScope;
  const pid = record.processPid;
  const ticks = record.processStartTicks;
  const sessionDigest = record.sessionDigest;
  const pidPairIsNull = pid === null && ticks === null;
  const pidPairIsOwned = Number.isSafeInteger(pid) && (pid as number) > 1
    && typeof ticks === 'string' && /^\d+$/.test(ticks);
  const bindingIsValid = bindingState === 'unbound'
    ? pidPairIsNull && sessionDigest === null
    : bindingState === 'owned-child'
      ? pidPairIsOwned && validDigest(sessionDigest)
      : bindingState === 'attested-processless'
        ? pidPairIsNull && validDigest(sessionDigest)
        : false;
  if (typeof record.namespace !== 'string' || !record.namespace || record.namespace.length > 512
    || typeof record.lifecycleKind !== 'string' || !record.lifecycleKind || record.lifecycleKind.length > 128
    || !CREDENTIAL_SCOPES.includes(credentialScope as ProviderCredentialLifecycleCredentialScope)
    || typeof record.leaseId !== 'string' || !UUID_PATTERN.test(record.leaseId)
    || !validDigest(record.ownerDigest) || !validDigest(record.requestDigest)
    || !bindingIsValid
    || !validDigest(record.baselineDigest, true) || !validDigest(record.currentDigest, true)
    || (record.removalTargetLeaseId !== null
      && (typeof record.removalTargetLeaseId !== 'string' || !UUID_PATTERN.test(record.removalTargetLeaseId)))
    || (record.removalTargetCredentialScope !== null
      && !CREDENTIAL_SCOPES.includes(
        record.removalTargetCredentialScope as ProviderCredentialLifecycleCredentialScope,
      ))
    || ((record.removalTargetLeaseId === null) !== (record.removalTargetCredentialScope === null))
    || !['active', 'committed', 'indeterminate'].includes(String(record.state))
    || typeof record.admittedAt !== 'string' || !Number.isFinite(Date.parse(record.admittedAt))
    || typeof record.updatedAt !== 'string' || !Number.isFinite(Date.parse(record.updatedAt))
    || typeof record.reviewAfter !== 'string' || !Number.isFinite(Date.parse(record.reviewAfter))) {
    throw new Error('credential lifecycle ledger contains an invalid record');
  }
  return record as unknown as ProviderCredentialLifecycleRecord;
}

type LifecycleDatabase = InstanceType<typeof DatabaseSync>;

function fsyncDirectory(directoryPath: string): void {
  const descriptor = fs.openSync(directoryPath, 'r');
  try {
    fs.fsyncSync(descriptor);
  } finally {
    fs.closeSync(descriptor);
  }
}

function validatePrivateFile(targetPath: string, maxBytes: number): Buffer | null {
  return readSmallRegularFile(targetPath, maxBytes);
}

function schemaKeyDigest(key: Buffer): string {
  return digest(key, 'ledger-schema', String(LEDGER_SCHEMA_VERSION));
}

function ensureDatabaseSchema(database: LifecycleDatabase, key: Buffer, initialize: boolean): void {
  if (initialize) database.exec(`
    CREATE TABLE ledger_metadata (
      singleton_id INTEGER PRIMARY KEY NOT NULL CHECK(singleton_id = 1),
      schema_version INTEGER NOT NULL CHECK(schema_version = ${LEDGER_SCHEMA_VERSION}),
      key_check_digest TEXT NOT NULL CHECK(length(key_check_digest) = 64 AND key_check_digest NOT GLOB '*[^0-9a-f]*')
    ) STRICT;
    CREATE TABLE IF NOT EXISTS lifecycle_records (
      namespace TEXT PRIMARY KEY NOT NULL,
      lifecycle_kind TEXT NOT NULL,
      credential_scope TEXT NOT NULL CHECK(credential_scope IN ('openclaw-auth-store', 'portal-json', 'native-cli', 'agent-zero', 'openclaw-and-portal', 'combined-domain')),
      lease_id TEXT NOT NULL CHECK(length(lease_id) = 36),
      owner_digest TEXT NOT NULL CHECK(length(owner_digest) = 64 AND owner_digest NOT GLOB '*[^0-9a-f]*'),
      request_digest TEXT NOT NULL CHECK(length(request_digest) = 64 AND request_digest NOT GLOB '*[^0-9a-f]*'),
      session_digest TEXT,
      process_pid INTEGER,
      process_start_ticks TEXT,
      binding_state TEXT NOT NULL CHECK(binding_state IN ('unbound', 'owned-child', 'attested-processless')),
      baseline_digest TEXT CHECK(baseline_digest IS NULL OR (length(baseline_digest) = 64 AND baseline_digest NOT GLOB '*[^0-9a-f]*')),
      current_digest TEXT CHECK(current_digest IS NULL OR (length(current_digest) = 64 AND current_digest NOT GLOB '*[^0-9a-f]*')),
      removal_target_lease_id TEXT CHECK(removal_target_lease_id IS NULL OR length(removal_target_lease_id) = 36),
      removal_target_credential_scope TEXT CHECK(removal_target_credential_scope IS NULL OR removal_target_credential_scope IN ('openclaw-auth-store', 'portal-json', 'native-cli', 'agent-zero', 'openclaw-and-portal', 'combined-domain')),
      state TEXT NOT NULL CHECK(state IN ('active', 'committed', 'indeterminate')),
      admitted_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      review_after TEXT NOT NULL,
      CHECK(session_digest IS NULL OR (length(session_digest) = 64 AND session_digest NOT GLOB '*[^0-9a-f]*')),
      CHECK((removal_target_lease_id IS NULL) = (removal_target_credential_scope IS NULL)),
      CHECK(
        (binding_state = 'unbound' AND session_digest IS NULL AND process_pid IS NULL AND process_start_ticks IS NULL)
        OR (binding_state = 'owned-child' AND session_digest IS NOT NULL AND process_pid > 1
          AND process_start_ticks IS NOT NULL AND length(process_start_ticks) > 0
          AND process_start_ticks NOT GLOB '*[^0-9]*')
        OR (binding_state = 'attested-processless' AND session_digest IS NOT NULL
          AND process_pid IS NULL AND process_start_ticks IS NULL)
      )
    ) STRICT;
    CREATE TABLE operation_receipts (
      operation_id_digest TEXT PRIMARY KEY NOT NULL CHECK(length(operation_id_digest) = 64 AND operation_id_digest NOT GLOB '*[^0-9a-f]*'),
      namespace_digest TEXT NOT NULL CHECK(length(namespace_digest) = 64 AND namespace_digest NOT GLOB '*[^0-9a-f]*'),
      owner_digest TEXT NOT NULL CHECK(length(owner_digest) = 64 AND owner_digest NOT GLOB '*[^0-9a-f]*'),
      request_digest TEXT NOT NULL CHECK(length(request_digest) = 64 AND request_digest NOT GLOB '*[^0-9a-f]*'),
      result_digest TEXT NOT NULL CHECK(length(result_digest) = 64 AND result_digest NOT GLOB '*[^0-9a-f]*'),
      completed_at TEXT NOT NULL,
      expires_at TEXT NOT NULL
    ) STRICT;
    PRAGMA user_version = ${LEDGER_SCHEMA_VERSION};
  `);
  if (initialize) {
    database.prepare(`
      INSERT INTO ledger_metadata (singleton_id, schema_version, key_check_digest)
      VALUES (1, ?, ?)
    `).run(LEDGER_SCHEMA_VERSION, schemaKeyDigest(key));
  }

  const tables = database.prepare(`
    SELECT name FROM sqlite_schema
    WHERE type = 'table' AND name NOT LIKE 'sqlite_%'
    ORDER BY name
  `).all().map((row) => String(row.name));
  if (tables.length !== 3
    || tables[0] !== 'ledger_metadata'
    || tables[1] !== 'lifecycle_records'
    || tables[2] !== 'operation_receipts') {
    throw new Error('credential lifecycle SQLite schema contains unknown or missing tables');
  }

  const metadataColumns = database.prepare('PRAGMA table_info(ledger_metadata)').all()
    .map((row) => String(row.name));
  const expectedMetadataColumns = ['singleton_id', 'schema_version', 'key_check_digest'];
  if (metadataColumns.length !== expectedMetadataColumns.length
    || metadataColumns.some((column, index) => column !== expectedMetadataColumns[index])) {
    throw new Error('credential lifecycle SQLite metadata schema contains unknown or missing fields');
  }
  const columns = database.prepare('PRAGMA table_info(lifecycle_records)').all()
    .map((row) => String(row.name));
  const expected = [
    'namespace', 'lifecycle_kind', 'credential_scope', 'lease_id', 'owner_digest', 'request_digest',
    'session_digest', 'process_pid', 'process_start_ticks', 'binding_state',
    'baseline_digest', 'current_digest', 'removal_target_lease_id', 'removal_target_credential_scope', 'state',
    'admitted_at', 'updated_at', 'review_after',
  ];
  if (columns.length !== expected.length || columns.some((column, index) => column !== expected[index])) {
    throw new Error('credential lifecycle SQLite schema contains unknown or missing fields');
  }

  const receiptColumns = database.prepare('PRAGMA table_info(operation_receipts)').all()
    .map((row) => String(row.name));
  const expectedReceiptColumns = [
    'operation_id_digest', 'namespace_digest', 'owner_digest', 'request_digest',
    'result_digest', 'completed_at', 'expires_at',
  ];
  if (receiptColumns.length !== expectedReceiptColumns.length
    || receiptColumns.some((column, index) => column !== expectedReceiptColumns[index])) {
    throw new Error('credential lifecycle SQLite receipt schema contains unknown or missing fields');
  }

  const metadataRows = database.prepare(`
    SELECT singleton_id, schema_version, key_check_digest FROM ledger_metadata
  `).all();
  if (metadataRows.length !== 1
    || Number(metadataRows[0].singleton_id) !== 1
    || Number(metadataRows[0].schema_version) !== LEDGER_SCHEMA_VERSION
    || Number(database.prepare('PRAGMA user_version').all()[0]?.user_version) !== LEDGER_SCHEMA_VERSION) {
    throw new Error('credential lifecycle SQLite metadata is missing or unsupported');
  }
  const storedDigest = String(metadataRows[0].key_check_digest || '');
  const expectedDigest = schemaKeyDigest(key);
  if (!DIGEST_PATTERN.test(storedDigest)
    || !timingSafeEqual(Buffer.from(storedDigest, 'hex'), Buffer.from(expectedDigest, 'hex'))) {
    throw new Error('credential lifecycle SQLite key binding is invalid');
  }
  const receiptRows = database.prepare(`
    SELECT operation_id_digest, namespace_digest, owner_digest, request_digest,
      result_digest, completed_at, expires_at
    FROM operation_receipts
  `).all();
  for (const receipt of receiptRows) {
    if (!validDigest(receipt.operation_id_digest)
      || !validDigest(receipt.namespace_digest)
      || !validDigest(receipt.owner_digest)
      || !validDigest(receipt.request_digest)
      || !validDigest(receipt.result_digest)
      || typeof receipt.completed_at !== 'string' || !Number.isFinite(Date.parse(receipt.completed_at))
      || typeof receipt.expires_at !== 'string' || !Number.isFinite(Date.parse(receipt.expires_at))) {
      throw new Error('credential lifecycle SQLite receipt contains invalid fields');
    }
  }
  // Completion rows are permanent at-most-once tombstones. `expires_at` is
  // retained for schema compatibility and may bound a future UX replay window,
  // but deleting the HMAC-only row would let the same operation UUID become a
  // fresh secret write after cleanup.
  const integrity = database.prepare('PRAGMA integrity_check').all();
  if (integrity.length !== 1 || String(integrity[0].integrity_check) !== 'ok') {
    throw new Error('credential lifecycle SQLite integrity check failed');
  }
}

function loadLedger(database: LifecycleDatabase): ProviderCredentialLifecycleLedgerFile {
  const records: Record<string, ProviderCredentialLifecycleRecord> = {};
  const rows = database.prepare(`
    SELECT namespace, lifecycle_kind, credential_scope, lease_id, owner_digest, request_digest,
      session_digest, process_pid, process_start_ticks, binding_state,
      baseline_digest, current_digest, removal_target_lease_id, removal_target_credential_scope, state,
      admitted_at, updated_at, review_after
    FROM lifecycle_records
  `).all();
  for (const row of rows) {
    const record = validateLifecycleRecord({
      namespace: row.namespace,
      lifecycleKind: row.lifecycle_kind,
      credentialScope: row.credential_scope,
      leaseId: row.lease_id,
      ownerDigest: row.owner_digest,
      requestDigest: row.request_digest,
      sessionDigest: row.session_digest,
      processPid: row.process_pid,
      processStartTicks: row.process_start_ticks,
      bindingState: row.binding_state,
      baselineDigest: row.baseline_digest,
      currentDigest: row.current_digest,
      removalTargetLeaseId: row.removal_target_lease_id,
      removalTargetCredentialScope: row.removal_target_credential_scope,
      state: row.state,
      admittedAt: row.admitted_at,
      updatedAt: row.updated_at,
      reviewAfter: row.review_after,
    });
    if (records[record.namespace]) throw new Error('credential lifecycle ledger contains a duplicate namespace');
    records[record.namespace] = record;
  }
  return { version: 1, records };
}

function persistLedger(database: LifecycleDatabase, ledger: ProviderCredentialLifecycleLedgerFile): void {
  database.exec('DELETE FROM lifecycle_records');
  const insert = database.prepare(`
    INSERT INTO lifecycle_records (
      namespace, lifecycle_kind, credential_scope, lease_id, owner_digest, request_digest,
      session_digest, process_pid, process_start_ticks, binding_state,
      baseline_digest, current_digest, removal_target_lease_id, removal_target_credential_scope, state,
      admitted_at, updated_at, review_after
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  for (const [namespace, candidate] of Object.entries(ledger.records)) {
    const record = validateLifecycleRecord(candidate);
    if (record.namespace !== namespace) throw new Error('credential lifecycle namespace/key mismatch');
    insert.run(
      record.namespace, record.lifecycleKind, record.credentialScope, record.leaseId, record.ownerDigest,
      record.requestDigest, record.sessionDigest, record.processPid,
      record.processStartTicks, record.bindingState, record.baselineDigest,
      record.currentDigest, record.removalTargetLeaseId, record.removalTargetCredentialScope, record.state,
      record.admittedAt, record.updatedAt, record.reviewAfter,
    );
  }
}

function processAlive(pid: number, expectedStartTicks: string): boolean {
  try {
    process.kill(pid, 0);
    return processStartTicks(pid) === expectedStartTicks;
  } catch (error: any) {
    return error?.code === 'EPERM' && processStartTicks(pid) === expectedStartTicks;
  }
}

function withLedgerLock<T>(operation: (
  ledgerPath: string,
  ledger: ProviderCredentialLifecycleLedgerFile,
  key: Buffer,
  database: LifecycleDatabase,
) => T): T {
  const ledgerPath = defaultLedgerPath();
  validateLedgerDirectory(ledgerPath);
  const directoryPath = path.dirname(ledgerPath);
  const keyPath = `${ledgerPath}.key`;
  let database: LifecycleDatabase | null = null;
  let transactionStarted = false;
  let initializing = false;
  try {
    const existingDatabase = validatePrivateFile(ledgerPath, MAX_LEDGER_BYTES);
    let key = validatePrivateFile(keyPath, 128);
    if (Boolean(existingDatabase) !== Boolean(key)) {
      throw new Error('credential lifecycle database/key pair is incomplete');
    }
    initializing = !existingDatabase && !key;
    if (existingDatabase && !existingDatabase.subarray(0, SQLITE_HEADER.length).equals(SQLITE_HEADER)) {
      throw new Error('credential lifecycle database has an invalid SQLite header');
    }
    for (const sidecarPath of [`${ledgerPath}-journal`, `${ledgerPath}-wal`, `${ledgerPath}-shm`]) {
      validatePrivateFile(sidecarPath, MAX_SQLITE_SIDECAR_BYTES);
    }

    if (initializing) {
      key = randomBytes(32);
      const keyDescriptor = fs.openSync(keyPath, 'wx', 0o600);
      try {
        fs.writeFileSync(keyDescriptor, key);
        fs.fsyncSync(keyDescriptor);
      } finally {
        fs.closeSync(keyDescriptor);
      }
      fsyncDirectory(directoryPath);
    }
    if (!key || key.length !== 32) throw new Error('credential lifecycle digest key is invalid');

    database = new DatabaseSync(ledgerPath);
    fs.chmodSync(ledgerPath, 0o600);
    if (initializing) fsyncDirectory(directoryPath);
    database.exec('PRAGMA busy_timeout = 0; PRAGMA journal_mode = DELETE; PRAGMA synchronous = FULL; PRAGMA trusted_schema = OFF;');
    database.exec('BEGIN IMMEDIATE');
    transactionStarted = true;
    ensureDatabaseSchema(database, key, initializing);
    const ledger = loadLedger(database);
    const result = operation(ledgerPath, ledger, key, database);
    persistLedger(database, ledger);
    database.exec('COMMIT');
    transactionStarted = false;
    if (initializing) fsyncDirectory(directoryPath);
    return result;
  } catch (error: any) {
    if (transactionStarted && database) {
      try { database.exec('ROLLBACK'); } catch {}
    }
    if (error instanceof DurableCredentialLifecycleConflictError
      || error instanceof DurableCredentialLifecycleRecoveryRequiredError
      || error instanceof DurableCredentialLifecycleUnavailableError) throw error;
    const contention = String(error?.code || '').includes('BUSY') || /database is locked/i.test(String(error?.message || ''));
    throw new DurableCredentialLifecycleUnavailableError(
      contention
        ? 'Provider authorization admission is temporarily locked by another Portal process.'
        : `Provider authorization admission is unavailable: ${error?.message || 'durable ledger failure'}`,
    );
  } finally {
    try { database?.close(); } catch {}
  }
}

// Ledger mutation is committed once, by withLedgerLock's SQLite transaction.
function atomicWriteLedger(_targetPath: string, _ledger: ProviderCredentialLifecycleLedgerFile): void {}

function digest(key: Buffer, kind: string, value: string): string {
  return createHmac('sha256', key).update(kind).update('\0').update(value).digest('hex');
}

function inferCredentialScope(lifecycleKind: string): ProviderCredentialLifecycleCredentialScope {
  if (lifecycleKind === 'native-cli') return 'native-cli';
  if (lifecycleKind === 'agent-zero-oauth') return 'agent-zero';
  if (lifecycleKind === 'api-key-save-portal') return 'portal-json';
  if (lifecycleKind === 'api-key-save-openclaw') return 'openclaw-and-portal';
  if (lifecycleKind === 'openclaw-oauth' || lifecycleKind === 'openclaw-device') {
    return 'openclaw-and-portal';
  }
  // Unknown lifecycle kinds may mutate more than their caller currently
  // understands. Serialize them against the entire shared credential domain.
  return 'combined-domain';
}

function credentialScopeCovers(
  proofScope: ProviderCredentialLifecycleCredentialScope,
  targetScope: ProviderCredentialLifecycleCredentialScope,
): boolean {
  if (proofScope === 'combined-domain') return true;
  if (proofScope === 'openclaw-and-portal') {
    return targetScope === 'openclaw-auth-store'
      || targetScope === 'portal-json'
      || targetScope === 'openclaw-and-portal';
  }
  return proofScope === targetScope;
}

export interface ClaimedProviderCredentialLifecycle {
  namespace: string;
  leaseId: string;
  resumed?: boolean;
  targetNamespace?: string;
  targetLeaseId?: string | null;
  targetCredentialScope?: ProviderCredentialLifecycleCredentialScope | null;
}

export interface ProviderCredentialLifecycleFingerprintProof {
  fingerprint: string;
  /** True only when the provider-specific control plane proves no credential exists. */
  absent: boolean;
}

const PROVIDER_REMOVAL_FENCE_PREFIX = 'provider-removal:';

function providerRemovalFenceNamespace(namespace: string): string {
  return `${PROVIDER_REMOVAL_FENCE_PREFIX}${namespace}`;
}

function ownershipChangedMessage(): DurableCredentialLifecycleRecoveryRequiredError {
  return new DurableCredentialLifecycleRecoveryRequiredError(
    'Provider credential lifecycle ownership changed while Portal was verifying the control plane. The newer lifecycle was preserved.',
  );
}

function processStartTicks(pid: number): string | null {
  try {
    const raw = fs.readFileSync(`/proc/${pid}/stat`, 'utf8');
    const commandEnd = raw.lastIndexOf(')');
    if (commandEnd < 0) return null;
    const fieldsAfterCommand = raw.slice(commandEnd + 1).trim().split(/\s+/);
    const value = fieldsAfterCommand[19];
    return /^\d+$/.test(value || '') ? value : null;
  } catch {
    return null;
  }
}

export function claimProviderCredentialLifecycle(
  namespace: string,
  ownerId: string,
  requestFingerprint: string,
  options: {
    lifecycleKind?: string;
    credentialScope?: ProviderCredentialLifecycleCredentialScope;
    reviewAfterMs?: number;
    baselineFingerprint?: string | null;
  } = {},
): ClaimedProviderCredentialLifecycle {
  return withLedgerLock((ledgerPath, ledger, key) => {
    const ownerDigest = digest(key, 'owner', ownerId);
    const requestDigest = digest(key, 'request', requestFingerprint);
    const removalFence = ledger.records[providerRemovalFenceNamespace(namespace)];
    if (removalFence) {
      throw new DurableCredentialLifecycleConflictError(
        'Provider credential removal currently owns this credential domain. Wait for verified removal before starting another sign-in.',
      );
    }
    const existing = ledger.records[namespace];
    if (existing) {
      if (existing.ownerDigest === ownerDigest && existing.requestDigest === requestDigest) {
        throw new DurableCredentialLifecycleRecoveryRequiredError(
          'Portal recovered an unfinished authorization lifecycle after restart. It will not start a duplicate; cancel, disconnect, or complete recovery for the existing provider attempt.',
        );
      }
      throw new DurableCredentialLifecycleConflictError(
        'Another authorization lifecycle already owns this provider credential. Finish or remove it before starting a different sign-in.',
      );
    }

    const now = new Date().toISOString();
    const reviewAfterMs = Math.max(60_000, options.reviewAfterMs ?? 24 * 60 * 60 * 1000);
    const leaseId = randomUUID();
    const lifecycleKind = options.lifecycleKind || namespace.split(':', 1)[0] || 'provider-auth';
    ledger.records[namespace] = {
      namespace,
      lifecycleKind,
      credentialScope: options.credentialScope || inferCredentialScope(lifecycleKind),
      leaseId,
      ownerDigest,
      requestDigest,
      sessionDigest: null,
      processPid: null,
      processStartTicks: null,
      bindingState: 'unbound',
      baselineDigest: options.baselineFingerprint
        ? digest(key, 'baseline', options.baselineFingerprint)
        : null,
      currentDigest: null,
      removalTargetLeaseId: null,
      removalTargetCredentialScope: null,
      state: 'active',
      admittedAt: now,
      updatedAt: now,
      reviewAfter: new Date(Date.now() + reviewAfterMs).toISOString(),
    };
    atomicWriteLedger(ledgerPath, ledger);
    return { namespace, leaseId };
  });
}

/**
 * Claim a durable destructive-operation fence for a credential domain.
 *
 * Starts and removals inspect the same ledger transaction, so neither can be
 * admitted between the other's read and write. An unfinished authorization
 * lifecycle is never stolen by removal: the caller must first complete or
 * explicitly recover that lifecycle. Exact retries can resume only after the
 * previous Portal controller exited or deliberately parked the fence.
 */
export function claimProviderCredentialRemovalLifecycle(
  targetNamespace: string,
  ownerId: string,
  requestFingerprint: string,
  options: {
    reviewAfterMs?: number;
    allowedTargetCredentialScopes?: ProviderCredentialLifecycleCredentialScope[];
    operationKind?: string;
    operationCredentialScope?: ProviderCredentialLifecycleCredentialScope;
    snapshotExistingTarget?: boolean;
    baselineFingerprint?: string | null;
    takeOverParkedWrite?: boolean;
    /** HMAC-only identity used to distinguish a changed envelope from a fresh operation. */
    operationId?: string;
  } = {},
): ClaimedProviderCredentialLifecycle {
  return withLedgerLock((ledgerPath, ledger, key) => {
    const operationKind = options.operationKind || 'provider-removal';
    const operationCredentialScope = options.operationCredentialScope || 'combined-domain';
    const snapshotExistingTarget = options.snapshotExistingTarget !== false;
    const namespace = providerRemovalFenceNamespace(targetNamespace);
    const ownerDigest = digest(key, 'owner', ownerId);
    const requestDigest = digest(key, 'request', requestFingerprint);
    const operationIdDigest = options.operationId
      ? digest(key, 'operation-id', options.operationId)
      : null;
    const existing = ledger.records[namespace];
    const currentStartTicks = processStartTicks(process.pid);
    if (!currentStartTicks) {
      throw new Error('Portal process identity could not be attested for provider removal');
    }
    if (existing) {
      const existingControllerAlive = Boolean(existing.processPid && existing.processStartTicks
        && processAlive(existing.processPid, existing.processStartTicks));
      const parkedWriteTakeover = options.takeOverParkedWrite === true
        && operationKind.startsWith('provider-removal')
        && existing.lifecycleKind.startsWith('api-key-save-')
        && !existingControllerAlive;
      if (parkedWriteTakeover) {
        const currentTarget = ledger.records[targetNamespace];
        if (currentTarget && options.allowedTargetCredentialScopes
          && !options.allowedTargetCredentialScopes.includes(currentTarget.credentialScope)) {
          throw new DurableCredentialLifecycleConflictError(
            'The retained provider lifecycle belongs to a different credential store and cannot be cleared by this removal.',
          );
        }
        if (currentTarget) {
          const safelyRemovable = providerCredentialLifecycleSafelyRemovable(currentTarget);
          if (!safelyRemovable) {
            throw new DurableCredentialLifecycleConflictError(
              'An active or unbound authorization lifecycle still owns this provider credential. Finish or recover it before disconnecting the provider.',
            );
          }
        }
        const now = new Date().toISOString();
        const leaseId = randomUUID();
        existing.lifecycleKind = operationKind;
        existing.credentialScope = operationCredentialScope;
        existing.leaseId = leaseId;
        existing.ownerDigest = ownerDigest;
        existing.requestDigest = requestDigest;
        existing.sessionDigest = digest(key, 'session', `removal-controller:${leaseId}`);
        existing.processPid = process.pid;
        existing.processStartTicks = currentStartTicks;
        existing.bindingState = 'owned-child';
        existing.baselineDigest = options.baselineFingerprint
          ? digest(key, 'baseline', options.baselineFingerprint)
          : null;
        existing.currentDigest = operationIdDigest;
        existing.removalTargetLeaseId = snapshotExistingTarget ? currentTarget?.leaseId ?? null : null;
        existing.removalTargetCredentialScope = snapshotExistingTarget
          ? currentTarget?.credentialScope ?? null
          : null;
        existing.state = 'active';
        existing.admittedAt = now;
        existing.updatedAt = now;
        existing.reviewAfter = new Date(
          Date.now() + Math.max(60_000, options.reviewAfterMs ?? 15 * 60 * 1000),
        ).toISOString();
        atomicWriteLedger(ledgerPath, ledger);
        return {
          namespace,
          leaseId,
          resumed: true,
          targetNamespace,
          targetLeaseId: existing.removalTargetLeaseId,
          targetCredentialScope: existing.removalTargetCredentialScope,
        };
      }
      if (existing.lifecycleKind !== operationKind) {
        throw new DurableCredentialLifecycleConflictError(
          'A different credential mutation already owns this provider domain.',
        );
      }
      if (operationIdDigest && existing.ownerDigest === ownerDigest
        && existing.currentDigest === operationIdDigest
        && existing.requestDigest !== requestDigest) {
        throw new DurableCredentialOperationRetainedEnvelopeMismatchError(
          'This credential-operation UUID belongs to a retained write with a different request. Retry the original request or use credential maintenance; the UUID was preserved for recovery.',
        );
      }
      if (operationIdDigest && existing.currentDigest !== operationIdDigest) {
        throw new DurableCredentialLifecycleConflictError(
          'This retained provider-removal lifecycle belongs to a different operation UUID. Retry that exact operation or use credential maintenance.',
        );
      }
      if (existing.ownerDigest !== ownerDigest || existing.requestDigest !== requestDigest) {
        throw new DurableCredentialLifecycleConflictError(
          'Another provider-removal lifecycle already owns this credential domain.',
        );
      }
      if (existingControllerAlive) {
        throw new DurableCredentialLifecycleRecoveryRequiredError(
          'This provider-removal lifecycle is already running. Wait for its authoritative readback before retrying.',
        );
      }
      const currentTarget = ledger.records[targetNamespace];
      if (existing.removalTargetLeaseId) {
        if (!currentTarget
          || currentTarget.leaseId !== existing.removalTargetLeaseId
          || currentTarget.credentialScope !== existing.removalTargetCredentialScope) {
          throw new DurableCredentialLifecycleRecoveryRequiredError(
            'Provider lifecycle ownership changed while a removal was parked. The newer lifecycle was preserved.',
          );
        }
      } else if (currentTarget) {
        throw new DurableCredentialLifecycleRecoveryRequiredError(
          'A provider lifecycle appeared while removal recovery was parked. The newer lifecycle was preserved.',
        );
      }
      if (currentTarget && options.allowedTargetCredentialScopes
        && !options.allowedTargetCredentialScopes.includes(currentTarget.credentialScope)) {
        throw new DurableCredentialLifecycleConflictError(
          'The retained provider lifecycle belongs to a different credential store and cannot be cleared by this removal.',
        );
      }
      if (existing.credentialScope !== operationCredentialScope) {
        throw new DurableCredentialLifecycleConflictError(
          'The parked credential mutation belongs to a different credential surface.',
        );
      }
      // The previous controller exited (restart/crash) or deliberately parked
      // an indeterminate attempt. Rotate the lease so stale callbacks cannot
      // release this resumed operation.
      existing.leaseId = randomUUID();
      existing.processPid = process.pid;
      existing.processStartTicks = currentStartTicks;
      existing.bindingState = 'owned-child';
      existing.sessionDigest = digest(key, 'session', `removal-controller:${existing.leaseId}`);
      existing.state = 'active';
      existing.updatedAt = new Date().toISOString();
      existing.reviewAfter = new Date(
        Date.now() + Math.max(60_000, options.reviewAfterMs ?? 15 * 60 * 1000),
      ).toISOString();
      atomicWriteLedger(ledgerPath, ledger);
      return {
        namespace,
        leaseId: existing.leaseId,
        resumed: true,
        targetNamespace,
        targetLeaseId: existing.removalTargetLeaseId,
        targetCredentialScope: existing.removalTargetCredentialScope,
      };
    }

    const target = ledger.records[targetNamespace];
    if (target && !snapshotExistingTarget) {
      throw new DurableCredentialLifecycleConflictError(
        'An authorization lifecycle still owns this credential domain. Finish it before saving a provider key.',
      );
    }
    if (target) {
      if (options.allowedTargetCredentialScopes
        && !options.allowedTargetCredentialScopes.includes(target.credentialScope)) {
        throw new DurableCredentialLifecycleConflictError(
          'The retained provider lifecycle belongs to a different credential store and cannot be cleared by this removal.',
        );
      }
      const safelyRemovable = providerCredentialLifecycleSafelyRemovable(target);
      if (!safelyRemovable) {
        throw new DurableCredentialLifecycleConflictError(
          'An active or unbound authorization lifecycle still owns this provider credential. Finish or recover it before disconnecting the provider.',
        );
      }
    }

    const now = new Date().toISOString();
    const leaseId = randomUUID();
    ledger.records[namespace] = {
      namespace,
      lifecycleKind: operationKind,
      credentialScope: operationCredentialScope,
      leaseId,
      ownerDigest,
      requestDigest,
      sessionDigest: digest(key, 'session', `removal-controller:${leaseId}`),
      // For a removal fence this is the Portal controller, not a provider
      // child. It distinguishes an active cross-process request from a
      // restart-recoverable/parked operation.
      processPid: process.pid,
      processStartTicks: currentStartTicks,
      bindingState: 'owned-child',
      baselineDigest: options.baselineFingerprint
        ? digest(key, 'baseline', options.baselineFingerprint)
        : null,
      // Provider secret-write fences reserve currentDigest for the HMAC of the
      // client operation UUID. Removal/auth lifecycles leave it null or use it
      // for their ordinary current-state proof.
      currentDigest: operationIdDigest,
      removalTargetLeaseId: snapshotExistingTarget ? target?.leaseId ?? null : null,
      removalTargetCredentialScope: snapshotExistingTarget ? target?.credentialScope ?? null : null,
      state: 'active',
      admittedAt: now,
      updatedAt: now,
      reviewAfter: new Date(
        Date.now() + Math.max(60_000, options.reviewAfterMs ?? 15 * 60 * 1000),
      ).toISOString(),
    };
    atomicWriteLedger(ledgerPath, ledger);
    return {
      namespace,
      leaseId,
      resumed: false,
      targetNamespace,
      targetLeaseId: snapshotExistingTarget ? target?.leaseId ?? null : null,
      targetCredentialScope: snapshotExistingTarget ? target?.credentialScope ?? null : null,
    };
  });
}

export type ClaimedProviderCredentialWriteLifecycle =
  | { disposition: 'completed'; claim: ClaimedProviderCredentialLifecycle }
  | { disposition: 'admitted' | 'recovered'; claim: ClaimedProviderCredentialLifecycle };

function writeRequestEnvelope(operationId: string, requestFingerprint: string): string {
  return `${operationId}\0${requestFingerprint}`;
}

export type ClaimedProviderCredentialRemovalOperationLifecycle =
  | { disposition: 'completed'; claim: null }
  | { disposition: 'admitted' | 'recovered'; claim: ClaimedProviderCredentialLifecycle };

/**
 * Admit an actor-bound destructive removal operation or replay its permanent
 * HMAC-only completion receipt. The pre/post receipt reads close the race
 * where another controller commits between replay lookup and fence admission.
 */
export function claimProviderCredentialRemovalOperationLifecycle(
  targetNamespace: string,
  ownerId: string,
  operationId: string,
  requestFingerprint: string,
  resultFingerprint: string,
  options: {
    reviewAfterMs?: number;
    allowedTargetCredentialScopes?: ProviderCredentialLifecycleCredentialScope[];
    operationKind?: string;
    operationCredentialScope?: ProviderCredentialLifecycleCredentialScope;
    snapshotExistingTarget?: boolean;
    baselineFingerprint?: string | null;
    takeOverParkedWrite?: boolean;
  } = {},
): ClaimedProviderCredentialRemovalOperationLifecycle {
  if (!UUID_PATTERN.test(operationId)) {
    throw new DurableCredentialLifecycleConflictError('A valid credential-operation UUID is required.');
  }
  const readMatchingReceipt = (beforeAdmission: boolean) => withLedgerLock(
    (_ledgerPath, _ledger, key, database) => {
      const receipt = database.prepare(`
        SELECT namespace_digest, owner_digest, request_digest, result_digest
        FROM operation_receipts WHERE operation_id_digest = ?
      `).all(digest(key, 'operation-id', operationId))[0];
      if (!receipt) return false;
      const exact = receipt.namespace_digest === digest(key, 'operation-namespace', targetNamespace)
        && receipt.owner_digest === digest(key, 'owner', ownerId)
        && receipt.request_digest === digest(key, 'request', requestFingerprint)
        && receipt.result_digest === digest(key, 'result', resultFingerprint);
      if (!exact) {
        if (beforeAdmission) {
          throw new DurableCredentialOperationEnvelopeMismatchError(
            'This credential-operation UUID was already used for a different request.',
          );
        }
        throw new DurableCredentialLifecycleRecoveryRequiredError(
          'A different provider-removal operation completed during admission. The domain remains locked for review.',
        );
      }
      return true;
    },
  );

  if (readMatchingReceipt(true)) return { disposition: 'completed', claim: null };
  const claim = claimProviderCredentialRemovalLifecycle(
    targetNamespace,
    ownerId,
    requestFingerprint,
    { ...options, operationId },
  );
  try {
    if (readMatchingReceipt(false)) {
      releaseProviderCredentialLifecycle(claim);
      return { disposition: 'completed', claim: null };
    }
  } catch (error) {
    parkProviderCredentialRemovalLifecycle(claim);
    throw error;
  }
  return { disposition: claim.resumed ? 'recovered' : 'admitted', claim };
}

export function claimProviderCredentialWriteLifecycle(
  targetNamespace: string,
  ownerId: string,
  operationId: string,
  requestFingerprint: string,
  credentialScope: 'openclaw-auth-store' | 'portal-json' | 'openclaw-and-portal',
  baselineFingerprint?: string | null,
): ClaimedProviderCredentialWriteLifecycle {
  if (!UUID_PATTERN.test(operationId)) {
    throw new DurableCredentialLifecycleConflictError('A valid credential-operation UUID is required.');
  }
  const readMatchingReceipt = (beforeAdmission: boolean) => withLedgerLock((_ledgerPath, _ledger, key, database) => {
    const operationIdDigest = digest(key, 'operation-id', operationId);
    const receipt = database.prepare(`
      SELECT namespace_digest, owner_digest, request_digest
      FROM operation_receipts WHERE operation_id_digest = ?
    `).all(operationIdDigest)[0];
    if (!receipt) return false;
    const exact = receipt.namespace_digest === digest(key, 'operation-namespace', targetNamespace)
      && receipt.owner_digest === digest(key, 'owner', ownerId)
      && receipt.request_digest === digest(key, 'request', requestFingerprint);
    if (!exact) {
      if (beforeAdmission) {
        throw new DurableCredentialOperationEnvelopeMismatchError(
          'This credential-operation UUID was already used for a different request.',
        );
      }
      throw new DurableCredentialLifecycleRecoveryRequiredError(
        'A different credential request completed during operation admission. The domain remains locked for review.',
      );
    }
    return true;
  });
  const receiptExists = readMatchingReceipt(true);

  const claim = claimProviderCredentialRemovalLifecycle(
    targetNamespace,
    ownerId,
    writeRequestEnvelope(operationId, requestFingerprint),
    {
    operationKind: credentialScope === 'portal-json'
      ? 'api-key-save-portal'
      : credentialScope === 'openclaw-auth-store'
      ? 'api-key-save-openclaw'
      : 'api-key-save-openclaw-and-portal',
    operationCredentialScope: credentialScope,
      snapshotExistingTarget: false,
      baselineFingerprint,
      operationId,
    },
  );
  // A completion may have committed between the first receipt read and fence
  // admission. Recheck after admission; the newly held fence prevents any
  // further credential mutation while this exact retry resolves the race.
  try {
    if (readMatchingReceipt(false)) {
      return { disposition: 'completed', claim };
    }
  } catch (error) {
    parkProviderCredentialRemovalLifecycle(claim);
    throw error;
  }
  if (receiptExists) {
    // The receipt disappeared between reads only if it expired. Fail closed
    // rather than treating an old operation UUID as permission to rewrite a
    // secret after its retry window.
    parkProviderCredentialRemovalLifecycle(claim);
    throw new DurableCredentialLifecycleRecoveryRequiredError(
      'The credential completion receipt expired during readback. The domain remains locked for review.',
    );
  }
  return { disposition: claim.resumed ? 'recovered' : 'admitted', claim };
}

/**
 * Persist the authoritative pre-write inventory only after the write fence is
 * held. Reading it before admission leaves a crash window where another writer
 * can change the domain and make that unrelated change look like this request's
 * commit during recovery.
 */
export function setProviderCredentialWriteAdmissionBaseline(
  claim: ClaimedProviderCredentialLifecycle,
  baselineFingerprint: string,
): void {
  if (!baselineFingerprint) {
    throw new DurableCredentialLifecycleRecoveryRequiredError(
      'Credential write admission is missing its authoritative baseline.',
    );
  }
  withLedgerLock((ledgerPath, ledger, key) => {
    const fence = ledger.records[claim.namespace];
    if (!fence || fence.leaseId !== claim.leaseId
      || !fence.lifecycleKind.startsWith('api-key-save-')
      || fence.state !== 'active') {
      throw ownershipChangedMessage();
    }
    const baselineDigest = digest(key, 'baseline', baselineFingerprint);
    if (fence.baselineDigest) {
      if (fence.baselineDigest === baselineDigest) return;
      throw new DurableCredentialLifecycleRecoveryRequiredError(
        'Credential write admission baseline is already durable and cannot be replaced.',
      );
    }
    fence.baselineDigest = baselineDigest;
    fence.updatedAt = new Date().toISOString();
    atomicWriteLedger(ledgerPath, ledger);
  });
}

export function verifyProviderCredentialWriteCompletionReceipt(
  targetNamespace: string,
  ownerId: string,
  operationId: string,
  requestFingerprint: string,
  resultFingerprint: string,
): boolean {
  if (!UUID_PATTERN.test(operationId)) return false;
  return withLedgerLock((_ledgerPath, _ledger, key, database) => {
    const receipt = database.prepare(`
      SELECT namespace_digest, owner_digest, request_digest, result_digest
      FROM operation_receipts WHERE operation_id_digest = ?
    `).all(digest(key, 'operation-id', operationId))[0];
    return Boolean(receipt
      && receipt.namespace_digest === digest(key, 'operation-namespace', targetNamespace)
      && receipt.owner_digest === digest(key, 'owner', ownerId)
      && receipt.request_digest === digest(key, 'request', requestFingerprint)
      && receipt.result_digest === digest(key, 'result', resultFingerprint));
  });
}

export function completeProviderCredentialWriteLifecycle(
  claim: ClaimedProviderCredentialLifecycle,
  ownerId: string,
  operationId: string,
  requestFingerprint: string,
  resultFingerprint: string,
  receiptTtlMs = 30 * 60 * 1000,
): void {
  if (!UUID_PATTERN.test(operationId) || !claim.targetNamespace) {
    throw new DurableCredentialLifecycleRecoveryRequiredError(
      'Credential write completion is missing its durable operation identity.',
    );
  }
  const targetNamespace = claim.targetNamespace;
  withLedgerLock((ledgerPath, ledger, key, database) => {
    const fence = ledger.records[claim.namespace];
    if (!fence || fence.leaseId !== claim.leaseId
      || fence.ownerDigest !== digest(key, 'owner', ownerId)
      || fence.requestDigest !== digest(key, 'request', writeRequestEnvelope(operationId, requestFingerprint))) {
      throw ownershipChangedMessage();
    }
    const now = new Date();
    database.prepare(`
      INSERT INTO operation_receipts (
        operation_id_digest, namespace_digest, owner_digest, request_digest,
        result_digest, completed_at, expires_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(
      digest(key, 'operation-id', operationId),
      digest(key, 'operation-namespace', targetNamespace),
      digest(key, 'owner', ownerId),
      digest(key, 'request', requestFingerprint),
      digest(key, 'result', resultFingerprint),
      now.toISOString(),
      new Date(now.getTime() + Math.min(24 * 60 * 60 * 1000, Math.max(60_000, receiptTtlMs))).toISOString(),
    );
    delete ledger.records[claim.namespace];
    atomicWriteLedger(ledgerPath, ledger);
  });
}

export function getProviderCredentialLifecycleRecord(namespace: string): ProviderCredentialLifecycleRecord | null {
  return withLedgerLock((_ledgerPath, ledger) => {
    const record = ledger.records[namespace];
    return record ? { ...record } : null;
  });
}

export function providerCredentialLifecycleProcessState(
  record: Pick<ProviderCredentialLifecycleRecord, 'processPid' | 'processStartTicks'>,
): 'alive' | 'exited' | 'unowned' {
  if (!record.processPid || !record.processStartTicks) return 'unowned';
  return processAlive(record.processPid, record.processStartTicks) ? 'alive' : 'exited';
}

/**
 * Whether a verified removal may supersede an existing lifecycle record.
 *
 * The binding clauses protect a lifecycle that still owns something real: a
 * live child process, or an attested processless attempt inside its review
 * window. An `unbound` record owns neither — the claim was written, the start
 * then failed before any attempt identity came back, and nothing was ever
 * bound to it.
 *
 * Without a clause for that case the record is permanently irremovable:
 * `owned-child` and `attested-processless` can never become true after the
 * fact, so both start and disconnect remain fail-closed with no operation able
 * to resolve the unbound claim.
 *
 * The escape is limited to the `agent-zero` scope. Agent Zero attempts are
 * processless by construction, so an unbound one cannot have a surviving child.
 * A process-backed lifecycle that was never bound may still own a live child
 * whose pid was never recorded, and removing it could strand a process that
 * goes on to write credentials — those stay refused, as their tests require.
 *
 * Removal callers still prove upstream absence before releasing, so a
 * credential that actually exists is refused either way.
 */
export function providerCredentialLifecycleSafelyRemovable(
  record: Pick<
    ProviderCredentialLifecycleRecord,
    'state' | 'bindingState' | 'credentialScope' | 'reviewAfter' | 'processPid' | 'processStartTicks'
  >,
): boolean {
  if (record.state !== 'committed' && record.state !== 'indeterminate') return false;
  const ownedChildExited = record.bindingState === 'owned-child'
    && providerCredentialLifecycleProcessState(record) === 'exited';
  if (ownedChildExited) return true;
  const reviewElapsed = record.credentialScope !== 'agent-zero'
    || Date.now() >= Date.parse(record.reviewAfter);
  if (record.bindingState === 'attested-processless') return reviewElapsed;
  if (record.bindingState === 'unbound') {
    return record.credentialScope === 'agent-zero'
      && Date.now() >= Date.parse(record.reviewAfter);
  }
  return false;
}

export function attestProviderCredentialLifecycleFingerprint(
  namespace: string,
  currentFingerprint: string,
  expectedLeaseId: string,
): 'unchanged' | 'changed' | 'unavailable' | 'ownership_changed' {
  if (!UUID_PATTERN.test(expectedLeaseId)) return 'ownership_changed';
  return withLedgerLock((_ledgerPath, ledger, key) => {
    const record = ledger.records[namespace];
    if (!record || record.leaseId !== expectedLeaseId) return 'ownership_changed';
    if (!record?.baselineDigest) return 'unavailable';
    const currentDigest = digest(key, 'baseline', currentFingerprint);
    return currentDigest === record.baselineDigest ? 'unchanged' : 'changed';
  });
}

/** Caller must supply multi-read, post-exit proof before invoking this helper. */
export function releaseProviderCredentialLifecycleAfterVerifiedAbsence(
  claim: ClaimedProviderCredentialLifecycle,
): void {
  withLedgerLock((ledgerPath, ledger) => {
    const record = ledger.records[claim.namespace];
    if (!record || record.leaseId !== claim.leaseId) throw ownershipChangedMessage();
    if (record.state === 'committed') {
      throw new DurableCredentialLifecycleConflictError(
        'A credential was committed by the recovered lifecycle. Remove it before starting another sign-in.',
      );
    }
    delete ledger.records[claim.namespace];
    atomicWriteLedger(ledgerPath, ledger);
  });
}

export async function reconcileProviderCredentialLifecycleBeforeAdmission(
  namespace: string,
  readFingerprint: () => Promise<string | ProviderCredentialLifecycleFingerprintProof>,
  options: {
    now?: () => number;
    delay?: (milliseconds: number) => Promise<unknown>;
    stableReads?: number;
    intervalMs?: number;
    processStillAlive?: (pid: number, expectedStartTicks: string) => boolean;
    signalProcess?: (pid: number, expectedStartTicks: string, signal: NodeJS.Signals) => void;
    termWaitMs?: number;
    killWaitMs?: number;
  } = {},
): Promise<void> {
  const record = getProviderCredentialLifecycleRecord(namespace);
  if (!record) return;
  const recoveryClaim = { namespace, leaseId: record.leaseId };

  const now = options.now || Date.now;
  const reviewAfter = Date.parse(record.reviewAfter);
  if (!Number.isFinite(reviewAfter) || now() < reviewAfter) {
    if (record.state === 'committed') {
      throw new DurableCredentialLifecycleConflictError(
        'A recovered authorization lifecycle committed a credential. Use server credential maintenance before starting another sign-in.',
      );
    }
    throw new DurableCredentialLifecycleRecoveryRequiredError(
      'Portal recovered an unfinished authorization lifecycle and is retaining it through its credential visibility window.',
    );
  }

  // A process may survive the instruction-level crash between spawn and the
  // durable PID bind. Credential snapshots alone cannot prove that such an
  // undiscovered child will not commit after the reads. Retain every unbound
  // record fail-closed until a provider-specific process marker/discovery
  // protocol can prove that no matching child survives.
  if (record.bindingState === 'unbound') {
    markProviderCredentialLifecycle(recoveryClaim, 'indeterminate');
    throw new DurableCredentialLifecycleRecoveryRequiredError(
      'Portal recovered an authorization lifecycle without a durable child-process identity. It remains locked because a surviving credential-mutating process cannot be excluded.',
    );
  }

  const delay = options.delay || ((milliseconds: number) => new Promise((resolve) => setTimeout(resolve, milliseconds)));
  const processStillAlive = options.processStillAlive || processAlive;
  const signalProcess = options.signalProcess || ((pid: number, expectedStartTicks: string, signal: NodeJS.Signals) => {
    // Re-attest immediately before every destructive signal so PID reuse can
    // never redirect cleanup to an unrelated process.
    if (processAlive(pid, expectedStartTicks)) process.kill(pid, signal);
  });

  if (record.bindingState === 'owned-child' && record.processPid && record.processStartTicks
    && processStillAlive(record.processPid, record.processStartTicks)) {
    const waitForExit = async (timeoutMs: number): Promise<boolean> => {
      const deadline = Date.now() + Math.max(0, timeoutMs);
      while (processStillAlive(record.processPid!, record.processStartTicks!)) {
        if (Date.now() >= deadline) return false;
        await delay(Math.min(50, Math.max(1, deadline - Date.now())));
      }
      return true;
    };

    try { signalProcess(record.processPid, record.processStartTicks, 'SIGTERM'); } catch {}
    let exited = await waitForExit(options.termWaitMs ?? 3_000);
    if (!exited) {
      try { signalProcess(record.processPid, record.processStartTicks, 'SIGKILL'); } catch {}
      exited = await waitForExit(options.killWaitMs ?? 2_000);
    }
    if (!exited) {
      markProviderCredentialLifecycle(recoveryClaim, 'indeterminate');
      throw new DurableCredentialLifecycleRecoveryRequiredError(
        'Portal could not confirm that the recovered provider authorization process stopped. The lifecycle remains locked for review.',
      );
    }
  }

  const stableReads = Math.max(2, options.stableReads ?? 3);
  const intervalMs = Math.max(1, options.intervalMs ?? 150);
  let lastFingerprint: string | null = null;
  let stableAbsence = true;
  for (let index = 0; index < stableReads; index += 1) {
    let currentFingerprint: string;
    try {
      const proof = await readFingerprint();
      currentFingerprint = typeof proof === 'string' ? proof : proof.fingerprint;
      if (!currentFingerprint) throw new Error('credential-domain proof is missing its fingerprint');
      stableAbsence = stableAbsence && typeof proof !== 'string' && proof.absent === true;
    } catch {
      markProviderCredentialLifecycle(recoveryClaim, 'indeterminate');
      throw new DurableCredentialLifecycleRecoveryRequiredError(
        'Portal could not attest the provider credential inventory after restart. The existing lifecycle remains locked for review.',
      );
    }
    if (lastFingerprint !== null && currentFingerprint !== lastFingerprint) {
      markProviderCredentialLifecycle(recoveryClaim, 'indeterminate');
      throw new DurableCredentialLifecycleRecoveryRequiredError(
        'The provider credential inventory was unstable during restart recovery.',
      );
    }
    lastFingerprint = currentFingerprint;
    if (index + 1 < stableReads) await delay(intervalMs);
  }

  if (stableAbsence) {
    // This is stronger than returning to the pre-start fingerprint: the
    // provider-specific reader proved that no credential exists at all. It is
    // therefore the explicit removal proof needed to recover committed or
    // baseline-less restart records.
    if (!clearProviderCredentialLifecycleAfterVerifiedRemoval(namespace, record.leaseId)) {
      throw ownershipChangedMessage();
    }
    return;
  }

  const comparison = lastFingerprint === null
    ? 'unavailable'
    : attestProviderCredentialLifecycleFingerprint(namespace, lastFingerprint, record.leaseId);
  if (comparison === 'ownership_changed') throw ownershipChangedMessage();
  if (comparison === 'unavailable') {
    markProviderCredentialLifecycle(recoveryClaim, 'indeterminate');
    throw new DurableCredentialLifecycleRecoveryRequiredError(
      'The recovered authorization lifecycle has no trustworthy pre-start inventory proof.',
    );
  }
  if (comparison === 'changed') {
    markProviderCredentialLifecycle(
      recoveryClaim,
      'committed',
      lastFingerprint,
    );
    throw new DurableCredentialLifecycleConflictError(
      'A credential changed while Portal was recovering the previous authorization lifecycle. Remove or verify it before retrying.',
    );
  }

  releaseProviderCredentialLifecycleAfterVerifiedAbsence(recoveryClaim);
}

export function bindProviderCredentialLifecycle(
  claim: ClaimedProviderCredentialLifecycle,
  sessionId: string,
  options: {
    binding:
      | { kind: 'owned-child'; processPid: number }
      | { kind: 'attested-processless' };
    baselineFingerprint?: string | null;
    reviewAfterMs?: number | null;
  },
): void {
  withLedgerLock((ledgerPath, ledger, key) => {
    const record = ledger.records[claim.namespace];
    if (!record || record.leaseId !== claim.leaseId) {
      throw new Error('provider credential lifecycle ownership changed before session binding');
    }
    const sessionDigest = digest(key, 'session', sessionId);
    if (record.bindingState !== 'unbound') {
      const exactOwnedChildRetry = options.binding.kind === 'owned-child'
        && record.bindingState === 'owned-child'
        && record.sessionDigest === sessionDigest
        && record.processPid === options.binding.processPid;
      const exactProcesslessRetry = options.binding.kind === 'attested-processless'
        && record.bindingState === 'attested-processless'
        && record.sessionDigest === sessionDigest;
      if (exactOwnedChildRetry || exactProcesslessRetry) return;
      throw new DurableCredentialLifecycleRecoveryRequiredError(
        'Provider credential lifecycle binding is already durable and cannot be replaced by a stale callback.',
      );
    }
    if (record.state !== 'active') {
      throw new DurableCredentialLifecycleRecoveryRequiredError(
        'Provider credential lifecycle settled before its process identity was durably bound.',
      );
    }
    record.sessionDigest = sessionDigest;
    if (options.binding.kind === 'owned-child') {
      const processPid = options.binding.processPid;
      const startTicks = Number.isSafeInteger(processPid) && processPid > 1
        ? processStartTicks(processPid)
        : null;
      if (!startTicks) throw new Error('provider child process identity could not be durably attested');
      record.processPid = processPid;
      record.processStartTicks = startTicks;
      record.bindingState = 'owned-child';
    } else {
      record.processPid = null;
      record.processStartTicks = null;
      record.bindingState = 'attested-processless';
    }
    // The admission claim owns the authoritative pre-start inventory. Session
    // binding may happen later with a differently shaped, provider-local
    // snapshot, so omission preserves the admission baseline and a new value
    // can only fill a previously missing baseline. Only an explicit null opts
    // into fail-closed baseline removal.
    if (Object.prototype.hasOwnProperty.call(options, 'baselineFingerprint')) {
      if (options.baselineFingerprint === null) {
        record.baselineDigest = null;
      } else if (!record.baselineDigest && options.baselineFingerprint) {
        record.baselineDigest = digest(key, 'baseline', options.baselineFingerprint);
      }
    }
    if (typeof options.reviewAfterMs === 'number') {
      record.reviewAfter = new Date(Date.now() + Math.max(60_000, options.reviewAfterMs)).toISOString();
    }
    record.updatedAt = new Date().toISOString();
    atomicWriteLedger(ledgerPath, ledger);
  });
}

export function markProviderCredentialLifecycle(
  claim: ClaimedProviderCredentialLifecycle,
  state: ProviderCredentialLifecycleState,
  currentFingerprint?: string | null,
): void {
  withLedgerLock((ledgerPath, ledger, key) => {
    const record = ledger.records[claim.namespace];
    if (!record || record.leaseId !== claim.leaseId) return;
    record.state = state;
    record.currentDigest = currentFingerprint ? digest(key, 'current', currentFingerprint) : record.currentDigest;
    record.updatedAt = new Date().toISOString();
    atomicWriteLedger(ledgerPath, ledger);
  });
}

export function releaseProviderCredentialLifecycle(claim: ClaimedProviderCredentialLifecycle): void {
  withLedgerLock((ledgerPath, ledger) => {
    const record = ledger.records[claim.namespace];
    if (!record || record.leaseId !== claim.leaseId) return;
    delete ledger.records[claim.namespace];
    atomicWriteLedger(ledgerPath, ledger);
  });
}

/** Park an indeterminate removal after its request has settled. */
export function parkProviderCredentialRemovalLifecycle(claim: ClaimedProviderCredentialLifecycle): void {
  withLedgerLock((ledgerPath, ledger) => {
    const record = ledger.records[claim.namespace];
    if (!record || record.leaseId !== claim.leaseId) return;
    if (!record.namespace.startsWith(PROVIDER_REMOVAL_FENCE_PREFIX)) return;
    record.state = 'indeterminate';
    record.processPid = null;
    record.processStartTicks = null;
    record.bindingState = 'attested-processless';
    record.updatedAt = new Date().toISOString();
    atomicWriteLedger(ledgerPath, ledger);
  });
}

/** Clear only after an independent control plane has verified credential removal. */
/**
 * Owner-initiated recovery from a stuck credential lifecycle. A failed sign-in
 * can leave a terminal record (committed/indeterminate/error, or a parked
 * removal fence) that makes every retry throw PROVIDER_CREDENTIAL_LIFECYCLE_
 * CONFLICT — the operator is told to "remove or verify it" but has no way to.
 *
 * This clears the record (and any removal fence) only when the SAME owner asks
 * and no live authorization child still owns it. It does not touch the
 * credential itself; the operator's fresh sign-in overwrites that. Refuses if a
 * child process is still alive, so an in-flight operation is never clobbered.
 */
export function resetStuckProviderCredentialLifecycle(
  namespace: string,
  ownerId: string,
): { cleared: boolean; reason: 'cleared' | 'none' | 'owner_mismatch' | 'process_alive' } {
  return withLedgerLock((ledgerPath, ledger, key) => {
    const record = ledger.records[namespace];
    const fenceNamespace = providerRemovalFenceNamespace(namespace);
    const fence = ledger.records[fenceNamespace];
    if (!record && !fence) return { cleared: false, reason: 'none' as const };

    const ownerDigest = digest(key, 'owner', ownerId);
    for (const candidate of [record, fence]) {
      if (candidate && candidate.ownerDigest !== ownerDigest) {
        return { cleared: false, reason: 'owner_mismatch' as const };
      }
      if (candidate && providerCredentialLifecycleProcessState(candidate) === 'alive') {
        return { cleared: false, reason: 'process_alive' as const };
      }
    }

    if (record) delete ledger.records[namespace];
    if (fence) delete ledger.records[fenceNamespace];
    atomicWriteLedger(ledgerPath, ledger);
    return { cleared: true, reason: 'cleared' as const };
  });
}

export function clearProviderCredentialLifecycleAfterVerifiedRemoval(
  namespace: string,
  expectedLeaseId: string,
): boolean {
  if (!UUID_PATTERN.test(expectedLeaseId)) return false;
  return withLedgerLock((ledgerPath, ledger) => {
    const record = ledger.records[namespace];
    if (!record) return false;
    if (record.leaseId !== expectedLeaseId) return false;
    delete ledger.records[namespace];
    atomicWriteLedger(ledgerPath, ledger);
    return true;
  });
}

/**
 * Explicit disconnect/removal recovery. The caller supplies a combined-domain
 * proof covering every credential store serialized by the namespace. A
 * lifecycle can be cleared only after its exact child has exited and three
 * stable reads prove either absolute absence or restoration to the HMAC'd
 * pre-admission baseline. Baseline-less records require absolute absence.
 */
export async function verifyAndClearProviderCredentialLifecycleAfterRemoval(
  namespace: string,
  readProof: () => Promise<ProviderCredentialLifecycleFingerprintProof>,
  options: {
    delay?: (milliseconds: number) => Promise<unknown>;
    stableReads?: number;
    intervalMs?: number;
  } = {},
): Promise<boolean> {
  const record = getProviderCredentialLifecycleRecord(namespace);
  if (!record) return true;
  // Unbound records may have a surviving child that crashed Portal before the
  // PID fsync. Do not clear them from credential reads alone.
  if (record.bindingState === 'unbound') return false;
  if (record.bindingState === 'owned-child'
    && providerCredentialLifecycleProcessState(record) !== 'exited') return false;

  const stableReads = Math.max(2, options.stableReads ?? 3);
  const intervalMs = Math.max(1, options.intervalMs ?? 150);
  const delay = options.delay || ((milliseconds: number) => new Promise((resolve) => setTimeout(resolve, milliseconds)));
  let previous: string | null = null;
  let absoluteAbsence = true;
  try {
    for (let index = 0; index < stableReads; index += 1) {
      const proof = await readProof();
      if (!proof.fingerprint) throw new Error('credential-domain proof is missing its fingerprint');
      if (previous !== null && proof.fingerprint !== previous) return false;
      previous = proof.fingerprint;
      absoluteAbsence = absoluteAbsence && proof.absent;
      if (index + 1 < stableReads) await delay(intervalMs);
    }
  } catch {
    markProviderCredentialLifecycle({ namespace, leaseId: record.leaseId }, 'indeterminate');
    return false;
  }

  const restoredBaseline = previous !== null
    && attestProviderCredentialLifecycleFingerprint(namespace, previous, record.leaseId) === 'unchanged';
  if (!absoluteAbsence && !restoredBaseline) return false;
  return clearProviderCredentialLifecycleAfterVerifiedRemoval(namespace, record.leaseId);
}


/**
 * Release a destructive-operation fence only after stable, target-specific
 * absence. The exact lease check prevents a delayed verifier from deleting a
 * successor operation after restart or explicit recovery.
 */
export async function verifyAndReleaseProviderCredentialRemovalLifecycle(
  claim: ClaimedProviderCredentialLifecycle,
  targetNamespace: string,
  readProof: () => Promise<ProviderCredentialLifecycleFingerprintProof>,
  options: {
    delay?: (milliseconds: number) => Promise<unknown>;
    stableReads?: number;
    intervalMs?: number;
    expectedPresence?: 'absent' | 'present';
    proofCredentialScope: ProviderCredentialLifecycleCredentialScope;
    completionReceipt?: {
      ownerId: string;
      operationId: string;
      requestFingerprint: string;
      resultFingerprint: string;
      receiptTtlMs?: number;
    };
  },
): Promise<boolean> {
  if (claim.namespace !== providerRemovalFenceNamespace(targetNamespace)) return false;
  const record = getProviderCredentialLifecycleRecord(claim.namespace);
  if (!record || record.leaseId !== claim.leaseId) return false;
  if (!credentialScopeCovers(options.proofCredentialScope, record.credentialScope)) return false;

  const stableReads = Math.max(2, options.stableReads ?? 3);
  const intervalMs = Math.max(1, options.intervalMs ?? 150);
  const delay = options.delay || ((milliseconds: number) => new Promise((resolve) => setTimeout(resolve, milliseconds)));
  let previous: string | null = null;
  const expectedPresence = options.expectedPresence || 'absent';
  try {
    for (let index = 0; index < stableReads; index += 1) {
      const proof = await readProof();
      if (!proof.fingerprint) return false;
      if (expectedPresence === 'absent' ? !proof.absent : proof.absent) return false;
      if (previous !== null && previous !== proof.fingerprint) return false;
      previous = proof.fingerprint;
      if (index + 1 < stableReads) await delay(intervalMs);
    }
  } catch {
    return false;
  }
  return withLedgerLock((ledgerPath, ledger, key, database) => {
    const fence = ledger.records[claim.namespace];
    if (!fence || fence.leaseId !== claim.leaseId) return false;
    const expectedTargetLeaseId = Object.prototype.hasOwnProperty.call(claim, 'targetLeaseId')
      ? claim.targetLeaseId
      : fence.removalTargetLeaseId;
    const expectedTargetCredentialScope = Object.prototype.hasOwnProperty.call(claim, 'targetCredentialScope')
      ? claim.targetCredentialScope
      : fence.removalTargetCredentialScope;
    if (expectedTargetLeaseId !== fence.removalTargetLeaseId
      || expectedTargetCredentialScope !== fence.removalTargetCredentialScope) return false;
    const target = ledger.records[targetNamespace];
    if (expectedTargetLeaseId !== null && expectedTargetLeaseId !== undefined) {
      if (!UUID_PATTERN.test(expectedTargetLeaseId)) return false;
      if (!target
        || target.leaseId !== expectedTargetLeaseId
        || target.credentialScope !== expectedTargetCredentialScope) return false;
      // Same removability rule the removal claim used. Held in one predicate so
      // the claim and release paths cannot drift or strand an admitted removal.
      if (!providerCredentialLifecycleSafelyRemovable(target)) return false;
      // A scoped removal may prove OpenClaw/Portal absent while a native or
      // otherwise broader lifecycle still exists. Release the operation fence,
      // but never erase ownership evidence outside the proof surface.
      if (credentialScopeCovers(options.proofCredentialScope, target.credentialScope)) {
        delete ledger.records[targetNamespace];
      }
    } else if (target) {
      // A lifecycle appeared despite the fence. Never clear an ownership record
      // that was not part of this removal's atomic admission snapshot.
      return false;
    }
    if (options.completionReceipt) {
      const receipt = options.completionReceipt;
      if (!UUID_PATTERN.test(receipt.operationId)
        || fence.ownerDigest !== digest(key, 'owner', receipt.ownerId)
        || fence.requestDigest !== digest(key, 'request', receipt.requestFingerprint)
        || fence.currentDigest !== digest(key, 'operation-id', receipt.operationId)) {
        throw ownershipChangedMessage();
      }
      const operationIdDigest = digest(key, 'operation-id', receipt.operationId);
      const expectedReceipt = {
        namespaceDigest: digest(key, 'operation-namespace', targetNamespace),
        ownerDigest: digest(key, 'owner', receipt.ownerId),
        requestDigest: digest(key, 'request', receipt.requestFingerprint),
        resultDigest: digest(key, 'result', receipt.resultFingerprint),
      };
      const existingReceipt = database.prepare(`
        SELECT namespace_digest, owner_digest, request_digest, result_digest
        FROM operation_receipts WHERE operation_id_digest = ?
      `).all(operationIdDigest)[0];
      if (existingReceipt) {
        const exact = existingReceipt.namespace_digest === expectedReceipt.namespaceDigest
          && existingReceipt.owner_digest === expectedReceipt.ownerDigest
          && existingReceipt.request_digest === expectedReceipt.requestDigest
          && existingReceipt.result_digest === expectedReceipt.resultDigest;
        if (!exact) {
          throw new DurableCredentialOperationEnvelopeMismatchError(
            'This credential-operation UUID already completed with a different envelope.',
          );
        }
      } else {
        const now = new Date();
        database.prepare(`
          INSERT INTO operation_receipts (
            operation_id_digest, namespace_digest, owner_digest, request_digest,
            result_digest, completed_at, expires_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?)
        `).run(
          operationIdDigest,
          expectedReceipt.namespaceDigest,
          expectedReceipt.ownerDigest,
          expectedReceipt.requestDigest,
          expectedReceipt.resultDigest,
          now.toISOString(),
          new Date(now.getTime() + Math.min(
            24 * 60 * 60 * 1000,
            Math.max(60_000, receipt.receiptTtlMs ?? 30 * 60 * 1000),
          )).toISOString(),
        );
      }
    }
    delete ledger.records[claim.namespace];
    atomicWriteLedger(ledgerPath, ledger);
    return true;
  });
}

export function __setProviderCredentialLifecycleLedgerPathForTests(value: string | null): void {
  testLedgerPath = value;
}

export function __readProviderCredentialLifecycleLedgerForTests(): ProviderCredentialLifecycleLedgerFile {
  return withLedgerLock((_ledgerPath, ledger) => ({
    version: 1,
    records: Object.fromEntries(
      Object.entries(ledger.records).map(([namespace, record]) => [namespace, { ...record }]),
    ),
  }));
}

export function __clearProviderCredentialLifecycleLedgerForTests(): void {
  const ledgerPath = defaultLedgerPath();
  for (const candidate of [ledgerPath, `${ledgerPath}.key`, `${ledgerPath}-journal`, `${ledgerPath}-wal`, `${ledgerPath}-shm`]) {
    try { fs.unlinkSync(candidate); } catch {}
  }
}
