import express from 'express';
import type { AddressInfo } from 'net';

const mockPrisma = {
  user: {
    findUnique: jest.fn(async () => ({
      id: 'target-user',
      email: 'target@example.com',
      role: 'USER',
      accountStatus: 'ACTIVE',
      isActive: true,
      sandboxEnabled: false,
      authorizationVersion: 1,
    })),
    update: jest.fn(),
  },
  app: {
    create: jest.fn(),
    update: jest.fn(),
    findMany: jest.fn(),
  },
  mailboxAccount: {
    create: jest.fn(),
    findMany: jest.fn(),
  },
  session: {
    create: jest.fn(),
    updateMany: jest.fn(),
  },
  activityLog: {
    create: jest.fn(),
  },
};

jest.mock('../config/database', () => ({ prisma: mockPrisma }));
jest.mock('../config/env', () => ({
  config: {
    jwtSecret: 'retirement-route-test-secret',
    corsOrigin: ['http://localhost'],
    maxFileSize: 1024,
    uploadDir: '/tmp/retirement-route-test-uploads',
  },
}));
jest.mock('../utils/jwt', () => ({
  verifyAccessToken: jest.fn(() => ({
    userId: 'target-user',
    email: 'target@example.com',
    role: 'USER',
    accountStatus: 'ACTIVE',
    sandboxEnabled: false,
    authorizationVersion: 1,
  })),
  verifyRefreshToken: jest.fn(),
  generateAccessToken: jest.fn(),
  generateRefreshToken: jest.fn(),
}));
jest.mock('../services/app-process.service', () => ({
  getAppTarget: jest.fn(),
}));

import usersRoutes from '../routes/users';
import appsRoutes from '../routes/apps';
import mailRoutes from '../routes/mail';
import {
  closeGlobalWorkspaceAuthorizationAdmission,
  requireGlobalWorkspaceAuthorizationAdmission,
} from '../services/workspaceAuthorizationBarrier';

async function request(
  app: express.Express,
  method: string,
  pathname: string,
  authenticated = true,
): Promise<{ status: number; body: any }> {
  const server = app.listen(0, '127.0.0.1');
  await new Promise<void>((resolve) => server.once('listening', resolve));
  try {
    const address = server.address() as AddressInfo;
    const response = await fetch(`http://127.0.0.1:${address.port}${pathname}`, {
      method,
      headers: {
        ...(authenticated ? { Authorization: 'Bearer retirement-test-token' } : {}),
        ...(method === 'POST' ? { 'Content-Type': 'application/json' } : {}),
      },
      ...(method === 'POST' ? { body: '{}' } : {}),
    });
    return {
      status: response.status,
      body: await response.json(),
    };
  } finally {
    await new Promise<void>((resolve, reject) => {
      server.close((error) => error ? reject(error) : resolve());
    });
  }
}

describe('user-retirement route admission boundary', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  test('rejects avatar, App, Mail, and unauthenticated Auth routes before middleware side effects', async () => {
    const authSideEffect = jest.fn((_req, res) => {
      mockPrisma.session.create();
      res.json({ reached: true });
    });
    const app = express();
    app.use(express.json());
    app.use('/api/users', usersRoutes);
    app.use('/api/apps', appsRoutes);
    app.use('/api/mail', mailRoutes);
    app.use(
      '/api/auth',
      requireGlobalWorkspaceAuthorizationAdmission,
      authSideEffect,
    );

    const fence = closeGlobalWorkspaceAuthorizationAdmission();
    try {
      const responses = await Promise.all([
        request(app, 'POST', '/api/users/me/avatar'),
        request(app, 'POST', '/api/apps'),
        request(app, 'GET', '/api/mail/accounts'),
        request(app, 'POST', '/api/auth/login', false),
      ]);

      expect(responses).toEqual(responses.map(() => ({
        status: 409,
        body: {
          error: 'Workspace authorization is changing. Retry after the Portal reloads.',
          code: 'WORKSPACE_SCOPE_CHANGED',
        },
      })));
      // Authenticated admission occurs before its authorization DB lookup,
      // Multer upload, mailbox resolution, or route handler.
      expect(mockPrisma.user.findUnique).not.toHaveBeenCalled();
      expect(mockPrisma.user.update).not.toHaveBeenCalled();
      expect(mockPrisma.app.create).not.toHaveBeenCalled();
      expect(mockPrisma.app.update).not.toHaveBeenCalled();
      expect(mockPrisma.mailboxAccount.create).not.toHaveBeenCalled();
      expect(mockPrisma.session.create).not.toHaveBeenCalled();
      expect(authSideEffect).not.toHaveBeenCalled();
    } finally {
      fence.release();
    }
  });
});

