import client from './client';
import { Metrics, ActivityLog } from '../types';
import {
  captureWorkspaceAuthorizationRequestContext,
  workspaceAuthorizedFetch,
} from '../utils/workspaceAuthorizedFetch';

export type ProjectChatProviderName =
  | 'OPENCLAW'
  | 'CLAUDE_CODE'
  | 'CODEX'
  | 'GROK'
  | 'AGENT_ZERO'
  | 'GEMINI'
  | 'OLLAMA';

export interface ProjectChatProviderCapability {
  provider: ProjectChatProviderName;
  displayName: string;
  runtime: string;
  selectable: boolean;
  executionScope: 'PROJECT_SANDBOX' | null;
  supportsAttachments: boolean;
  supportsModelSelection: boolean;
  supportsAbort: boolean;
  supportsReset: boolean;
  requiresOAuth: boolean;
  reason: string;
}

export interface ProjectChatProviderQualificationStatus {
  provider: 'OPENCLAW' | 'CODEX' | 'CLAUDE_CODE' | 'AGENT_ZERO' | 'GEMINI' | 'OLLAMA';
  status: 'QUALIFIED' | 'UNQUALIFIED' | 'EXPIRED' | 'INVALID' | 'UNAVAILABLE';
  selectable: boolean;
  reason: string;
  qualifiedAt: string | null;
  expiresAt: string | null;
  evidenceFingerprint: string | null;
}

export interface ProjectChatProviderBinding {
  provider: ProjectChatProviderName;
  runtime: string;
  sessionKey: string | null;
  externalSessionId: string | null;
  model: string | null;
  status: string;
  lastActivity: string;
  policyFingerprint: string;
}

export interface ProjectChatProviderCapabilitiesResponse {
  migration?: {
    required: true;
    projectId: string;
    title: string;
    message: string;
  };
  activeProvider: ProjectChatProviderName;
  providers: ProjectChatProviderCapability[];
  supportedProviders: ProjectChatProviderCapability[];
  bindings: ProjectChatProviderBinding[];
  executionContext: {
    scope: 'PROJECT_SANDBOX';
    projectId: string;
    policyFingerprint: string;
  } | null;
  /**
   * Present when the server-selected provider's own runtime is not installed
   * on this server. This is a different problem from "not verified yet" and
   * needs the opposite action, so the panel must not conflate them.
   */
  activeProviderRuntime?: {
    provider: ProjectChatProviderName;
    available: boolean;
    reason: string | null;
    identityProvider: ProjectChatProviderName | null;
  } | null;
  qualifications: {
    OPENCLAW: ProjectChatProviderQualificationStatus;
    CODEX: ProjectChatProviderQualificationStatus;
    CLAUDE_CODE: ProjectChatProviderQualificationStatus;
    AGENT_ZERO: ProjectChatProviderQualificationStatus;
    GEMINI: ProjectChatProviderQualificationStatus;
    OLLAMA: ProjectChatProviderQualificationStatus;
  };
  qualifiedModels?: Partial<Record<
    Exclude<ProjectChatProviderName, 'GROK'>,
    string | null
  >>;
  coordination: {
    stateVersion: number;
    selectedProvider: ProjectChatProviderName;
    transcriptCursor: number;
    activeTurn: {
      id: string;
      provider: ProjectChatProviderName;
      status: string;
      requestId: string;
      leaseExpiresAt: string;
    } | null;
    /** A short-lived runtime admission is active; clients must wait rather
     * than starting a second mutating admission. */
    runtimeTransitionActive?: boolean;
  };
}

export interface ProjectChatPersistedMessage {
  id?: string;
  role: string;
  content: string;
  messageId?: string | null;
  timestamp?: string;
  provider?: ProjectChatProviderName;
  runtime?: string;
  model?: string | null;
  providerSessionId?: string | null;
  turnId?: string | null;
  thinkingContent?: string;
  thinkingSubject?: string;
  toolCalls?: Array<{
    id: string;
    name: string;
    arguments?: unknown;
    result?: string;
    startedAt: number;
    endedAt?: number;
    status: 'running' | 'done' | 'error';
  }>;
  segments?: Array<{
    text: string;
    subject?: string;
    position: 'before' | 'between' | 'after';
    kind?: 'text' | 'thinking';
    ts?: number;
    order?: number;
  }>;
  presentationTruncated?: boolean;
}

