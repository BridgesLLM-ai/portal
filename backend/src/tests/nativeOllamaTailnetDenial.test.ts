import { NativeOllamaTransportError } from '../services/nativeOllamaTransport';

/**
 * A Remote GPU whose tailnet Grant is not applied answers with a bare 403 from
 * Tailscale Serve. Ollama's API has no authentication and never returns
 * 401/403, so attributing that to Ollama pointed the operator at a healthy GPU
 * while the real fix was a tailnet policy change.
 */
describe('tailnet denial is not an Ollama rejection', () => {
  const load = () => require('../services/nativeOllamaBackend');

  test.each([401, 403])('a bare %i from the serve port is TAILNET_ACCESS_DENIED', (status) => {
    const { translateTransportErrorForTests } = load();
    const translate = translateTransportErrorForTests;
    expect(() => translate(new NativeOllamaTransportError('HTTP_STATUS', 'x', status)))
      .toThrow(expect.objectContaining({ code: 'TAILNET_ACCESS_DENIED' }));
  });

  test('other non-success statuses remain an Ollama rejection', () => {
    const { translateTransportErrorForTests } = load();
    expect(() => translateTransportErrorForTests(
      new NativeOllamaTransportError('HTTP_STATUS', 'x', 500),
    )).toThrow(expect.objectContaining({ code: 'OLLAMA_REJECTED' }));
  });

  test('connection problems still read as unavailable, not denied', () => {
    const { translateTransportErrorForTests } = load();
    for (const code of ['TIMEOUT', 'CONNECTION_FAILED'] as const) {
      expect(() => translateTransportErrorForTests(
        new NativeOllamaTransportError(code, 'x'),
      )).toThrow(expect.objectContaining({ code: 'OLLAMA_UNAVAILABLE' }));
    }
  });

  test('the denial message describes an access refusal, not a rejected request', () => {
    const { translateTransportErrorForTests } = load();
    let message = '';
    try {
      translateTransportErrorForTests(new NativeOllamaTransportError('HTTP_STATUS', 'x', 403));
    } catch (error: any) { message = String(error?.message || ''); }
    expect(message).toContain('refused this connection');
    expect(message).not.toContain('Ollama API rejected');
  });
});
