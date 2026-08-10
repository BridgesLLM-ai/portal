import systemRemediationRouter, {
  getSystemRemediationContract,
  systemRemediationCanRun,
  systemRemediationConfirmationValid,
} from '../routes/system-remediation';

describe('system remediation privilege contract', () => {
  test('keeps every remediation endpoint owner-only', () => {
    expect(systemRemediationCanRun('OWNER')).toBe(true);
    expect(systemRemediationCanRun('SUB_ADMIN')).toBe(false);
    expect(systemRemediationCanRun('USER')).toBe(false);
    const middlewareNames = (systemRemediationRouter as any).stack
      .filter((layer: any) => !layer.route)
      .map((layer: any) => layer.handle?.name);
    expect(middlewareNames).toContain('requireOwner');
  });

  test.each([
    ['terminal', 'REPAIR TERMINAL'],
    ['fileManager', 'REPAIR FILE MANAGER'],
    ['agentTools', 'VERIFY AGENT TOOLS'],
    ['projectRuntimeImage', 'REPAIR PROJECT RUNTIME IMAGE'],
  ])('requires the exact typed confirmation for %s', (feature, phrase) => {
    const contract = getSystemRemediationContract(feature);
    expect(contract).toMatchObject({ ownerOnly: true, confirmationPhrase: phrase });
    expect(systemRemediationConfirmationValid(contract!, phrase)).toBe(true);
    expect(systemRemediationConfirmationValid(contract!, phrase.toLowerCase())).toBe(false);
    expect(systemRemediationConfirmationValid(contract!, undefined)).toBe(false);
  });

  test('does not invent a contract for an unknown feature', () => {
    expect(getSystemRemediationContract('unknown')).toBeNull();
  });
});
