import { normalizeRegistrationMode } from './registrationMode';

describe('registration mode normalization', () => {
  it('shares case-insensitive behavior between auth enforcement and the public shell', () => {
    expect(normalizeRegistrationMode(' OPEN ')).toBe('open');
    expect(normalizeRegistrationMode('Approval')).toBe('approval');
    expect(normalizeRegistrationMode('closed')).toBe('closed');
    expect(normalizeRegistrationMode('unexpected')).toBe('approval');
    expect(normalizeRegistrationMode(null)).toBe('approval');
  });
});
