/**
 * Root operator import of an App credential file. File refusals use real
 * files; storage is mocked (store.test.ts covers it). Values are dummies.
 */
jest.mock('../config/database', () => ({ prisma: { $disconnect: jest.fn(async () => undefined) } }));
jest.mock('../services/appCredentials/store', () => ({
  requireCredentialApp: jest.fn(),
  setAppCredential: jest.fn(),
  verifyPortalEncryptionKey: jest.fn(),
}));

import { execFileSync, spawnSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { ImportError, parseArgs, readSourceFile, runImport, safeFailureMessage } from './appCredentialImport';
import { AppCredentialError, APP_CREDENTIAL_MAX_BYTES } from '../services/appCredentials/policy';
import { requireCredentialApp, setAppCredential, verifyPortalEncryptionKey } from '../services/appCredentials/store';

const APP = '11111111-2222-4333-8444-555555555555';
const SECRET = 'DUMMY-NOT-A-REAL-SECRET';
const asRoot = { getuid: () => 0 };

let base: string;
let source: string;
const savedEnv = { JWT_SECRET: process.env.JWT_SECRET, PORTAL_ENCRYPTION_KEY: process.env.PORTAL_ENCRYPTION_KEY };

beforeEach(() => {
  jest.clearAllMocks();
  // Canonical path: os.tmpdir() can itself be reached through a symlink.
  base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'app-credential-import-')));
  source = path.join(base, 'api-token-secrets.json');
  fs.writeFileSync(source, `{"username":"dummy","password":"${SECRET}"}`, { mode: 0o600 });
  fs.chmodSync(source, 0o600);
  process.env.JWT_SECRET = 'cli-test-jwt-secret-not-a-live-secret';
  delete process.env.PORTAL_ENCRYPTION_KEY;
  (verifyPortalEncryptionKey as jest.Mock).mockResolvedValue('verified');
  (requireCredentialApp as jest.Mock).mockResolvedValue({ id: APP, name: 'demo-app', userId: 'owner-1', projectIdentityId: 'project-1' });
  (setAppCredential as jest.Mock).mockImplementation(async (input: any) => ({
    appId: APP, slot: input.slot, revision: input.dryRun ? 0 : 3, storedAt: input.dryRun ? '' : '2026-10-06T05:00:00.000Z',
    replaced: false, bytes: input.value.length,
  }));
});

afterEach(() => {
  fs.rmSync(base, { recursive: true, force: true });
  for (const [key, value] of Object.entries(savedEnv)) {
    if (value === undefined) delete process.env[key]; else process.env[key] = value;
  }
});

function refusal(run: () => unknown, pattern: RegExp): void {
  let caught: unknown;
  try { run(); } catch (error) { caught = error; }
  expect(caught).toBeInstanceOf(ImportError);
  expect((caught as Error).message).toMatch(pattern);
  expect((caught as Error).message).not.toContain(SECRET);
}

describe('appCredentialImport arguments', () => {
  test('accepts exactly --app, --slot, --from-file and the three switches', () => {
    expect(parseArgs(['--app', APP, '--slot', 'api-token', '--from-file', '/var/lib/x.json', '--dry-run', '--replace']))
      .toEqual({ appId: APP, slot: 'api-token', fromFile: '/var/lib/x.json', replace: true, dryRun: true, allowMultipleLinks: false });
    expect(parseArgs(['--app', APP, '--slot', 'api-token', '--from-file', '/var/lib/x.json', '--allow-multiple-links']).allowMultipleLinks).toBe(true);
  });

  test('refuses values on the command line and malformed arguments without echoing them', () => {
    refusal(() => parseArgs(['--app', APP, '--slot', 'api-token', '--value', SECRET]), /Unknown argument at position 5/);
    refusal(() => parseArgs(['--app', APP, '--slot', 'api-token', SECRET]), /Unknown argument/);
    refusal(() => parseArgs(['--app', APP, '--slot', 'api-token']), /Required: --from-file/);
    refusal(() => parseArgs(['--app', APP, '--app', APP, '--slot', 'x', '--from-file', '/a']), /given twice/);
    refusal(() => parseArgs(['--app', APP, '--slot', 'x', '--from-file', '/a', '--dry-run', '--dry-run']), /given twice/);
    refusal(() => parseArgs(['--app', APP, '--slot', 'x', '--from-file']), /needs a value/);
    for (const file of ['relative/path.json', '/var/lib/../etc/passwd', '/var/lib/dir/', '/var/lib/./x']) {
      refusal(() => parseArgs(['--app', APP, '--slot', 'x', '--from-file', file]), /normalized absolute file path/);
    }
    refusal(() => parseArgs(['--app', 'not-a-uuid', '--slot', 'x', '--from-file', '/a']), /Project App ID/);
    refusal(() => parseArgs(['--app', APP, '--slot', 'Bad_Name', '--from-file', '/a']), /credential name/);
  });
});

