import client from './client';

export type ProjectRuntimeImageRepairStatus = Readonly<{
  state: 'ready' | 'running' | 'failed' | 'unavailable';
  unavailableReason?: 'image-missing' | 'image-state-unknown' | 'unit-state-unknown';
  confirmationPhrase: string;
  ownerOnly: true;
  changesSystem: true;
  restartExpected: true;
}>;

export type ProjectRuntimeImageRepairLaunch = Readonly<{
  ok: true;
  state: 'ready' | 'running';
  started: boolean;
}>;

const confirmationPhrase = 'REPAIR PROJECT RUNTIME IMAGE';

function requireRecord(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${label} response is malformed`);
  }
  return value as Record<string, unknown>;
}

export function validateProjectRuntimeImageRepairStatus(
  value: unknown,
): ProjectRuntimeImageRepairStatus {
  const record = requireRecord(value, 'Project runtime image repair status');
  const unavailableReasons = ['image-missing', 'image-state-unknown', 'unit-state-unknown'] as const;
  const unavailableReason = record.unavailableReason;
  if (
    !['ready', 'running', 'failed', 'unavailable'].includes(String(record.state))
    || record.confirmationPhrase !== confirmationPhrase
    || record.ownerOnly !== true
    || record.changesSystem !== true
    || record.restartExpected !== true
    || (unavailableReason !== undefined && !unavailableReasons.includes(
      unavailableReason as typeof unavailableReasons[number],
    ))
    || (record.state !== 'unavailable' && unavailableReason !== undefined)
  ) {
    throw new Error('Project runtime image repair status response is malformed');
  }
  return Object.freeze({
    state: record.state as ProjectRuntimeImageRepairStatus['state'],
    ...(unavailableReason !== undefined ? {
      unavailableReason: unavailableReason as NonNullable<ProjectRuntimeImageRepairStatus['unavailableReason']>,
    } : {}),
    confirmationPhrase,
    ownerOnly: true,
    changesSystem: true,
    restartExpected: true,
  });
}

export function validateProjectRuntimeImageRepairLaunch(
  value: unknown,
): ProjectRuntimeImageRepairLaunch {
  const record = requireRecord(value, 'Project runtime image repair launch');
  if (
    record.ok !== true
    || (record.state !== 'ready' && record.state !== 'running')
    || typeof record.started !== 'boolean'
  ) {
    throw new Error('Project runtime image repair launch response is malformed');
  }
  return Object.freeze({
    ok: true,
    state: record.state,
    started: record.started,
  });
}

export const projectRuntimeImageRepairAPI = {
  async status(): Promise<ProjectRuntimeImageRepairStatus> {
    const { data } = await client.get('/system/remediation/projectRuntimeImage/status', {
      timeout: 10_000,
      _silent: true,
    } as any);
    return validateProjectRuntimeImageRepairStatus(data);
  },

  async repair(confirmation: string): Promise<ProjectRuntimeImageRepairLaunch> {
    const { data } = await client.post('/system/remediation/projectRuntimeImage/auto-setup', {
      confirmation,
    }, { timeout: 15_000, _skipNetworkRetry: true } as any);
    return validateProjectRuntimeImageRepairLaunch(data);
  },
};
