import client from './client';

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

  sendTestEmail: async (): Promise<{ success: boolean; message?: string; error?: string }> => {
    const { data } = await client.post('/admin/settings/test-email');
    return data;
  },
};