describe('appCredentialImport source file', () => {
  test('reads a private regular file up to 64 KiB', () => {
    expect(readSourceFile(source).toString()).toContain(SECRET);
    const exact = path.join(base, 'exact');
    fs.writeFileSync(exact, Buffer.alloc(APP_CREDENTIAL_MAX_BYTES, 'x'), { mode: 0o640 });
    expect(readSourceFile(exact)).toHaveLength(APP_CREDENTIAL_MAX_BYTES);
  });

  test('refuses group-writable sources and multiply linked sources unless explicitly allowed', () => {
    fs.chmodSync(source, 0o660);
    refusal(() => readSourceFile(source), /group-writable; run chmod g-w/);
    fs.chmodSync(source, 0o600);
    fs.linkSync(source, path.join(base, 'second-link.json'));
    refusal(() => readSourceFile(source), /has 2 hard links.*--allow-multiple-links/);
    expect(readSourceFile(source, { allowMultipleLinks: true }).toString()).toContain(SECRET);
  });

  test('refuses a source rewritten while it is being read (no mixed snapshot)', () => {
    const original = fs.readSync;
    let calls = 0;
    const spy = jest.spyOn(fs, 'readSync').mockImplementation(((...args: Parameters<typeof fs.readSync>) => {
      calls += 1;
      // Rewrite the same inode after the first read call, as a concurrent writer would.
      if (calls === 2) fs.writeFileSync(source, '{"username":"other","password":"CHANGED-DUMMY-VALUE!!"}');
      return (original as (...a: Parameters<typeof fs.readSync>) => number)(...args);
    }) as typeof fs.readSync);
    try {
      refusal(() => readSourceFile(source), /changed while it was being read/);
    } finally {
      spy.mockRestore();
    }
  });

  test('refuses world-readable, world-writable, oversize, missing and non-regular sources', () => {
    fs.chmodSync(source, 0o644);
    refusal(() => readSourceFile(source), /world-readable; run chmod o-rwx/);
    fs.chmodSync(source, 0o602);
    refusal(() => readSourceFile(source), /world-writable; run chmod o-rwx/);
    const big = path.join(base, 'big');
    fs.writeFileSync(big, Buffer.alloc(APP_CREDENTIAL_MAX_BYTES + 1, 'x'), { mode: 0o600 });
    refusal(() => readSourceFile(big), /larger than 65536 bytes/);
    refusal(() => readSourceFile(path.join(base, 'missing')), /does not exist/);
    const directory = path.join(base, 'directory');
    fs.mkdirSync(directory, { mode: 0o700 });
    refusal(() => readSourceFile(directory), /not a regular file/);
    const fifo = path.join(base, 'fifo');
    execFileSync('mkfifo', ['-m', '600', fifo]);
    refusal(() => readSourceFile(fifo), /not a regular file/);
  });

  test('refuses a symlink at the file or anywhere in its path', () => {
    const link = path.join(base, 'link.json');
    fs.symlinkSync(source, link);
    refusal(() => readSourceFile(link), /symbolic link/);
    const realDir = path.join(base, 'real');
    fs.mkdirSync(realDir, { mode: 0o700 });
    fs.writeFileSync(path.join(realDir, 'login.env'), `PASSWORD=${SECRET}\n`, { mode: 0o600 });
    fs.symlinkSync(realDir, path.join(base, 'via'));
    refusal(() => readSourceFile(path.join(base, 'via', 'login.env')), /symbolic link/);
  });
});

