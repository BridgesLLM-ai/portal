import fs from 'fs';
import os from 'os';
import path from 'path';
import { spawn, spawnSync } from 'child_process';
import {
  assertOpenClawDiagnosticsAdmitted,
  openClawDiagnosticCommand,
  OPENCLAW_DIAGNOSTIC_BLOCKERS,
  OPENCLAW_DIAGNOSTIC_LOCK,
  OPENCLAW_DIAGNOSTICS_QUIESCE_MARKER,
} from '../utils/openclawDiagnosticLease';

describe('OpenClaw diagnostic reader exclusion', () => {
  let root: string;
  beforeEach(() => { root = fs.mkdtempSync(path.join(os.tmpdir(), 'portal-reader-lease-')); });
  afterEach(() => { fs.rmSync(root, { recursive: true, force: true }); });

  test('absent evidence admits; present, malformed and dangling evidence all block', () => {
    const marker = path.join(root, 'maintenance');
    expect(() => assertOpenClawDiagnosticsAdmitted([marker])).not.toThrow();
    fs.writeFileSync(marker, 'not JSON');
    expect(() => assertOpenClawDiagnosticsAdmitted([marker])).toThrow('diagnostics are paused');
    fs.unlinkSync(marker);
    fs.symlinkSync(path.join(root, 'absent'), marker);
    expect(() => assertOpenClawDiagnosticsAdmitted([marker])).toThrow('diagnostics are paused');
  });

  test('toolctl quiesce and restart-window markers both pause diagnostics', () => {
    expect(OPENCLAW_DIAGNOSTIC_BLOCKERS).toEqual(expect.arrayContaining([
      OPENCLAW_DIAGNOSTICS_QUIESCE_MARKER,
      '/var/lib/bridgesllm-installer/openclaw-mutation-maintenance-v1.json',
    ]));
    const quiesce = path.join(root, 'quiesce');
    fs.writeFileSync(quiesce, '{}');
    expect(() => assertOpenClawDiagnosticsAdmitted([quiesce])).toThrow('diagnostics are paused');
  });

  test('non-OpenClaw commands are unchanged', () => {
    expect(openClawDiagnosticCommand('npm', ['root', '-g'])).toEqual(['npm', ['root', '-g']]);
  });

  test('real SQLite reader holds migration out; exclusive migration refuses new readers without touching the DB', async () => {
    const lock = path.join(root, 'readers.lock');
    const database = path.join(root, 'synthetic.sqlite');
    const executable = path.join(root, 'openclaw');
    fs.writeFileSync(executable, `#!/usr/bin/python3\nimport sqlite3,sys\nc=sqlite3.connect(sys.argv[1])\nc.execute('CREATE TABLE IF NOT EXISTS sentinel(value)')\nc.commit()\nprint('ready',flush=True)\nsys.stdin.read()\nc.close()\n`, { mode: 0o700 });
    const [command, productArgs] = openClawDiagnosticCommand(executable, [database]);
    // Use the actual product invocation, substituting only the disposable lock.
    const args = productArgs.map((value) => value === OPENCLAW_DIAGNOSTIC_LOCK ? lock : value);
    const reader = spawn(command, args, { stdio: ['pipe', 'pipe', 'pipe'] });
    try {
      await new Promise<void>((resolve, reject) => {
        reader.once('error', reject);
        reader.once('exit', (code) => reject(new Error(`reader exited early: ${code}`)));
        reader.stdout.once('data', (data) => String(data).includes('ready') ? resolve() : reject(new Error(String(data))));
      });
      expect(spawnSync('/usr/bin/flock', ['--exclusive', '--nonblock', lock, '/usr/bin/true']).status).toBe(1);
      const exited = new Promise<void>((resolve) => reader.once('exit', () => resolve()));
      reader.stdin.end();
      await exited;
      expect(spawnSync('/usr/bin/flock', ['--exclusive', '--nonblock', lock, '/usr/bin/true']).status).toBe(0);
      const before = fs.readFileSync(database);
      // Keep an exclusive lease while invoking the exact guarded reader command.
      const blocked = spawnSync('/usr/bin/flock', ['--exclusive', '--nonblock', lock,
        '/usr/bin/flock', ...args], { encoding: 'utf8', input: '', timeout: 2000 });
      expect(blocked.status).toBe(1);
      expect(fs.readFileSync(database)).toEqual(before);
      expect(spawnSync(command, args, { input: '', timeout: 2000 }).status).toBe(0);
    } finally { reader.kill(); }
  });
});
