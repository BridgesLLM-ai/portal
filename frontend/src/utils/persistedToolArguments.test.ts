import { describe, expect, it } from 'vitest';
import { recoverPersistedToolArguments } from './persistedToolArguments';

describe('persisted native tool arguments', () => {
  it('passes ordinary arguments through unchanged', () => {
    const args = { command: 'npm test' };
    expect(recoverPersistedToolArguments(args)).toBe(args);
    expect(recoverPersistedToolArguments('apply this patch')).toBe('apply this patch');
    expect(recoverPersistedToolArguments(undefined)).toBeUndefined();
    expect(recoverPersistedToolArguments({ __truncated: 'yes', preview: '{}' })).toEqual({ __truncated: 'yes', preview: '{}' });
  });

  it('recovers the fields a card titles itself with from a truncated preview', () => {
    const original = JSON.stringify({ file_path: '/srv/app/src/huge "quoted".ts', content: 'x'.repeat(9000) });
    const recovered = recoverPersistedToolArguments({ __truncated: true, preview: `${original.slice(0, 4000)}\n… [truncated by Portal]` });
    expect(recovered).toEqual({ file_path: '/srv/app/src/huge "quoted".ts' });
  });

  it('drops a preview with nothing recoverable instead of showing unreadable JSON', () => {
    expect(recoverPersistedToolArguments({ __truncated: true, preview: '{"content":"' + 'y'.repeat(3000) })).toBeUndefined();
    // A field cut off mid-string is not invented.
    expect(recoverPersistedToolArguments({ __truncated: true, preview: '{"command":"npm run bu' })).toBeUndefined();
  });
});
