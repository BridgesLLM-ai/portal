import { execFileSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';

process.env.DATABASE_URL ||= 'postgresql://test:test@127.0.0.1:5432/portal_test';
process.env.JWT_SECRET ||= 'systemd-expansion-test-secret';
process.env.JWT_REFRESH_SECRET ||= 'systemd-expansion-test-refresh-secret';

/* eslint-disable @typescript-eslint/no-var-requires */
const {
  PORTAL_INSTALLER_AUTHENTICATION_SCRIPT,
  PORTAL_SELF_UPDATE_SCRIPT,
} = require('../services/updatePreparation');
/* eslint-enable @typescript-eslint/no-var-requires */

/**
 * The Dashboard self-update scripts are passed to `systemd-run` as argv, and
 * systemd rewrites its own escapes *before* bash parses anything:
 *
 *   `$$`      -> a literal `$`
 *   `${NAME}` -> the unit environment value, i.e. empty for anything bash owns
 *
 * 4.0.17 shipped `/proc/$$/fd/3`, `${key_identity##*:}` and `${10}` in that
 * text. systemd turned the first into `/proc/$/fd/3` and blanked the other two,
 * so every Dashboard update died at the first `stat` and no host running
 * 4.0.17 or 4.0.18 could update itself again.
 *
 * The invariant is therefore simple: these scripts must be **fixed points**
 * under systemd expansion. Anything else is a latent update-blocking bug.
 */
function applySystemdArgumentExpansion(argument: string): string {
  return argument
    .replace(/\$\{[^}]*\}/g, '')
    .replace(/\$\$/g, '$');
}

const SCRIPTS: ReadonlyArray<readonly [string, string]> = [
  ['PORTAL_INSTALLER_AUTHENTICATION_SCRIPT', PORTAL_INSTALLER_AUTHENTICATION_SCRIPT],
  ['PORTAL_SELF_UPDATE_SCRIPT', PORTAL_SELF_UPDATE_SCRIPT],
];

describe('systemd-run argument expansion', () => {
  it.each(SCRIPTS)('leaves %s byte-identical', (_name, script) => {
    expect(applySystemdArgumentExpansion(script)).toBe(script);
  });

  it.each(SCRIPTS)('%s contains no systemd-expandable construct', (_name, script) => {
    expect(script).not.toMatch(/\$\$/);
    expect(script).not.toMatch(/\$\{/);
  });

  it('the guard actually rejects the constructs 4.0.17 shipped', () => {
    // Without this, a regex that silently stopped matching would leave every
    // assertion above passing against a broken script.
    expect(applySystemdArgumentExpansion('installer_fd="/proc/$$/fd/3"'))
      .toBe('installer_fd="/proc/$/fd/3"');
    expect(applySystemdArgumentExpansion('key_size="${key_identity##*:}"'))
      .toBe('key_size=""');
    expect(applySystemdArgumentExpansion('"${10}"')).toBe('""');
  });

  it('models real systemd, verified against the running systemd-run', () => {
    // The invariant above is only worth as much as the model of systemd it
    // encodes, so the model is checked against the real thing whenever this
    // host can run it. A drifted model would otherwise pass forever.
    const outputFile = path.join(
      fs.mkdtempSync(path.join(os.tmpdir(), 'systemd-expansion-')),
      'probe.txt',
    );
    const probe = 'echo "dd=$$"; echo "braced=${probe_unset_variable}"; echo "bare=$0"';

    let ran = false;
    try {
      execFileSync('systemd-run', [
        `--unit=portal-expansion-model-${process.pid}`,
        '--collect',
        '--quiet',
        '--wait',
        `--property=StandardOutput=file:${outputFile}`,
        '/bin/bash', '-c', probe, 'probe-argv0',
      ], { stdio: 'ignore', timeout: 30_000 });
      ran = true;
    } catch {
      // No systemd, not root, or a sandbox that forbids transient units.
    }

    if (!ran) {
      expect(fs.existsSync(outputFile)).toBe(false);
      return;
    }

    const observed = fs.readFileSync(outputFile, 'utf8');
    expect(observed).toContain('dd=$');
    expect(observed).toContain('braced=');
    expect(observed).not.toContain('braced=${');
    expect(observed).toContain('bare=probe-argv0');
  });
});
