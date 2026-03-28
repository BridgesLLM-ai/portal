import client from './client';

export interface AdminUser {
  id: string;
  email: string;
  username: string;
  firstName?: string | null;
  lastName?: string | null;
  role: 'OWNER' | 'SUB_ADMIN' | 'USER' | 'VIEWER';
  accountStatus: 'ACTIVE' | 'PENDING' | 'DISABLED' | 'BANNED';
  isActive: boolean;
  sandboxEnabled: boolean;
  lastLoginAt?: string | null;
  approvedAt?: string | null;
  approvedBy?: string | null;
  createdAt: string;
  avatarPath?: string | null;
}

export interface RegistrationRequest {
  id: string;
  email: string;
  name: string;
  message?: string | null;
  status: 'PENDING' | 'APPROVED' | 'DENIED';
  requestedAt: string;
  reviewedAt?: string | null;
  reviewedBy?: string | null;
}

export interface PaginatedResponse<T> {
  total: number;
  page: number;
  pages: number;
}

export const adminAPI = {
  // Users
  listUsers: async (params?: { page?: number; limit?: number; search?: string }): Promise<{ users: AdminUser[]; total: number; page: number; pages: number }> => {
    const { data } = await client.get('/admin/users', { params });
    return data;
  },

  getUser: async (id: string): Promise<AdminUser> => {
    const { data } = await client.get(`/admin/users/${id}`);
    return data;
  },

  updateUser: async (id: string, updates: Partial<Pick<AdminUser, 'role' | 'accountStatus' | 'sandboxEnabled' | 'isActive' | 'username'>>): Promise<AdminUser> => {
    const { data } = await client.patch(`/admin/users/${id}`, updates);
    return data;
  },

  transferOwnership: async (id: string): Promise<{ success: boolean }> => {
    const { data } = await client.post(`/admin/users/${id}/transfer-ownership`);
    return data;
  },

  deleteUser: async (id: string): Promise<{ success: boolean }> => {
    const { data } = await client.delete(`/admin/users/${id}`);
    return data;
  },

  // Registration requests
  listRegistrationRequests: async (params?: { status?: string; page?: number; limit?: number }): Promise<{ requests: RegistrationRequest[]; total: number; page: number; pages: number }> => {
    const { data } = await client.get('/admin/registration-requests', { params });
    return data;
  },

  approveRequest: async (id: string): Promise<{ success: boolean }> => {
    const { data } = await client.post(`/admin/registration-requests/${id}/approve`);
    return data;
  },

  denyRequest: async (id: string, reason?: string): Promise<{ success: boolean }> => {
    const { data } = await client.post(`/admin/registration-requests/${id}/deny`, { reason });
    return data;
  },

  // Settings
  getSettings: async (): Promise<Record<string, string>> => {
    const { data } = await client.get('/admin/settings');
    return data;
  },

  updateSettings: async (settings: Record<string, string>): Promise<Record<string, string>> => {
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
