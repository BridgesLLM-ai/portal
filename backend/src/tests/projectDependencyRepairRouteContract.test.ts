import fs from 'fs';
import path from 'path';

const routeSource = fs.readFileSync(path.resolve(__dirname, '../routes/projects.ts'), 'utf8');

describe('Owner dependency repair route contract', () => {
  test('exposes one bounded durable-session-gated reload discovery surface', () => {
    expect(routeSource).toContain("'/dependency-repair/active'");
    expect(routeSource).toContain('listActiveProjectDependencyRepairsForOwner({');
    expect(routeSource).toContain('limit: 20');
    expect(routeSource).toMatch(/'\/dependency-repair\/active',[\s\S]*?authenticateToken,[\s\S]*?requireApproved,[\s\S]*?requireOwner,[\s\S]*?requireDurableDependencyRepairSession/);
    expect(routeSource).toMatch(/res\.status\(200\)\.json\(\{ repairs, count: repairs\.length, unavailable: false \}\)/);
    expect(routeSource).toMatch(/res\.status\(200\)\.json\(\{ repairs: \[\], count: 0, unavailable: true \}\)/);
  });

  test('returns typed status uncertainty without Axios rejection and reports honest runtime truth', () => {
    expect(routeSource).toMatch(/catch \(error\) \{[\s\S]*?Dependency repair status failed:[\s\S]*?res\.status\(200\)\.json\(projectDependencyRepairResponse\(\{[\s\S]*?state: 'UNAVAILABLE'/);
    expect(routeSource).toContain("retryable: input.state === 'QUARANTINED' && input.restartRequired !== true");
    expect(routeSource).toMatch(/statusRetryable: \(input\.state === 'PROMOTING' \|\| input\.state === 'UNAVAILABLE'\)\s*&& input\.restartRequired !== true/);
    expect(routeSource).toContain('eligible: Boolean(input.backup?.backup)');
    expect(routeSource).toContain('pinned: input.backupPinned === true');
    expect(routeSource).toContain('restartRequired: input.restartRequired === true');
  });

  test('retains restart-required truth after the terminal timer fires or process termination fails', () => {
    expect(routeSource).toMatch(/function scheduleProjectDependencyRepairStartupHandoff[\s\S]*?fenceState\.restartRequired = true;[\s\S]*?terminalHandoffTimer = setTimeout[\s\S]*?terminalHandoffTimer = null;[\s\S]*?dependencyRepairTerminateProcess/);
    expect(routeSource).not.toMatch(/terminalHandoffTimer = null;\s*fenceState\.restartRequired = false/);
    expect(routeSource).toMatch(/restartRequired: active && \(!fenceState \|\| !leaseHeld \|\| fenceState\.restartRequired\)/);
    expect(routeSource).toMatch(/bounded live retries were exhausted/);
    expect(routeSource).toMatch(/retained backup exclusion lease was lost/);
  });
});
