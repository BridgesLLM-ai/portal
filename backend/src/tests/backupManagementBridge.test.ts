import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { spawnSync } from 'child_process';

jest.mock('../config/database', () => ({
  prisma: { systemSetting: { findUnique: jest.fn(async () => null) } },
}));

// The backend never re-implements backup policy: it runs the same
// backup-data.py the timers run. These tests drive that real program through
// the bridge, and check that both readers agree on which archives authenticate.
const repositoryRoot = path.resolve(__dirname, '../../..');
const root = fs.mkdtempSync(path.join('/root', 'portal-bridge-test-'));
fs.chmodSync(root, 0o700);
const portal = path.join(root, 'portal');
const state = path.join(portal, 'backend', '.data', 'backups');
const backups = path.join(root, 'backups');
const trust = path.join(root, 'trust');
fs.mkdirSync(state, { recursive: true, mode: 0o700 });
fs.chmodSync(path.dirname(state), 0o700);
fs.mkdirSync(backups, { mode: 0o700 });
fs.mkdirSync(trust, { mode: 0o700 });
fs.copyFileSync(path.join(repositoryRoot, 'backup-data.py'), path.join(portal, 'backup-data.py'));
fs.chmodSync(path.join(portal, 'backup-data.py'), 0o644);
fs.writeFileSync(path.join(state, 'backup-base-path'), `${backups}\n`, { mode: 0o600 });
const key = crypto.randomBytes(32);
fs.writeFileSync(path.join(trust, 'archive-hmac.key'), key, { mode: 0o600 });
Object.assign(process.env, {
  PORTAL_ROOT: portal,
  BACKUP_STATE_DIR: state,
  BACKUP_CONFIG_FILE: path.join(state, 'backup-base-path'),
  BRIDGESLLM_BACKUP_TRUST_ROOT: trust,
});

// eslint-disable-next-line @typescript-eslint/no-var-requires
const bridge = require('../services/backupManagement.service') as typeof import('../services/backupManagement.service');
// eslint-disable-next-line @typescript-eslint/no-var-requires
const backup = require('../services/backup.service') as typeof import('../services/backup.service');

afterAll(() => fs.rmSync(root, { recursive: true, force: true }));

