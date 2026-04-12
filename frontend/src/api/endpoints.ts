import client from './client';
import { Metrics, ActivityLog } from '../types';

export const filesAPI = {
  list: async (params?: { path?: string; page?: number; limit?: number; search?: string; mime?: string }) => {
    const { data } = await client.get('/files', { params });
    return data;
  },
  resolve: async (params: { id?: string; path?: string }) => {
    const { data } = await client.get('/files/resolve', { params });
    return data;
  },
  upload: async (formData: FormData) => {
    const { data } = await client.post('/files/upload', formData, {
      headers: { 'Content-Type': 'multipart/form-data' },
    });
    return data;
  },
  delete: async (id: string) => {
    const { data } = await client.delete(`/files/${id}`);
    return data;
  },
  download: (id: string) => {
    const base = import.meta.env.VITE_API_URL || '';
    return `${base}/files/${id}/download`;
  },
};

export const appsAPI = {
  list: async () => {
    const { data } = await client.get('/apps');
    return data;
  },
  get: async (id: string) => {
    const { data } = await client.get(`/apps/${id}`);
    return data;
  },
  create: async (formData: FormData) => {
    const { data } = await client.post('/apps', formData, {
      headers: { 'Content-Type': 'multipart/form-data' },
    });
    return data;
  },
  update: async (id: string, payload: any) => {
    const { data } = await client.put(`/apps/${id}`, payload);
    return data;
  },
  delete: async (id: string) => {
    const { data } = await client.delete(`/apps/${id}`);
    return data;
  },
  deploy: async (id: string, formData: FormData) => {
    const { data } = await client.post(`/apps/${id}/deploy`, formData, {
      headers: { 'Content-Type': 'multipart/form-data' },
    });
    return data;
  },
  createShareLink: async (id: string) => {
    const { data } = await client.post(`/apps/${id}/share`);
    return data;
  },
  getShareLinks: async (id: string) => {
    const { data } = await client.get(`/apps/${id}/share`);
    return data;
  },
};

export const metricsAPI = {
  latest: async (): Promise<Metrics> => {
    const { data } = await client.get('/metrics/latest');
    return data;
  },
  history: async (hours?: number): Promise<Metrics[]> => {
    const { data } = await client.get('/metrics/history', { params: { hours } });
    return data;
  },
};

export interface SystemStats {
  timestamp: string;
  hostname: string;
  platform: string;
  arch: string;
  uptime: number;
  cpu: {
    overall: number;
    perCore: { core: number; usage: number }[];
  };
  memory: {
    total: number;
    used: number;
    free: number;
    available: number;
    buffers: number;
    cached: number;
    buffCache: number;
    usagePercent: number;
  };
  loadAverage: {
    '1min': number;
    '5min': number;
    '15min': number;
  };
  disk: Array<{
    mount: string;
    total: number;
    used: number;
    available: number;
    usagePercent: number;
  }>;
  processes: number;
  docker?: {
    available: boolean;
    containers: any[];
  };
}

export const systemStatsAPI = {
  latest: async (): Promise<SystemStats> => {
    const { data } = await client.get('/system/stats');
    return data;
  },
};

// Smart upload - chunked for large files
export const uploadAPI = {
  // Always use Cloudflare HTTPS - large files use chunked upload
  getUploadUrl: (_fileSize: number) => {
    return import.meta.env.VITE_API_URL || `${window.location.origin}/api`;
  },

  initChunked: async (fileName: string, fileSize: number, totalChunks: number, baseUrl?: string) => {
    const url = baseUrl || (import.meta.env.VITE_API_URL || '');
    const resp = await fetch(`${url}/upload/init`, {
      method: 'POST',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ fileName, fileSize, totalChunks }),
    });
    return resp.json();
  },

  uploadChunk: async (uploadId: string, chunkIndex: number, chunk: ArrayBuffer, baseUrl?: string) => {
    const url = baseUrl || (import.meta.env.VITE_API_URL || '');
    const resp = await fetch(`${url}/upload/chunk`, {
      method: 'POST',
      credentials: 'include',
      headers: {
        'x-upload-id': uploadId,
        'x-chunk-index': chunkIndex.toString(),
        'Content-Type': 'application/octet-stream',
      },
      body: chunk,
    });
    return resp.json();
  },

  completeChunked: async (uploadId: string, baseUrl?: string) => {
    const url = baseUrl || (import.meta.env.VITE_API_URL || '');
    const resp = await fetch(`${url}/upload/complete`, {
      method: 'POST',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ uploadId }),
    });
    return resp.json();
  },
};

