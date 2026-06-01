import { EventEmitter } from 'events';

const prismaMock = {
  app: {
    findMany: jest.fn(),
    update: jest.fn().mockResolvedValue({}),
  },
};

jest.mock('@prisma/client', () => ({
  PrismaClient: jest.fn(() => prismaMock),
}));

jest.mock('child_process', () => ({
  spawn: jest.fn(),
  execSync: jest.fn(),
}));

jest.mock('net', () => ({
  createConnection: jest.fn(() => {
    const socket: any = {};
    socket.destroy = jest.fn();
    socket.setTimeout = jest.fn();
    socket.once = jest.fn((event: string, callback: (...args: any[]) => void) => {
      if (event === 'error') callback(new Error('ECONNREFUSED'));
      return socket;
    });
    return socket;
  }),
}));

import { spawn } from 'child_process';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'fs';
import os from 'os';
import path from 'path';
import { getAppStatus, startApp, stopApp } from '../services/app-process.service';

function makeDeployDir(): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'portal-app-process-test-'));
  writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ scripts: { start: 'node server.js' } }));
  mkdirSync(path.join(dir, 'node_modules'));
  return dir;
}

function makeMockChild() {
  const child = new EventEmitter() as any;
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.kill = jest.fn(() => true);
  return child;
}

describe('app-process.service', () => {
  beforeEach(() => {
    jest.useFakeTimers();
    jest.clearAllMocks();
    prismaMock.app.update.mockResolvedValue({});
    prismaMock.app.findMany.mockResolvedValue([]);
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it('does not restart an app after an intentional SIGTERM stop', async () => {
    const deployDir = makeDeployDir();
    const child = makeMockChild();
    (spawn as jest.Mock).mockReturnValue(child);

    try {
      const startPromise = startApp('app-1', 'deploy-1', deployDir, 5001);
      await Promise.resolve();
      jest.advanceTimersByTime(500);
      await startPromise;
      expect(spawn).toHaveBeenCalledTimes(1);
      expect(spawn).toHaveBeenLastCalledWith('npm', ['start'], expect.objectContaining({
        cwd: deployDir,
        detached: true,
        env: expect.objectContaining({ PORT: '5001', NODE_ENV: 'production' }),
      }));

      const stopPromise = stopApp('deploy-1');
      child.emit('exit', null, 'SIGTERM');
      await stopPromise;

      expect(child.kill).toHaveBeenCalledWith('SIGTERM');
      expect(getAppStatus('deploy-1')).toBeNull();

      jest.advanceTimersByTime(6000);
      expect(spawn).toHaveBeenCalledTimes(1);
      expect(prismaMock.app.update).toHaveBeenLastCalledWith({
        where: { id: 'app-1' },
        data: { processStatus: 'stopped' },
      });
    } finally {
      rmSync(deployDir, { recursive: true, force: true });
    }
  });
});
