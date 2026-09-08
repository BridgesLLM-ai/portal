import { execFileSync } from 'child_process';
import {
  __desktopEnvTest,
  managedDesktopSystemdRunArgs,
  managedDesktopSystemdRunArgv,
} from './desktopEnv';

describe('Remote Desktop systemd-run argument boundary', () => {
  test.each([
    ['249', 'systemd 249 (249.11-0ubuntu3.12)\n', 249],
    ['252', 'systemd 252 (252.39-1~deb12u2)\n', 252],
    ['254', 'systemd 254 (254.5-1)\n', 254],
    ['255', 'systemd 255 (255.4-1ubuntu8.16)\n', 255],
  ])('attests systemd %s', (_label, output, expected) => {
    expect(__desktopEnvTest.parseSystemdRunVersion(output)).toBe(expected);
  });

  test.each(['not-systemd\n', 'systemd 248 (248.3)\n'])('rejects an unsupported version: %s', (output) => {
    expect(() => __desktopEnvTest.parseSystemdRunVersion(output)).toThrow(/249 or newer/i);
  });

  test('encodes hostile direct argv before older systemd service expansion', () => {
    const target = [
      '/usr/bin/mousepad',
      '$PATH',
      '${HOME}',
      '$$',
      '%n',
      '$(touch nope)',
      ' space ',
      '界',
      '',
    ];
    const argv = managedDesktopSystemdRunArgv(
      'bridgesllm-open-path-test.service',
      target[0],
      target.slice(1),
      252,
    );

    expect(argv).not.toContain('--expand-environment=no');
    expect(argv.every((value) => !value.includes('$') && !value.includes('%'))).toBe(true);
    expect(__desktopEnvTest.decodeDesktopArgv(argv.at(-1)!)).toEqual(target);
    expect(argv.slice(-4, -1)).toEqual([
      process.execPath,
      '-e',
      __desktopEnvTest.DESKTOP_ARGV_WRAPPER_SOURCE,
    ]);
  });

  test('adds the explicit no-expansion switch on systemd 254+', () => {
    const argv = managedDesktopSystemdRunArgv(
      'bridgesllm-open-path-test.service',
      '/usr/bin/true',
      [],
      254,
    );
    expect(argv).toContain('--expand-environment=no');
  });

  test('encodes shell-bearing desktop commands instead of exposing them to systemd', () => {
    const command = 'printf "%s" "$HOME"; printf "%s" "%n"';
    const argv = managedDesktopSystemdRunArgs(
      'bridgesllm-project-test.service',
      command,
      252,
    );
    const decoded = __desktopEnvTest.decodeDesktopArgv(argv.at(-1)!);
    expect(decoded.slice(0, 2)).toEqual(['/bin/bash', '-c']);
    expect(decoded[2]).toContain(command);
    expect(argv.every((value) => !value.includes('$') && !value.includes('%'))).toBe(true);
  });

  test('the fixed wrapper preserves the decoded argv at the real exec boundary', () => {
    const expected = ['$PATH', '${HOME}', '$$', '%n', ' spaced ', '界', ''];
    const childSource = 'process.stdout.write(JSON.stringify(process.argv.slice(1)))';
    const launchArgv = [process.execPath, '-e', childSource, ...expected];
    const systemdPayload = Buffer.from(JSON.stringify(launchArgv), 'utf8').toString('base64url');
    const output = execFileSync(process.execPath, [
      '-e',
      __desktopEnvTest.DESKTOP_ARGV_WRAPPER_SOURCE,
      systemdPayload,
    ], {
      encoding: 'utf8',
      env: { PATH: '/usr/bin:/bin' },
    });
    expect(JSON.parse(output)).toEqual(expected);
  });
});
