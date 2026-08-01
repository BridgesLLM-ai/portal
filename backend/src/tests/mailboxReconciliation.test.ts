import { encryptSecret } from '../utils/authSecrets';
import {
  __mailboxReconciliationTest,
  mailboxReconciliationPolicy,
} from '../services/mailboxReconciliation';

describe('mailbox reconciliation Stalwart boundary', () => {
  const originalFetch = global.fetch;
  const originalStalwartUrl = process.env.STALWART_URL;
  const originalEncryptionKey = process.env.PORTAL_ENCRYPTION_KEY;

  beforeEach(() => {
    process.env.STALWART_URL = 'http://stalwart.test';
    process.env.PORTAL_ENCRYPTION_KEY = 'mailbox-reconciliation-test-key';
  });

  afterEach(() => {
    global.fetch = originalFetch;
    jest.restoreAllMocks();
  });

  afterAll(() => {
    if (originalStalwartUrl === undefined) delete process.env.STALWART_URL;
    else process.env.STALWART_URL = originalStalwartUrl;
    if (originalEncryptionKey === undefined) delete process.env.PORTAL_ENCRYPTION_KEY;
    else process.env.PORTAL_ENCRYPTION_KEY = originalEncryptionKey;
  });

  test('bounds Stalwart responses without exposing an upstream response body', async () => {
    global.fetch = jest.fn().mockResolvedValue(new Response('upstream-secret-that-must-not-escape', {
      status: 500,
      headers: { 'Content-Length': String(mailboxReconciliationPolicy.maxResponseBytes + 1) },
    })) as unknown as typeof fetch;

    let message = '';
    try {
      await __mailboxReconciliationTest.ensureStalwartPrincipal(
        'alice',
        encryptSecret('mailbox-password'),
      );
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }

    expect(message).toBe('Mail server returned an oversized response while attempting to create the mailbox account');
    expect(message).not.toContain('upstream-secret');
    expect(global.fetch).toHaveBeenCalledWith(
      'http://stalwart.test/api/principal',
      expect.objectContaining({
        method: 'POST',
        redirect: 'error',
        signal: expect.any(Object),
      }),
    );
  });

  test('reports an HTTP failure without copying the response body into the error', async () => {
    global.fetch = jest.fn().mockResolvedValue(new Response('upstream-secret-that-must-not-escape', {
      status: 500,
    })) as unknown as typeof fetch;

    await expect(__mailboxReconciliationTest.ensureStalwartPrincipal(
      'alice',
      encryptSecret('mailbox-password'),
    )).rejects.toThrow('Mail server could not create the mailbox account (HTTP 500)');

    try {
      await __mailboxReconciliationTest.ensureStalwartPrincipal(
        'alice',
        encryptSecret('mailbox-password'),
      );
    } catch (error) {
      expect(String(error)).not.toContain('upstream-secret');
    }
  });
});

describe('mailbox reconciliation when mail is unconfigured', () => {
  const originalAdminPass = process.env.STALWART_ADMIN_PASS;
  const originalFetch = global.fetch;

  beforeEach(() => {
    delete process.env.STALWART_ADMIN_PASS;
    __mailboxReconciliationTest.invalidateReadinessCache();
  });

  afterEach(() => {
    global.fetch = originalFetch;
    __mailboxReconciliationTest.invalidateReadinessCache();
    jest.restoreAllMocks();
  });

  afterAll(() => {
    if (originalAdminPass === undefined) delete process.env.STALWART_ADMIN_PASS;
    else process.env.STALWART_ADMIN_PASS = originalAdminPass;
  });

  test('readiness reports ready/unconfigured so unresolved tasks cannot veto an update', async () => {
    const { getMailboxReconciliationReadiness } = await import('../services/mailboxReconciliation');
    const readiness = await getMailboxReconciliationReadiness();
    expect(readiness.ready).toBe(true);
    expect(readiness.state).toBe('unconfigured');
    expect(readiness.pending).toBe(0);
  });

  test('drain parks the queue without attempting any Stalwart call', async () => {
    const fetchSpy = jest.fn();
    global.fetch = fetchSpy as unknown as typeof fetch;
    const { drainMailboxReconciliation } = await import('../services/mailboxReconciliation');
    const outcomes = await drainMailboxReconciliation({ maxTasks: 5, timeBudgetMs: 1000 });
    expect(outcomes).toEqual([]);
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});
