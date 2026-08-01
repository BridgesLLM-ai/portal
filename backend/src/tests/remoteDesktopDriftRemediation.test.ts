import fs from 'fs';
import path from 'path';

/**
 * Remote Desktop reported `partial` because a pinned runtime binary had
 * drifted, and offered "Set up Remote Desktop" as the fix. That action cannot
 * change a tool version — by design, tools converge only on a fresh install,
 * an installer --maintain-tools run, or an explicit maintenance action. Running
 * it took 61 steps and ended in the identical warning.
 */
describe('remote desktop remediation targets the real cause', () => {
  const source = fs.readFileSync(path.resolve(__dirname, '../config/featureReadiness.ts'), 'utf8');

  test('detects a launcher blocked by a drifted runtime binary', () => {
    expect(source).toContain('const driftBlocked = checks.some');
    expect(source).toContain('runtime binary .* failed its Portal');
  });

  test('offers tool convergence, not another setup run, for drift', () => {
    expect(source).toContain("id: 'converge-portal-tested-tools'");
    expect(source).toContain('install.sh --update --maintain-tools');
    expect(source).toContain('Re-running Remote Desktop setup cannot change it');
  });

  test('keeps the setup action for ordinary Remote Desktop failures', () => {
    expect(source).toContain("id: 'remote-desktop-auto-setup'");
    expect(source).toContain("endpoint: '/remote-desktop/auto-setup'");
  });

  test('a manual remediation carries no Portal endpoint to click', () => {
    const block = source.slice(
      source.indexOf("id: 'converge-portal-tested-tools'"),
      source.indexOf("id: 'remote-desktop-auto-setup'"),
    );
    expect(block).not.toContain('endpoint:');
    expect(block).toContain('manualCommand:');
  });
});