export const projectsAPI = {
  list: async () => {
    const { data } = await client.get('/projects');
    return data;
  },
  create: async (name: string, template?: string) => {
    const { data } = await client.post('/projects', { name, template });
    return data;
  },
  clone: async (url: string, name?: string) => {
    const { data } = await client.post('/projects/clone', { url, name });
    return data;
  },
  delete: async (name: string) => {
    const { data } = await client.delete(`/projects/${name}`);
    return data;
  },
  rename: async (name: string, newName: string) => {
    const { data } = await client.patch(`/projects/${name}/rename`, { newName });
    return data;
  },
  getTree: async (name: string, path?: string) => {
    const { data } = await client.get(`/projects/${name}/tree`, { params: { path } });
    return data;
  },
  readFile: async (name: string, path: string) => {
    const { data } = await client.get(`/projects/${name}/file`, { params: { path } });
    return data;
  },
  writeFile: async (name: string, path: string, content: string) => {
    const { data } = await client.put(`/projects/${name}/file`, { path, content });
    return data;
  },
  createFile: async (name: string, path: string, content?: string) => {
    const { data } = await client.post(`/projects/${name}/file`, { path, content });
    return data;
  },
  deleteFile: async (name: string, path: string) => {
    const { data } = await client.delete(`/projects/${name}/file`, { params: { path } });
    return data;
  },
  git: async (name: string, action: string, params?: any) => {
    const { data } = await client.post(`/projects/${name}/git`, { action, ...params });
    return data;
  },
  gitEnhancedLog: async (name: string, branch?: string, limit?: number) => {
    const { data } = await client.post(`/projects/${name}/git`, { action: 'log-enhanced', branch, limit });
    return data;
  },
  gitRevert: async (name: string, hash: string) => {
    const { data } = await client.post(`/projects/${name}/git`, { action: 'revert', hash });
    return data;
  },
  deploy: async (name: string) => {
    const { data } = await client.post(`/projects/${name}/deploy`);
    return data;
  },
  checkDeps: async (name: string) => {
    const { data } = await client.get(`/projects/${name}/check-deps`);
    return data;
  },
  docUpdate: async (name: string, type: string, description: string, details?: string) => {
    const { data } = await client.post(`/projects/${name}/doc-update`, { type, description, details });
    return data;
  },
  share: async (name: string, options?: { expiresAt?: string; maxUses?: number; isPublic?: boolean; password?: string }) => {
    const { data } = await client.post(`/projects/${name}/share`, options);
    return data;
  },
  listShares: async (name: string) => {
    const { data } = await client.get(`/projects/${name}/shares`);
    return data;
  },
  updateShare: async (name: string, linkId: string, updates: { isPublic?: boolean; password?: string; isActive?: boolean }) => {
    const { data } = await client.patch(`/projects/${name}/share/${linkId}`, updates);
    return data;
  },
  revokeShare: async (name: string, linkId: string) => {
    const { data } = await client.delete(`/projects/${name}/share/${linkId}`);
    return data;
  },
  deleteShare: async (name: string, linkId: string) => {
    const { data } = await client.delete(`/projects/${name}/share/${linkId}`, { params: { permanent: 'true' } });
    return data;
  },
  emailShare: async (name: string, linkId: string, body: { recipientEmail: string; password?: string }) => {
    const { data } = await client.post(`/projects/${name}/share/${linkId}/email`, body);
    return data;
  },
  uploadFiles: async (name: string, files: File[], targetPath?: string) => {
    const formData = new FormData();
    files.forEach(f => formData.append('files', f));
    const params = targetPath ? `?path=${encodeURIComponent(targetPath)}` : '';
    // Must set Content-Type to multipart/form-data to override the axios default of application/json
    // Without this, axios serializes FormData as JSON and multer gets no files
    const { data } = await client.post(`/projects/${name}/upload${params}`, formData, {
      headers: { 'Content-Type': 'multipart/form-data' },
    });
    return data;
  },
  renameFile: async (name: string, oldPath: string, newPath: string) => {
    const { data } = await client.post(`/projects/${name}/rename-file`, { oldPath, newPath });
    return data;
  },
  // Chat removed — frontend uses agentSend + agentPoll
  // OpenClaw TUI Chat persistence
  chatHistory: async (name: string) => {
    const { data } = await client.get(`/projects/${name}/chat/history`);
    return data;
  },
  chatSaveMessage: async (name: string, role: string, content: string, messageId?: string) => {
    const { data } = await client.post(`/projects/${name}/chat/message`, { role, content, messageId });
    return data;
  },
  chatSaveMessages: async (name: string, messages: Array<{ role: string; content: string; messageId?: string; timestamp?: string }>) => {
    const { data } = await client.post(`/projects/${name}/chat/messages`, { messages });
    return data;
  },
  chatClearHistory: async (name: string) => {
    const { data } = await client.delete(`/projects/${name}/chat/history`);
    return data;
  },
  chatSessionStatus: async (name: string) => {
    const { data } = await client.get(`/projects/${name}/chat/session-status`);
    return data;
  },
  // Assistant polling (non-streaming architecture)
  agentPoll: async (name: string, afterLine: number = 0, lastSize: number = 0) => {
    const { data } = await client.get(`/projects/${name}/assistant/poll`, { params: { after: afterLine, lastSize } });
    return data;
  },
  agentSend: async (name: string, message: string, model: string) => {
    const { data } = await client.post(`/projects/${name}/assistant/send`, { message, model });
    return data;
  },
  agentGetHistory: async (name: string) => {
    const { data } = await client.get(`/projects/${name}/assistant/history`);
    return data;
  },
  agentSaveHistory: async (name: string, messages: Array<{ role: string; content: string }>, model: string) => {
    const { data } = await client.post(`/projects/${name}/assistant/history`, { messages, model });
    return data;
  },
  agentGetMemory: async (name: string) => {
    const { data } = await client.get(`/projects/${name}/assistant/memory`);
    return data;
  },
  agentSaveMemory: async (name: string, content: string) => {
    const { data } = await client.post(`/projects/${name}/assistant/memory`, { content });
    return data;
  },
  agentResetSession: async (name: string) => {
    const { data } = await client.post(`/projects/${name}/assistant/reset`);
    return data;
  },
  agentGetActiveModel: async (name: string) => {
    const { data } = await client.get(`/projects/${name}/assistant/active-model`);
    return data;
  },
};

