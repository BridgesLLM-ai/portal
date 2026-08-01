import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const modalFlowSources = {
  ApiKeySetupFlow: readFileSync(new URL('./ApiKeySetupFlow.tsx', import.meta.url), 'utf8'),
  AwsSdkSetupFlow: readFileSync(new URL('./AwsSdkSetupFlow.tsx', import.meta.url), 'utf8'),
  DeviceCodeFlow: readFileSync(new URL('./DeviceCodeFlow.tsx', import.meta.url), 'utf8'),
  ProviderAuthChoice: readFileSync(new URL('./ProviderAuthChoice.tsx', import.meta.url), 'utf8'),
  OpenClawProviderPicker: readFileSync(new URL('./OpenClawProviderPicker.tsx', import.meta.url), 'utf8'),
  NativeCliSetupFlow: readFileSync(new URL('./NativeCliSetupFlow.tsx', import.meta.url), 'utf8'),
  OAuthSetupFlow: readFileSync(new URL('./OAuthSetupFlow.tsx', import.meta.url), 'utf8'),
  SetupTokenFlow: readFileSync(new URL('./SetupTokenFlow.tsx', import.meta.url), 'utf8'),
};

describe('provider setup modal contract', () => {
  it.each(Object.entries(modalFlowSources))(
    'routes %s through the shared viewport modal layer',
    (_name, source) => {
      expect(source).toMatch(/import ViewportModal from ['"]\.\.\/ViewportModal['"]/);
      expect(source).toContain('<ViewportModal');
      expect(source).not.toMatch(/className=["'{`][^\n]*\bfixed\s+inset-0\b/);
      expect(source).not.toMatch(/\bz-50\b/);
      expect(source).toContain('role="dialog"');
      expect(source).toContain('aria-modal="true"');
      expect(source).toMatch(/aria-labelledby="[^"]+"/);
    },
  );

  it('keeps each flow surface bounded to the visual viewport with one content scroller', () => {
    for (const source of Object.values(modalFlowSources)) {
      expect(source).toContain('max-h-[calc(100dvh-2rem)]');
      expect(source.match(/overflow-y-auto/g)).toHaveLength(1);
    }
  });

  it('blocks accidental backdrop and Escape dismissal while setup work owns progress', () => {
    expect(modalFlowSources.ApiKeySetupFlow).toContain("dismissible={step !== 'saving'}");
    expect(modalFlowSources.DeviceCodeFlow).toContain('dismissible={!loading && !cancelling && !activeSession}');
    expect(modalFlowSources.NativeCliSetupFlow).toContain('dismissible={!loading && !cancelling && !sessionOwned && !reviewState && !operation}');
    expect(modalFlowSources.OAuthSetupFlow).toContain('dismissible={!loading && !cancelling && !sessionOwned && !reviewState && !operation}');
    expect(modalFlowSources.SetupTokenFlow).toContain('dismissible={!loading && !cancelling && !activeSession && !reviewState && !operation}');

    for (const flow of [
      modalFlowSources.DeviceCodeFlow,
      modalFlowSources.NativeCliSetupFlow,
      modalFlowSources.OAuthSetupFlow,
      modalFlowSources.SetupTokenFlow,
    ]) {
      expect(flow).toContain('cancelOAuthSession(apiBase, sessionId)');
      expect(flow).toContain('Keep this dialog open and retry cancellation.');
    }
  });
});
