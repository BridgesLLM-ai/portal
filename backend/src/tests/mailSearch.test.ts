jest.mock('../services/virusScan', () => ({
  scanBuffer: jest.fn(),
}));

import { listEmails } from '../services/mailService';

describe('mailbox-wide JMAP search', () => {
  const originalFetch = global.fetch;

  afterEach(() => {
    global.fetch = originalFetch;
    jest.restoreAllMocks();
  });

  test('sends the normalized search as a JMAP text filter instead of filtering one browser page', async () => {
    const fetchMock = jest.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({
        primaryAccounts: { 'urn:ietf:params:jmap:mail': 'mail-account' },
        accounts: {
          'mail-account': {
            accountCapabilities: { 'urn:ietf:params:jmap:mail': {} },
          },
        },
      }), { status: 200, headers: { 'Content-Type': 'application/json' } }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        methodResponses: [
          ['Email/query', { ids: [], total: 0, position: 0 }, '0'],
          ['Email/get', { list: [] }, '1'],
        ],
      }), { status: 200, headers: { 'Content-Type': 'application/json' } }));
    global.fetch = fetchMock as unknown as typeof fetch;

    await expect(listEmails('alice', 'secret', {
      mailboxId: 'mailbox-inbox',
      query: 'invoice 2026',
      position: 0,
      limit: 50,
    })).resolves.toEqual({ emails: [], total: 0, position: 0 });

    const jmapRequest = fetchMock.mock.calls[1]?.[1] as RequestInit;
    const body = JSON.parse(String(jmapRequest.body));
    expect(body.methodCalls[0][0]).toBe('Email/query');
    expect(body.methodCalls[0][1].filter).toEqual({
      inMailbox: 'mailbox-inbox',
      text: 'invoice 2026',
    });
  });
});
