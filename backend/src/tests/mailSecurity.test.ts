jest.mock('../services/virusScan', () => ({
  scanBuffer: jest.fn(),
}));

import { scanBuffer } from '../services/virusScan';
import {
  downloadAttachment,
  getEmail,
  MAX_MAIL_ATTACHMENT_BYTES,
  uploadBlob,
} from '../services/mailService';

const mockedScanBuffer = scanBuffer as jest.MockedFunction<typeof scanBuffer>;

function jmapSessionResponse(): Response {
  return new Response(JSON.stringify({
    primaryAccounts: { 'urn:ietf:params:jmap:mail': 'mail-account' },
    accounts: {
      'mail-account': {
        accountCapabilities: { 'urn:ietf:params:jmap:mail': {} },
      },
    },
  }), { status: 200, headers: { 'Content-Type': 'application/json' } });
}

describe('mail attachment security', () => {
  const originalFetch = global.fetch;

  beforeEach(() => {
    mockedScanBuffer.mockReset();
    mockedScanBuffer.mockResolvedValue({ clean: true, scannerAvailable: true });
  });

  afterEach(() => {
    global.fetch = originalFetch;
    jest.restoreAllMocks();
  });

  test('scans every outbound blob before uploading it to Stalwart', async () => {
    const fetchMock = jest.fn()
      .mockResolvedValueOnce(jmapSessionResponse())
      .mockResolvedValueOnce(new Response(JSON.stringify({
        blobId: 'safe-blob',
        type: 'application/pdf',
        size: 4,
      }), { status: 200, headers: { 'Content-Type': 'application/json' } }));
    global.fetch = fetchMock as unknown as typeof fetch;

    await expect(uploadBlob(Buffer.from('safe'), 'application/pdf', 'alice', 'secret', 'report.pdf'))
      .resolves.toEqual({ blobId: 'safe-blob', type: 'application/pdf', size: 4 });
    expect(mockedScanBuffer).toHaveBeenCalledWith(Buffer.from('safe'), 'report.pdf');
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  test('fails closed when the malware scanner cannot verify an outbound attachment', async () => {
    mockedScanBuffer.mockResolvedValue({
      clean: false,
      scannerAvailable: false,
      threat: 'scanner unavailable',
      error: 'scanner-unavailable',
    });
    global.fetch = jest.fn() as unknown as typeof fetch;

    await expect(uploadBlob(Buffer.from('data'), 'text/plain', 'alice', 'secret', 'notes.txt'))
      .rejects.toThrow('malware scanner is unavailable');
    expect(global.fetch).not.toHaveBeenCalled();
  });

  test('rejects dangerous and oversized outbound attachments before network access', async () => {
    global.fetch = jest.fn() as unknown as typeof fetch;
    await expect(uploadBlob(Buffer.from('x'), 'application/octet-stream', 'alice', 'secret', 'payload.exe'))
      .rejects.toThrow('blocked');
    await expect(uploadBlob(Buffer.alloc(MAX_MAIL_ATTACHMENT_BYTES + 1), 'text/plain', 'alice', 'secret', 'large.txt'))
      .rejects.toThrow('between 1 byte');
    expect(global.fetch).not.toHaveBeenCalled();
  });

  test('rejects an attachment download from its declared size before buffering it', async () => {
    const fetchMock = jest.fn()
      .mockResolvedValueOnce(jmapSessionResponse())
      .mockResolvedValueOnce(new Response('small-body', {
        status: 200,
        headers: { 'Content-Length': String(MAX_MAIL_ATTACHMENT_BYTES + 1) },
      }));
    global.fetch = fetchMock as unknown as typeof fetch;

    await expect(downloadAttachment('blob-id', 'safe.pdf', 'application/pdf', 'alice', 'secret'))
      .rejects.toThrow('response exceeds');
  });

  test('fetches message detail without a hidden mark-read mutation', async () => {
    const fetchMock = jest.fn()
      .mockResolvedValueOnce(jmapSessionResponse())
      .mockResolvedValueOnce(new Response(JSON.stringify({
        methodResponses: [['Email/get', {
          list: [{
            id: 'message-1',
            threadId: 'thread-1',
            mailboxIds: { inbox: true },
            from: [{ name: 'Sender', email: 'sender@example.com' }],
            to: [{ name: 'Alice', email: 'alice@example.com' }],
            subject: 'Unread message',
            receivedAt: '2026-07-19T12:00:00.000Z',
            size: 100,
            preview: 'Preview',
            keywords: {},
            htmlBody: [],
            textBody: [],
            bodyValues: {},
            attachments: [],
          }],
        }, '0']],
      }), { status: 200, headers: { 'Content-Type': 'application/json' } }));
    global.fetch = fetchMock as unknown as typeof fetch;

    await expect(getEmail('message-1', 'alice', 'secret')).resolves.toEqual(expect.objectContaining({
      id: 'message-1',
      isUnread: true,
    }));
    expect(fetchMock).toHaveBeenCalledTimes(2);
    const request = JSON.parse(String(fetchMock.mock.calls[1][1]?.body));
    expect(request.methodCalls).toHaveLength(1);
    expect(request.methodCalls[0][0]).toBe('Email/get');
  });
});
