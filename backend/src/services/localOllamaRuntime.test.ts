const findMany = jest.fn();

jest.mock('../config/database', () => ({
  prisma: { systemSetting: { findMany } },
}));

jest.mock('../config/env', () => ({
  config: { ollamaApiUrl: 'http://127.0.0.1:11434' },
}));

import { getLocalOllamaRuntimeConfiguration } from './localOllamaRuntime';

describe('local Ollama runtime resolution', () => {
  const originalHost = process.env.OLLAMA_HOST;
  const originalApiUrl = process.env.OLLAMA_API_URL;

  beforeEach(() => {
    jest.clearAllMocks();
    delete process.env.OLLAMA_HOST;
    delete process.env.OLLAMA_API_URL;
  });

  afterAll(() => {
    if (originalHost === undefined) delete process.env.OLLAMA_HOST;
    else process.env.OLLAMA_HOST = originalHost;
    if (originalApiUrl === undefined) delete process.env.OLLAMA_API_URL;
    else process.env.OLLAMA_API_URL = originalApiUrl;
  });

  test('never reads legacy endpoint rows or environment URL candidates', async () => {
    process.env.OLLAMA_HOST = 'http://100.64.0.20:11434';
    process.env.OLLAMA_API_URL = 'http://169.254.169.254:11434';
    findMany.mockResolvedValue([
      { key: 'ollama.host', value: 'http://ollama.internal:11434' },
      { key: 'ollama.localEnabled', value: 'true' },
      { key: 'ollama.remoteHost', value: 'http://10.0.0.2:11434' },
    ]);

    await expect(getLocalOllamaRuntimeConfiguration()).resolves.toEqual({
      enabled: true,
      endpoint: 'http://127.0.0.1:11434',
    });
    expect(findMany).toHaveBeenCalledWith({
      where: { key: 'ollama.localEnabled' },
    });
  });

  test('uses the fixed IPv4 socket authority while retaining the disabled state', async () => {
    findMany.mockResolvedValue([
      { key: 'ollama.host', value: 'http://[::1]:11434/' },
      { key: 'ollama.localEnabled', value: 'false' },
    ]);

    await expect(getLocalOllamaRuntimeConfiguration()).resolves.toEqual({
      enabled: false,
      endpoint: 'http://127.0.0.1:11434',
    });
  });
});
