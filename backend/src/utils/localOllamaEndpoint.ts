export const DEFAULT_LOCAL_OLLAMA_ENDPOINT = 'http://127.0.0.1:11434';
export const LOCAL_OLLAMA_PORT = 11434;

const LOCAL_OLLAMA_ROOT_RE = /^http:\/\/(localhost|127\.0\.0\.1|\[::1\])(?::([0-9]+))?\/?$/i;

export class LocalOllamaEndpointError extends Error {
  readonly code = 'LOCAL_OLLAMA_ENDPOINT_REQUIRED';

  constructor() {
    super('Ollama must use an uncredentialed loopback http endpoint on port 11434.');
    this.name = 'LocalOllamaEndpointError';
  }
}

/**
 * Accepts only the installer-owned local Ollama boundary. The deliberately
 * small grammar prevents URL-parser canonicalization from turning shorthand
 * or encoded hostnames into a trusted destination.
 */
export function canonicalizeLocalOllamaEndpoint(value: unknown): string {
  const raw = String(value ?? '').trim();
  const match = raw.match(LOCAL_OLLAMA_ROOT_RE);
  if (!match || (match[2] && match[2] !== String(LOCAL_OLLAMA_PORT))) {
    throw new LocalOllamaEndpointError();
  }

  const host = match[1].toLowerCase();
  if (host === '[::1]') return `http://[::1]:${LOCAL_OLLAMA_PORT}`;
  return DEFAULT_LOCAL_OLLAMA_ENDPOINT;
}

/**
 * Legacy environment/settings values are untrusted candidates, not runtime
 * authority. Invalid candidates are ignored and resolution falls back to the
 * fixed loopback endpoint; it never broadens to another network address.
 */
export function resolveLocalOllamaEndpoint(
  ...candidates: Array<string | null | undefined>
): string {
  for (const candidate of candidates) {
    if (!String(candidate ?? '').trim()) continue;
    try {
      return canonicalizeLocalOllamaEndpoint(candidate);
    } catch {
      // Continue only to another loopback candidate.
    }
  }
  return DEFAULT_LOCAL_OLLAMA_ENDPOINT;
}
