import fs from 'fs';
import os from 'os';
import path from 'path';
import { spawn } from 'child_process';
const { DatabaseSync } = require('node:sqlite');
import {
  __clearProviderCredentialLifecycleLedgerForTests,
  __readProviderCredentialLifecycleLedgerForTests,
  __setProviderCredentialLifecycleLedgerPathForTests,
  attestProviderCredentialLifecycleFingerprint,
  bindProviderCredentialLifecycle,
  claimProviderCredentialLifecycle,
  claimProviderCredentialRemovalOperationLifecycle,
  claimProviderCredentialRemovalLifecycle,
  claimProviderCredentialWriteLifecycle,
  clearProviderCredentialLifecycleAfterVerifiedRemoval,
  completeProviderCredentialWriteLifecycle,
  DurableCredentialLifecycleConflictError,
  DurableCredentialOperationEnvelopeMismatchError,
  DurableCredentialOperationRetainedEnvelopeMismatchError,
  DurableCredentialLifecycleRecoveryRequiredError,
  DurableCredentialLifecycleUnavailableError,
  getProviderCredentialLifecycleRecord,
  markProviderCredentialLifecycle,
  parkProviderCredentialRemovalLifecycle,
  providerCredentialLifecycleProcessState,
  reconcileProviderCredentialLifecycleBeforeAdmission,
  releaseProviderCredentialLifecycle,
  resetStuckProviderCredentialLifecycle,
  setProviderCredentialWriteAdmissionBaseline,
  verifyAndClearProviderCredentialLifecycleAfterRemoval,
  verifyAndReleaseProviderCredentialRemovalLifecycle,
  verifyProviderCredentialWriteCompletionReceipt,
} from './providerCredentialLifecycleLedger';

