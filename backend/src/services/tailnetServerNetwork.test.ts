import { mkdtemp, readdir } from 'fs/promises';
import { EventEmitter } from 'events';
import os from 'os';
import path from 'path';
import {
  TailnetServerNetworkError,
  connectServerWithAuthKey,
  installTailscaleOnServer,
  readTailnetServerNetworkStatus,
  startServerLoginFlow,
  type TailnetServerNetworkDependencies,
} from './tailnetServerNetwork';

const RUNNING_STATUS = JSON.stringify({
  BackendState: 'Running',
  Self: { HostName: 'bridgesllm-portal', TailscaleIPs: ['100.64.0.9', 'fd7a::9'] },
  CurrentTailnet: { Name: 'robert.example.ts.net' },
});

const NEEDS_LOGIN_STATUS = JSON.stringify({
  BackendState: 'NeedsLogin',
  AuthURL: 'https://login.tailscale.com/a/abc123',
  Self: { HostName: 'bridgesllm-portal', TailscaleIPs: [] },
});

function accessInstalled(): TailnetServerNetworkDependencies['accessImpl'] {
  return async () => undefined;
}

function accessMissing(): TailnetServerNetworkDependencies['accessImpl'] {
  return async () => { throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' }); };
}

function execRouter(
  handler: (file: string, args: readonly string[]) => { stdout?: string; stderr?: string } | Error,
): NonNullable<TailnetServerNetworkDependencies['execFileImpl']> {
  return async (file, args) => {
    const result = handler(file, args);
    if (result instanceof Error) throw result;
    return { stdout: result.stdout || '', stderr: result.stderr || '' };
  };
}

function spawnedChild(
  result: 'spawn' | Error = 'spawn',
): EventEmitter & { unref: jest.Mock } {
  const child = Object.assign(new EventEmitter(), {
    unref: jest.fn(),
  });
  queueMicrotask(() => {
    if (result === 'spawn') child.emit('spawn');
    else child.emit('error', result);
  });
  return child;
}

describe('tailnet server network', () => {
  test('reports not-installed with no binary present', async () => {
    const status = await readTailnetServerNetworkStatus({
      accessImpl: accessMissing(),
      execFileImpl: execRouter(() => new Error('should not run')),
    });
    expect(status).toMatchObject({
      installed: false,
      running: false,
      loginUrl: null,
      tailnetName: null,
    });
  });

  test('reports a joined tailnet with hostname, IP, and tailnet name', async () => {
    const status = await readTailnetServerNetworkStatus({
      accessImpl: accessInstalled(),
      execFileImpl: execRouter((file, args) => {
        if (args[0] === 'version') return { stdout: '1.98.9\n  tailscale commit' };
        if (args[0] === 'is-active') return {};
        if (args[0] === 'status') return { stdout: RUNNING_STATUS };
        return new Error(`unexpected ${file} ${args.join(' ')}`);
      }),
    });
    expect(status).toMatchObject({
      installed: true,
      version: '1.98.9',
      daemonActive: true,
      backendState: 'Running',
      running: true,
      tailnetName: 'robert.example.ts.net',
      hostName: 'bridgesllm-portal',
      tailnetIp: '100.64.0.9',
      loginUrl: null,
    });
  });

  test('surfaces a pending https login URL and rejects non-https ones', async () => {
    const pending = await readTailnetServerNetworkStatus({
      accessImpl: accessInstalled(),
      execFileImpl: execRouter((_file, args) => {
        if (args[0] === 'status') return { stdout: NEEDS_LOGIN_STATUS };
        return {};
      }),
    });
    expect(pending.loginUrl).toBe('https://login.tailscale.com/a/abc123');
    expect(pending.running).toBe(false);

    const hostile = await readTailnetServerNetworkStatus({
      accessImpl: accessInstalled(),
      execFileImpl: execRouter((_file, args) => {
        if (args[0] === 'status') {
          return { stdout: JSON.stringify({ BackendState: 'NeedsLogin', AuthURL: 'http://evil.example/steal' }) };
        }
        return {};
      }),
    });
    expect(hostile.loginUrl).toBeNull();
  });

  test('auth-key connect passes the key via a deleted temp file, never argv', async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), 'tsnet-test-'));
    const seenArgs: string[][] = [];
    const status = await connectServerWithAuthKey(
      { authKey: 'tskey-auth-abcdef123456', hostname: 'my-portal' },
      {
        accessImpl: accessInstalled(),
        tempDir,
        execFileImpl: execRouter((_file, args) => {
          seenArgs.push([...args]);
          if (args[0] === 'status') return { stdout: RUNNING_STATUS };
          return {};
        }),
      },
    );
    expect(status.running).toBe(true);
    const upCall = seenArgs.find((args) => args[0] === 'up');
    expect(upCall).toBeDefined();
    expect(upCall!.join(' ')).not.toContain('tskey-auth-abcdef123456');
    expect(upCall!.some((arg) => arg.startsWith('--auth-key=file:'))).toBe(true);
    expect(upCall!).toContain('--hostname=my-portal');
    expect(upCall!).not.toContain('--reset');
    // The key file must not survive the operation.
    expect(await readdir(tempDir)).toEqual([]);
  });

  test('rejects malformed auth keys and hostnames before touching the system', async () => {
    await expect(connectServerWithAuthKey(
      { authKey: 'not-a-key' },
      { accessImpl: accessInstalled(), execFileImpl: execRouter(() => new Error('must not run')) },
    )).rejects.toMatchObject({ code: 'REQUEST_INVALID' });
    await expect(connectServerWithAuthKey(
      { authKey: 'tskey-auth-abcdef123456', hostname: 'bad host!' },
      { accessImpl: accessInstalled(), execFileImpl: execRouter(() => new Error('must not run')) },
    )).rejects.toMatchObject({ code: 'REQUEST_INVALID' });
  });

  test('connect failures scrub auth-key material from surfaced errors', async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), 'tsnet-test-'));
    const rejection = connectServerWithAuthKey(
      { authKey: 'tskey-auth-secretsecret' },
      {
        accessImpl: accessInstalled(),
        tempDir,
        execFileImpl: execRouter((_file, args) => {
          if (args[0] === 'up') {
            return Object.assign(
              new Error('up failed'),
              { stderr: 'invalid key: tskey-auth-secretsecret rejected' },
            );
          }
          return {};
        }),
      },
    );
    await expect(rejection).rejects.toMatchObject({ code: 'TAILSCALE_CONNECT_FAILED' });
    await expect(rejection).rejects.not.toThrow(/tskey-auth-secretsecret/);
    expect(await readdir(tempDir)).toEqual([]);
  });

  test('login flow returns the URL once the daemon reports it', async () => {
    let statusCalls = 0;
    const spawned: string[][] = [];
    const status = await startServerLoginFlow({}, {
      accessImpl: accessInstalled(),
      sleep: async () => undefined,
      spawnImpl: ((file: string, args: readonly string[]) => {
        spawned.push([file, ...args]);
        return spawnedChild() as never;
      }) as never,
      execFileImpl: execRouter((_file, args) => {
        if (args[0] === 'status') {
          statusCalls += 1;
          return { stdout: statusCalls >= 3 ? NEEDS_LOGIN_STATUS : JSON.stringify({ BackendState: 'NoState' }) };
        }
        return {};
      }),
    });
    expect(status.loginUrl).toBe('https://login.tailscale.com/a/abc123');
    expect(spawned).toHaveLength(1);
    expect(spawned[0][1]).toBe('up');
    expect(spawned[0]).not.toContain('--reset');
  });

  test('login flow reuses an already-pending URL without spawning again', async () => {
    const spawned: string[][] = [];
    const status = await startServerLoginFlow({}, {
      accessImpl: accessInstalled(),
      sleep: async () => undefined,
      spawnImpl: ((file: string, args: readonly string[]) => {
        spawned.push([file, ...args]);
        return spawnedChild() as never;
      }) as never,
      execFileImpl: execRouter((_file, args) => {
        if (args[0] === 'status') return { stdout: NEEDS_LOGIN_STATUS };
        return {};
      }),
    });
    expect(status.loginUrl).toBe('https://login.tailscale.com/a/abc123');
    expect(spawned).toHaveLength(0);
  });

  test('login flow converts asynchronous spawn errors into a bounded typed failure', async () => {
    let child!: ReturnType<typeof spawnedChild>;
    await expect(startServerLoginFlow({}, {
      accessImpl: accessInstalled(),
      spawnImpl: (() => {
        child = spawnedChild(
          Object.assign(new Error('spawn tailscale ENOENT private-detail'), {
            code: 'ENOENT',
          }),
        );
        return child;
      }) as never,
      execFileImpl: execRouter((_file, args) => {
        if (args[0] === 'status') {
          return { stdout: JSON.stringify({ BackendState: 'NoState' }) };
        }
        return {};
      }),
    })).rejects.toMatchObject({
      code: 'TAILSCALE_CONNECT_FAILED',
      statusCode: 502,
    });
    expect(child.unref).not.toHaveBeenCalled();
    expect(child.listenerCount('error')).toBe(0);
  });

  test('install is refused on non-Linux and validates the downloaded script shape', async () => {
    await expect(installTailscaleOnServer({
      platform: 'darwin',
      accessImpl: accessMissing(),
    })).rejects.toMatchObject({ code: 'SERVER_NETWORK_UNSUPPORTED' });

    await expect(installTailscaleOnServer({
      platform: 'linux',
      accessImpl: accessMissing(),
      execFileImpl: execRouter(() => ({})),
      fetchImpl: (async () => ({
        ok: true,
        status: 200,
        text: async () => '<html>not a script</html>',
      })) as never,
    })).rejects.toMatchObject({ code: 'TAILSCALE_INSTALL_FAILED' });
  });

  test('install short-circuits to status when tailscale is already present', async () => {
    const status = await installTailscaleOnServer({
      platform: 'linux',
      accessImpl: accessInstalled(),
      fetchImpl: (async () => { throw new Error('must not download'); }) as never,
      execFileImpl: execRouter((_file, args) => {
        if (args[0] === 'status') return { stdout: RUNNING_STATUS };
        if (args[0] === 'version') return { stdout: '1.98.9' };
        return {};
      }),
    });
    expect(status).toMatchObject({ installed: true, running: true });
  });

  test('a second concurrent mutating operation is refused as busy', async () => {
    let releaseGate: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => { releaseGate = resolve; });
    const first = connectServerWithAuthKey(
      { authKey: 'tskey-auth-abcdef123456' },
      {
        accessImpl: accessInstalled(),
        execFileImpl: (async (_file: string, args: readonly string[]) => {
          if (args[0] === 'up') await gate;
          if (args[0] === 'status') return { stdout: RUNNING_STATUS };
          return { stdout: '', stderr: '' };
        }) as never,
      },
    );
    await new Promise((resolve) => { setTimeout(resolve, 20); });
    await expect(startServerLoginFlow({}, {
      accessImpl: accessInstalled(),
      execFileImpl: execRouter(() => ({})),
    })).rejects.toMatchObject({ code: 'SERVER_NETWORK_BUSY' });
    releaseGate();
    await expect(first).resolves.toMatchObject({ running: true });
  });

  test('errors are typed TailnetServerNetworkError instances', async () => {
    try {
      await connectServerWithAuthKey({ authKey: 'nope' }, { accessImpl: accessInstalled() });
      throw new Error('expected rejection');
    } catch (error) {
      expect(error).toBeInstanceOf(TailnetServerNetworkError);
    }
  });
});