export interface ProjectChatHistoryPage {
  messages: ProjectChatPersistedMessage[];
  pagination: {
    hasMore: boolean;
    nextCursor: string | null;
    limit: number;
  };
  session?: Record<string, unknown> | null;
  activeBinding?: Record<string, unknown> | null;
  executionContext?: Record<string, unknown> | null;
}

export interface ProjectChatSendRequest {
  provider: ProjectChatProviderName;
  stateVersion: number;
  message: string;
  messageId: string;
  model?: string;
}

export interface ProjectChatMessageStatusResponse {
  found: boolean;
  status: 'absent' | 'admitted' | 'active' | 'terminal';
  provider: ProjectChatProviderName;
  messageId: string;
  projectId: string;
  stateVersion: number | null;
  turnStatus?: string;
  dispatchStatus?: 'unconfirmed' | 'accepted' | 'unknown';
  recoveryRequired?: boolean;
  turnId?: string;
}

export const filesAPI = {
  list: async (
    params?: { path?: string; page?: number; limit?: number; search?: string; mime?: string },
    signal?: AbortSignal,
  ) => {
    const { data } = await client.get('/files', { params, signal });
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
  batchDelete: async (ids: string[]) => {
    const { data } = await client.post('/files/batch-delete', { ids });
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
  createShareLink: async (id: string, options?: { expiresAt?: string; maxUses?: number }) => {
    const { data } = await client.post(`/apps/${id}/share`, options || {});
    return data;
  },
  getShareLinks: async (id: string) => {
    const { data } = await client.get(`/apps/${id}/share`);
    return data;
  },
  updateShareLink: async (id: string, linkId: string, isActive: boolean) => {
    const { data } = await client.patch(`/apps/${id}/share/${encodeURIComponent(linkId)}`, { isActive });
    return data;
  },
  deleteShareLink: async (id: string, linkId: string) => {
    const { data } = await client.delete(`/apps/${id}/share/${encodeURIComponent(linkId)}`);
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
    const resp = await workspaceAuthorizedFetch(`${url}/upload/init`, {
      method: 'POST',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ fileName, fileSize, totalChunks }),
    });
    return resp.json();
  },

  uploadChunk: async (uploadId: string, chunkIndex: number, chunk: ArrayBuffer, baseUrl?: string) => {
    const url = baseUrl || (import.meta.env.VITE_API_URL || '');
    const resp = await workspaceAuthorizedFetch(`${url}/upload/chunk`, {
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
    const resp = await workspaceAuthorizedFetch(`${url}/upload/complete`, {
      method: 'POST',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ uploadId }),
    });
    return resp.json();
  },
};

const projectSegment = (name: string) => encodeURIComponent(name);
const projectLinkSegment = (linkId: string) => encodeURIComponent(linkId);

export type ProjectSearchResult =
  | { kind: 'project'; project: string; name: string }
  | { kind: 'file'; project: string; name: string; path: string };

export interface ProjectSearchResponse {
  query: string;
  results: ProjectSearchResult[];
  truncated: boolean;
  visited: number;
}

export interface ProjectIdentityProof {
  id: string;
  generation: number;
}

export interface ProjectSummary {
  name: string;
  hasGit: boolean;
  currentBranch: string;
  deployedUrl: string;
  createdAt: string;
  updatedAt: string;
  identity: ProjectIdentityProof;
  deployment?: {
    appId: string;
    deployType: 'static' | 'fullstack' | 'runtime' | string;
    processStatus: string;
    port: number | null;
    isActive: boolean;
  } | null;
  destructiveActions: {
    allowed: boolean;
    reason: string | null;
  };
}

export interface ProjectTreeEntry {
  name: string;
  type: 'file' | 'directory';
  path: string;
  size?: number;
  gitStatus?: string;
}

export interface ProjectTreeResponse {
  tree: ProjectTreeEntry[];
  currentPath: string;
  identity: ProjectIdentityProof;
}

