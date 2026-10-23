/**
 * Runtime projection of App credentials: real directories, modes and
 * ownership (root-attested: chown to the App user 1000:1000 needs root).
 * Values are obvious dummies.
 */
import fs from 'fs';
import os from 'os';
import path from 'path';
import {
  __appCredentialProjectionTest as seams,
  attestAppCredentialDirectory,
  materializeAppCredentials,
  removeAppCredentialDirectory,
  removeAppCredentialProjections,
  sweepAppCredentialProjections,
  type AppCredentialAttachment,
} from './projection';

const APP = '11111111-2222-4333-8444-555555555555';
const OTHER_APP = '66666666-7777-4888-8999-000000000000';
const SECRET = 'DUMMY-NOT-A-REAL-SECRET';
const entries = [
  { slot: 'api-token', value: `{"username":"dummy","password":"${SECRET}"}` },
  { slot: 'service-login', value: `URL=https://service.invalid\nLOGIN_EMAIL=someone@example.invalid\nPASSWORD=${SECRET}\n` },
];

let base: string;
let root: string;

beforeEach(() => {
  base = fs.mkdtempSync(path.join(os.tmpdir(), 'app-credential-projection-'));
  root = path.join(base, 'app-credentials');
  seams.setRuntimeRoot(root);
  seams.setFilesystemType(() => seams.TMPFS_MAGIC);
});

afterEach(() => {
  seams.reset();
  fs.rmSync(base, { recursive: true, force: true });
});

function mode(file: string): number {
  return fs.lstatSync(file).mode & 0o7777;
}

