import { buildAutoForwardSieveScript, syncAutoForwardRule } from '../services/mailService';

function response(status: number, body: any, statusText = 'OK') {
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText,
    json: async () => body,
    text: async () => (typeof body === 'string' ? body : JSON.stringify(body)),
  } as Response;
}

describe('server-side mail auto-forwarding', () => {
  const originalFetch = global.fetch;

  beforeEach(() => {
    process.env.STALWART_URL = 'http://stalwart.test';
  });

  afterEach(() => {
    global.fetch = originalFetch;
    jest.restoreAllMocks();
  });

  it('builds a copy-forward Sieve script that leaves mail in the portal inbox', () => {
    expect(buildAutoForwardSieveScript('person@example.com')).toContain('require ["copy"];');
    expect(buildAutoForwardSieveScript('person@example.com')).toContain('redirect :copy "person@example.com";');
  });

  it('creates and activates a portal-managed Sieve rule when forwarding is enabled', async () => {
    const fetchMock = jest.fn()
      .mockResolvedValueOnce(response(200, {
        primaryAccounts: {
          'urn:ietf:params:jmap:mail': 'mail-account',
          'urn:ietf:params:jmap:sieve': 'sieve-account',
        },
        accounts: { 'mail-account': {}, 'sieve-account': {} },
      }))
      .mockResolvedValueOnce(response(200, {
        methodResponses: [['SieveScript/get', { list: [] }, 'sieve-get']],
      }))
      .mockResolvedValueOnce(response(201, {
        blobId: 'blob-forward-rule',
        type: 'application/sieve',
      }))
      .mockResolvedValueOnce(response(200, {
        methodResponses: [['SieveScript/set', {
          created: { portalAutoForward: { id: 'script1', isActive: true } },
          notCreated: null,
          notUpdated: null,
          notDestroyed: null,
        }, 'sieve-set']],
      }));
    global.fetch = fetchMock as any;

    await syncAutoForwardRule('external@example.com', 'mailuser', 'mailpass');

    expect(fetchMock).toHaveBeenCalledTimes(4);
    const uploadCall = fetchMock.mock.calls[2];
    expect(uploadCall[0]).toBe('http://stalwart.test/jmap/upload/sieve-account');
    expect(uploadCall[1].headers['Content-Type']).toBe('application/sieve; charset=utf-8');
    expect(String(uploadCall[1].body)).toContain('redirect :copy "external@example.com";');

    const setPayload = JSON.parse(String(fetchMock.mock.calls[3][1].body));
    expect(setPayload.using).toContain('urn:ietf:params:jmap:sieve');
    expect(setPayload.methodCalls[0][1]).toMatchObject({
      accountId: 'sieve-account',
      create: {
        portalAutoForward: {
          name: 'bridgesllm-auto-forward',
          blobId: 'blob-forward-rule',
        },
      },
      onSuccessActivateScript: '#portalAutoForward',
    });
  });

  it('deactivates and destroys the portal-managed rule when forwarding is disabled', async () => {
    const fetchMock = jest.fn()
      .mockResolvedValueOnce(response(200, {
        accounts: { account1: {} },
      }))
      .mockResolvedValueOnce(response(200, {
        methodResponses: [['SieveScript/get', {
          list: [{ id: 'script1', name: 'bridgesllm-auto-forward', isActive: true, blobId: 'blob1' }],
        }, 'sieve-get']],
      }))
      .mockResolvedValueOnce(response(200, {
        methodResponses: [
          ['SieveScript/set', { updated: { script1: { isActive: false } }, notCreated: null, notUpdated: null, notDestroyed: null }, 'deactivate'],
          ['SieveScript/set', { destroyed: ['script1'], notCreated: null, notUpdated: null, notDestroyed: null }, 'destroy'],
        ],
      }));
    global.fetch = fetchMock as any;

    await syncAutoForwardRule(null, 'mailuser', 'mailpass');

    const setPayload = JSON.parse(String(fetchMock.mock.calls[2][1].body));
    expect(setPayload.methodCalls).toEqual([
      ['SieveScript/set', { accountId: 'account1', onSuccessDeactivateScript: true }, 'deactivate'],
      ['SieveScript/set', { accountId: 'account1', destroy: ['script1'] }, 'destroy'],
    ]);
  });

  it('surfaces JMAP Sieve errors instead of treating them as an empty script list', async () => {
    const fetchMock = jest.fn()
      .mockResolvedValueOnce(response(200, {
        accounts: { account1: {} },
      }))
      .mockResolvedValueOnce(response(200, {
        methodResponses: [['error', { type: 'unknownMethod', description: 'Sieve disabled' }, 'sieve-get']],
      }));
    global.fetch = fetchMock as any;

    await expect(syncAutoForwardRule('external@example.com', 'mailuser', 'mailpass'))
      .rejects.toThrow('Sieve disabled');
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('refuses to overwrite a non-Portal active Sieve script', async () => {
    const fetchMock = jest.fn()
      .mockResolvedValueOnce(response(200, {
        accounts: { account1: {} },
      }))
      .mockResolvedValueOnce(response(200, {
        methodResponses: [['SieveScript/get', {
          list: [{ id: 'custom1', name: 'custom-filter', isActive: true, blobId: 'blob1' }],
        }, 'sieve-get']],
      }));
    global.fetch = fetchMock as any;

    await expect(syncAutoForwardRule('external@example.com', 'mailuser', 'mailpass'))
      .rejects.toThrow('refusing to overwrite');
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});
