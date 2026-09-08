import {
  buildSuggestedNextActions,
  type FeatureReadinessResult,
  withRemoteDesktopRemediation,
} from '../config/featureReadiness';

/**
 * Remote Desktop reported `partial` because a pinned runtime binary had
 * drifted, and offered "Set up Remote Desktop" as the fix. That action cannot
 * change a tool version. Native convergence is now deliberately unavailable,
 * so neither setup nor an unqualified shell command is a truthful action.
 */
describe('remote desktop remediation targets the real cause', () => {
  function missingRemoteDesktop(message: string): FeatureReadinessResult {
    return {
      id: 'remoteDesktop',
      label: 'Remote Desktop',
      status: 'partial',
      applicable: true,
      checks: [{
        id: 'desktop-runtime',
        label: 'Desktop runtime',
        type: 'command',
        required: true,
        ok: false,
        message,
        remediation: 'Inspect the failed readiness check.',
      }],
    };
  }

  test('offers no unsafe action when a native runtime drift blocks the launcher', () => {
    const result = withRemoteDesktopRemediation(missingRemoteDesktop(
      'antigravity runtime binary at /usr/local/bin/agy failed its Portal command/version contract (expected 1.1.17)',
    ));
    expect(result.remediationAction).toBeUndefined();
    expect(result.checks[0]?.remediation).toBe(
      'Remote Desktop setup cannot change native packages. For OpenClaw, Codex, Claude Code, and ClawHub, Owner can run Admin > Maintenance > Update Compatible AI Tools; other runtimes keep their dedicated setup path.',
    );
    expect(JSON.stringify(result)).not.toContain('maintain-tools');
    expect(JSON.stringify(result)).not.toContain('Reconverge');
    expect(JSON.stringify(result)).not.toContain('Re-run Remote Desktop setup');
    expect(buildSuggestedNextActions([result])).toEqual([
      'Remote Desktop: Remote Desktop setup cannot change native packages. For OpenClaw, Codex, Claude Code, and ClawHub, Owner can run Admin > Maintenance > Update Compatible AI Tools; other runtimes keep their dedicated setup path.',
    ]);
  });

  test('keeps the setup action for ordinary Remote Desktop failures', () => {
    const result = withRemoteDesktopRemediation(missingRemoteDesktop(
      'bridges-rd-websockify.service is inactive.',
    ));
    expect(result.remediationAction).toEqual(expect.objectContaining({
      id: 'remote-desktop-auto-setup',
      endpoint: '/remote-desktop/auto-setup',
      method: 'POST',
    }));
  });
});