describe('App credential projection', () => {
  test('writes one 0400 file per slot in a fresh 0500 directory, all owned by the App user', () => {
    const attachment = materializeAppCredentials({ appId: APP, revision: 3, entries });
    expect(path.dirname(attachment.sourceDirectory)).toBe(root);
    expect(path.basename(attachment.sourceDirectory)).toMatch(new RegExp(`^${APP}-[0-9a-f]{16}$`));
    expect(attachment).toMatchObject({ appId: APP, revision: 3, slots: ['api-token', 'service-login'], containerDirectory: '/portal/credentials' });
    expect(mode(root)).toBe(0o700);
    expect(fs.lstatSync(root).uid).toBe(0);
    const directory = fs.lstatSync(attachment.sourceDirectory);
    expect([directory.uid, directory.gid, mode(attachment.sourceDirectory)]).toEqual([1000, 1000, 0o500]);
    expect(fs.readdirSync(attachment.sourceDirectory).sort()).toEqual(['api-token', 'service-login']);
    for (const entry of entries) {
      const file = path.join(attachment.sourceDirectory, entry.slot);
      const stat = fs.lstatSync(file);
      expect([stat.isFile(), stat.uid, stat.gid, mode(file), stat.nlink]).toEqual([true, 1000, 1000, 0o400, 1]);
      expect(fs.readFileSync(file, 'utf8')).toBe(entry.value);
    }
    // The attachment carries names, a revision and an inode: nothing from a value.
    expect(JSON.stringify(attachment)).not.toContain(SECRET);
    expect(Object.isFrozen(attachment)).toBe(true);
    const second = materializeAppCredentials({ appId: APP, revision: 3, entries });
    expect(second.sourceDirectory).not.toBe(attachment.sourceDirectory);
  });

  test('refuses to write anywhere that is not tmpfs (real statfs on this disk-backed temp dir) and leaves nothing', () => {
    seams.reset();
    seams.setRuntimeRoot(root);
    if (fs.statfsSync(base).type === seams.TMPFS_MAGIC) {
      seams.setFilesystemType(() => 0xef53);
    }
    expect(() => materializeAppCredentials({ appId: APP, revision: 1, entries })).toThrow(expect.objectContaining({
      code: 'APP_CREDENTIAL_PROJECTION_UNAVAILABLE',
      message: expect.stringContaining('tmpfs'),
    }));
    expect(fs.readdirSync(root)).toEqual([]);
  });

  test('refuses an unsafe runtime root', () => {
    fs.mkdirSync(path.join(base, 'elsewhere'));
    fs.symlinkSync(path.join(base, 'elsewhere'), root);
    expect(() => materializeAppCredentials({ appId: APP, revision: 1, entries })).toThrow(expect.objectContaining({ code: 'APP_CREDENTIAL_PROJECTION_UNAVAILABLE' }));
    fs.unlinkSync(root);
    fs.mkdirSync(root, { mode: 0o755 });
    fs.chmodSync(root, 0o755);
    // A loose existing root is re-tightened before anything is written into it.
    materializeAppCredentials({ appId: APP, revision: 1, entries });
    expect(mode(root)).toBe(0o700);
  });

  test('rejects malformed projection input before touching the filesystem', () => {
    const cases = [
      { appId: 'not-a-uuid', revision: 1, entries },
      { appId: APP, revision: 0, entries },
      { appId: APP, revision: 1, entries: [] },
      { appId: APP, revision: 1, entries: [entries[0], entries[0]] },
      { appId: APP, revision: 1, entries: [{ slot: '../x', value: 'v' }] },
      { appId: APP, revision: 1, entries: [{ slot: 'empty', value: '' }] },
      { appId: APP, revision: 1, entries: Array.from({ length: 17 }, (_, index) => ({ slot: `s${index}`, value: 'v' })) },
    ];
    for (const input of cases) expect(() => materializeAppCredentials(input)).toThrow('App credential projection input is invalid');
    expect(fs.existsSync(root)).toBe(false);
  });

  test('attestation catches a changed mode, an extra or missing file, a link and a replaced directory', () => {
    const fresh = () => materializeAppCredentials({ appId: APP, revision: 1, entries });
    let attachment: AppCredentialAttachment = fresh();
    expect(() => attestAppCredentialDirectory(attachment)).not.toThrow();

    fs.chmodSync(attachment.sourceDirectory, 0o700);
    expect(() => attestAppCredentialDirectory(attachment)).toThrow('changed or is unsafe');

    attachment = fresh();
    fs.chmodSync(path.join(attachment.sourceDirectory, 'api-token'), 0o444);
    expect(() => attestAppCredentialDirectory(attachment)).toThrow('changed or is unsafe');

    attachment = fresh();
    fs.writeFileSync(path.join(attachment.sourceDirectory, 'extra'), 'x');
    expect(() => attestAppCredentialDirectory(attachment)).toThrow('changed or is unsafe');

    attachment = fresh();
    fs.rmSync(path.join(attachment.sourceDirectory, 'api-token'));
    expect(() => attestAppCredentialDirectory(attachment)).toThrow('changed or is unsafe');

    attachment = fresh();
    fs.rmSync(path.join(attachment.sourceDirectory, 'api-token'));
    fs.symlinkSync('/etc/hostname', path.join(attachment.sourceDirectory, 'api-token'));
    expect(() => attestAppCredentialDirectory(attachment)).toThrow('changed or is unsafe');

    attachment = fresh();
    fs.rmSync(attachment.sourceDirectory, { recursive: true });
    fs.mkdirSync(attachment.sourceDirectory, { mode: 0o500 });
    expect(() => attestAppCredentialDirectory(attachment)).toThrow('changed or is unsafe');

    attachment = fresh();
    expect(() => attestAppCredentialDirectory({ ...attachment, appId: OTHER_APP })).toThrow('changed or is unsafe');
    seams.setFilesystemType(() => 0xef53);
    expect(() => attestAppCredentialDirectory(attachment)).toThrow('changed or is unsafe');
  });

  test('removal is exact: one directory, one App, or (at boot) every projection, nothing else', () => {
    const first = materializeAppCredentials({ appId: APP, revision: 1, entries });
    const second = materializeAppCredentials({ appId: APP, revision: 2, entries });
    const other = materializeAppCredentials({ appId: OTHER_APP, revision: 1, entries });
    fs.writeFileSync(path.join(root, 'unrelated-file'), 'keep');

    removeAppCredentialDirectory(first.sourceDirectory);
    expect(fs.existsSync(first.sourceDirectory)).toBe(false);
    removeAppCredentialDirectory(first.sourceDirectory); // idempotent
    expect(() => removeAppCredentialDirectory(path.join(base, 'elsewhere'))).toThrow('outside the App credential runtime directory');
    expect(() => removeAppCredentialDirectory(path.join(root, 'unrelated-file'))).toThrow('outside the App credential runtime directory');

    expect(removeAppCredentialProjections(APP)).toBe(1);
    expect(fs.existsSync(second.sourceDirectory)).toBe(false);
    expect(fs.existsSync(other.sourceDirectory)).toBe(true);
    expect(removeAppCredentialProjections('not-a-uuid')).toBe(0);

    materializeAppCredentials({ appId: APP, revision: 3, entries });
    expect(sweepAppCredentialProjections()).toBe(2);
    expect(fs.readdirSync(root)).toEqual(['unrelated-file']);
    fs.rmSync(root, { recursive: true });
    expect(sweepAppCredentialProjections()).toBe(0);
  });
});
