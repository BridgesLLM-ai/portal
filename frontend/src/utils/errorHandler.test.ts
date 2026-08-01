// @vitest-environment jsdom
// @vitest-environment-options {"url":"https://portal.example.com/projects?resetToken=secret#oauth-code"}
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { reportErrorToApi } = vi.hoisted(() => ({
  reportErrorToApi: vi.fn().mockResolvedValue(null),
}));

vi.mock('../api/endpoints', () => ({
  activityAPI: { reportError: reportErrorToApi },
}));

vi.mock('./sounds', () => ({
  default: { error: vi.fn() },
}));

import { captureError, clearErrors, exportErrorsJSON, getErrors, reportError } from './errorHandler';

describe('frontend error diagnostics', () => {
  beforeEach(() => {
    clearErrors();
    reportErrorToApi.mockClear();
  });

  it('redacts query and fragment secrets and safely serializes circular debug data', () => {
    const debug: Record<string, unknown> = { request: 'failed' };
    debug.self = debug;

    expect(() => reportError({ message: 'failure', debug })).not.toThrow();

    const [stored] = getErrors();
    expect(stored.debug?.url).toBe('https://portal.example.com/projects');
    expect(stored.debug?.route).toBe('/projects');
    expect(stored.debug?.self).toBe('[Circular]');
    expect(exportErrorsJSON()).not.toContain('resetToken');
    expect(exportErrorsJSON()).not.toContain('oauth-code');
    expect(reportErrorToApi).toHaveBeenCalledWith(expect.objectContaining({ context: expect.any(String) }));
  });

  it('bounds fields before reporting them to the server', () => {
    reportError({ message: 'x'.repeat(5_000), stack: 's'.repeat(70_000), endpoint: 'e'.repeat(2_000) });

    expect(reportErrorToApi).toHaveBeenCalledWith(expect.objectContaining({
      message: 'x'.repeat(4_000),
      stack: 's'.repeat(64 * 1024),
      endpoint: 'e'.repeat(1_000),
    }));
  });

  it('records an API route as the endpoint instead of mislabeling it as context', () => {
    captureError(
      new Error('qualification failed'),
      'api',
      { endpoint: 'POST /projects/alpha/chat/providers/openclaw/qualify' },
    );

    const [stored] = getErrors();
    expect(stored.debug?.endpoint).toBe(
      'POST /projects/alpha/chat/providers/openclaw/qualify',
    );
    expect(stored.debug?.context).toBeUndefined();
    expect(reportErrorToApi).toHaveBeenCalledWith(expect.objectContaining({
      endpoint: 'POST /projects/alpha/chat/providers/openclaw/qualify',
      context: expect.not.stringContaining('/projects/alpha'),
    }));
  });
});
