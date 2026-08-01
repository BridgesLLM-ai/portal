import { describe, expect, it } from 'vitest';
import { extractError } from './errorHelpers';

function serverError(status: number, data: Record<string, unknown>) {
  return { response: { status, statusText: '', data }, config: { url: '/x', method: 'post' } };
}

describe('server-named error causes beat status guesses', () => {
  it('explains an access refusal instead of blaming a restarting backend', () => {
    // The real report: Remote GPU connect returned 502 TAILNET_ACCESS_DENIED and
    // the UI hinted "the backend may be restarting" while the GPU was healthy.
    // The wording deliberately no longer names a single culprit: the refusal can
    // come from tailnet policy or from Ollama rejecting the Host it was handed.
    const out = extractError(serverError(502, {
      error: 'The Remote GPU refused this connection at its private listener.',
      code: 'TAILNET_ACCESS_DENIED',
    }), 'Request failed');
    expect(out.hint).toContain('refused the connection');
    expect(out.hint).not.toContain('restarting');
    expect(out.code).toBe('TAILNET_ACCESS_DENIED');
  });

  it('still falls back to the status hint when no code is given', () => {
    const out = extractError(serverError(502, { error: 'boom' }), 'Request failed');
    expect(out.hint).toContain('Bad gateway');
  });

  it('ignores an unknown code and uses the status hint', () => {
    const out = extractError(serverError(409, { error: 'x', code: 'SOMETHING_NEW' }), 'ctx');
    expect(out.hint).toContain('Conflict');
  });

  it('explains a self-clearing turn lease rather than a bare conflict', () => {
    const out = extractError(serverError(503, {
      error: 'This Project is still finishing a chat turn.',
      code: 'TURN_STILL_ACTIVE',
    }), 'Deleting project');
    expect(out.hint).toContain('clears itself');
  });
});