describe('backup management bridge to backup-data.py', () => {
  const policy = { keep: { daily: 2, weekly: 1, monthly: 1, comprehensive: 1 }, autoCleanup: true, reserveGiB: 3 };

  it('reads defaults, saves through the program, and returns its refusals', async () => {
    const shown = await bridge.readBackupPolicy();
    expect(shown).toMatchObject({ source: 'default', policy: { keep: { daily: 7, weekly: 4, monthly: 3, comprehensive: 3 }, autoCleanup: false, reserveGiB: 5 } });
    expect(shown.storage.totalBytes).toBeGreaterThan(0);
    await expect(bridge.saveBackupPolicy(policy)).resolves.toMatchObject({ source: 'saved', policy });
    const saved = fs.readFileSync(path.join(state, 'policy.json'), 'utf8');
    for (const invalid of [{ ...policy, extra: true }, { ...policy, reserveGiB: '3' }, null, 'policy']) {
      await expect(bridge.saveBackupPolicy(invalid)).rejects.toMatchObject({ status: 400, code: 'POLICY_INVALID' });
    }
    expect(fs.readFileSync(path.join(state, 'policy.json'), 'utf8')).toBe(saved);
    expect(fs.statSync(path.join(state, 'policy.json')).mode & 0o777).toBe(0o600);
  });

  it('will not execute a backup program that others can modify', async () => {
    const unsafe = path.join(root, 'unsafe');
    fs.mkdirSync(unsafe, { mode: 0o700 });
    fs.copyFileSync(path.join(portal, 'backup-data.py'), path.join(unsafe, 'backup-data.py'));
    fs.chmodSync(path.join(unsafe, 'backup-data.py'), 0o666);
    await expect(bridge.runBackupDataCommand(['policy', 'show'], { script: path.join(unsafe, 'backup-data.py') }))
      .rejects.toMatchObject({ code: 'BACKUP_MANAGEMENT_UNAVAILABLE' });
  });

  it('rejects a malformed plan token before the program runs', async () => {
    await expect(bridge.runBackupCleanup('--confirm')).rejects.toMatchObject({ status: 400, code: 'STALE' });
  });

  it('authenticates exactly the same archives as the backend listing', () => {
    const directory = path.join(backups, 'daily');
    fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
    const names: string[] = [];
    const publish = (tamper?: (receipt: Record<string, unknown>, archive: string) => void) => {
      const name = `portal-daily-20260901-0${names.length}0000-data-${crypto.randomBytes(4).toString('hex')}.tar.gz`;
      const archive = path.join(directory, name);
      fs.writeFileSync(archive, crypto.randomBytes(4096), { mode: 0o600 });
      const stat = fs.statSync(archive, { bigint: true });
      const receipt: Record<string, unknown> = {
        schema: 'bridgesllm.backup-publication.v1', archive: name, backupType: 'daily', completeness: 'complete',
        archiveSize: Number(stat.size), archiveMtimeNs: stat.mtimeNs.toString(),
        manifestHmac: crypto.createHash('sha256').update(fs.readFileSync(archive)).digest('hex'), degradedComponents: [],
      };
      receipt.signature = crypto.createHmac('sha256', key).update(backup.backupReceiptSigningPayload(receipt as any)).digest('hex');
      tamper?.(receipt, archive);
      const receiptPath = `${archive}.receipt.json`;
      if (!fs.existsSync(receiptPath)) fs.writeFileSync(receiptPath, `${JSON.stringify(receipt)}\n`, { mode: 0o600 });
      names.push(name);
    };
    publish();
    publish((receipt) => { receipt.archiveSize = Number(receipt.archiveSize) + 1; });
    publish((receipt) => { receipt.signature = '0'.repeat(64); });
    publish((receipt) => { receipt.backupType = 'weekly'; });
    publish((receipt) => { receipt.extra = 1; });
    publish((receipt, archive) => {
      fs.writeFileSync(`${archive}.receipt.json`, `${JSON.stringify(receipt)}\n`, { mode: 0o644 });
      fs.chmodSync(`${archive}.receipt.json`, 0o644);
    });
    publish((receipt, archive) => {
      fs.writeFileSync(path.join(root, `${path.basename(archive)}.target`), JSON.stringify(receipt), { mode: 0o600 });
      fs.symlinkSync(path.join(root, `${path.basename(archive)}.target`), `${archive}.receipt.json`);
    });
    publish((_receipt, archive) => { fs.utimesSync(archive, new Date('2026-01-01T00:00:00Z'), new Date('2026-01-01T00:00:00Z')); });
    publish();

    const listed = Object.fromEntries(backup.listBackupFiles(backups)
      .filter((file) => file.type === 'daily')
      .map((file) => [file.filename, file.classificationAuthenticated]));
    const harness = [
      'import importlib.util, json, os, sys',
      'from pathlib import Path',
      'spec = importlib.util.spec_from_file_location("backup_data", sys.argv[1])',
      'm = importlib.util.module_from_spec(spec); spec.loader.exec_module(m)',
      'm.TRUST = Path(sys.argv[2]); key = m.receipt_key()',
      'directory = Path(sys.argv[3])',
      'print(json.dumps({p.name: m.receipt_identity(p, "daily", os.lstat(p), key) is not None',
      '                  for p in sorted(directory.iterdir()) if m.ARCHIVE_NAME.fullmatch(p.name)}))',
    ].join('\n');
    const result = spawnSync('/usr/bin/python3', ['-c', harness, path.join(portal, 'backup-data.py'), trust, directory], { encoding: 'utf8' });
    expect(result.status).toBe(0);
    const python = JSON.parse(result.stdout);
    expect(Object.keys(python).sort()).toEqual([...names].sort());
    expect(python).toEqual(listed);
    expect(Object.values(python).filter(Boolean)).toHaveLength(2);
  });
});
