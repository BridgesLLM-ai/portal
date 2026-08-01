import { describe, expect, it } from 'vitest';
import { isTypedConfirmationMatch } from './typedConfirmation';

describe('typed confirmation', () => {
  it('is exact and case-sensitive while tolerating accidental outer whitespace', () => {
    expect(isTypedConfirmationMatch('RESTART OPENCLAW', ' RESTART OPENCLAW ')).toBe(true);
    expect(isTypedConfirmationMatch('RESTART OPENCLAW', 'restart openclaw')).toBe(false);
    expect(isTypedConfirmationMatch('RESTART OPENCLAW', '')).toBe(false);
  });

  it('allows confirmation-free read-only actions', () => {
    expect(isTypedConfirmationMatch(null, '')).toBe(true);
  });
});
