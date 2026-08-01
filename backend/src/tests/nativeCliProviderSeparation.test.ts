import {
  getLinkedOpenClawProviderIds,
  getNativeProviderLinkedToOpenClawProvider,
} from '../agents/nativeCliAuth';
import { getAiProviderMeta } from '../config/aiProviders';

describe('native Antigravity and OpenClaw Gemini separation', () => {
  test('links only Antigravity to the native GEMINI harness', () => {
    expect(getLinkedOpenClawProviderIds('GEMINI')).toEqual(['google-antigravity']);
    expect(getNativeProviderLinkedToOpenClawProvider('google-antigravity')).toBe('GEMINI');
    expect(getNativeProviderLinkedToOpenClawProvider('google-gemini-cli')).toBeNull();
    expect(getNativeProviderLinkedToOpenClawProvider('google')).toBeNull();
  });

  test('keeps the provider catalogs on distinct auth transports', () => {
    expect(getAiProviderMeta('google-antigravity')?.primaryAuthType).toBe('native_cli');
    expect(getAiProviderMeta('google-gemini-cli')?.primaryAuthType).toBe('oauth');
  });
});