describe('provider credential lifecycle ledger', () => {
  let root: string;
  let ledgerPath: string;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'portal-provider-lifecycle-'));
    fs.chmodSync(root, 0o700);
    ledgerPath = path.join(root, 'ledger.sqlite3');
    __setProviderCredentialLifecycleLedgerPathForTests(ledgerPath);
  });

  afterEach(() => {
    __clearProviderCredentialLifecycleLedgerForTests();
    __setProviderCredentialLifecycleLedgerPathForTests(null);
    fs.rmSync(root, { recursive: true, force: true });
  });

  function makeRecordedProcessExited(namespace: string): void {
    const database = new DatabaseSync(ledgerPath);
    try {
      database.prepare('UPDATE lifecycle_records SET process_start_ticks = ? WHERE namespace = ?')
        .run('999999999999999999', namespace);
    } finally {
      database.close();
    }
  }

  test('narrows a world-readable ledger directory instead of refusing provider setup', () => {
    // `backend/.data` ships in the release tree and is extracted under
    // the installer umask, so on a real install it is 0755. Refusing there made
    // every provider OAuth attempt fail with "permissions are too broad".
    const shipped = fs.mkdtempSync(path.join(os.tmpdir(), 'portal-shipped-data-'));
    fs.chmodSync(shipped, 0o755);
    __setProviderCredentialLifecycleLedgerPathForTests(path.join(shipped, 'ledger.sqlite3'));
    try {
      expect(() => claimProviderCredentialLifecycle(
        'openclaw:xai',
        'user:owner',
        'request',
        { baselineFingerprint: 'baseline', reviewAfterMs: 60_000 },
      )).not.toThrow();
      expect(fs.statSync(shipped).mode & 0o777).toBe(0o700);
    } finally {
      __clearProviderCredentialLifecycleLedgerForTests();
      fs.rmSync(shipped, { recursive: true, force: true });
      __setProviderCredentialLifecycleLedgerPathForTests(ledgerPath);
    }
  });

  test('still refuses a group- or world-writable ledger directory', () => {
    const loose = fs.mkdtempSync(path.join(os.tmpdir(), 'portal-loose-data-'));
    fs.chmodSync(loose, 0o777);
    __setProviderCredentialLifecycleLedgerPathForTests(path.join(loose, 'ledger.sqlite3'));
    try {
      expect(() => claimProviderCredentialLifecycle(
        'openclaw:xai',
        'user:owner',
        'request',
        { baselineFingerprint: 'baseline', reviewAfterMs: 60_000 },
      )).toThrow(/group- or world-writable/);
    } finally {
      __clearProviderCredentialLifecycleLedgerForTests();
      fs.rmSync(loose, { recursive: true, force: true });
      __setProviderCredentialLifecycleLedgerPathForTests(ledgerPath);
    }
  });

  test('persists only opaque lifecycle metadata with root-only atomic files', () => {
    const claim = claimProviderCredentialLifecycle(
      'openclaw:openai',
      'user:private-owner-id',
      'request-containing-private-project',
      { baselineFingerprint: 'profile-id:secret-token', reviewAfterMs: 60_000 },
    );
    bindProviderCredentialLifecycle(claim, 'oauth_private_session', {
      binding: { kind: 'owned-child', processPid: process.pid },
      baselineFingerprint: 'another-private-baseline',
    });

    const serialized = fs.readFileSync(ledgerPath, 'utf8');
    expect(serialized).not.toContain('private-owner-id');
    expect(serialized).not.toContain('private-project');
    expect(serialized).not.toContain('secret-token');
    expect(serialized).not.toContain('oauth_private_session');
    expect(fs.statSync(ledgerPath).mode & 0o777).toBe(0o600);
    expect(fs.statSync(`${ledgerPath}.key`).mode & 0o777).toBe(0o600);
    expect(fs.statSync(root).mode & 0o777).toBe(0o700);
  });

  test('session/process binding with no baseline option preserves the admission baseline', () => {
    const claim = claimProviderCredentialLifecycle('credential-domain:openai', 'user:one', 'request', {
      baselineFingerprint: 'provider-domain-before',
      reviewAfterMs: 60_000,
    });
    bindProviderCredentialLifecycle(claim, 'session', { binding: { kind: 'owned-child', processPid: process.pid } });
    expect(attestProviderCredentialLifecycleFingerprint(
      'credential-domain:openai',
      'provider-domain-before',
      claim.leaseId,
    ))
      .toBe('unchanged');
  });

  test('owner reset clears a stuck committed lifecycle so a fresh sign-in can start', () => {
    const namespace = 'credential-domain:openclaw:xai';
    const claim = claimProviderCredentialLifecycle(namespace, 'user:one', 'stuck-request', {
      baselineFingerprint: 'before',
    });
    // Simulate the stuck terminal state a failed xAI finalization leaves behind.
    markProviderCredentialLifecycle(claim, 'committed', 'partial-xai-credential');
    expect(getProviderCredentialLifecycleRecord(namespace)).not.toBeNull();

    // A different account cannot clear it.
    expect(resetStuckProviderCredentialLifecycle(namespace, 'user:two'))
      .toEqual({ cleared: false, reason: 'owner_mismatch' });

    // The owner clears it; the record is gone and a fresh claim now succeeds.
    expect(resetStuckProviderCredentialLifecycle(namespace, 'user:one'))
      .toEqual({ cleared: true, reason: 'cleared' });
    expect(getProviderCredentialLifecycleRecord(namespace)).toBeNull();
    expect(() => claimProviderCredentialLifecycle(namespace, 'user:one', 'fresh-request', {
      baselineFingerprint: 'before',
    })).not.toThrow();
  });

  test('owner reset refuses to clobber a lifecycle whose child is still alive', () => {
    const namespace = 'credential-domain:openclaw:xai';
    const claim = claimProviderCredentialLifecycle(namespace, 'user:one', 'live-request', {
      baselineFingerprint: 'before',
    });
    bindProviderCredentialLifecycle(claim, 'session', {
      binding: { kind: 'owned-child', processPid: process.pid },
    });
    expect(resetStuckProviderCredentialLifecycle(namespace, 'user:one'))
      .toEqual({ cleared: false, reason: 'process_alive' });
    expect(getProviderCredentialLifecycleRecord(namespace)).not.toBeNull();
  });

  test('owner reset on a clean namespace reports nothing to clear', () => {
    expect(resetStuckProviderCredentialLifecycle('credential-domain:openclaw:xai', 'user:one'))
      .toEqual({ cleared: false, reason: 'none' });
  });

  test('survives process-memory loss and refuses both exact and conflicting duplicate admission', () => {
    claimProviderCredentialLifecycle('native:codex', 'user:one', 'same-request', {
      baselineFingerprint: 'before',
    });

    expect(() => claimProviderCredentialLifecycle('native:codex', 'user:one', 'same-request'))
      .toThrow(DurableCredentialLifecycleRecoveryRequiredError);
    expect(() => claimProviderCredentialLifecycle('native:codex', 'user:two', 'different-request'))
      .toThrow(DurableCredentialLifecycleConflictError);
  });

  test('requires post-deadline stable absence and marks inventory drift committed', async () => {
    const unchangedClaim = claimProviderCredentialLifecycle('openclaw:openai', 'user:one', 'request', {
      baselineFingerprint: 'empty',
      reviewAfterMs: 60_000,
    });
    bindProviderCredentialLifecycle(unchangedClaim, 'first-session', { binding: { kind: 'owned-child', processPid: process.pid } });
    makeRecordedProcessExited('openclaw:openai');
    const future = Date.now() + 61_000;
    const reads = jest.fn().mockResolvedValue('empty');
    await reconcileProviderCredentialLifecycleBeforeAdmission('openclaw:openai', reads, {
      now: () => future,
      delay: async () => undefined,
      stableReads: 3,
    });
    expect(reads).toHaveBeenCalledTimes(3);
    expect(getProviderCredentialLifecycleRecord('openclaw:openai')).toBeNull();

    const changedClaim = claimProviderCredentialLifecycle('openclaw:openai', 'user:one', 'request', {
      baselineFingerprint: 'empty',
      reviewAfterMs: 60_000,
    });
    bindProviderCredentialLifecycle(changedClaim, 'second-session', { binding: { kind: 'owned-child', processPid: process.pid } });
    makeRecordedProcessExited('openclaw:openai');
    await expect(reconcileProviderCredentialLifecycleBeforeAdmission(
      'openclaw:openai',
      async () => 'credential-committed',
      { now: () => future, delay: async () => undefined },
    )).rejects.toThrow(DurableCredentialLifecycleConflictError);
    expect(getProviderCredentialLifecycleRecord('openclaw:openai')?.state).toBe('committed');
  });

  test('verified stable credential removal clears a committed native domain for fresh admission', async () => {
    const namespace = 'credential-domain:openai';
    const claim = claimProviderCredentialLifecycle(namespace, 'user:one', 'native-codex', {
      baselineFingerprint: 'credential-present-before-reauth',
      reviewAfterMs: 60_000,
    });
    bindProviderCredentialLifecycle(claim, 'native-session', { binding: { kind: 'owned-child', processPid: process.pid } });
    makeRecordedProcessExited(namespace);
    markProviderCredentialLifecycle(claim, 'committed', 'credential-rotated');

    await reconcileProviderCredentialLifecycleBeforeAdmission(
      namespace,
      async () => ({ fingerprint: 'verified-empty-native-and-openclaw-domain', absent: true }),
      {
        now: () => Date.now() + 61_000,
        delay: async () => undefined,
        stableReads: 3,
      },
    );
    expect(getProviderCredentialLifecycleRecord(namespace)).toBeNull();
    expect(() => claimProviderCredentialLifecycle(namespace, 'user:one', 'fresh-native-codex'))
      .not.toThrow();
  });

  test('OpenClaw-only disconnect cannot clear a native-owned shared domain', async () => {
    const namespace = 'credential-domain:openai';
    const claim = claimProviderCredentialLifecycle(namespace, 'user:one', 'native-codex', {
      baselineFingerprint: 'combined-before',
    });
    markProviderCredentialLifecycle(claim, 'committed', 'native-credential-changed');

    await expect(verifyAndClearProviderCredentialLifecycleAfterRemoval(
      namespace,
      async () => ({
        fingerprint: 'openclaw-empty-but-native-still-present',
        absent: false,
      }),
      { delay: async () => undefined },
    )).resolves.toBe(false);
    expect(getProviderCredentialLifecycleRecord(namespace)?.state).toBe('committed');
  });

  test('explicit removal clears on stable baseline restoration but never while the owned child is live', async () => {
    const namespace = 'credential-domain:google';
    const claim = claimProviderCredentialLifecycle(namespace, 'user:one', 'google-oauth', {
      baselineFingerprint: 'preexisting-native-gemini',
    });
    bindProviderCredentialLifecycle(claim, 'session', { binding: { kind: 'owned-child', processPid: process.pid } });
    markProviderCredentialLifecycle(claim, 'committed', 'changed-during-oauth');
    const proof = async () => ({ fingerprint: 'preexisting-native-gemini', absent: false });

    await expect(verifyAndClearProviderCredentialLifecycleAfterRemoval(
      namespace,
      proof,
      { delay: async () => undefined },
    )).resolves.toBe(false);
    expect(getProviderCredentialLifecycleRecord(namespace)).not.toBeNull();

    makeRecordedProcessExited(namespace);
    await expect(verifyAndClearProviderCredentialLifecycleAfterRemoval(
      namespace,
      proof,
      { delay: async () => undefined },
    )).resolves.toBe(true);
    expect(getProviderCredentialLifecycleRecord(namespace)).toBeNull();
  });

  test.each([
    ['ordinary OAuth', 'openclaw:openai', 'oauth-provider-baseline', 'generic-oauth-session-shape'],
    ['device OAuth', 'openclaw:github-copilot', 'device-provider-baseline', 'generic-device-session-shape'],
    ['native CLI', 'native:codex', 'native-provider-baseline', 'generic-native-session-shape'],
    ['Claude setup-token', 'openclaw:anthropic', 'claude-combined-store-baseline', 'generic-claude-session-shape'],
  ])('preserves the claim-time baseline and releases unchanged %s after restart', async (
    _label,
    namespace,
    providerBaseline,
    incompatibleBindBaseline,
  ) => {
    const claim = claimProviderCredentialLifecycle(namespace, 'user:one', 'request', {
      baselineFingerprint: providerBaseline,
      reviewAfterMs: 60_000,
    });
    bindProviderCredentialLifecycle(claim, 'session-after-start', {
      binding: { kind: 'owned-child', processPid: process.pid },
      baselineFingerprint: incompatibleBindBaseline,
    });
    makeRecordedProcessExited(namespace);

    expect(attestProviderCredentialLifecycleFingerprint(namespace, providerBaseline, claim.leaseId)).toBe('unchanged');
    expect(attestProviderCredentialLifecycleFingerprint(namespace, incompatibleBindBaseline, claim.leaseId)).toBe('changed');

    await reconcileProviderCredentialLifecycleBeforeAdmission(
      namespace,
      async () => providerBaseline,
      {
        now: () => Date.now() + 61_000,
        delay: async () => undefined,
      },
    );
    expect(getProviderCredentialLifecycleRecord(namespace)).toBeNull();
  });

  test('never signals a live recorded process before its visibility deadline', async () => {
    const claim = claimProviderCredentialLifecycle('openclaw:anthropic', 'user:one', 'request', {
      baselineFingerprint: 'before',
      reviewAfterMs: 60_000,
    });
    bindProviderCredentialLifecycle(claim, 'session', { binding: { kind: 'owned-child', processPid: process.pid } });
    const signalProcess = jest.fn();

    await expect(reconcileProviderCredentialLifecycleBeforeAdmission(
      'openclaw:anthropic',
      async () => 'before',
      {
        now: () => Date.now(),
        processStillAlive: () => true,
        signalProcess,
      },
    )).rejects.toThrow(DurableCredentialLifecycleRecoveryRequiredError);
    expect(signalProcess).not.toHaveBeenCalled();
  });

  test('stops an expired owned process before stable absence releases its lifecycle', async () => {
    const claim = claimProviderCredentialLifecycle('native:gemini', 'user:one', 'request', {
      baselineFingerprint: 'before',
      reviewAfterMs: 60_000,
    });
    bindProviderCredentialLifecycle(claim, 'session', { binding: { kind: 'owned-child', processPid: process.pid } });
    let alive = true;
    const signals: string[] = [];

    await reconcileProviderCredentialLifecycleBeforeAdmission(
      'native:gemini',
      async () => 'before',
      {
        now: () => Date.now() + 61_000,
        processStillAlive: () => alive,
        signalProcess: (_pid, _ticks, signal) => { signals.push(signal); },
        delay: async () => { alive = false; },
        stableReads: 3,
        intervalMs: 1,
      },
    );

    expect(signals).toEqual(['SIGTERM']);
    expect(getProviderCredentialLifecycleRecord('native:gemini')).toBeNull();
  });

  test('retains an expired lifecycle when its exact recorded process will not stop', async () => {
    const claim = claimProviderCredentialLifecycle('native:grok', 'user:one', 'request', {
      baselineFingerprint: 'before',
      reviewAfterMs: 60_000,
    });
    bindProviderCredentialLifecycle(claim, 'session', { binding: { kind: 'owned-child', processPid: process.pid } });
    const signals: string[] = [];

    await expect(reconcileProviderCredentialLifecycleBeforeAdmission(
      'native:grok',
      async () => 'before',
      {
        now: () => Date.now() + 61_000,
        processStillAlive: () => true,
        signalProcess: (_pid, _ticks, signal) => { signals.push(signal); },
        delay: async () => undefined,
        termWaitMs: 0,
        killWaitMs: 0,
      },
    )).rejects.toThrow(DurableCredentialLifecycleRecoveryRequiredError);

    expect(signals).toEqual(['SIGTERM', 'SIGKILL']);
    expect(getProviderCredentialLifecycleRecord('native:grok')?.state).toBe('indeterminate');
  });

  test('treats read failure and unstable proof as indeterminate', async () => {
    claimProviderCredentialLifecycle('openclaw:github-copilot', 'user:one', 'request', {
      baselineFingerprint: 'empty',
      reviewAfterMs: 60_000,
    });
    await expect(reconcileProviderCredentialLifecycleBeforeAdmission(
      'openclaw:github-copilot',
      async () => { throw new Error('store unavailable'); },
      { now: () => Date.now() + 61_000, delay: async () => undefined },
    )).rejects.toThrow(DurableCredentialLifecycleRecoveryRequiredError);
    expect(getProviderCredentialLifecycleRecord('openclaw:github-copilot')?.state).toBe('indeterminate');
  });

  test('uses process start ticks so PID reuse cannot be mistaken for the owned child', () => {
    const claim = claimProviderCredentialLifecycle('native:grok', 'user:one', 'request', {
      baselineFingerprint: 'empty',
    });
    bindProviderCredentialLifecycle(claim, 'session', { binding: { kind: 'owned-child', processPid: process.pid } });
    expect(providerCredentialLifecycleProcessState(getProviderCredentialLifecycleRecord('native:grok')!)).toBe('alive');

    makeRecordedProcessExited('native:grok');
    expect(providerCredentialLifecycleProcessState(getProviderCredentialLifecycleRecord('native:grok')!)).toBe('exited');
  });

  test('uses SQLite kernel serialization so a live transaction cannot be reclaimed or delete its successor', () => {
    __readProviderCredentialLifecycleLedgerForTests();
    const predecessor = new DatabaseSync(ledgerPath);
    predecessor.exec('PRAGMA busy_timeout = 0; BEGIN IMMEDIATE');
    expect(() => claimProviderCredentialLifecycle('native:gemini', 'user:one', 'request'))
      .toThrow(DurableCredentialLifecycleUnavailableError);
    // Closing without commit simulates owner death. SQLite rolls back the exact
    // transaction; there is no path-based stale lock for a reclaimer to rename
    // over a live successor.
    predecessor.close();
    const successor = claimProviderCredentialLifecycle('native:gemini', 'user:one', 'request');
    expect(getProviderCredentialLifecycleRecord('native:gemini')?.leaseId).toBe(successor.leaseId);
  });

  test.each([
    ['database only', 'key'],
    ['key only', 'database'],
  ])('fails closed when the durable pair is incomplete: %s', (_label, remove) => {
    __readProviderCredentialLifecycleLedgerForTests();
    fs.unlinkSync(remove === 'key' ? `${ledgerPath}.key` : ledgerPath);
    expect(() => getProviderCredentialLifecycleRecord('credential-domain:openai'))
      .toThrow(DurableCredentialLifecycleUnavailableError);
  });

  test('fails closed for a wrong key, malformed database, missing schema, and oversized database', () => {
    __readProviderCredentialLifecycleLedgerForTests();
    fs.writeFileSync(`${ledgerPath}.key`, Buffer.alloc(32, 0x5a), { mode: 0o600 });
    expect(() => getProviderCredentialLifecycleRecord('credential-domain:openai'))
      .toThrow(DurableCredentialLifecycleUnavailableError);

    __clearProviderCredentialLifecycleLedgerForTests();
    __readProviderCredentialLifecycleLedgerForTests();
    fs.writeFileSync(ledgerPath, Buffer.alloc(0), { mode: 0o600 });
    expect(() => getProviderCredentialLifecycleRecord('credential-domain:openai'))
      .toThrow(DurableCredentialLifecycleUnavailableError);

    __clearProviderCredentialLifecycleLedgerForTests();
    __readProviderCredentialLifecycleLedgerForTests();
    const missingSchema = new DatabaseSync(ledgerPath);
    missingSchema.exec('DROP TABLE lifecycle_records');
    missingSchema.close();
    expect(() => getProviderCredentialLifecycleRecord('credential-domain:openai'))
      .toThrow(DurableCredentialLifecycleUnavailableError);

    __clearProviderCredentialLifecycleLedgerForTests();
    __readProviderCredentialLifecycleLedgerForTests();
    fs.truncateSync(ledgerPath, (16 * 1024 * 1024) + 1);
    expect(() => getProviderCredentialLifecycleRecord('credential-domain:openai'))
      .toThrow(DurableCredentialLifecycleUnavailableError);
  });

  test('recovers a real hot journal after the SQLite writer is SIGKILLed mid-transaction', async () => {
    const claim = claimProviderCredentialLifecycle('credential-domain:openai', 'user:one', 'request');
    const script = `
      const { DatabaseSync } = require('node:sqlite');
      const database = new DatabaseSync(process.argv[1]);
      database.exec('PRAGMA journal_mode = DELETE; PRAGMA synchronous = FULL; BEGIN IMMEDIATE');
      database.prepare('UPDATE lifecycle_records SET state = ? WHERE namespace = ?')
        .run('committed', 'credential-domain:openai');
      process.stdout.write('ready\\n');
      setInterval(() => {}, 1000);
    `;
    const child = spawn(process.execPath, ['-e', script, ledgerPath], {
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    await new Promise<void>((resolve, reject) => {
      let stderr = '';
      child.stderr?.on('data', (chunk) => { stderr += String(chunk); });
      child.once('error', reject);
      child.stdout?.once('data', (chunk) => {
        if (!String(chunk).includes('ready')) reject(new Error(`child did not enter transaction: ${stderr}`));
        else resolve();
      });
    });
    child.kill('SIGKILL');
    await new Promise<void>((resolve) => child.once('close', () => resolve()));

    expect(getProviderCredentialLifecycleRecord(claim.namespace)).toMatchObject({
      leaseId: claim.leaseId,
      state: 'active',
    });
  });

  test('an older owner cannot release a successor lease', () => {
    const oldClaim = claimProviderCredentialLifecycle('native:claude-code', 'user:one', 'first');
    clearProviderCredentialLifecycleAfterVerifiedRemoval('native:claude-code', oldClaim.leaseId);
    const successor = claimProviderCredentialLifecycle('native:claude-code', 'user:two', 'second');
    expect(clearProviderCredentialLifecycleAfterVerifiedRemoval('native:claude-code', '')).toBe(false);
    releaseProviderCredentialLifecycle(oldClaim);
    expect(getProviderCredentialLifecycleRecord('native:claude-code')?.leaseId).toBe(successor.leaseId);
  });

  test('binding is monotonic and accepts only an exact idempotent retry', () => {
    const claim = claimProviderCredentialLifecycle('credential-domain:anthropic', 'user:one', 'request');
    bindProviderCredentialLifecycle(claim, 'session-one', { binding: { kind: 'attested-processless' } });
    expect(() => bindProviderCredentialLifecycle(
      claim,
      'session-one',
      { binding: { kind: 'attested-processless' } },
    )).not.toThrow();
    expect(() => bindProviderCredentialLifecycle(
      claim,
      'stale-session',
      { binding: { kind: 'owned-child', processPid: process.pid } },
    )).toThrow(DurableCredentialLifecycleRecoveryRequiredError);
    expect(getProviderCredentialLifecycleRecord(claim.namespace)).toMatchObject({
      bindingState: 'attested-processless',
      processPid: null,
    });
  });

  test('write completion receipts make lost-response retries exact and secret-free', () => {
    const operationId = '123e4567-e89b-42d3-a456-426614174000';
    const namespace = 'credential-domain:xai';
    const owner = 'user:private-owner';
    const requestFingerprint = 'request-derived-from-private-key';
    const resultFingerprint = 'xai:portal-api-key:model-x';
    const admission = claimProviderCredentialWriteLifecycle(
      namespace,
      owner,
      operationId,
      requestFingerprint,
      'openclaw-and-portal',
    );
    expect(admission.disposition).toBe('admitted');
    if (admission.disposition === 'completed') throw new Error('unexpected completion');

    completeProviderCredentialWriteLifecycle(
      admission.claim,
      owner,
      operationId,
      requestFingerprint,
      resultFingerprint,
    );
    const database = new DatabaseSync(ledgerPath);
    try {
      database.prepare('UPDATE operation_receipts SET expires_at = ?').run('2000-01-01T00:00:00.000Z');
    } finally {
      database.close();
    }
    const completedRetry = claimProviderCredentialWriteLifecycle(
      namespace,
      owner,
      operationId,
      requestFingerprint,
      'openclaw-and-portal',
    );
    expect(completedRetry.disposition).toBe('completed');
    expect(verifyProviderCredentialWriteCompletionReceipt(
      namespace,
      owner,
      operationId,
      requestFingerprint,
      resultFingerprint,
    )).toBe(true);
    expect(verifyProviderCredentialWriteCompletionReceipt(
      namespace,
      owner,
      operationId,
      requestFingerprint,
      'different-result',
    )).toBe(false);
    const receiptReadbackFence = getProviderCredentialLifecycleRecord(completedRetry.claim.namespace);
    let completedMismatch: unknown;
    try {
      claimProviderCredentialWriteLifecycle(
        namespace,
        owner,
        operationId,
        'different-request',
        'openclaw-and-portal',
      );
    } catch (error) {
      completedMismatch = error;
    }
    expect(completedMismatch).toBeInstanceOf(DurableCredentialOperationEnvelopeMismatchError);
    expect(completedMismatch).not.toBeInstanceOf(DurableCredentialOperationRetainedEnvelopeMismatchError);
    expect(getProviderCredentialLifecycleRecord(completedRetry.claim.namespace)).toEqual(receiptReadbackFence);
    releaseProviderCredentialLifecycle(completedRetry.claim);

    const serialized = fs.readFileSync(ledgerPath, 'utf8');
    expect(serialized).not.toContain(operationId);
    expect(serialized).not.toContain('private-owner');
    expect(serialized).not.toContain('private-key');
    expect(serialized).not.toContain(resultFingerprint);
  });

  test('removal completion receipts are actor-bound, exact, permanent, and atomic with fence release', async () => {
    const operationId = '123e4567-e89b-42d3-a456-426614174099';
    const namespace = 'credential-domain:openrouter';
    const owner = 'user:removal-owner';
    const requestFingerprint = 'disconnect-openrouter-v1';
    const resultFingerprint = 'openrouter-disconnected-v1';
    const admission = claimProviderCredentialRemovalOperationLifecycle(
      namespace,
      owner,
      operationId,
      requestFingerprint,
      resultFingerprint,
      {
        operationKind: 'provider-removal-portal-api-key',
        operationCredentialScope: 'combined-domain',
      },
    );
    expect(admission.disposition).toBe('admitted');
    if (!admission.claim) throw new Error('unexpected completed replay');

    await expect(verifyAndReleaseProviderCredentialRemovalLifecycle(
      admission.claim,
      namespace,
      async () => ({ fingerprint: 'all-provider-surfaces-empty', absent: true }),
      {
        delay: async () => undefined,
        stableReads: 2,
        proofCredentialScope: 'combined-domain',
        completionReceipt: {
          ownerId: owner,
          operationId,
          requestFingerprint,
          resultFingerprint,
        },
      },
    )).resolves.toBe(true);
    expect(getProviderCredentialLifecycleRecord(admission.claim.namespace)).toBeNull();

    const database = new DatabaseSync(ledgerPath);
    try {
      database.prepare('UPDATE operation_receipts SET expires_at = ? WHERE operation_id_digest IS NOT NULL')
        .run('2000-01-01T00:00:00.000Z');
    } finally {
      database.close();
    }
    expect(claimProviderCredentialRemovalOperationLifecycle(
      namespace,
      owner,
      operationId,
      requestFingerprint,
      resultFingerprint,
    )).toEqual({ disposition: 'completed', claim: null });
    expect(() => claimProviderCredentialRemovalOperationLifecycle(
      namespace,
      'user:different-owner',
      operationId,
      requestFingerprint,
      resultFingerprint,
    )).toThrow(DurableCredentialOperationEnvelopeMismatchError);
    expect(() => claimProviderCredentialRemovalOperationLifecycle(
      namespace,
      owner,
      operationId,
      'different-request',
      resultFingerprint,
    )).toThrow(DurableCredentialOperationEnvelopeMismatchError);

    const serialized = fs.readFileSync(ledgerPath, 'utf8');
    expect(serialized).not.toContain(operationId);
    expect(serialized).not.toContain('removal-owner');
    expect(serialized).not.toContain(requestFingerprint);
    expect(serialized).not.toContain(resultFingerprint);
  });

  test('a crashed write is recovered for readback and never admitted as a fresh secret write', () => {
    const operationId = '123e4567-e89b-42d3-a456-426614174001';
    const namespace = 'credential-domain:anthropic';
    const first = claimProviderCredentialWriteLifecycle(
      namespace,
      'user:owner',
      operationId,
      'setup-token-request',
      'openclaw-and-portal',
    );
    if (first.disposition === 'completed') throw new Error('unexpected completion');
    parkProviderCredentialRemovalLifecycle(first.claim);

    const retry = claimProviderCredentialWriteLifecycle(
      namespace,
      'user:owner',
      operationId,
      'setup-token-request',
      'openclaw-and-portal',
    );
    expect(retry.disposition).toBe('recovered');
    if (retry.disposition === 'completed') throw new Error('unexpected completion');
    expect(retry.claim.leaseId).not.toBe(first.claim.leaseId);
  });

  test.each(['live', 'parked'] as const)(
    'preserves a %s write fence when its retained UUID arrives with a changed envelope',
    (state) => {
      const operationId = '123e4567-e89b-42d3-a456-426614174010';
      const namespace = 'credential-domain:openai';
      const owner = 'user:owner';
      const first = claimProviderCredentialWriteLifecycle(
        namespace,
        owner,
        operationId,
        'original-request',
        'openclaw-and-portal',
      );
      if (first.disposition === 'completed') throw new Error('unexpected completion');
      if (state === 'parked') parkProviderCredentialRemovalLifecycle(first.claim);

      const retainedBefore = getProviderCredentialLifecycleRecord(first.claim.namespace);

      let mismatch: unknown;
      try {
        claimProviderCredentialWriteLifecycle(
          namespace,
          owner,
          operationId,
          'changed-request',
          'openclaw-and-portal',
        );
      } catch (error) {
        mismatch = error;
      }
      expect(mismatch).toBeInstanceOf(DurableCredentialOperationRetainedEnvelopeMismatchError);
      expect(mismatch).not.toBeInstanceOf(DurableCredentialOperationEnvelopeMismatchError);
      expect(getProviderCredentialLifecycleRecord(first.claim.namespace)).toEqual(retainedBefore);

      let freshError: unknown;
      try {
        claimProviderCredentialWriteLifecycle(
          namespace,
          owner,
          '123e4567-e89b-42d3-a456-426614174011',
          'changed-request',
          'openclaw-and-portal',
        );
      } catch (error) {
        freshError = error;
      }
      expect(freshError).toBeInstanceOf(DurableCredentialLifecycleConflictError);
      expect(freshError).not.toBeInstanceOf(DurableCredentialOperationEnvelopeMismatchError);

      // Once the original controller is parked, the exact retained UUID and
      // request can still recover the fence. The changed envelope never strands
      // the only recovery identity.
      if (state === 'live') parkProviderCredentialRemovalLifecycle(first.claim);
      const recovered = claimProviderCredentialWriteLifecycle(
        namespace,
        owner,
        operationId,
        'original-request',
        'openclaw-and-portal',
      );
      expect(recovered.disposition).toBe('recovered');
      expect(recovered.claim.leaseId).not.toBe(first.claim.leaseId);
    },
  );

  test('explicit removal can take over an abandoned write fence without manual ledger surgery', async () => {
    const operationId = '123e4567-e89b-42d3-a456-426614174003';
    const namespace = 'credential-domain:anthropic';
    const write = claimProviderCredentialWriteLifecycle(
      namespace,
      'user:writer',
      operationId,
      'setup-token-request',
      'openclaw-and-portal',
    );
    parkProviderCredentialRemovalLifecycle(write.claim);
    expect(() => claimProviderCredentialRemovalLifecycle(
      namespace,
      'user:remover',
      'disconnect-request',
    )).toThrow(DurableCredentialLifecycleConflictError);

    const removal = claimProviderCredentialRemovalLifecycle(
      namespace,
      'user:remover',
      'disconnect-request',
      { takeOverParkedWrite: true, operationCredentialScope: 'openclaw-and-portal' },
    );
    expect(getProviderCredentialLifecycleRecord(removal.namespace)).toMatchObject({
      lifecycleKind: 'provider-removal',
      state: 'active',
      credentialScope: 'openclaw-and-portal',
    });
    await expect(verifyAndReleaseProviderCredentialRemovalLifecycle(
      removal,
      namespace,
      async () => ({ fingerprint: 'absent', absent: true }),
      { stableReads: 2, delay: async () => undefined, proofCredentialScope: 'openclaw-and-portal' },
    )).resolves.toBe(true);
  });

  test('write admission binds its baseline only under the held fence and never replaces it', () => {
    const operationId = '123e4567-e89b-42d3-a456-426614174002';
    const namespace = 'credential-domain:anthropic';
    const first = claimProviderCredentialWriteLifecycle(
      namespace,
      'user:owner',
      operationId,
      'setup-token-request',
      'openclaw-and-portal',
    );
    expect(first.disposition).toBe('admitted');
    expect(attestProviderCredentialLifecycleFingerprint(
      first.claim.namespace,
      'inventory-before',
      first.claim.leaseId,
    )).toBe('unavailable');

    setProviderCredentialWriteAdmissionBaseline(first.claim, 'inventory-before');
    expect(attestProviderCredentialLifecycleFingerprint(
      first.claim.namespace,
      'inventory-before',
      first.claim.leaseId,
    )).toBe('unchanged');
    expect(() => setProviderCredentialWriteAdmissionBaseline(first.claim, 'inventory-from-another-writer'))
      .toThrow(DurableCredentialLifecycleRecoveryRequiredError);
  });

  test('final removal CAS retains a target that becomes active while proof is paused', async () => {
    const namespace = 'credential-domain:openai';
    const target = claimProviderCredentialLifecycle(namespace, 'user:start', 'request', {
      credentialScope: 'openclaw-and-portal',
    });
    bindProviderCredentialLifecycle(target, 'settled-session', { binding: { kind: 'attested-processless' } });
    markProviderCredentialLifecycle(target, 'committed', 'credential-present');
    const removal = claimProviderCredentialRemovalLifecycle(namespace, 'user:remove', 'remove', {
      operationCredentialScope: 'openclaw-and-portal',
    });
    let resume!: () => void;
    const paused = new Promise<void>((resolve) => { resume = resolve; });
    let entered!: () => void;
    const enteredRead = new Promise<void>((resolve) => { entered = resolve; });
    const verifier = verifyAndReleaseProviderCredentialRemovalLifecycle(
      removal,
      namespace,
      async () => {
        entered();
        await paused;
        return { fingerprint: 'openclaw-and-portal-empty', absent: true };
      },
      {
        delay: async () => undefined,
        stableReads: 2,
        proofCredentialScope: 'openclaw-and-portal',
      },
    );
    await enteredRead;
    markProviderCredentialLifecycle(target, 'active');
    resume();

    await expect(verifier).resolves.toBe(false);
    expect(getProviderCredentialLifecycleRecord(namespace)?.leaseId).toBe(target.leaseId);
    expect(getProviderCredentialLifecycleRecord(removal.namespace)?.leaseId).toBe(removal.leaseId);
  });

  test('an old async verifier cannot clear a successor lease after an ABA replacement', async () => {
    const namespace = 'credential-domain:openai';
    const oldClaim = claimProviderCredentialLifecycle(namespace, 'user:old', 'old-request', {
      baselineFingerprint: 'before',
    });
    bindProviderCredentialLifecycle(oldClaim, 'old-session', { binding: { kind: 'owned-child', processPid: process.pid } });
    makeRecordedProcessExited(namespace);

    let resume!: () => void;
    const paused = new Promise<void>((resolve) => { resume = resolve; });
    let entered!: () => void;
    const enteredRead = new Promise<void>((resolve) => { entered = resolve; });
    const verifier = verifyAndClearProviderCredentialLifecycleAfterRemoval(
      namespace,
      async () => {
        entered();
        await paused;
        return { fingerprint: 'before', absent: true };
      },
      { delay: async () => undefined, stableReads: 2 },
    );
    await enteredRead;

    clearProviderCredentialLifecycleAfterVerifiedRemoval(namespace, oldClaim.leaseId);
    const successor = claimProviderCredentialLifecycle(namespace, 'user:new', 'new-request', {
      baselineFingerprint: 'successor-before',
    });
    resume();

    await expect(verifier).resolves.toBe(false);
    expect(getProviderCredentialLifecycleRecord(namespace)?.leaseId).toBe(successor.leaseId);
  });

  test('restart reconciliation cannot clear a successor after its proof read pauses', async () => {
    const namespace = 'credential-domain:google';
    const oldClaim = claimProviderCredentialLifecycle(namespace, 'user:old', 'old-request', {
      baselineFingerprint: 'before',
      reviewAfterMs: 60_000,
    });
    bindProviderCredentialLifecycle(oldClaim, 'old-session', { binding: { kind: 'owned-child', processPid: process.pid } });
    makeRecordedProcessExited(namespace);

    let resume!: () => void;
    const paused = new Promise<void>((resolve) => { resume = resolve; });
    let entered!: () => void;
    const enteredRead = new Promise<void>((resolve) => { entered = resolve; });
    const verifier = reconcileProviderCredentialLifecycleBeforeAdmission(
      namespace,
      async () => {
        entered();
        await paused;
        return 'before';
      },
      {
        now: () => Date.now() + 61_000,
        delay: async () => undefined,
        stableReads: 2,
      },
    );
    await enteredRead;

    clearProviderCredentialLifecycleAfterVerifiedRemoval(namespace, oldClaim.leaseId);
    const successor = claimProviderCredentialLifecycle(namespace, 'user:new', 'new-request', {
      baselineFingerprint: 'successor-before',
    });
    resume();

    await expect(verifier).rejects.toThrow(DurableCredentialLifecycleRecoveryRequiredError);
    expect(getProviderCredentialLifecycleRecord(namespace)?.leaseId).toBe(successor.leaseId);
  });

  test('durably serializes provider removal against starts in both admission orders', async () => {
    const namespace = 'credential-domain:openai';
    const start = claimProviderCredentialLifecycle(namespace, 'user:start', 'start-request');
    expect(() => claimProviderCredentialRemovalLifecycle(namespace, 'user:remove', 'remove-request'))
      .toThrow(DurableCredentialLifecycleConflictError);
    clearProviderCredentialLifecycleAfterVerifiedRemoval(namespace, start.leaseId);

    const removal = claimProviderCredentialRemovalLifecycle(namespace, 'user:remove', 'remove-request');
    expect(() => claimProviderCredentialLifecycle(namespace, 'user:start', 'start-request'))
      .toThrow(DurableCredentialLifecycleConflictError);
    expect(() => claimProviderCredentialRemovalLifecycle(namespace, 'user:remove', 'remove-request'))
      .toThrow(DurableCredentialLifecycleRecoveryRequiredError);

    parkProviderCredentialRemovalLifecycle(removal);
    const resumed = claimProviderCredentialRemovalLifecycle(namespace, 'user:remove', 'remove-request');
    expect(resumed.leaseId).not.toBe(removal.leaseId);
    await expect(verifyAndReleaseProviderCredentialRemovalLifecycle(
      resumed,
      namespace,
      async () => ({ fingerprint: 'openclaw-empty', absent: true }),
      { delay: async () => undefined, stableReads: 2, proofCredentialScope: 'combined-domain' },
    )).resolves.toBe(true);
    expect(() => claimProviderCredentialLifecycle(namespace, 'user:start', 'start-request')).not.toThrow();
  });

  test('OpenClaw removal releases its fence without clearing broader native ownership evidence', async () => {
    const namespace = 'credential-domain:anthropic';
    const committed = claimProviderCredentialLifecycle(namespace, 'user:start', 'claude-oauth', {
      baselineFingerprint: 'native-claude-remains',
    });
    bindProviderCredentialLifecycle(committed, 'completed-processless-oauth-session', {
      binding: { kind: 'attested-processless' },
    });
    markProviderCredentialLifecycle(committed, 'committed', 'openclaw-and-native-present');

    const removal = claimProviderCredentialRemovalLifecycle(
      namespace,
      'user:remove',
      'remove-openclaw',
      { operationCredentialScope: 'openclaw-and-portal' },
    );
    expect(removal.targetLeaseId).toBe(committed.leaseId);
    expect(() => claimProviderCredentialLifecycle(namespace, 'user:new', 'new-start'))
      .toThrow(DurableCredentialLifecycleConflictError);

    await expect(verifyAndReleaseProviderCredentialRemovalLifecycle(
      removal,
      namespace,
      // This proof covers OpenClaw and Portal JSON only. The target owns the
      // broader combined domain, so its native evidence must survive.
      async () => ({ fingerprint: 'openclaw-anthropic-empty', absent: true }),
      {
        delay: async () => undefined,
        stableReads: 2,
        proofCredentialScope: 'openclaw-and-portal',
      },
    )).resolves.toBe(true);
    expect(getProviderCredentialLifecycleRecord(namespace)?.leaseId).toBe(committed.leaseId);
    expect(getProviderCredentialLifecycleRecord(removal.namespace)).toBeNull();
  });

  test('removal rejects an unbound indeterminate lifecycle that may still have a surviving child', () => {
    const namespace = 'credential-domain:google';
    const uncertain = claimProviderCredentialLifecycle(namespace, 'user:start', 'gemini-oauth');
    markProviderCredentialLifecycle(uncertain, 'indeterminate');
    expect(() => claimProviderCredentialRemovalLifecycle(namespace, 'user:remove', 'remove-google'))
      .toThrow(DurableCredentialLifecycleConflictError);
  });

  test('Agent Zero processless attempts cannot be removed before authoritative expiry', () => {
    const namespace = 'agent-zero:codex_oauth';
    const attempt = claimProviderCredentialLifecycle(namespace, 'user:start', 'attempt', {
      lifecycleKind: 'agent-zero-oauth',
      credentialScope: 'agent-zero',
      reviewAfterMs: 60_000,
    });
    bindProviderCredentialLifecycle(attempt, 'attempt-id', {
      binding: { kind: 'attested-processless' },
      reviewAfterMs: 60_000,
    });
    markProviderCredentialLifecycle(attempt, 'indeterminate');
    expect(() => claimProviderCredentialRemovalLifecycle(namespace, 'user:remove', 'disconnect', {
      operationCredentialScope: 'agent-zero',
    })).toThrow(DurableCredentialLifecycleConflictError);

    const database = new DatabaseSync(ledgerPath);
    database.prepare('UPDATE lifecycle_records SET review_after = ? WHERE namespace = ?')
      .run(new Date(Date.now() - 1_000).toISOString(), namespace);
    database.close();
    expect(() => claimProviderCredentialRemovalLifecycle(namespace, 'user:remove', 'disconnect', {
      operationCredentialScope: 'agent-zero',
    })).not.toThrow();
  });

  test('an unbound Agent Zero attempt can be cleared once its review window elapses', () => {
    // A failed sign-in claimed the namespace, then errored before any attempt
    // identity came back, so nothing was ever bound. Without an escape the
    // record is permanently irremovable: start refuses because a lifecycle is
    // open, disconnect refuses because it is unbound, and no third action
    // exists. Agent Zero attempts are processless, so there is no surviving
    // child to strand.
    const namespace = 'agent-zero:xai_grok_oauth';
    const stranded = claimProviderCredentialLifecycle(namespace, 'user:start', 'grok-oauth', {
      lifecycleKind: 'agent-zero-oauth',
      credentialScope: 'agent-zero',
      reviewAfterMs: 60_000,
    });
    markProviderCredentialLifecycle(stranded, 'indeterminate');
    expect(() => claimProviderCredentialRemovalLifecycle(namespace, 'user:remove', 'disconnect', {
      operationCredentialScope: 'agent-zero',
    })).toThrow(DurableCredentialLifecycleConflictError);

    const database = new DatabaseSync(ledgerPath);
    database.prepare('UPDATE lifecycle_records SET review_after = ? WHERE namespace = ?')
      .run(new Date(Date.now() - 1_000).toISOString(), namespace);
    database.close();
    expect(() => claimProviderCredentialRemovalLifecycle(namespace, 'user:remove', 'disconnect', {
      operationCredentialScope: 'agent-zero',
    })).not.toThrow();
  });

  test('an elapsed review does not make a process-backed unbound record removable', () => {
    // The same escape must not apply where a child process may have survived
    // without its pid ever being recorded.
    const namespace = 'credential-domain:anthropic';
    const uncertain = claimProviderCredentialLifecycle(namespace, 'user:start', 'claude-oauth');
    markProviderCredentialLifecycle(uncertain, 'indeterminate');
    const database = new DatabaseSync(ledgerPath);
    database.prepare('UPDATE lifecycle_records SET review_after = ? WHERE namespace = ?')
      .run(new Date(Date.now() - 60_000).toISOString(), namespace);
    database.close();
    expect(() => claimProviderCredentialRemovalLifecycle(namespace, 'user:remove', 'remove-anthropic'))
      .toThrow(DurableCredentialLifecycleConflictError);
  });

  test('removal also rejects a never-bound committed crash-gap record', () => {
    const namespace = 'credential-domain:openai';
    const uncertain = claimProviderCredentialLifecycle(namespace, 'user:start', 'codex-oauth');
    markProviderCredentialLifecycle(uncertain, 'committed');
    expect(() => claimProviderCredentialRemovalLifecycle(namespace, 'user:remove', 'remove-openai'))
      .toThrow(DurableCredentialLifecycleConflictError);
  });

  test('a stale removal verifier cannot release a successor removal fence', async () => {
    const namespace = 'agent-zero:codex_oauth';
    const oldRemoval = claimProviderCredentialRemovalLifecycle(
      namespace,
      'user:owner',
      'disconnect',
      { operationCredentialScope: 'agent-zero' },
    );
    let resume!: () => void;
    const paused = new Promise<void>((resolve) => { resume = resolve; });
    let entered!: () => void;
    const enteredRead = new Promise<void>((resolve) => { entered = resolve; });
    const verifier = verifyAndReleaseProviderCredentialRemovalLifecycle(
      oldRemoval,
      namespace,
      async () => {
        entered();
        await paused;
        return { fingerprint: 'disconnected', absent: true };
      },
      { delay: async () => undefined, stableReads: 2, proofCredentialScope: 'agent-zero' },
    );
    await enteredRead;
    clearProviderCredentialLifecycleAfterVerifiedRemoval(oldRemoval.namespace, oldRemoval.leaseId);
    const successor = claimProviderCredentialRemovalLifecycle(
      namespace,
      'user:next',
      'disconnect-next',
      { operationCredentialScope: 'agent-zero' },
    );
    resume();

    await expect(verifier).resolves.toBe(false);
    expect(getProviderCredentialLifecycleRecord(successor.namespace)?.leaseId).toBe(successor.leaseId);
  });

  test('never auto-releases an unbound record from credential snapshots alone', async () => {
    const namespace = 'credential-domain:xai';
    claimProviderCredentialLifecycle(namespace, 'user:owner', 'start', {
      baselineFingerprint: 'empty',
      reviewAfterMs: 60_000,
    });
    await expect(reconcileProviderCredentialLifecycleBeforeAdmission(
      namespace,
      async () => ({ fingerprint: 'empty', absent: true }),
      { now: () => Date.now() + 61_000, delay: async () => undefined },
    )).rejects.toThrow(/without a durable child-process identity/i);
    expect(getProviderCredentialLifecycleRecord(namespace)?.state).toBe('indeterminate');
  });

  test('rejects malformed committed state and ignores an orphaned torn temp file', () => {
    const claim = claimProviderCredentialLifecycle('openclaw:xai', 'user:one', 'request', {
      baselineFingerprint: 'before',
    });
    fs.writeFileSync(path.join(root, '.ledger.sqlite3.crash.tmp'), '{"version":', { mode: 0o600 });
    expect(__readProviderCredentialLifecycleLedgerForTests().records['openclaw:xai']).toBeTruthy();
    expect(attestProviderCredentialLifecycleFingerprint('openclaw:xai', 'before', claim.leaseId)).toBe('unchanged');

    fs.writeFileSync(ledgerPath, '{"version":1,"records":{"openclaw:xai":{}}}\n', { mode: 0o600 });
    expect(() => getProviderCredentialLifecycleRecord('openclaw:xai'))
      .toThrow(DurableCredentialLifecycleUnavailableError);
  });
});
