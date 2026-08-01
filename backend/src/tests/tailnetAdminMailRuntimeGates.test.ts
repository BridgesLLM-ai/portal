import http from 'http';
import express, { NextFunction, Request, Response } from 'express';

const prismaMocks = {
  userFindUnique: jest.fn(),
  mailboxAccountFindUnique: jest.fn(),
  activityLogCreate: jest.fn(),
};
const sendEmailMock = jest.fn();
const provisionUserMailboxMock = jest.fn();
const deleteUserMailboxMock = jest.fn();
const deleteUserMailboxByUserIdMock = jest.fn();
const getProvisionedMailboxesMock = jest.fn();

jest.mock('../middleware/auth', () => ({
  authenticateToken: (req: Request, _res: Response, next: NextFunction) => {
    req.user = {
      userId: 'tailnet-owner',
      email: 'owner@example.com',
      role: 'OWNER',
      accountStatus: 'ACTIVE',
    };
    next();
  },
}));

jest.mock('../config/database', () => ({
  prisma: {
    user: { findUnique: prismaMocks.userFindUnique },
    mailboxAccount: { findUnique: prismaMocks.mailboxAccountFindUnique },
    activityLog: { create: prismaMocks.activityLogCreate },
  },
}));

jest.mock('../services/mailService', () => ({
  sendEmail: sendEmailMock,
}));

jest.mock('../services/userMailService', () => ({
  provisionUserMailbox: provisionUserMailboxMock,
  deleteUserMailbox: deleteUserMailboxMock,
  deleteUserMailboxByUserId: deleteUserMailboxByUserIdMock,
  getProvisionedMailboxes: getProvisionedMailboxesMock,
}));

jest.mock('../services/imageAssets', () => ({
  AVATARS_DIR: '/tmp/tailnet-admin-mail-test-avatars',
  BRANDING_DIR: '/tmp/tailnet-admin-mail-test-branding',
  createImageUpload: jest.fn(
    () => (_req: Request, _res: Response, next: NextFunction) => next(),
  ),
  parseCropParams: jest.fn(),
  processImageToTarget: jest.fn(),
  cleanupBasenameVariants: jest.fn(),
  cleanupBasenamePrefixVariants: jest.fn(),
  cleanupFile: jest.fn(),
}));

import adminRouter from '../routes/admin';

type TestResponse = {
  status: number;
  body: Record<string, unknown>;
};

async function request(
  server: http.Server,
  method: string,
  requestPath: string,
  body?: Record<string, unknown>,
): Promise<TestResponse> {
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Server is not listening');
  const encoded = body === undefined ? undefined : Buffer.from(JSON.stringify(body));

  return new Promise((resolve, reject) => {
    const req = http.request({
      hostname: '127.0.0.1',
      port: address.port,
      method,
      path: requestPath,
      headers: encoded ? {
        'content-type': 'application/json',
        'content-length': String(encoded.length),
      } : undefined,
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
    if (encoded) req.write(encoded);
    req.end();
  });
}

describe('Tailnet admin mail runtime capability gates', () => {
  let server: http.Server;
  let originalOriginMode: string | undefined;
  let originalFetch: typeof global.fetch;
  let fetchMock: jest.Mock;

  beforeAll(async () => {
    originalOriginMode = process.env.ORIGIN_MODE;
    originalFetch = global.fetch;

    const app = express();
    app.use(express.json());
    app.use('/admin', adminRouter);
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

  test.each([
    {
      label: 'test delivery',
      method: 'POST',
      path: '/admin/settings/test-email',
      body: undefined,
    },
    {
      label: 'JMAP status',
      method: 'GET',
      path: '/admin/email-status',
      body: undefined,
    },
    {
      label: 'mailbox listing',
      method: 'GET',
      path: '/admin/mailboxes',
      body: undefined,
    },
    {
      label: 'mailbox deletion',
      method: 'DELETE',
      path: '/admin/mailboxes/example-user',
      body: { confirmation: 'DELETE MAILBOX example-user' },
    },
  ])('rejects $label before any database or mail-system work', async ({ method, path, body }) => {
    const response = await request(server, method, path, body);

    expect(response.status).toBe(409);
    expect(response.body).toMatchObject({
      code: 'PORTAL_FEATURE_UNAVAILABLE',
      feature: 'mail',
      retryable: false,
    });
    for (const prismaMock of Object.values(prismaMocks)) {
      expect(prismaMock).not.toHaveBeenCalled();
    }
    expect(fetchMock).not.toHaveBeenCalled();
    expect(sendEmailMock).not.toHaveBeenCalled();
    expect(provisionUserMailboxMock).not.toHaveBeenCalled();
    expect(getProvisionedMailboxesMock).not.toHaveBeenCalled();
    expect(deleteUserMailboxMock).not.toHaveBeenCalled();
    expect(deleteUserMailboxByUserIdMock).not.toHaveBeenCalled();
  });
});
