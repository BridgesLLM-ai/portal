import { portalContinuityRepairMain } from './portalContinuityRepair';

describe('Portal continuity repair CLI', () => {
  test('loads the protected inputs and applies only the sealed candidate plan', async () => {
    const calls: string[] = [];
    const stdout: string[] = [];
    const token = 'b'.repeat(64);

    await expect(portalContinuityRepairMain(
      [
        '--env-file', '/opt/bridgesllm/portal/backend/.env.production',
        '--plan-file', '/opt/bridgesllm/update-stage/continuity-plan.json',
      ],
      {
        stdout: { write: (value: string | Uint8Array) => { stdout.push(String(value)); return true; } },
        stderr: { write: () => true },
      },
      {
        getUid: () => 0,
        loadEnvironment: () => { calls.push('environment'); },
        readPlan: () => { calls.push('plan'); return token; },
        loadDependencies: async () => ({
          repair: async (expected) => {
            calls.push(`repair:${expected}`);
            return { appsQuarantined: 2 };
          },
          disconnect: async () => { calls.push('disconnect'); },
        }),
      },
    )).resolves.toBe(0);

    expect(calls).toEqual(['environment', 'plan', `repair:${token}`, 'disconnect']);
    expect(stdout.join('')).toBe('Portal continuity repair complete: quarantined-app-links=2\n');
  });

  test('fails closed without loading the database when the plan is unavailable', async () => {
    const stderr: string[] = [];
    await expect(portalContinuityRepairMain(
      [
        '--env-file', '/opt/bridgesllm/portal/backend/.env.production',
        '--plan-file', '/opt/bridgesllm/update-stage/continuity-plan.json',
      ],
      {
        stdout: { write: () => true },
        stderr: { write: (value: string | Uint8Array) => { stderr.push(String(value)); return true; } },
      },
      {
        getUid: () => 0,
        loadEnvironment: () => undefined,
        readPlan: () => { throw new Error('REPAIR_PLAN_UNAVAILABLE'); },
        loadDependencies: async () => { throw new Error('should not load'); },
      },
    )).resolves.toBe(1);
    expect(stderr.join('')).toBe('Portal continuity repair failed: REPAIR_PLAN_UNAVAILABLE\n');
  });
});
