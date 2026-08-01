import type {
  LocalOllamaBackendAuthority,
  OllamaBackendAuthorityStreamResponse,
} from './ollamaBackendAuthority';
import { streamNativeOllama } from './nativeOllamaTransport';
import {
  OLLAMA_PULL_TIMEOUT_MS,
  OllamaPullManager,
  type OllamaPullStreamRequest,
} from './ollamaPullManager';

const SETUP_LOCAL_OLLAMA_AUTHORITY: LocalOllamaBackendAuthority = Object.freeze({
  kind: 'LOCAL',
  source: 'local-policy',
  endpoint: 'http://127.0.0.1:11434',
  generation: null,
  version: null,
  bindingFingerprint: 'local-ollama-v1:127.0.0.1:11434',
  selectedModel: null,
  selectedModelDigest: null,
});

/**
 * Pre-owner setup has no authority-setting owner yet. Keep its pull lane on
 * the literal IPv4 loopback transport instead of consulting configured
 * LOCAL/Tailnet authority or the owner-managed localEnabled setting.
 */
export const requestSetupLocalOllamaPull: OllamaPullStreamRequest = async (
  model,
  signal,
  onChunk,
  onAuthority,
): Promise<OllamaBackendAuthorityStreamResponse> => {
  const body = Buffer.from(JSON.stringify({
    model,
    stream: true,
  }), 'utf8');
  try {
    onAuthority(SETUP_LOCAL_OLLAMA_AUTHORITY);
    const response = await streamNativeOllama({
      endpoint: {
        address: '127.0.0.1',
        family: 4,
        port: 11434,
      },
      path: '/api/pull',
      method: 'POST',
      body,
      timeoutMs: OLLAMA_PULL_TIMEOUT_MS,
      maxResponseBytes: 64 * 1024 * 1024,
      signal,
    }, onChunk);
    return Object.freeze({
      authority: SETUP_LOCAL_OLLAMA_AUTHORITY,
      statusCode: response.statusCode,
      headers: response.headers,
      responseBytes: response.responseBytes,
      streaming: true as const,
    });
  } finally {
    body.fill(0);
  }
};

export const setupLocalOllamaPullManager = new OllamaPullManager(
  requestSetupLocalOllamaPull,
);
