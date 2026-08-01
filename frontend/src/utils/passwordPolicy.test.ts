import { describe, expect, it } from 'vitest';
import { validatePortalPassword } from './passwordPolicy';

describe('public password policy', () => {
  it('matches the server strength requirements', () => {
    expect(validatePortalPassword('Aa1')).toMatch(/8 characters/);
    expect(validatePortalPassword('weakpass1')).toMatch(/uppercase/);
    expect(validatePortalPassword('STRONGPASS1')).toMatch(/lowercase/);
    expect(validatePortalPassword('StrongPass')).toMatch(/number/);
    expect(validatePortalPassword('StrongPass1')).toBeNull();
  });
});