function requireRecord(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${label} is malformed`);
  }
  return value as Record<string, unknown>;
}

export function validateProjectIdentityProof(value: unknown): ProjectIdentityProof {
  const record = requireRecord(value, 'Project identity proof');
  if (
    typeof record.id !== 'string'
    || !record.id
    || record.id.length > 128
    || record.id.trim() !== record.id
    || !Number.isSafeInteger(record.generation)
    || (record.generation as number) < 1
  ) {
    throw new Error('Project identity proof is malformed');
  }
  return { id: record.id, generation: record.generation as number };
}

function validateProjectSummary(value: unknown): ProjectSummary {
  const record = requireRecord(value, 'Project inventory entry');
  const destructiveActions = requireRecord(
    record.destructiveActions,
    'Project destructive-action capability',
  );
  const deployment = record.deployment === null || record.deployment === undefined
    ? null
    : requireRecord(record.deployment, 'Project deployment summary');
  if (
    typeof record.name !== 'string'
    || !record.name
    || typeof record.hasGit !== 'boolean'
    || typeof record.currentBranch !== 'string'
    || typeof record.deployedUrl !== 'string'
    || typeof record.createdAt !== 'string'
    || typeof record.updatedAt !== 'string'
    || typeof destructiveActions.allowed !== 'boolean'
    || (destructiveActions.reason !== null && typeof destructiveActions.reason !== 'string')
    || (deployment !== null && (
      typeof deployment.appId !== 'string'
      || !deployment.appId
      || typeof deployment.deployType !== 'string'
      || !deployment.deployType
      || typeof deployment.processStatus !== 'string'
      || (deployment.port !== null && (
        typeof deployment.port !== 'number'
        || !Number.isSafeInteger(deployment.port)
        || (deployment.port as number) < 1
        || (deployment.port as number) > 65535
      ))
      || typeof deployment.isActive !== 'boolean'
    ))
  ) {
    throw new Error('Project inventory entry is malformed');
  }
  return {
    name: record.name,
    hasGit: record.hasGit,
    currentBranch: record.currentBranch,
    deployedUrl: record.deployedUrl,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
    identity: validateProjectIdentityProof(record.identity),
    deployment: deployment ? {
      appId: deployment.appId as string,
      deployType: deployment.deployType as string,
      processStatus: deployment.processStatus as string,
      port: deployment.port as number | null,
      isActive: deployment.isActive as boolean,
    } : null,
    destructiveActions: {
      allowed: destructiveActions.allowed,
      reason: destructiveActions.reason as string | null,
    },
  };
}

export function validateProjectListResponse(value: unknown): { projects: ProjectSummary[] } {
  const record = requireRecord(value, 'Project inventory');
  if (!Array.isArray(record.projects)) throw new Error('Project inventory is malformed');
  return { projects: record.projects.map(validateProjectSummary) };
}

function validateProjectTreeEntry(value: unknown): ProjectTreeEntry {
  const record = requireRecord(value, 'Project tree entry');
  if (
    typeof record.name !== 'string'
    || !record.name
    || (record.type !== 'file' && record.type !== 'directory')
    || typeof record.path !== 'string'
    || !record.path
    || (record.size !== undefined && (
      typeof record.size !== 'number'
      || !Number.isSafeInteger(record.size)
      || record.size < 0
    ))
    || (record.gitStatus !== undefined && typeof record.gitStatus !== 'string')
  ) {
    throw new Error('Project tree entry is malformed');
  }
  return {
    name: record.name,
    type: record.type,
    path: record.path,
    ...(record.size === undefined ? {} : { size: record.size }),
    ...(record.gitStatus === undefined ? {} : { gitStatus: record.gitStatus }),
  };
}

export function validateProjectTreeResponse(value: unknown): ProjectTreeResponse {
  const record = requireRecord(value, 'Project tree');
  if (!Array.isArray(record.tree) || typeof record.currentPath !== 'string') {
    throw new Error('Project tree is malformed');
  }
  return {
    tree: record.tree.map(validateProjectTreeEntry),
    currentPath: record.currentPath,
    identity: validateProjectIdentityProof(record.identity),
  };
}

export function validateProjectRenameResponse(
  value: unknown,
  expected: Readonly<{
    name: string;
    attemptId: string;
    identity: ProjectIdentityProof;
  }>,
): { name: string; attemptId: string; status: 'committed'; identity: ProjectIdentityProof } {
  const record = requireRecord(value, 'Project rename response');
  const identity = validateProjectIdentityProof(record.identity);
  const expectedGeneration = expected.identity.generation + 1;
  if (
    record.name !== expected.name
    || record.attemptId !== expected.attemptId
    || record.status !== 'committed'
    || identity.id !== expected.identity.id
    || !Number.isSafeInteger(expectedGeneration)
    || identity.generation !== expectedGeneration
  ) {
    throw new Error('Project rename response does not match the admitted attempt');
  }
  return {
    name: expected.name,
    attemptId: expected.attemptId,
    status: 'committed',
    identity,
  };
}

export interface AgentZeroProjectModelCatalog {
  available: true;
  checkedAt: string;
  providers: Array<{
    providerId: string;
    displayName: string;
    connectionState: 'connected';
    models: Array<{
      id: string;
      displayName: string;
    }>;
  }>;
}

export const projectsAPI = {
  list: async () => {
    const { data } = await client.get('/projects');
    return validateProjectListResponse(data);
  },
  search: async (query: string, limit = 24, signal?: AbortSignal): Promise<ProjectSearchResponse> => {
    const { data } = await client.get('/projects/search', { params: { q: query, limit }, signal });
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
    const { data } = await client.delete(`/projects/${projectSegment(name)}`);
    return data;
  },
  rename: async (
    name: string,
    newName: string,
    attempt: Readonly<{ attemptId: string; identity: ProjectIdentityProof }>,
  ) => {
    const { data } = await client.patch(`/projects/${projectSegment(name)}/rename`, {
      newName,
      attemptId: attempt.attemptId,
      projectIdentityId: attempt.identity.id,
      projectGeneration: attempt.identity.generation,
    });
    return validateProjectRenameResponse(data, { name: newName, ...attempt });
  },
  getTree: async (name: string, path?: string) => {
    const { data } = await client.get(`/projects/${projectSegment(name)}/tree`, { params: { path } });
    return validateProjectTreeResponse(data);
  },
  readFile: async (name: string, path: string) => {
    const { data } = await client.get(`/projects/${projectSegment(name)}/file`, { params: { path } });
    return data;
  },
  writeFile: async (name: string, path: string, content: string) => {
    const { data } = await client.put(`/projects/${projectSegment(name)}/file`, { path, content });
    return data;
  },
  createFile: async (name: string, path: string, content?: string) => {
    const { data } = await client.post(`/projects/${projectSegment(name)}/file`, { path, content });
    return data;
  },
  deleteFile: async (name: string, path: string) => {
    const { data } = await client.delete(`/projects/${projectSegment(name)}/file`, { params: { path } });
    return data;
  },
  git: async (name: string, action: string, params?: any) => {
    const { data } = await client.post(`/projects/${projectSegment(name)}/git`, { action, ...params });
    return data;
  },
  gitEnhancedLog: async (name: string, branch?: string, limit?: number) => {
    const { data } = await client.post(`/projects/${projectSegment(name)}/git`, { action: 'log-enhanced', branch, limit });
    return data;
  },
  gitRevert: async (name: string, hash: string) => {
    const { data } = await client.post(`/projects/${projectSegment(name)}/git`, { action: 'revert', hash });
    return data;
  },
  deploy: async (name: string) => {
    const { data } = await client.post(`/projects/${projectSegment(name)}/deploy`);
    return data;
  },
  undeploy: async (name: string) => {
    const { data } = await client.delete(`/projects/${projectSegment(name)}/deploy`);
    return data;
  },
  appProcess: async (
    name: string,
    action: 'start' | 'stop' | 'restart' | 'status' | 'logs',
  ): Promise<{
    status: string;
    deployType: string;
    supportedActions: string[];
    port?: number;
    logs: string[];
    restartCount: number;
    lastError?: string;
    limitation?: string;
    message?: string;
  }> => {
    const { data } = await client.post(`/projects/${projectSegment(name)}/app-process`, { action });
    return data;
  },
  checkDeps: async (name: string) => {
    const { data } = await client.get(`/projects/${projectSegment(name)}/check-deps`);
    return data;
  },
  docUpdate: async (name: string, type: string, description: string, details?: string) => {
    const { data } = await client.post(`/projects/${projectSegment(name)}/doc-update`, { type, description, details });
    return data;
  },
  share: async (name: string, options?: { expiresAt?: string; maxUses?: number; isPublic?: boolean; password?: string }) => {
    const { data } = await client.post(`/projects/${projectSegment(name)}/share`, options);
    return data;
  },
  listShares: async (name: string) => {
    const { data } = await client.get(`/projects/${projectSegment(name)}/shares`);
    return data;
  },
  updateShare: async (name: string, linkId: string, updates: { isPublic?: boolean; password?: string; isActive?: boolean }) => {
    const { data } = await client.patch(`/projects/${projectSegment(name)}/share/${projectLinkSegment(linkId)}`, updates);
    return data;
  },
  revokeShare: async (name: string, linkId: string) => {
    const { data } = await client.delete(`/projects/${projectSegment(name)}/share/${projectLinkSegment(linkId)}`);
    return data;
  },
  deleteShare: async (name: string, linkId: string) => {
    const { data } = await client.delete(`/projects/${projectSegment(name)}/share/${projectLinkSegment(linkId)}`, { params: { permanent: 'true' } });
    return data;
  },
  emailShare: async (name: string, linkId: string, body: { recipientEmail: string }) => {
    const { data } = await client.post(`/projects/${projectSegment(name)}/share/${projectLinkSegment(linkId)}/email`, body);
    return data;
  },
  uploadFiles: async (name: string, files: File[], targetPath?: string) => {
    const formData = new FormData();
    files.forEach(f => formData.append('files', f));
    const params = targetPath ? `?path=${encodeURIComponent(targetPath)}` : '';
    // Must set Content-Type to multipart/form-data to override the axios default of application/json
    // Without this, axios serializes FormData as JSON and multer gets no files
    const { data } = await client.post(`/projects/${projectSegment(name)}/upload${params}`, formData, {
      headers: { 'Content-Type': 'multipart/form-data' },
    });
    return data;
  },
  renameFile: async (name: string, oldPath: string, newPath: string) => {
    const { data } = await client.post(`/projects/${projectSegment(name)}/rename-file`, { oldPath, newPath });
    return data;
  },
  // Portal-owned Project Chat transcript + fail-closed provider bindings.
  projectChatProviders: async (name: string): Promise<ProjectChatProviderCapabilitiesResponse> => {
    const { data } = await client.get(`/projects/${encodeURIComponent(name)}/chat/providers`);
    return data;
  },
  projectChatModels: async (name: string): Promise<{
    provider: 'OPENCLAW';
    models: Array<{
      id: string;
      alias: string | null;
      displayName: string;
      provider: string;
      source: 'dynamic';
    }>;
  }> => {
    const { data } = await client.get(
      `/projects/${encodeURIComponent(name)}/chat/models`,
      { params: { provider: 'OPENCLAW' } },
    );
    return data;
  },
  migrateLegacyProjectInPlace: async (name: string) => {
    const { data } = await client.post(
      `/projects/${encodeURIComponent(name)}/chat/migrate-legacy`,
      {},
    );
    return data as {
      migrated: true;
      projectId: string;
      projectName: string;
      sourceProjectId: string;
      sourceProjectName: string;
      generation: number;
      alreadyCurrent: false;
      integrity: {
        fileCount: number;
        totalBytes: number;
        manifestSha256: string;
      };
    };
  },
  agentZeroProjectModels: async (name: string): Promise<AgentZeroProjectModelCatalog> => {
    // Expected-failure probe: hosts without a connected Agent Zero OAuth
    // account fail this on every Project Chat open, and the provider menu
    // already renders that state inline. Capturing it lit the global error
    // badge during perfectly healthy cold opens.
    const { data } = await client.get(
      `/projects/${encodeURIComponent(name)}/chat/providers/agent-zero/models`,
      { _silent: true } as any,
    );
    return data;
  },
  qualifyOpenClawProject: async (name: string) => {
    const { data } = await client.post(
      `/projects/${encodeURIComponent(name)}/chat/providers/openclaw/qualify`,
      {},
      { _skipNetworkRetry: true } as any,
    );
    return data as {
      provider: 'OPENCLAW';
      qualification: ProjectChatProviderQualificationStatus;
    };
  },
  qualifyProjectChatProvider: async (
    name: string,
    provider: 'OPENCLAW' | 'CODEX' | 'CLAUDE_CODE' | 'AGENT_ZERO' | 'GEMINI' | 'OLLAMA',
    model?: string,
  ) => {
    const routeSlug = {
      OPENCLAW: 'openclaw',
      CODEX: 'codex',
      CLAUDE_CODE: 'claude-code',
      AGENT_ZERO: 'agent-zero',
      GEMINI: 'antigravity',
      OLLAMA: 'ollama',
    }[provider];
    const { data } = await client.post(
      `/projects/${encodeURIComponent(name)}/chat/providers/${routeSlug}/qualify`,
      (provider === 'AGENT_ZERO' || provider === 'OLLAMA') && String(model || '').trim()
        ? { model: String(model).trim() }
        : {},
      // Qualification is a rate-limited, stateful probe. Replaying one click
      // on a 5xx both hides the first failure and consumes the entire allowance.
      // Keep one captured diagnostic as well as the inline message: the
      // endpoint/code bundle is what lets an operator distinguish host policy
      // drift from provider authentication or availability failures.
      { _skipNetworkRetry: true } as any,
    );
    return data as {
      provider: 'OPENCLAW' | 'CODEX' | 'CLAUDE_CODE' | 'AGENT_ZERO' | 'GEMINI' | 'OLLAMA';
      qualification: ProjectChatProviderQualificationStatus;
      stateVersion: number;
    };
  },
  selectProjectChatProvider: async (
    name: string,
    provider: ProjectChatProviderName,
    stateVersion: number,
    model?: string,
  ) => {
    const { data } = await client.post(`/projects/${encodeURIComponent(name)}/chat/provider`, {
      provider,
      stateVersion,
      model,
    });
    return data;
  },
  chatHistory: async (
    name: string,
    provider: ProjectChatProviderName = 'OPENCLAW',
    page?: { limit?: number; before?: string | null },
  ): Promise<ProjectChatHistoryPage> => {
    const params = {
      provider,
      ...(page?.limit ? { limit: page.limit } : {}),
      ...(page?.before ? { before: page.before } : {}),
    };
    const { data } = await client.get(`/projects/${encodeURIComponent(name)}/chat/history`, { params });
    return data;
  },
  chatClearHistory: async (
    name: string,
    provider: ProjectChatProviderName,
    stateVersion: number,
  ) => {
    if (!Number.isSafeInteger(stateVersion) || stateVersion < 0) {
      throw new Error('A current Project Chat state version is required to clear history');
    }
    const { data } = await client.delete(`/projects/${encodeURIComponent(name)}/chat/history`, {
      params: { provider, stateVersion },
    });
    return data;
  },
  chatSessionStatus: async (name: string, provider: ProjectChatProviderName = 'OPENCLAW') => {
    const { data } = await client.get(`/projects/${encodeURIComponent(name)}/chat/session-status`, { params: { provider } });
    return data;
  },
  // Assistant polling (non-streaming architecture)
  agentPoll: async (
    name: string,
    afterLine: number = 0,
    lastSize: number = 0,
    provider: ProjectChatProviderName = 'OPENCLAW',
    turnId?: string | null,
  ) => {
    const { data } = await client.get(`/projects/${projectSegment(name)}/assistant/poll`, {
      params: { after: afterLine, lastSize, provider, ...(turnId ? { turnId } : {}) },
      // Durable replay owns its retry cadence and honors the server's
      // Retry-After window. The generic Axios retry would otherwise turn one
      // rate-limited poll into three requests before the replay loop can
      // back off.
      _skipNetworkRetry: true,
      _silent: true,
    } as any);
    return data;
  },
  agentAbort: async (name: string, provider: ProjectChatProviderName, stateVersion: number) => {
    const { data } = await client.post(`/projects/${encodeURIComponent(name)}/assistant/abort`, {
      provider,
      stateVersion,
    });
    return data;
  },
  agentSend: async (name: string, request: ProjectChatSendRequest) => {
    if (!Number.isSafeInteger(request.stateVersion) || request.stateVersion < 0) {
      throw new Error('A current Project Chat state version is required to send a message');
    }
    if (!String(request.messageId || '').trim()) {
      throw new Error('A stable Project Chat message ID is required to send a message');
    }
    if (!String(request.message || '').trim()) {
      throw new Error('A Project Chat message is required');
    }
    const { data } = await client.post(`/projects/${projectSegment(name)}/assistant/send`, {
      provider: request.provider,
      stateVersion: request.stateVersion,
      message: request.message,
      messageId: request.messageId.trim(),
      ...(request.model ? { model: request.model } : {}),
    });
    return data;
  },
  agentMessageStatus: async (
    name: string,
    request: {
      provider: ProjectChatProviderName;
      messageId: string;
      messageFingerprint: string;
    },
  ): Promise<ProjectChatMessageStatusResponse> => {
    if (!String(request.messageId || '').trim() || !/^[a-f0-9]{64}$/i.test(request.messageFingerprint)) {
      throw new Error('A stable Project Chat message ID and payload fingerprint are required');
    }
    const { data } = await client.post(`/projects/${projectSegment(name)}/assistant/message-status`, {
      provider: request.provider,
      messageId: request.messageId.trim(),
      messageFingerprint: request.messageFingerprint.toLowerCase(),
    }, {
      // Status reconciliation owns its bounded quiet-window retry. Generic
      // retries would make one observation appear more authoritative than it is.
      _skipNetworkRetry: true,
      _silent: true,
    } as any);
    return data;
  },
  agentGetMemory: async (name: string) => {
    const { data } = await client.get(`/projects/${projectSegment(name)}/assistant/memory`);
    return data;
  },
  agentResetSession: async (
    name: string,
    provider: ProjectChatProviderName,
    stateVersion: number,
  ) => {
    if (!Number.isSafeInteger(stateVersion) || stateVersion < 0) {
      throw new Error('A current Project Chat state version is required to reset the session');
    }
    const { data } = await client.post(`/projects/${projectSegment(name)}/assistant/reset`, {
      provider,
      stateVersion,
    });
    return data;
  },
  agentGetActiveModel: async (name: string) => {
    const { data } = await client.get(`/projects/${projectSegment(name)}/assistant/active-model`);
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
  capabilities: async (refresh = false) => {
    const { data } = await client.get('/terminal/capabilities', { params: refresh ? { refresh: true } : undefined });
    return data;
  },
  autocomplete: async (prefix: string, limit = 20) => {
    const { data } = await client.get('/terminal/autocomplete', { params: { prefix, limit } });
    return data;
  },
  classify: async (command: string) => {
    const { data } = await client.post('/terminal/classify', { command });
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
  relaySupported?: boolean;
  geminiSupported?: boolean;
  detectorPatched: boolean;
  relayPatched: boolean;
  replyPatched: boolean;
  geminiCliPatched?: boolean;
  geminiCliYoloPatched?: boolean;
  geminiRuntimePatched?: boolean;
  heartbeatRunner: string | null;
  replyBundle: string | null;
  executeRuntime?: string | null;
  geminiCliBackend?: string | null;
  issues: string[];
  note?: string;
  confirmationPhrase?: string;
}

const AGENT_ZERO_MODEL_CATALOG_TIMEOUT_MS = 25_000;
const AGENT_ZERO_MODEL_SWITCH_TIMEOUT_MS = 60_000;

export interface GatewayPendingQuestion {
  id: string;
  sessionKey: string;
  createdAt: number;
  expiresAt: number;
  state: string;
  surface: 'agent-chat' | 'project-chat';
  questions: Array<{
    id: string;
    question: string;
    header?: string;
    multiSelect: boolean;
    isOther?: boolean;
    isSecret?: boolean;
    options: Array<{ label: string; description?: string }>;
  }>;
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
  models: async (provider = 'OPENCLAW'): Promise<{ provider: string; capabilities?: { supportsModelSelection?: boolean; modelSelectionMode?: string; supportsCustomModelInput?: boolean; canEnumerateModels?: boolean; modelCatalogKind?: string; supportsInTurnSteering?: boolean; supportsQueuedFollowUps?: boolean; followUpMode?: string; adapterFamily?: string; adapterKey?: string }; models: Array<{ id: string; alias: string | null; displayName: string; provider: string; source?: string }>; unavailableModelIds?: string[] }> => {
    const isAgentZero = String(provider || '').trim().toUpperCase() === 'AGENT_ZERO';
    const { data } = await client.get('/gateway/models', {
      params: { provider },
      ...(isAgentZero ? {
        timeout: AGENT_ZERO_MODEL_CATALOG_TIMEOUT_MS,
        _skipNetworkRetry: true,
      } : {}),
    } as any);
    return data;
  },
  /** questions an agent run is currently paused on. */
  pendingQuestions: async (session?: string): Promise<{
    questions: GatewayPendingQuestion[];
  }> => {
    const { data } = await client.get('/gateway/ask-user/pending', {
      params: session ? { session } : {},
      _silent: true,
    } as any);
    return data;
  },
  answerQuestion: async (id: string, answers: Record<string, string>) => {
    const { data } = await client.post('/gateway/ask-user/answer', { id, answers });
    return data;
  },
  dismissQuestion: async (id: string) => {
    const { data } = await client.post('/gateway/ask-user/dismiss', { id });
    return data;
  },
  history: async (session = 'agent:main:main', afterId?: string) => {
    const { data } = await client.get('/gateway/history', { params: { session, after: afterId } });
    return data;
  },
  sessionInfo: async (session = 'agent:main:main', options?: { silent?: boolean }) => {
    const { data } = await client.get('/gateway/session-info', {
      params: { session, ...(options?.silent ? { silent: '1' } : {}) },
      ...(options?.silent ? { _silent: true } as any : {}),
    });
    return data;
  },
  createSession: async (session: string, provider = 'OPENCLAW') => {
    const { data } = await client.post('/gateway/session-create', { session, provider });
    return data;
  },
  patchSessionModel: async (session: string, model: string, provider = 'OPENCLAW') => {
    const normalizedModel = String(model || '').trim();
    const payload = normalizedModel
      ? { session, provider, model: normalizedModel }
      : { session, provider, reset: true };
    const isAgentZero = String(provider || '').trim().toUpperCase() === 'AGENT_ZERO';
    const response = isAgentZero
      ? await client.post('/gateway/session-model', payload, {
          timeout: AGENT_ZERO_MODEL_SWITCH_TIMEOUT_MS,
          _skipNetworkRetry: true,
        } as any)
      : await client.post('/gateway/session-model', payload);
    const { data } = response;
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
  applyCompatibilityHotfix: async (confirmation: string): Promise<{ ok: boolean; alreadyApplied: boolean; status: CompatibilityHotfixStatus; patchOutput?: string; restartOutput?: string; message?: string }> => {
    const { data } = await client.post('/gateway/compatibility-hotfix/apply', { confirmation });
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
    const authorizationContext = captureWorkspaceAuthorizationRequestContext();

    const doFetch = async (): Promise<Response> => {
      const response = await workspaceAuthorizedFetch(`${apiUrl}/gateway/send?stream=1`, {
        method: 'POST',
        credentials: 'include',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ message, session }),
        signal: controller.signal,
      }, authorizationContext);
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
    model?: string | null;
    message: string;
    thinking?: string | null;
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
    model?: string | null;
    message?: string;
    thinking?: string | null;
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
  list: async (refresh = false) => {
    const { data } = await client.get('/skills', { params: refresh ? { refresh: 1 } : undefined });
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
  install: async (name: string, confirmation: string) => {
    const { data } = await client.post('/skills/install', { name, confirmation });
    return data;
  },
  uninstall: async (name: string, confirmation: string) => {
    const { data } = await client.post('/skills/uninstall', { name, confirmation });
    return data;
  },
  listPlugins: async (refresh = false) => {
    const { data } = await client.get('/skills/plugins', { params: refresh ? { refresh: 1 } : undefined });
    return data;
  },
  installPlugin: async (spec: string, confirmation: string) => {
    const { data } = await client.post('/skills/plugins/install', { spec, confirmation });
    return data;
  },
};
