import http from 'http';
import express, { NextFunction, Request, Response } from 'express';

const getUserMailAccountsMock = jest.fn();
const getUserMailCredentialsMock = jest.fn();
const ensureRuntimeDirectoryMock = jest.fn();
const ensureToolMirrorMock = jest.fn();
const getUserUploadDirMock = jest.fn();
const removeToolMirrorMock = jest.fn();
const scanBufferMock = jest.fn();
const comparePasswordMock = jest.fn();
const normalizeMailListRequestMock = jest.fn();
const normalizeMailSearchQueryMock = jest.fn();
const validateMailSignaturePayloadMock = jest.fn();
const issueMailAttachmentCapabilityTokenMock = jest.fn();
const verifyMailAttachmentCapabilityTokenMock = jest.fn();

const mailServiceMocks = {
  getMailboxes: jest.fn(),
  listEmails: jest.fn(),
  getEmail: jest.fn(),
  downloadAttachment: jest.fn(),
  uploadBlob: jest.fn(),
  sendEmail: jest.fn(),
  trashEmail: jest.fn(),
  moveEmail: jest.fn(),
  toggleFlag: jest.fn(),
  markRead: jest.fn(),
  bulkMarkRead: jest.fn(),
  bulkTrash: jest.fn(),
  bulkMove: jest.fn(),
  forwardEmail: jest.fn(),
  getSignature: jest.fn(),
  saveSignature: jest.fn(),
  getUnreadCount: jest.fn(),
  syncAutoForwardRule: jest.fn(),
  normalizeAttachmentName: jest.fn((value: string) => value),
  normalizeContentType: jest.fn((value: string) => value),
};

const prismaMocks = {
  activityLogCreate: jest.fn(),
  mailboxAccountFindFirst: jest.fn(),
  mailboxAccountFindUnique: jest.fn(),
  mailboxAccountUpdate: jest.fn(),
  systemSettingFindFirst: jest.fn(),
  userFindUnique: jest.fn(),
};

jest.mock('../middleware/auth', () => ({
  authenticateToken: (req: Request, _res: Response, next: NextFunction) => {
    req.user = {
      userId: 'tailnet-user',
      email: 'owner@example.com',
      role: 'OWNER',
      accountStatus: 'ACTIVE',
    };
    next();
  },
}));

jest.mock('../services/userMailService', () => ({
  getUserMailAccounts: getUserMailAccountsMock,
  getUserMailCredentials: getUserMailCredentialsMock,
}));

jest.mock('../services/mailService', () => ({
  ...mailServiceMocks,
  MAX_MAIL_ATTACHMENT_BYTES: 25 * 1024 * 1024,
}));

jest.mock('../config/database', () => ({
  prisma: {
    activityLog: { create: prismaMocks.activityLogCreate },
    mailboxAccount: {
      findFirst: prismaMocks.mailboxAccountFindFirst,
      findUnique: prismaMocks.mailboxAccountFindUnique,
      update: prismaMocks.mailboxAccountUpdate,
    },
    systemSetting: { findFirst: prismaMocks.systemSettingFindFirst },
    user: { findUnique: prismaMocks.userFindUnique },
  },
}));

jest.mock('../config/env', () => ({
  config: {
    jwtSecret: 'tailnet-mail-runtime-test-secret-with-enough-entropy',
  },
}));

jest.mock('../utils/runtimeDirectory', () => ({
  ensureRuntimeDirectory: ensureRuntimeDirectoryMock,
}));

jest.mock('../routes/files', () => ({
  ensureToolMirror: ensureToolMirrorMock,
  getUserUploadDir: getUserUploadDirMock,
  removeToolMirror: removeToolMirrorMock,
}));

jest.mock('../services/virusScan', () => ({
  scanBuffer: scanBufferMock,
}));

jest.mock('../utils/password', () => ({
  comparePassword: comparePasswordMock,
}));

jest.mock('../services/mailRequestPolicy', () => ({
  normalizeMailListRequest: normalizeMailListRequestMock,
  normalizeMailSearchQuery: normalizeMailSearchQueryMock,
  validateMailSignaturePayload: validateMailSignaturePayloadMock,
}));

jest.mock('../services/mailAttachmentCapability', () => ({
  issueMailAttachmentCapabilityToken: issueMailAttachmentCapabilityTokenMock,
  verifyMailAttachmentCapabilityToken: verifyMailAttachmentCapabilityTokenMock,
}));

import mailRouter from '../routes/mail';

type TestResponse = {
  status: number;
  body: Record<string, unknown>;
};

