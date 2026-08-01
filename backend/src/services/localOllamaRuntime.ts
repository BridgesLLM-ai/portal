import { prisma } from '../config/database';
import { DEFAULT_LOCAL_OLLAMA_ENDPOINT } from '../utils/localOllamaEndpoint';

export interface LocalOllamaRuntimeConfiguration {
  readonly enabled: boolean;
  readonly endpoint: string;
}

/**
 * One runtime resolver for Agent Chat and Ollama inventory. The legacy
 * ollama.remoteHost row is intentionally not read: a raw URL is not a remote
 * peer identity and therefore has no runtime authority.
 */
export async function getLocalOllamaRuntimeConfiguration(): Promise<LocalOllamaRuntimeConfiguration> {
  let localEnabled = true;
  try {
    const settings = await prisma.systemSetting.findMany({
      where: { key: 'ollama.localEnabled' },
    });
    for (const setting of settings) {
      if (setting.key === 'ollama.localEnabled') localEnabled = setting.value !== 'false';
    }
  } catch {
    // Database-backed configuration is optional during startup/recovery.
  }

  return Object.freeze({
    enabled: localEnabled,
    endpoint: DEFAULT_LOCAL_OLLAMA_ENDPOINT,
  });
}
