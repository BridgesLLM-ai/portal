import fs from 'fs';
import os from 'os';
import path from 'path';
import { execFileSync } from 'child_process';
import { compatibleAiNodeVersion, getCompatibleAiPrerequisites } from './compatibleAiPrerequisites';

const supported = {
  nodePath: '/usr/bin/node', npmPath: '/usr/bin/npm',
  version: 'v24.22.1', safeNode: true, npmExecutable: true,
};

test('matches the actual installer on supported, unsupported and malformed Node versions', () => {
  const installer = fs.readFileSync(path.resolve(__dirname, '../../../installer/install.sh'), 'utf8');
  const source = installer.match(/^node_version_meets_minimum\(\) \{[\s\S]*?^\}/m)![0];
  const pins = installer.match(/^readonly PIN_NODE_(?:24|26)_MIN_VERSION=.*$/gm)!.join('\n');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'portal-node-admission-'));
  const binary = path.join(dir, 'node');
  try {
    for (const version of ['v22.22.3', 'v24.21.0', 'v24.22.0', 'v24.22.1', 'v24.23.0',
      'v25.9.0', 'v26.12.0', 'v26.12.1', 'v26.13.0', 'v27.0.0', 'v24.22.1-rc.1', 'not-a-version']) {
      fs.writeFileSync(binary, '#!/bin/sh\nprintf "%s\\n" "' + version + '"\n', { mode: 0o700 });
      const actual = execFileSync('/bin/bash', ['-c',
        pins + '\n' + source + '\nif node_version_meets_minimum "$1"; then echo yes; else echo no; fi',
        'test', binary], { encoding: 'utf8' }).trim() === 'yes';
      expect(compatibleAiNodeVersion(version)).toBe(actual);
    }
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('rejects the historical 24.21.0 prerequisite without starting host changes', async () => {
  const result = await getCompatibleAiPrerequisites(async () => ({ ...supported, version: 'v24.21.0' }));
  expect(result).toMatchObject({ ready: false, code: 'NODE_VERSION_UNSUPPORTED', nodeVersion: 'v24.21.0' });
  expect(result.message).toContain('separate host-maintenance window');
});

test.each([
  { nodePath: '/usr/local/bin/node' }, { npmPath: '/usr/local/bin/npm' },
  { safeNode: false }, { npmExecutable: false },
])('refuses unsafe or shadowed system runtime: %j', async (changed) => {
  expect(await getCompatibleAiPrerequisites(async () => ({ ...supported, ...changed })))
    .toMatchObject({ ready: false, code: 'NODE_RUNTIME_UNSAFE' });
});

test('does not expose arbitrary executable output or exception text', async () => {
  const bad = await getCompatibleAiPrerequisites(async () => ({ ...supported, version: 'secret fixture output' }));
  expect(JSON.stringify(bad)).not.toContain('secret fixture');
  const failed = await getCompatibleAiPrerequisites(async () => { throw new Error('secret fixture error'); });
  expect(failed).toMatchObject({ ready: false, code: 'NODE_CHECK_UNAVAILABLE' });
  expect(JSON.stringify(failed)).not.toContain('secret fixture');
});

test('qualified runtime admits the next installer check, not an upgrade success', async () => {
  expect(await getCompatibleAiPrerequisites(async () => supported))
    .toMatchObject({ ready: true, code: 'READY', nodeVersion: 'v24.22.1' });
});
