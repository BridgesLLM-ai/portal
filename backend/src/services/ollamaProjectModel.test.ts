import {
  OllamaProjectModelSelectionError,
  ollamaProjectModelBindingValue,
  parseOllamaProjectModelBinding,
  requireLoopbackOllamaProjectBaseUrl,
  resolveAllowedOllamaProjectModel,
} from './ollamaProjectModel';

const DIGEST = 'a'.repeat(64);

function response(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

describe('Ollama Project exact installed model resolution', () => {
  test('accepts only an uncredentialed loopback root', () => {
    expect(requireLoopbackOllamaProjectBaseUrl('http://127.0.0.1:11434/'))
      .toBe('http://127.0.0.1:11434');
    expect(requireLoopbackOllamaProjectBaseUrl('http://[::1]:11434'))
      .toBe('http://[::1]:11434');
    for (const endpoint of [
      'https://127.0.0.1:11434',
      'http://ollama.internal:11434',
      'http://127.0.0.1:11435',
      'http://[::ffff:127.0.0.1]:11434',
      'http://127.0.0.1:11434/api',
      'http://user:pass@127.0.0.1:11434',
    ]) {
      expect(() => requireLoopbackOllamaProjectBaseUrl(endpoint)).toThrow(OllamaProjectModelSelectionError);
    }
  });

  test('binds an explicit installed tool model to its exact immutable digest', async () => {
    const fetchImpl = jest.fn(async (url: string, init?: RequestInit) => {
      if (url.endsWith('/api/tags')) {
        expect(init?.method).toBe('GET');
        expect(init?.redirect).toBe('manual');
        return response({ models: [{ name: 'qwen3:8b', model: 'qwen3:8b', digest: DIGEST }] });
      }
      expect(url).toBe('http://127.0.0.1:11434/api/show');
      expect(init?.redirect).toBe('manual');
      expect(JSON.parse(String(init?.body))).toEqual({ model: 'qwen3:8b', verbose: false });
      return response({ capabilities: ['completion', 'tools', 'thinking', 'tools'] });
    }) as unknown as typeof fetch;

    const selection = await resolveAllowedOllamaProjectModel([], 'qwen3:8b', {
      baseUrl: 'http://127.0.0.1:11434',
      fetchImpl,
    });
    expect(selection).toEqual({
      model: 'qwen3:8b',
      digest: `sha256:${DIGEST}`,
      capabilities: ['completion', 'thinking', 'tools'],
      backendKind: 'LOCAL',
      backendFingerprint: 'local-ollama-v1:127.0.0.1:11434',
      backendGeneration: null,
    });
    const binding = ollamaProjectModelBindingValue(selection);
    expect(binding).toBe(`qwen3:8b@sha256:${DIGEST}`);
    expect(parseOllamaProjectModelBinding(binding)).toEqual({
      model: 'qwen3:8b',
      digest: `sha256:${DIGEST}`,
      capabilities: ['tools'],
      backendKind: 'LOCAL',
      backendFingerprint: 'local-ollama-v1:127.0.0.1:11434',
      backendGeneration: null,
    });
  });

  test('fails closed on tag replacement, ambiguity, and missing tool support', async () => {
    const noTools = jest.fn(async (url: string) => (
      url.endsWith('/api/tags')
        ? response({ models: [{ name: 'text:latest', digest: DIGEST }] })
        : response({ capabilities: ['completion'] })
    )) as unknown as typeof fetch;
    await expect(resolveAllowedOllamaProjectModel([], 'text:latest', {
      baseUrl: 'http://127.0.0.1:11434',
      fetchImpl: noTools,
    })).rejects.toThrow(/does not advertise native tool calling/);

    const duplicate = jest.fn(async (url: string) => (
      url.endsWith('/api/tags')
        ? response({ models: [
          { name: 'qwen3:8b', digest: DIGEST },
          { name: 'qwen3:8b', digest: 'b'.repeat(64) },
        ] })
        : response({ capabilities: ['tools'] })
    )) as unknown as typeof fetch;
    await expect(resolveAllowedOllamaProjectModel([], 'qwen3:8b', {
      baseUrl: 'http://127.0.0.1:11434',
      fetchImpl: duplicate,
    })).rejects.toThrow(/ambiguous/);

    expect(() => parseOllamaProjectModelBinding('qwen3:8b')).toThrow(/exact model digest/);
  });

  test('does not follow catalog redirects to a different destination', async () => {
    const fetchMock = jest.fn(async (_input: string | URL | Request, _init?: RequestInit) => new Response(null, {
      status: 307,
      headers: { location: 'http://169.254.169.254/latest/meta-data' },
    }));
    const fetchImpl = fetchMock as unknown as typeof fetch;

    await expect(resolveAllowedOllamaProjectModel([], 'qwen3:8b', {
      baseUrl: 'http://127.0.0.1:11434',
      fetchImpl,
    })).rejects.toThrow(/catalog failed with HTTP 307/i);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0][1]).toEqual(expect.objectContaining({
      method: 'GET',
      redirect: 'manual',
      signal: expect.any(AbortSignal),
    }));
  });

  test('binds Tailnet qualification to the paired model, digest, generation, and canonical encoding', async () => {
    const authority = Object.freeze({
      kind: 'TAILNET' as const,
      source: 'tailnet-binding' as const,
      endpoint: null,
      generation: 7,
      version: 11,
      bindingFingerprint: 'ollama-backend:paired-fingerprint',
      selectedModel: 'qwen3:8b',
      selectedModelDigest: `sha256:${DIGEST}`,
    });
    const resolved = {
      authority,
      bindingView: {
        purposeId: 'PRIMARY' as const,
        authority: {} as any,
        candidate: null,
      },
    };
    const requestResolvedJson = jest.fn(async (_resolved: unknown, input: { path: string }) => ({
      authority,
      value: input.path === '/api/tags'
        ? { models: [{ name: 'qwen3:8b', digest: DIGEST }, { name: 'other:latest', digest: 'b'.repeat(64) }] }
        : { capabilities: ['completion', 'tools'] },
    })) as any;

    const selection = await resolveAllowedOllamaProjectModel(
      ['other:latest'],
      null,
      {
        resolveAuthority: async () => resolved as any,
        requestResolvedJson,
      },
    );
    expect(selection).toEqual({
      model: 'qwen3:8b',
      digest: `sha256:${DIGEST}`,
      capabilities: ['completion', 'tools'],
      backendKind: 'TAILNET',
      backendFingerprint: authority.bindingFingerprint,
      backendGeneration: 7,
    });
    expect(requestResolvedJson.mock.calls.map(([, input]: any[]) => input.path))
      .toEqual(['/api/tags', '/api/show']);

    const binding = ollamaProjectModelBindingValue(selection);
    expect(binding).toMatch(/^ollama-project:v2:/);
    expect(parseOllamaProjectModelBinding(binding)).toEqual({
      ...selection,
      capabilities: ['tools'],
    });

    const parsed = JSON.parse(
      Buffer.from(binding.slice('ollama-project:v2:'.length), 'base64url').toString('utf8'),
    );
    const alias = 'ollama-project:v2:' + Buffer.from(JSON.stringify({
      model: parsed.model,
      digest: parsed.digest,
      backendKind: parsed.backendKind,
      backendGeneration: parsed.backendGeneration,
      backendFingerprint: parsed.backendFingerprint,
    }), 'utf8').toString('base64url');
    expect(() => parseOllamaProjectModelBinding(alias)).toThrow(/canonical/i);

    requestResolvedJson.mockImplementationOnce(async () => ({
      authority,
      value: { models: [{ name: 'qwen3:8b', digest: 'c'.repeat(64) }] },
    }));
    await expect(resolveAllowedOllamaProjectModel([], null, {
      resolveAuthority: async () => resolved as any,
      requestResolvedJson,
    })).rejects.toThrow(/selected immutable digest/i);
  });
});