describe('appCredentialImport run', () => {
  const argv = (...extra: string[]) => ['--app', APP, '--slot', 'api-token', '--from-file', source, ...extra];

  test('refuses non-root before reading anything', async () => {
    const readSpy = jest.spyOn(fs, 'openSync');
    await expect(runImport(argv(), { getuid: () => 1000 })).rejects.toThrow('Run as root');
    expect(readSpy).not.toHaveBeenCalled();
    readSpy.mockRestore();
    expect(setAppCredential).not.toHaveBeenCalled();
  });

  test('refuses to run without the Portal environment (it would encrypt with the wrong key)', async () => {
    delete process.env.JWT_SECRET;
    await expect(runImport(argv(), asRoot)).rejects.toThrow('Portal environment is not loaded');
    process.env.PORTAL_ENCRYPTION_KEY = 'portal-key';
    (verifyPortalEncryptionKey as jest.Mock).mockRejectedValueOnce(new AppCredentialError('APP_CREDENTIAL_UNREADABLE', 'This process does not hold the Portal encryption key.', 503));
    await expect(runImport(argv(), asRoot)).rejects.toThrow('does not hold the Portal encryption key');
    expect(setAppCredential).not.toHaveBeenCalled();
  });

  test('refuses an App that is not a live full-stack Project App', async () => {
    (requireCredentialApp as jest.Mock).mockRejectedValueOnce(new AppCredentialError('APP_CREDENTIAL_APP_NOT_FOUND', 'No live full-stack Project App has that ID.', 404));
    await expect(runImport(argv(), asRoot)).rejects.toThrow('No live full-stack Project App');
    expect(setAppCredential).not.toHaveBeenCalled();
  });

  test('dry run validates through the same store path and writes nothing', async () => {
    const receipt = await runImport(argv('--dry-run'), asRoot);
    expect(setAppCredential).toHaveBeenCalledWith(expect.objectContaining({ appId: APP, slot: 'api-token', dryRun: true, expectedRevision: null, actor: { kind: 'operator' } }));
    expect(receipt).toMatchObject({ app: APP, slot: 'api-token', dryRun: true, storedAt: null, revision: null, keyCheck: 'verified' });
  });

  test('imports from the file, adds only unless --replace, and prints a receipt with nothing from the value but its length', async () => {
    const receipt = await runImport(argv(), asRoot);
    const call = (setAppCredential as jest.Mock).mock.calls[0][0];
    expect(Buffer.isBuffer(call.value)).toBe(true);
    expect(call).toMatchObject({ appId: APP, slot: 'api-token', expectedRevision: null, dryRun: false, actor: { kind: 'operator' } });
    expect(Object.keys(receipt).sort()).toEqual(['app', 'appName', 'appliesOn', 'bytes', 'dryRun', 'keyCheck', 'replaced', 'revision', 'slot', 'storedAt']);
    expect(receipt).toMatchObject({ app: APP, appName: 'demo-app', slot: 'api-token', revision: 3, storedAt: '2026-10-06T05:00:00.000Z',
      bytes: fs.statSync(source).size, appliesOn: expect.stringContaining('/portal/credentials/api-token') });
    expect(JSON.stringify(receipt)).not.toContain(SECRET);
    await runImport(argv('--replace'), asRoot);
    expect((setAppCredential as jest.Mock).mock.calls[1][0].expectedRevision).toBeUndefined();
  });

  test('failure output is safe: known refusals verbatim, anything else by type only', () => {
    expect(safeFailureMessage(new ImportError('Run as root'))).toBe('Run as root');
    expect(safeFailureMessage(Object.assign(new Error(`database said ${SECRET}`), { code: 'P2000' }))).toBe('internal error (P2000); nothing was printed from the source file');
    expect(safeFailureMessage(new TypeError(`bad ${SECRET}`))).toBe('internal error (TypeError); nothing was printed from the source file');
    const unreachable = safeFailureMessage(Object.assign(new Error(`Can't reach database server ${SECRET}`), { code: 'P1001' }));
    expect(unreachable).toMatch(/^the Portal database could not be reached or refused the connection \(P1001\)/);
    expect(unreachable).not.toContain(SECRET);
  });

  test('the command exits non-zero with a prefixed, safe message', () => {
    const result = spawnSync(process.execPath, ['-r', 'ts-node/register/transpile-only', 'src/cli/appCredentialImport.ts',
      '--app', APP, '--slot', 'api-token', '--value', SECRET], {
      cwd: path.resolve(__dirname, '../..'),
      env: { ...process.env, DATABASE_URL: 'postgresql://jest:jest@127.0.0.1:1/jest_placeholder', TS_NODE_COMPILER_OPTIONS: '{"module":"commonjs"}' },
      encoding: 'utf8',
      timeout: 120_000,
    });
    expect(result.status).toBe(2);
    expect(result.stdout).toBe('');
    expect(result.stderr.trim()).toBe('app-credential-import: Unknown argument at position 5. Values are read only from --from-file.');
    expect(result.stderr).not.toContain(SECRET);
  });

  test('a fresh root shell in the installed backend folder loads .env before the database and fails only inside the safe boundary', () => {
    // Installer convention: backend/.env -> .env.production; the operator's
    // login shell carries no Portal variables. The database here is
    // unreachable on purpose, so the run must end with the prefixed safe
    // message, never a module-load crash about DATABASE_URL.
    const installed = path.join(base, 'backend');
    fs.mkdirSync(installed, { mode: 0o700 });
    const envSecret = 'DUMMY-ENV-JWT-NOT-A-LIVE-SECRET';
    fs.writeFileSync(path.join(installed, '.env.production'),
      `DATABASE_URL=postgresql://jest:jest@127.0.0.1:1/jest_placeholder\nJWT_SECRET=${envSecret}\n`, { mode: 0o600 });
    fs.symlinkSync('.env.production', path.join(installed, '.env'));
    // The installed command is JavaScript. This source-level subprocess uses
    // the same explicit compiler contract even though its cwd is a fixture.
    const env: NodeJS.ProcessEnv = { PATH: process.env.PATH, HOME: process.env.HOME,
      TS_NODE_PROJECT: path.resolve(__dirname, '../../tsconfig.json'),
      TS_NODE_COMPILER_OPTIONS: '{"module":"commonjs"}' };
    const result = spawnSync(process.execPath, ['-r', require.resolve('ts-node/register/transpile-only'),
      path.resolve(__dirname, 'appCredentialImport.ts'), '--app', APP, '--slot', 'api-token', '--from-file', source, '--dry-run'], {
      cwd: installed, env, encoding: 'utf8', timeout: 120_000,
    });
    expect(result.stdout).toBe('');
    expect(result.status).toBe(2);
    expect(result.stderr.startsWith('app-credential-import: ')).toBe(true);
    expect(result.stderr).not.toMatch(/DATABASE_URL is required/);
    expect(result.stderr).not.toContain(SECRET);
    expect(result.stderr).not.toContain(envSecret);
    expect(result.stderr).not.toMatch(/prisma:|invocation/i);
    expect(result.stderr.trim().split('\n')).toHaveLength(1);
    if (process.getuid?.() !== 0) expect(result.stderr.trim()).toBe('app-credential-import: Run as root');
  });

  test('library output is suppressed during the import and restored afterwards', async () => {
    const writes: string[] = [];
    const original = process.stdout.write;
    process.stdout.write = ((chunk: string) => { writes.push(String(chunk)); return true; }) as typeof process.stdout.write;
    try {
      const { withoutLibraryOutput } = await import('./appCredentialImport');
      await expect(withoutLibraryOutput(async () => {
        console.log(`prisma:error args ${SECRET}`);
        console.error(`prisma:error args ${SECRET}`);
        process.stdout.write(`raw ${SECRET}`);
        throw new Error('database unreachable');
      })).rejects.toThrow('database unreachable');
      expect(writes.join('')).not.toContain(SECRET);
      process.stdout.write('after');
      expect(writes.join('')).toContain('after');
    } finally {
      process.stdout.write = original;
    }
  });
});