export const aiAPI = {
  analyze: async (filePath: string, projectName?: string, prompt?: string) => {
    const { data } = await client.post('/ai/analyze', { filePath, projectName, prompt });
    return data;
  },
  chat: async (message: string, context?: string) => {
    const { data } = await client.post('/ai/chat', { message, context });
    return data;
  },
  readFile: async (path: string, project?: string) => {
    const { data } = await client.get('/ai/file-content', { params: { path, project } });
    return data;
  },
  analyzeCode: async (code: string, language?: string, model?: string) => {
    const { data } = await client.post('/ai/analyze-code', { code, language, model });
    return data;
  },
  ollamaStatus: async () => {
    const { data } = await client.get('/ai/ollama-status');
    return data;
  },
};

export const terminalAPI = {
  lookup: async (query: string, context?: string, model?: string, tier?: string) => {
    const { data } = await client.post('/terminal/lookup', { query, context, model, tier });
    return data;
  },
  autocomplete: async (prefix: string) => {
    const { data } = await client.get('/terminal/autocomplete', { params: { prefix } });
    return data;
  },
};

export const usageAPI = {
  stats: async (agentId?: string, options?: { signal?: AbortSignal }) => {
    const params: Record<string, string> = {};
    if (agentId) params.agent = agentId;
    const { data } = await client.get('/gateway/usage-stats', { params, signal: options?.signal });
    return data;
  },
};

export interface CompatibilityHotfixStatus {
  ok?: boolean;
  applied: boolean;
  supported: boolean;
  scriptExists: boolean;
  detectorPatched: boolean;
  relayPatched: boolean;
  replyPatched: boolean;
  heartbeatRunner: string | null;
  replyBundle: string | null;
  issues: string[];
  note?: string;
}

