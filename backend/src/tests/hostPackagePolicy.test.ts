import fs from 'fs';
import os from 'os';
import path from 'path';
import { spawnSync } from 'child_process';
import ts from 'typescript';
import { noninteractiveHostPackageCommand } from '../config/hostPackagePolicy';
import { FFMPEG_INSTALL_COMMAND, SAFE_INSTALL_ALLOWLIST } from '../config/toolAdapters';

const policy = { DEBIAN_FRONTEND: 'noninteractive', NEEDRESTART_MODE: 'l', NEEDRESTART_SUSPEND: '1' };
const root = path.resolve(__dirname, '../../..');

// Evaluate only the actual command expressions, never import/execute routes or
// launch jobs. This also verifies each production callsite applies the policy.
function packageCommands(relative: string): string[] {
  const source = ts.createSourceFile(relative, fs.readFileSync(path.join(root, relative), 'utf8'), ts.ScriptTarget.Latest, true);
  const result: string[] = [];
  function visit(node: ts.Node) {
    if (ts.isCallExpression(node) && node.expression.getText(source) === 'noninteractiveHostPackageCommand') {
      result.push(new Function('noninteractiveHostPackageCommand', 'requiredPkgs', `return (${node.getText(source)});`)(
        noninteractiveHostPackageCommand, ['xfce4', 'xterm'],
      ));
    }
    ts.forEachChild(node, visit);
  }
  visit(source);
  return result;
}

