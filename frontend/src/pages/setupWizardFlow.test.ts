import { describe, expect, it } from 'vitest';
import {
  buildSetupHttpsHandoffUrl,
  getPostSetupDestination,
  getPreviousSetupStep,
  getSetupBrowserTransport,
  getSetupLogoValidationError,
  getSetupNavigationState,
  isSetupAiRuntimeReady,
  readSetupFragmentCredential,
  scrubSetupSecretsFromUrl,
  SETUP_LOGO_MAX_BYTES,
} from './setupWizardFlow';

describe('setup wizard runtime handoff', () => {
  it('blocks credential collection on public HTTP while allowing HTTPS and loopback', () => {
    expect(getSetupBrowserTransport('http:', '203.0.113.10')).toBe('blocked');
    expect(getSetupBrowserTransport('http:', 'portal.example.com')).toBe('blocked');
    expect(getSetupBrowserTransport('http:', 'localhost')).toBe('loopback');
    expect(getSetupBrowserTransport('http:', '127.0.0.1')).toBe('loopback');
    expect(getSetupBrowserTransport('https:', 'portal.example.com')).toBe('https');
  });

  it('keeps bootstrap and HTTPS handoff credentials out of request query strings', () => {
    const bootstrap = 'a'.repeat(64);
    expect(readSetupFragmentCredential(`#bootstrap=${bootstrap}`)).toEqual({ kind: 'bootstrap', value: bootstrap });
    expect(readSetupFragmentCredential(`#handoff=${bootstrap}`)).toEqual({ kind: 'handoff', value: bootstrap });
    expect(readSetupFragmentCredential(`?bootstrap=${bootstrap}`)).toBeNull();

    const scrubbed = new URL(scrubSetupSecretsFromUrl(
      `http://localhost:4001/setup?step=2&token=legacy#bootstrap=${bootstrap}`,
    ));
    expect(scrubbed.searchParams.get('step')).toBe('2');
    expect(scrubbed.searchParams.has('token')).toBe(false);
    expect(scrubbed.hash).toBe('');
  });

  it('puts a one-time domain handoff in the HTTPS fragment and preserves resumable navigation', () => {
    const handoffToken = 'b'.repeat(64);
    const handoff = new URL(buildSetupHttpsHandoffUrl({
      targetUrl: 'https://portal.example.com',
      handoffToken,
      navigation: { step: 2, quickSetup: false },
    }));
    expect(handoff.origin).toBe('https://portal.example.com');
    expect(handoff.searchParams.get('step')).toBe('2');
    expect(handoff.search).not.toContain(handoffToken);
    expect(handoff.hash).toContain(handoffToken);
    expect(() => buildSetupHttpsHandoffUrl({
      targetUrl: 'http://portal.example.com',
      handoffToken,
      navigation: { step: 2, quickSetup: false },
    })).toThrow(/HTTPS target/);
  });

  it('does not offer provider sign-in until OpenClaw and its credentialed gateway are ready', () => {
    expect(isSetupAiRuntimeReady(null)).toBe(false);
    expect(isSetupAiRuntimeReady({ ready: false })).toBe(false);
    expect(isSetupAiRuntimeReady({ ready: true })).toBe(true);
    expect(isSetupAiRuntimeReady({})).toBe(false);
  });

  it('hands quick or runtime-deferred setup to authenticated AI settings after launch', () => {
    expect(getPostSetupDestination({ quickSetup: true, aiRuntimeReady: true })).toContain('ai-providers');
    expect(getPostSetupDestination({ quickSetup: false, aiRuntimeReady: false })).toContain('ai-providers');
    expect(getPostSetupDestination({ quickSetup: false, aiRuntimeReady: true })).toBe('/dashboard');
    expect(getPostSetupDestination({
      quickSetup: false,
      aiRuntimeReady: true,
      tailnetRequested: true,
    })).toBe('/settings?tab=ai-providers&setup=complete&ollama=tailnet');
  });

  it('resumes only bounded navigation state and returns quick setup to Welcome', () => {
    expect(getSetupNavigationState('?step=2&mode=quick&token=secret', 8)).toEqual({ step: 2, quickSetup: true });
    expect(getSetupNavigationState('?step=99&mode=quick', 8)).toEqual({ step: 0, quickSetup: false });
    expect(getSetupNavigationState('?step=5&mode=quick', 8)).toEqual({ step: 5, quickSetup: false });
    expect(getPreviousSetupStep({ step: 2, quickSetup: true })).toEqual({ step: 0, quickSetup: false });
    expect(getPreviousSetupStep({ step: 5, quickSetup: false })).toEqual({ step: 4, quickSetup: false });
  });

  it('allows only bounded raster logo uploads before the server normalizes them', () => {
    expect(getSetupLogoValidationError({ type: 'image/png', size: 1024 })).toBeNull();
    expect(getSetupLogoValidationError({ type: 'image/svg+xml', size: 1024 })).toMatch(/SVG is not supported/);
    expect(getSetupLogoValidationError({ type: 'image/png', size: SETUP_LOGO_MAX_BYTES + 1 })).toMatch(/5 MB/);
    expect(getSetupLogoValidationError({ type: 'image/png', size: 0 })).toMatch(/empty/);
  });
});