async function request(
  server: http.Server,
  method: string,
  requestPath: string,
  body?: Buffer,
  headers: Record<string, string> = {},
): Promise<TestResponse> {
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Server is not listening');

  return new Promise((resolve, reject) => {
    const req = http.request({
      hostname: '127.0.0.1',
      port: address.port,
      method,
      path: requestPath,
      headers: {
        ...(body ? { 'content-length': String(body.length) } : {}),
        ...headers,
      },
    }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (chunk) => chunks.push(Buffer.from(chunk)));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        resolve({
          status: res.statusCode || 0,
          body: text ? JSON.parse(text) : {},
        });
      });
    });
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

function multipartMessage(): { body: Buffer; contentType: string } {
  const boundary = 'tailnet-mail-runtime-boundary';
  const data = JSON.stringify({
    to: [{ email: 'recipient@example.com' }],
    subject: 'Must not be sent',
    textBody: 'Tailnet mail is unavailable.',
  });
  const body = Buffer.from([
    `--${boundary}\r\n`,
    'Content-Disposition: form-data; name="data"\r\n',
    'Content-Type: application/json\r\n\r\n',
    `${data}\r\n`,
    `--${boundary}\r\n`,
    'Content-Disposition: form-data; name="attachments"; filename="proof.txt"\r\n',
    'Content-Type: text/plain\r\n\r\n',
    'Multer must never persist this attachment.\r\n',
    `--${boundary}--\r\n`,
  ].join(''));
  return {
    body,
    contentType: `multipart/form-data; boundary=${boundary}`,
  };
}

function expectNoMailWork(fetchMock: jest.Mock): void {
  expect(getUserMailAccountsMock).not.toHaveBeenCalled();
  expect(getUserMailCredentialsMock).not.toHaveBeenCalled();
  expect(ensureRuntimeDirectoryMock).not.toHaveBeenCalled();
  expect(ensureToolMirrorMock).not.toHaveBeenCalled();
  expect(getUserUploadDirMock).not.toHaveBeenCalled();
  expect(removeToolMirrorMock).not.toHaveBeenCalled();
  expect(scanBufferMock).not.toHaveBeenCalled();
  expect(comparePasswordMock).not.toHaveBeenCalled();
  expect(normalizeMailListRequestMock).not.toHaveBeenCalled();
  expect(normalizeMailSearchQueryMock).not.toHaveBeenCalled();
  expect(validateMailSignaturePayloadMock).not.toHaveBeenCalled();
  expect(issueMailAttachmentCapabilityTokenMock).not.toHaveBeenCalled();
  expect(verifyMailAttachmentCapabilityTokenMock).not.toHaveBeenCalled();
  for (const serviceMock of Object.values(mailServiceMocks)) {
    expect(serviceMock).not.toHaveBeenCalled();
  }
  for (const prismaMock of Object.values(prismaMocks)) {
    expect(prismaMock).not.toHaveBeenCalled();
  }
  expect(fetchMock).not.toHaveBeenCalled();
}

describe('Tailnet mail runtime capability gate', () => {
  let server: http.Server;
  let originalOriginMode: string | undefined;
  let originalFetch: typeof global.fetch;
  let fetchMock: jest.Mock;

  beforeAll(async () => {
    originalOriginMode = process.env.ORIGIN_MODE;
    originalFetch = global.fetch;

    const app = express();
    app.use('/mail', mailRouter);
    server = http.createServer(app);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  });

  beforeEach(() => {
    jest.clearAllMocks();
    process.env.ORIGIN_MODE = 'tailnet';
    fetchMock = jest.fn();
    global.fetch = fetchMock as unknown as typeof global.fetch;
  });

  afterAll(async () => {
    if (originalOriginMode === undefined) delete process.env.ORIGIN_MODE;
    else process.env.ORIGIN_MODE = originalOriginMode;
    global.fetch = originalFetch;
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  test('rejects account discovery before mailbox auto-provisioning, Prisma, or Stalwart access', async () => {
    const response = await request(server, 'GET', '/mail/accounts');

    expect(response.status).toBe(409);
    expect(response.body).toMatchObject({
      code: 'PORTAL_FEATURE_UNAVAILABLE',
      feature: 'mail',
      retryable: false,
    });
    expectNoMailWork(fetchMock);
  });

  test('rejects multipart send before Multer storage, credential lookup, scanning, or delivery', async () => {
    const multipart = multipartMessage();
    const response = await request(server, 'POST', '/mail/send', multipart.body, {
      'content-type': multipart.contentType,
    });

    expect(response.status).toBe(409);
    expect(response.body).toMatchObject({
      code: 'PORTAL_FEATURE_UNAVAILABLE',
      feature: 'mail',
      retryable: false,
    });
    expectNoMailWork(fetchMock);
  });
});