export const gatewayAPI = {
  status: async () => {
    const { data } = await client.get('/gateway/status');
    return data;
  },
  sessions: async () => {
    const { data } = await client.get('/gateway/sessions');
    return data;
  },
  models: async (provider = 'OPENCLAW'): Promise<{ provider: string; capabilities?: { supportsModelSelection?: boolean; modelSelectionMode?: string; supportsCustomModelInput?: boolean; canEnumerateModels?: boolean; modelCatalogKind?: string; supportsInTurnSteering?: boolean; supportsQueuedFollowUps?: boolean; followUpMode?: string; adapterFamily?: string; adapterKey?: string }; models: Array<{ id: string; alias: string | null; displayName: string; provider: string; source?: string }> }> => {
    const { data } = await client.get('/gateway/models', { params: { provider } });
    return data;
  },
  history: async (session = 'agent:main:main', afterId?: string) => {
    const { data } = await client.get('/gateway/history', { params: { session, after: afterId } });
    return data;
  },
  sessionInfo: async (session = 'agent:main:main', options?: { silent?: boolean }) => {
    const { data } = await client.get('/gateway/session-info', {
      params: { session },
      ...(options?.silent ? { _silent: true } as any : {}),
    });
    return data;
  },
  patchSessionModel: async (session: string, model: string, provider = 'OPENCLAW') => {
    const { data } = await client.post('/gateway/session-model', { session, model, provider });
    return data;
  },
  patchSession: async (session: string, settings: Record<string, any>, provider = 'OPENCLAW') => {
    const { data } = await client.post('/gateway/session-patch', { session, provider, settings });
    return data;
  },
  getConfigPath: async (path: string) => {
    const { data } = await client.get('/gateway/config-path', { params: { path } });
    return data;
  },
  patchConfigPath: async (path: string, value: any) => {
    const { data } = await client.post('/gateway/config-path', { path, value });
    return data;
  },
  getCompatibilityHotfixStatus: async (): Promise<CompatibilityHotfixStatus> => {
    const { data } = await client.get('/gateway/compatibility-hotfix');
    return data;
  },
  applyCompatibilityHotfix: async (): Promise<{ ok: boolean; alreadyApplied: boolean; status: CompatibilityHotfixStatus; patchOutput?: string; restartOutput?: string; message?: string }> => {
    const { data } = await client.post('/gateway/compatibility-hotfix/apply');
    return data;
  },
  send: async (message: string, session = 'main') => {
    const { data } = await client.post('/gateway/send', { message, session });
    return data;
  },
  sendStream: (
    message: string,
    session: string = 'main',
    callbacks: {
      onStatus?: (content: string) => void;
      onText?: (content: string) => void;
      onDone?: (fullText: string) => void;
      onError?: (error: string) => void;
    },
  ): AbortController => {
    const controller = new AbortController();
    const apiUrl = import.meta.env.VITE_API_URL || '';

    const doFetch = async (): Promise<Response> => {
      const response = await fetch(`${apiUrl}/gateway/send?stream=1`, {
        method: 'POST',
        credentials: 'include',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ message, session }),
        signal: controller.signal,
      });
      // Auto-refresh on 401/403
      if ((response.status === 401 || response.status === 403) && !controller.signal.aborted) {
        try {
          const refreshResp = await fetch(`${apiUrl}/auth/refresh`, {
            method: 'POST',
            credentials: 'include',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({}),
          });
          if (refreshResp.ok) {
            return doFetch();
          }
        } catch {}
      }
      return response;
    };

    doFetch()
      .then(async (response) => {
        if (!response.ok) {
          callbacks.onError?.(`Gateway error: ${response.status}`);
          return;
        }
        const reader = response.body?.getReader();
        if (!reader) { callbacks.onError?.('No stream'); return; }

        const decoder = new TextDecoder();
        let buffer = '';

        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });
          const lines = buffer.split('\n');
          buffer = lines.pop() || '';

          for (const line of lines) {
            if (!line.startsWith('data: ')) continue;
            const payload = line.slice(6).trim();
            if (payload === '[DONE]') continue;
            try {
              const evt = JSON.parse(payload);
              if (evt.type === 'status') callbacks.onStatus?.(evt.content);
              else if (evt.type === 'text') callbacks.onText?.(evt.content);
              else if (evt.type === 'done') callbacks.onDone?.(evt.content);
              else if (evt.type === 'error') callbacks.onError?.(evt.content);
            } catch {}
          }
        }
      })
      .catch((err) => {
        if (err.name !== 'AbortError') {
          callbacks.onError?.(err.message);
        }
      });

    return controller;
  },
};

