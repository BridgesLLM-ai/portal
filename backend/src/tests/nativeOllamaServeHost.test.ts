import fs from 'fs';
import path from 'path';

/**
 * Ollama refuses any Host it does not recognise with a bare 403. Through
 * Tailscale Serve it would otherwise be handed the tailnet address and port
 * (100.x.y.z:11435) and reject every request — which the Portal reported as
 * the GPU rejecting the work, while the GPU was healthy and answering.
 *
 * The contract uses the tunnel only for transport and presents Ollama's
 * loopback origin as the HTTP Host, avoiding a 403 on CGNAT-style endpoints.
 */
describe('native Ollama transport Host through Tailscale Serve', () => {
  const source = fs.readFileSync(
    path.resolve(__dirname, '../services/nativeOllamaTransport.ts'),
    'utf8',
  );

  test('presents the loopback origin Ollama listens on', () => {
    expect(source).toContain("const REMOTE_LOOPBACK_ORIGIN = '127.0.0.1:11434';");
    expect(source).toContain('host: REMOTE_LOOPBACK_ORIGIN');
  });

  test('only rewrites the Host for the serve listener', () => {
    expect(source).toContain('const REMOTE_SERVE_PORT = 11435;');
    expect(source).toContain('normalized.endpoint.port === REMOTE_SERVE_PORT');
  });

  test('a direct local backend keeps its own Host', () => {
    // The rewrite is conditional, so a 11434 endpoint still derives its Host
    // from the socket rather than being told it is talking to a tunnel.
    const start = source.indexOf('normalized.endpoint.port === REMOTE_SERVE_PORT');
    const block = source.slice(start, start + 160);
    expect(block).toContain('host: REMOTE_LOOPBACK_ORIGIN');
    expect(block).toContain(': {}');
  });
});