describe('host package subprocess policy', () => {
  let fixture: string;
  let bin: string;
  let trace: string;
  const write = (name: string, body: string) => fs.writeFileSync(path.join(bin, name), body, { mode: 0o700 });
  const records = () => fs.existsSync(trace) ? fs.readFileSync(trace, 'utf8').trim().split('\n').map((line) => JSON.parse(line)) : [];

  beforeEach(() => {
    fixture = fs.mkdtempSync(path.join(os.tmpdir(), 'portal-package-policy-'));
    bin = path.join(fixture, 'bin');
    fs.mkdirSync(bin);
    trace = path.join(fixture, 'trace.jsonl');
    write('apt-get', `#!/usr/bin/python3
import json, os, subprocess, sys
with open(os.environ['TRACE'], 'a') as f:
    f.write(json.dumps({'program': 'apt-get', 'args': sys.argv[1:], 'policy': {k: os.getenv(k) for k in ${JSON.stringify(Object.keys(policy))}}}) + '\\n')
subprocess.run(['sh', '-c', 'package-hook'], check=True)
sys.exit(int(os.getenv('PACKAGE_STATUS', '0')))
`);
    write('package-hook', `#!/usr/bin/python3
import json, os
with open(os.environ['TRACE'], 'a') as f:
    f.write(json.dumps({'program': 'hook', 'policy': {k: os.getenv(k) for k in ${JSON.stringify(Object.keys(policy))}}}) + '\\n')
`);
    write('apt', '#!/bin/sh\nprintf "Listing...\\n%s" "${PROTECTED_PACKAGES:-}"\n');
    // Chrome download/removal are inert doubles, not writes to /tmp/google-chrome.deb.
    write('wget', '#!/bin/sh\nexit 0\n');
    write('rm', '#!/bin/sh\nexit 0\n');
    for (const name of ['systemctl', 'service', 'shutdown', 'reboot', 'curl', 'sudo']) {
      write(name, '#!/bin/sh\necho FORBIDDEN >&2\nexit 90\n');
    }
    // Independent fake host policy starts with auto-reboot enabled; the actual
    // production Python launcher must override it after importing python-apt.
    fs.writeFileSync(path.join(fixture, 'apt_pkg.py'), `class Config(dict):
    def set(self, name, value): self[name] = value
config = Config()
`);
    fs.writeFileSync(path.join(fixture, 'apt.py'), `import apt_pkg
apt_pkg.config.set('Unattended-Upgrade::Automatic-Reboot', 'true')
apt_pkg.config.set('Unattended-Upgrade::Allowed-Origins', 'host-security-policy')
`);
    write('unattended-upgrade', `#!/usr/bin/python3
import apt, apt_pkg, json, os, subprocess, sys
assert sys.argv[1:] == ['-v']
assert apt_pkg.config['Unattended-Upgrade::Allowed-Origins'] == 'host-security-policy'
if apt_pkg.config['Unattended-Upgrade::Automatic-Reboot'] != 'false':
    subprocess.run(['reboot'], check=True)
with open(os.environ['TRACE'], 'a') as f:
    f.write(json.dumps({'program': 'unattended-upgrade', 'reboot': apt_pkg.config['Unattended-Upgrade::Automatic-Reboot']}) + '\\n')
sys.exit(subprocess.call(['apt-get', 'install', '-y', 'fixture-security-update']))
`);
  });
  afterEach(() => fs.rmSync(fixture, { recursive: true, force: true }));

  function execute(command: string, extra: Record<string, string> = {}) {
    const result = spawnSync('/bin/bash', ['-c', command], {
      encoding: 'utf8', timeout: 10_000, input: '',
      env: {
        PATH: `${bin}:/usr/bin:/bin`, HOME: fixture, LANG: 'C.UTF-8', TRACE: trace, PYTHONPATH: fixture,
        DEBIAN_FRONTEND: 'dialog', NEEDRESTART_MODE: 'a', NEEDRESTART_SUSPEND: '', ...extra,
      },
    });
    expect(result.error).toBeUndefined();
    expect(result.stderr).not.toContain('FORBIDDEN');
    return result;
  }

  function expectPackages(count: number) {
    const packages = records().filter((r) => r.program === 'apt-get' || r.program === 'hook');
    expect(packages).toHaveLength(count * 2);
    packages.forEach((r) => expect(r.policy).toEqual(policy));
  }

  test('allowlisted FFmpeg update and install pass policy through hook exec', () => {
    expect(SAFE_INSTALL_ALLOWLIST.has(FFMPEG_INSTALL_COMMAND)).toBe(true);
    expect(execute(FFMPEG_INSTALL_COMMAND).status).toBe(0);
    expectPackages(2);
    expect(records()[2].args).toEqual(['-o', 'DPkg::Lock::Timeout=300', 'install', '-y', '-qq', 'ffmpeg']);
  });

  test('FFmpeg update failure prevents installation and retains status', () => {
    expect(execute(FFMPEG_INSTALL_COMMAND, { PACKAGE_STATUS: '43' }).status).toBe(43);
    expectPackages(1);
  });

  test.each([0, 1, 2])('desktop package expression %i exports policy before apt children', (index) => {
    const commands = packageCommands('backend/src/routes/remote-desktop.ts');
    expect(commands).toHaveLength(3);
    expect(execute(commands[index]).status).toBe(0);
    expectPackages(index === 0 ? 2 : 1);
  });

  test('maintenance cache refresh passes policy to apt and hook', () => {
    const commands = packageCommands('backend/src/routes/system-maintenance.ts');
    expect(commands).toHaveLength(2);
    expect(execute(commands[1]).status).toBe(0);
    expectPackages(1);
  });

  test('security launcher disables configured auto-reboot without changing allowed origins', () => {
    const command = packageCommands('backend/src/routes/system-maintenance.ts')[0];
    expect(execute(command).status).toBe(0);
    expect(records()[0]).toEqual({ program: 'unattended-upgrade', reboot: 'false' });
    expectPackages(1);
  });

  test('security package failure is propagated', () => {
    const command = packageCommands('backend/src/routes/system-maintenance.ts')[0];
    expect(execute(command, { PACKAGE_STATUS: '43' }).status).toBe(43);
    expectPackages(1);
  });

  test('protected component still refuses before starting security mutations', () => {
    const command = packageCommands('backend/src/routes/system-maintenance.ts')[0];
    expect(execute(command, { PROTECTED_PACKAGES: 'caddy/stable 1.0 amd64\n' }).status).toBe(42);
    expect(records()).toEqual([]);
  });
});
