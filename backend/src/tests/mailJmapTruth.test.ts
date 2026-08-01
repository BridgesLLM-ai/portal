jest.mock('../services/virusScan', () => ({
  scanBuffer: jest.fn(),
}));

import {
  bulkMove,
  markRead,
  moveEmail,
  sendEmail,
  trashEmail,
} from '../services/mailService';
import { PortalFeatureUnavailableError } from '../utils/portalFeatureCapabilities';

function jsonResponse(body: any): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
}

function sessionResponse(): Response {
  return jsonResponse({
    primaryAccounts: { 'urn:ietf:params:jmap:mail': 'mail-account' },
    accounts: {
      'mail-account': {
        accountCapabilities: { 'urn:ietf:params:jmap:mail': {} },
      },
    },
  });
}

function methodResponse(...methodResponses: any[]): Response {
  return jsonResponse({ methodResponses });
}

describe('JMAP mail mutation truth', () => {
  const originalFetch = global.fetch;
  const originalOriginMode = process.env.ORIGIN_MODE;
  const originalInstallProfile = process.env.INSTALL_PROFILE;

  beforeEach(() => {
    delete process.env.ORIGIN_MODE;
    process.env.INSTALL_PROFILE = 'server';
  });

  afterEach(() => {
    global.fetch = originalFetch;
    jest.restoreAllMocks();
  });

  afterAll(() => {
    if (originalOriginMode === undefined) delete process.env.ORIGIN_MODE;
    else process.env.ORIGIN_MODE = originalOriginMode;
    if (originalInstallProfile === undefined) delete process.env.INSTALL_PROFILE;
    else process.env.INSTALL_PROFILE = originalInstallProfile;
  });

  test.each([
    { ORIGIN_MODE: 'tailnet', INSTALL_PROFILE: 'server' },
    { ORIGIN_MODE: '', INSTALL_PROFILE: 'local' },
  ])('rejects JMAP delivery before credentials or network when mail is unavailable ($ORIGIN_MODE/$INSTALL_PROFILE)', async (environment) => {
    process.env.ORIGIN_MODE = environment.ORIGIN_MODE;
    process.env.INSTALL_PROFILE = environment.INSTALL_PROFILE;
    const fetchMock = jest.fn();
    global.fetch = fetchMock as unknown as typeof fetch;

    await expect(sendEmail({
      to: [{ email: 'bob@example.test' }],
      subject: 'Must not send',
      textBody: 'Body',
    }, 'alice', 'secret')).rejects.toBeInstanceOf(PortalFeatureUnavailableError);

    expect(fetchMock).not.toHaveBeenCalled();
  });

  test('does not report send success for an HTTP-200 JMAP method error', async () => {
    const fetchMock = jest.fn()
      .mockResolvedValueOnce(sessionResponse())
      .mockResolvedValueOnce(methodResponse(
        ['Mailbox/get', { list: [{ id: 'drafts', role: 'drafts' }] }, 'mb'],
      ))
      .mockResolvedValueOnce(methodResponse(
        ['Identity/get', { list: [{ id: 'identity-1' }] }, 'id'],
      ))
      .mockResolvedValueOnce(methodResponse(
        ['error', { type: 'invalidArguments', description: 'draft rejected' }, '0'],
        ['error', { type: 'invalidResultReference' }, '1'],
      ));
    global.fetch = fetchMock as unknown as typeof fetch;

    await expect(sendEmail({
      to: [{ email: 'bob@example.test' }],
      subject: 'Truth test',
      textBody: 'Body',
    }, 'alice', 'secret')).rejects.toThrow(/create outbound email failed: invalidArguments/);
  });

  test('does not report send success when submission creation is rejected', async () => {
    const fetchMock = jest.fn()
      .mockResolvedValueOnce(sessionResponse())
      .mockResolvedValueOnce(methodResponse(
        ['Mailbox/get', { list: [{ id: 'drafts', role: 'drafts' }] }, 'mb'],
      ))
      .mockResolvedValueOnce(methodResponse(
        ['Identity/get', { list: [{ id: 'identity-1' }] }, 'id'],
      ))
      .mockResolvedValueOnce(methodResponse(
        ['Email/set', { created: { draft: { id: 'email-1' } } }, '0'],
        ['EmailSubmission/set', {
          notCreated: { send: { type: 'forbidden', description: 'submission denied' } },
        }, '1'],
      ));
    global.fetch = fetchMock as unknown as typeof fetch;

    await expect(sendEmail({
      to: [{ email: 'bob@example.test' }],
      subject: 'Truth test',
      textBody: 'Body',
    }, 'alice', 'secret')).rejects.toThrow(/submit outbound email failed/);
  });

  test('rejects a move when Email/set reports notUpdated', async () => {
    const fetchMock = jest.fn()
      .mockResolvedValueOnce(sessionResponse())
      .mockResolvedValueOnce(methodResponse(
        ['Email/get', { list: [{ id: 'email-1', mailboxIds: { inbox: true } }] }, '0'],
      ))
      .mockResolvedValueOnce(methodResponse(
        ['Email/set', {
          notUpdated: { 'email-1': { type: 'notFound' } },
        }, 'email-update'],
      ));
    global.fetch = fetchMock as unknown as typeof fetch;

    await expect(moveEmail('email-1', 'archive', 'alice', 'secret'))
      .rejects.toThrow(/move email failed/);
  });

  test('rejects a read mutation without an updated confirmation', async () => {
    const fetchMock = jest.fn()
      .mockResolvedValueOnce(sessionResponse())
      .mockResolvedValueOnce(methodResponse(
        ['Email/set', {}, 'email-update'],
      ));
    global.fetch = fetchMock as unknown as typeof fetch;

    await expect(markRead('email-1', true, 'alice', 'secret'))
      .rejects.toThrow(/no updated confirmations/);
  });

  test('rejects a trash mutation unless the requested email is confirmed updated', async () => {
    const fetchMock = jest.fn()
      .mockResolvedValueOnce(sessionResponse())
      .mockResolvedValueOnce(sessionResponse())
      .mockResolvedValueOnce(methodResponse(
        ['Mailbox/get', { list: [{ id: 'trash', role: 'trash' }] }, '0'],
      ))
      .mockResolvedValueOnce(methodResponse(
        ['Email/get', { list: [{ id: 'email-1', mailboxIds: { inbox: true } }] }, '0'],
      ))
      .mockResolvedValueOnce(methodResponse(
        ['Email/set', { updated: {} }, 'email-update'],
      ));
    global.fetch = fetchMock as unknown as typeof fetch;

    await expect(trashEmail('email-1', 'alice', 'secret'))
      .rejects.toThrow(/did not confirm update for: email-1/);
  });

  test('fails a bulk move before mutation when JMAP omits any requested email', async () => {
    const fetchMock = jest.fn()
      .mockResolvedValueOnce(sessionResponse())
      .mockResolvedValueOnce(methodResponse(
        ['Email/get', {
          list: [{ id: 'email-1', mailboxIds: { inbox: true } }],
          notFound: ['email-2'],
        }, '0'],
      ));
    global.fetch = fetchMock as unknown as typeof fetch;

    await expect(bulkMove(['email-1', 'email-2'], 'archive', 'alice', 'secret'))
      .rejects.toThrow(/could not load: email-2/);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});
