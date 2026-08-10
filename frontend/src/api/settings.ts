import client from './client';

export type EmbedOriginPolicyEntry = {
  origin: string;
  camera: boolean;
  microphone: boolean;
};

export type EmbedOriginPolicy = {
  version: 1;
  revision: string;
  status: 'ready' | 'invalid';
  entries: EmbedOriginPolicyEntry[];
  defaultOrigins?: string[];
  /** Compatibility with the immediately preceding candidate API. */
  builtInOrigins?: string[];
  limits: {
    maxOrigins: number;
    maxOriginBytes: number;
    maxPolicyBytes: number;
  };
  updatedAt: string | null;
  warning?: string;
};

export type UpdateEmbedOriginPolicyRequest = {
  expectedRevision: string;
  entries: EmbedOriginPolicyEntry[];
};

export const settingsAPI = {
  getPortalSettings: async (): Promise<Record<string, string>> => {
    const { data } = await client.get('/admin/settings');
    return data;
  },

  updatePortalSettings: async (settings: Record<string, string>): Promise<Record<string, string>> => {
    const { data } = await client.put('/admin/settings', settings);
    return data;
  },

  getSearchVisibility: async (): Promise<{ visibility: 'visible' | 'hidden' }> => {
    const { data } = await client.get('/admin/search-visibility');
    return data;
  },

  updateSearchVisibility: async (visibility: 'visible' | 'hidden'): Promise<{ visibility: 'visible' | 'hidden' }> => {
    const { data } = await client.put('/admin/search-visibility', { visibility });
    return data;
  },

  getEmbedOriginPolicy: async (signal?: AbortSignal): Promise<EmbedOriginPolicy> => {
    const { data } = await client.get('/admin/security/embed-origins', { signal });
    return data;
  },

  updateEmbedOriginPolicy: async (request: UpdateEmbedOriginPolicyRequest): Promise<EmbedOriginPolicy> => {
    const { data } = await client.put('/admin/security/embed-origins', request);
    return data;
  },

  sendTestEmail: async (): Promise<{ success: boolean; message?: string; error?: string }> => {
    const { data } = await client.post('/admin/settings/test-email');
    return data;
  },
};