export const activityAPI = {
  list: async (params?: { severity?: string; limit?: number; offset?: number; search?: string; kind?: string; category?: string; page?: number }): Promise<{ logs: ActivityLog[]; total: number; pages: number; page: number }> => {
    const { data } = await client.get('/activity', { params });
    return data;
  },
  unblockIP: async (ip: string, activityId?: string) => {
    const { data } = await client.post('/activity/unblock-ip', { ip, activityId });
    return data;
  },
  heartbeat: async () => {
    const { data } = await client.post('/activity/heartbeat');
    return data;
  },
  archive: async () => {
    const { data } = await client.post('/activity/archive');
    return data;
  },
  /** Report a frontend/API error to the activity log */
  reportError: async (params: {
    message: string;
    stack?: string;
    componentName?: string;
    endpoint?: string;
    context?: string;
    severity?: 'ERROR' | 'CRITICAL';
  }) => {
    try {
      const { data } = await client.post('/activity/report-error', params);
      return data;
    } catch {
      // Silently fail — don't let error reporting cause more errors
      return null;
    }
  },
};

export const alertsAPI = {
  list: async (params?: { severity?: string; limit?: number; offset?: number; since?: string }): Promise<{ alerts: ActivityLog[]; total: number }> => {
    const { data } = await client.get('/alerts', { params });
    return data;
  },
  dismiss: async (id: string) => {
    const { data } = await client.post(`/alerts/${id}/dismiss`);
    return data;
  },
  ingest: async (severity: string, component: string, message: string) => {
    const { data } = await client.post('/alerts', { severity, component, message });
    return data;
  },
};

export const automationsAPI = {
  list: async (agentId?: string, options?: { signal?: AbortSignal }) => {
    const params: Record<string, string> = {};
    if (agentId) {
      params.agentId = agentId;
      params.agent = agentId;
    }
    const { data } = await client.get('/automations/list', { params, signal: options?.signal });
    return data;
  },
  get: async (id: string) => {
    const { data } = await client.get(`/automations/${id}`);
    return data;
  },
  create: async (job: {
    name: string;
    schedule?: string;
    scheduleType: 'interval' | 'hourly' | 'daily' | 'weekly' | 'custom';
    interval?: string;
    time?: string;
    dayOfWeek?: number;
    agent?: string;
    model?: string;
    message: string;
    thinking?: string;
    disabled?: boolean;
    tz?: string;
  }) => {
    const { data } = await client.post('/automations', job);
    return data;
  },
  update: async (id: string, job: {
    name?: string;
    schedule?: string;
    scheduleType?: 'interval' | 'hourly' | 'daily' | 'weekly' | 'custom';
    interval?: string;
    time?: string;
    dayOfWeek?: number;
    agent?: string;
    model?: string;
    message?: string;
    thinking?: string;
    tz?: string;
  }) => {
    const { data } = await client.put(`/automations/${id}`, job);
    return data;
  },
  toggle: async (id: string, enabled?: boolean) => {
    const { data } = await client.post(`/automations/${id}/toggle`, { enabled });
    return data;
  },
  remove: async (id: string) => {
    const { data } = await client.delete(`/automations/${id}`);
    return data;
  },
  runNow: async (id: string) => {
    const { data } = await client.post(`/automations/${id}/run`);
    return data;
  },
  runs: async (id: string, limit = 20) => {
    const { data } = await client.get(`/automations/${id}/runs`, { params: { limit } });
    return data;
  },
  status: async () => {
    const { data } = await client.get('/automations/status');
    return data;
  },
};

export const skillsAPI = {
  list: async () => {
    const { data } = await client.get('/skills');
    return data;
  },
  search: async (query: string, limit = 20) => {
    const { data } = await client.get('/skills/search', { params: { q: query, limit } });
    return data;
  },
  explore: async (sort = 'trending', limit = 25) => {
    const { data } = await client.get('/skills/explore', { params: { sort, limit } });
    return data;
  },
  inspect: async (slug: string) => {
    const { data } = await client.get(`/skills/inspect/${encodeURIComponent(slug)}`);
    return data;
  },
  install: async (name: string) => {
    const { data } = await client.post('/skills/install', { name });
    return data;
  },
  uninstall: async (name: string) => {
    const { data } = await client.post('/skills/uninstall', { name });
    return data;
  },
  listPlugins: async () => {
    const { data } = await client.get('/skills/plugins');
    return data;
  },
  installPlugin: async (spec: string) => {
    const { data } = await client.post('/skills/plugins/install', { spec });
    return data;
  },
};
