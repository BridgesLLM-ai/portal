import client from './client';
import { Metrics, ActivityLog } from '../types';
import {
  captureWorkspaceAuthorizationRequestContext,
  workspaceAuthorizedFetch,
} from '../utils/workspaceAuthorizedFetch';

export type ShareRateLimitWindowSeconds = 60 | 300 | 3600;

export interface ShareLinkPolicyOptions {
  expiresAt?: string;
  maxUses?: number;
  rateLimitMaxRequests?: number;
  rateLimitWindowSeconds?: ShareRateLimitWindowSeconds;
}

export interface ProjectShareCreateOptions extends ShareLinkPolicyOptions {
  isPublic?: boolean;
  password?: string;
}

export interface ProjectShareLink {
  id: string;
  token: string;
  isActive: boolean;
  isPublic: boolean;
  currentUses: number;
  maxUses: number | null;
  rateLimitMaxRequests: number | null;
  rateLimitWindowSeconds: ShareRateLimitWindowSeconds | null;
  expiresAt: string | null;
  createdAt: string;
}

export interface ProjectShareCreateResponse {
  shareLink: ProjectShareLink;
  url: string;
  hostedUrl: string;
}

export interface ProjectShareListResponse {
  shares: ProjectShareLink[];
}

export interface ProjectShareUpdateOptions {
  isPublic?: boolean;
  password?: string;
  isActive?: boolean;
}

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

export interface ProjectChatExecutionContextRef {
  scope: 'PROJECT_SANDBOX';
  projectId: string;
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
  executionContext: ProjectChatExecutionContextRef | null;
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
  session: {
    status: string;
    model: string | null;
    activeProvider: ProjectChatProviderName;
    runtime: string | null;
    lastActivity: string | null;
    requiresPreparation?: boolean;
    staleReason?: string | null;
  };
  activeBinding: {
    provider: ProjectChatProviderName;
    runtime: string;
    sessionKey?: string | null;
    externalSessionId?: string | null;
    model: string | null;
    status?: string;
    requiresPreparation?: boolean;
    staleReason?: string | null;
  } | null;
  executionContext: ProjectChatExecutionContextRef;
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
  createShareLink: async (id: string, options: ShareLinkPolicyOptions = {}) => {
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

export type ProjectRuntimeRecoveryReplayProof = Readonly<{
  proof: string;
  action: 'deploy' | 'start' | 'restart';
  projectIdentity: ProjectIdentityProof;
  expectedAppId: string | null;
  expectedDeployType?: 'fullstack';
  sourceDigest?: string;
}>;

export type ProjectRuntimeRecoveryCompletion = Readonly<{
  success: true;
  action: 'deploy' | 'start' | 'restart';
  projectIdentityId: string;
  projectIdentityGeneration: number;
  appId: string;
  deploymentRevision: string;
}>;

export type ProjectHostedDeploySuccess = Readonly<{
  message: 'Deployed';
  appId: string;
  name: string;
  url: string;
  deployType: 'static' | 'fullstack';
  port?: number;
  buildOutput?: string;
}>;

export type ProjectDesktopRuntimeDeploySuccess = Readonly<{
  message: 'Running on Remote Desktop';
  appId: string;
  name: string;
  deployType: 'runtime';
  buildOutput?: string;
}>;

export type ProjectDeploySuccess = ProjectHostedDeploySuccess | ProjectDesktopRuntimeDeploySuccess;

export function projectRuntimeRecoveryCompletion(
  value: unknown,
  replay: ProjectRuntimeRecoveryReplayProof,
): ProjectRuntimeRecoveryCompletion | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  const expectedKeys = [
    'action',
    'appId',
    'deploymentRevision',
    'projectIdentityGeneration',
    'projectIdentityId',
    'success',
  ];
  if (
    Object.keys(record).sort().some((key, index) => key !== expectedKeys[index])
    || Object.keys(record).length !== expectedKeys.length
    || record.success !== true
    || record.action !== replay.action
    || record.projectIdentityId !== replay.projectIdentity.id
    || record.projectIdentityGeneration !== replay.projectIdentity.generation
    || typeof record.appId !== 'string'
    || !record.appId
    || record.appId.length > 255
    || (replay.expectedAppId !== null && record.appId !== replay.expectedAppId)
    || !/^(?:0|[1-9][0-9]*)$/.test(String(record.deploymentRevision || ''))
  ) return null;
  return record as unknown as ProjectRuntimeRecoveryCompletion;
}

function validateProjectDeploySuccess(
  value: unknown,
  replay?: ProjectRuntimeRecoveryReplayProof,
): ProjectDeploySuccess {
  const record = requireRecord(value, 'Project deployment');
  const commonKeys = ['appId', 'buildOutput', 'deployType', 'message', 'name'];
  const runtimeResponse = record.deployType === 'runtime';
  const allowedKeys = new Set(runtimeResponse
    ? commonKeys
    : [...commonKeys, 'port', 'url']);
  if (
    Object.keys(record).some((key) => !allowedKeys.has(key))
    || typeof record.appId !== 'string'
    || !record.appId
    || record.appId.length > 255
    || typeof record.name !== 'string'
    || !record.name
    || new TextEncoder().encode(record.name).byteLength > 255
    || !['static', 'fullstack', 'runtime'].includes(String(record.deployType))
    || (record.buildOutput !== undefined && typeof record.buildOutput !== 'string')
    || (replay?.action === 'deploy' && replay.expectedDeployType !== record.deployType)
    || (replay?.expectedAppId !== null && replay?.expectedAppId !== undefined && record.appId !== replay.expectedAppId)
    || (runtimeResponse
      ? record.message !== 'Running on Remote Desktop'
        || record.url !== undefined
        || record.port !== undefined
      : record.message !== 'Deployed'
        || typeof record.url !== 'string'
        || !/^\/hosted\/[A-Za-z0-9_-]+\/$/.test(record.url)
        || (record.port !== undefined && (!Number.isInteger(record.port) || Number(record.port) < 1 || Number(record.port) > 65535)))
  ) {
    throw new Error('Project deployment response is malformed');
  }
  if (runtimeResponse) {
    return Object.freeze({
      message: 'Running on Remote Desktop',
      appId: record.appId as string,
      name: record.name as string,
      deployType: 'runtime',
      ...(record.buildOutput !== undefined ? { buildOutput: record.buildOutput as string } : {}),
    });
  }
  return Object.freeze({
    message: 'Deployed',
    appId: record.appId as string,
    name: record.name as string,
    url: record.url as string,
    deployType: record.deployType as ProjectHostedDeploySuccess['deployType'],
    ...(record.port !== undefined ? { port: Number(record.port) } : {}),
    ...(record.buildOutput !== undefined ? { buildOutput: record.buildOutput } : {}),
  });
}

export interface ProjectAvailability {
  available: false;
  code: 'PROJECT_IDENTITY_RECONCILIATION_REQUIRED'
    | 'PROJECT_LIFECYCLE_RECONCILIATION_REQUIRED'
    | 'PROJECT_LIFECYCLE_RECOVERY_PENDING';
  message: string;
  action: 'RECONCILE_PROJECT_IDENTITY' | 'RECONCILE_PROJECT_LIFECYCLE' | 'RETRY';
  retryable: boolean;
}

export type ProjectRuntimeManagement =
  | 'portal-container'
  | 'external-loopback'
  | 'desktop-session'
  | 'static';

export type ProjectRuntimeStatusSource =
  | 'portal-manager'
  | 'persisted-app'
  | 'external-binding'
  | 'deployment-record';

export type ProjectProcessAction = 'start' | 'stop' | 'restart' | 'status' | 'logs';

export type ProjectDetectedDeployType = 'static' | 'fullstack' | 'runtime';

export type ProjectLifecycleAction =
  | 'redeploy'
  | 'undeploy'
  | 'rename-project'
  | 'delete-project';

export interface ProjectDeploymentProcessState {
  status: string;
  deployType: string;
  runtimeManagement: ProjectRuntimeManagement;
  statusSource: ProjectRuntimeStatusSource;
  supportedActions: ProjectProcessAction[];
  port?: number;
  logs: string[];
  restartCount: number;
  persistedStatus?: string | null;
  recoveryRequired?: boolean;
  lastError?: string;
  limitation?: string;
  message?: string;
}

export interface ProjectSummary {
  name: string;
  /** Server-owned source classification. Unavailable lifecycle rows may omit it. */
  detectedDeployType?: ProjectDetectedDeployType;
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
    runtimeManagement: ProjectRuntimeManagement;
    statusSource: ProjectRuntimeStatusSource;
    supportedLifecycleActions: ProjectLifecycleAction[];
    /** Present only when a server-managed APP_API_TARGET binding exists but is invalid. */
    bindingStatus?: 'invalid';
    configurationCode?: 'PROJECT_RUNTIME_BINDING_INVALID';
    limitation?: string;
    port: number | null;
    isActive: boolean;
  } | null;
  destructiveActions: {
    allowed: boolean;
    reason: string | null;
  };
  availability?: ProjectAvailability;
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

const projectRuntimeManagementValues = new Set<ProjectRuntimeManagement>([
  'portal-container',
  'external-loopback',
  'desktop-session',
  'static',
]);

const projectRuntimeStatusSourceValues = new Set<ProjectRuntimeStatusSource>([
  'portal-manager',
  'persisted-app',
  'external-binding',
  'deployment-record',
]);

const projectProcessActionValues = new Set<ProjectProcessAction>([
  'start',
  'stop',
  'restart',
  'status',
  'logs',
]);

const portalManagerProcessActions: ProjectProcessAction[] = [
  'start',
  'stop',
  'restart',
  'status',
  'logs',
];
const portalRecoveryProcessActions: ProjectProcessAction[] = ['start', 'stop', 'status'];
const portalSettledProcessActions: ProjectProcessAction[] = ['start', 'status'];

const projectDetectedDeployTypeValues = new Set<ProjectDetectedDeployType>([
  'static',
  'fullstack',
  'runtime',
]);

const projectLifecycleActionValues = new Set<ProjectLifecycleAction>([
  'redeploy',
  'undeploy',
  'rename-project',
  'delete-project',
]);

function isProjectRuntimeManagement(value: unknown): value is ProjectRuntimeManagement {
  return typeof value === 'string'
    && projectRuntimeManagementValues.has(value as ProjectRuntimeManagement);
}

function isProjectRuntimeStatusSource(value: unknown): value is ProjectRuntimeStatusSource {
  return typeof value === 'string'
    && projectRuntimeStatusSourceValues.has(value as ProjectRuntimeStatusSource);
}

function projectRuntimeMetadataIsCoherent(
  runtimeManagement: ProjectRuntimeManagement,
  statusSource: ProjectRuntimeStatusSource,
): boolean {
  switch (runtimeManagement) {
    case 'external-loopback': return statusSource === 'external-binding';
    case 'static': return statusSource === 'deployment-record';
    case 'desktop-session': return statusSource === 'persisted-app';
    case 'portal-container': return statusSource === 'portal-manager' || statusSource === 'persisted-app';
  }
}

function projectRuntimeDeployTypeIsCoherent(
  deployType: string,
  runtimeManagement: ProjectRuntimeManagement,
): boolean {
  switch (runtimeManagement) {
    case 'portal-container': return deployType === 'fullstack';
    case 'external-loopback': return deployType === 'fullstack' || deployType === 'static';
    case 'desktop-session': return deployType === 'runtime';
    case 'static': return deployType === 'static';
  }
}

function projectLifecycleActionsAreCoherent(
  deployType: string,
  detectedDeployType: ProjectDetectedDeployType,
  runtimeManagement: ProjectRuntimeManagement,
  destructiveActionsAllowed: boolean,
  actions: unknown[],
  bindingStatus: 'invalid' | undefined,
): boolean {
  const expected: ProjectLifecycleAction[] = runtimeManagement === 'external-loopback'
    ? bindingStatus === 'invalid'
      ? []
      : deployType === 'static' && detectedDeployType === 'static'
        ? ['redeploy']
        : []
    : [
        'redeploy',
        'undeploy',
        ...(destructiveActionsAllowed
          ? ['rename-project', 'delete-project'] as ProjectLifecycleAction[]
          : []),
      ];
  return actions.length === expected.length
    && expected.every((action) => actions.includes(action));
}

function projectProcessActionsMatch(
  actions: unknown[],
  expected: ProjectProcessAction[],
): boolean {
  return actions.length === expected.length
    && expected.every((action) => actions.includes(action));
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
  const availability = record.availability === null || record.availability === undefined
    ? null
    : requireRecord(record.availability, 'Project availability');
  const availabilityCodes = new Set([
    'PROJECT_IDENTITY_RECONCILIATION_REQUIRED',
    'PROJECT_LIFECYCLE_RECONCILIATION_REQUIRED',
    'PROJECT_LIFECYCLE_RECOVERY_PENDING',
  ]);
  const availabilityActions = new Set([
    'RECONCILE_PROJECT_IDENTITY',
    'RECONCILE_PROJECT_LIFECYCLE',
    'RETRY',
  ]);
  const detectedDeployType = record.detectedDeployType as ProjectDetectedDeployType;
  const deploymentBindingStatus = deployment?.bindingStatus === undefined
    ? undefined
    : deployment.bindingStatus;
  if (
    typeof record.name !== 'string'
    || !record.name
    || (availability === null
      ? !projectDetectedDeployTypeValues.has(record.detectedDeployType as ProjectDetectedDeployType)
      : record.detectedDeployType !== undefined
        && !projectDetectedDeployTypeValues.has(record.detectedDeployType as ProjectDetectedDeployType))
    || typeof record.hasGit !== 'boolean'
    || typeof record.currentBranch !== 'string'
    || typeof record.deployedUrl !== 'string'
    || typeof record.createdAt !== 'string'
    || typeof record.updatedAt !== 'string'
    || typeof destructiveActions.allowed !== 'boolean'
    || (destructiveActions.reason !== null && typeof destructiveActions.reason !== 'string')
    || (availability !== null && (
      availability.available !== false
      || typeof availability.code !== 'string'
      || !availabilityCodes.has(availability.code)
      || typeof availability.message !== 'string'
      || !availability.message
      || typeof availability.action !== 'string'
      || !availabilityActions.has(availability.action)
      || typeof availability.retryable !== 'boolean'
    ))
    || (deployment !== null && (
      typeof deployment.appId !== 'string'
      || !deployment.appId
      || typeof deployment.deployType !== 'string'
      || !deployment.deployType
      || typeof deployment.processStatus !== 'string'
      || !isProjectRuntimeManagement(deployment.runtimeManagement)
      || !isProjectRuntimeStatusSource(deployment.statusSource)
      || !projectRuntimeMetadataIsCoherent(
        deployment.runtimeManagement as ProjectRuntimeManagement,
        deployment.statusSource as ProjectRuntimeStatusSource,
      )
      || !projectRuntimeDeployTypeIsCoherent(
        deployment.deployType,
        deployment.runtimeManagement as ProjectRuntimeManagement,
      )
      || !Array.isArray(deployment.supportedLifecycleActions)
      || deployment.supportedLifecycleActions.some((action) => (
        typeof action !== 'string'
        || !projectLifecycleActionValues.has(action as ProjectLifecycleAction)
      ))
      || new Set(deployment.supportedLifecycleActions).size
        !== deployment.supportedLifecycleActions.length
      || !projectLifecycleActionsAreCoherent(
        deployment.deployType,
        detectedDeployType,
        deployment.runtimeManagement as ProjectRuntimeManagement,
        destructiveActions.allowed,
        deployment.supportedLifecycleActions,
        deploymentBindingStatus as 'invalid' | undefined,
      )
      || (deployment.runtimeManagement === 'external-loopback'
        && destructiveActions.allowed !== false)
      || (deploymentBindingStatus !== undefined && (
        deploymentBindingStatus !== 'invalid'
        || deployment.runtimeManagement !== 'external-loopback'
        || deployment.statusSource !== 'external-binding'
        || deployment.configurationCode !== 'PROJECT_RUNTIME_BINDING_INVALID'
        || typeof deployment.limitation !== 'string'
        || !deployment.limitation
        || deployment.limitation.length > 2_000
      ))
      || (deploymentBindingStatus === undefined && (
        deployment.configurationCode !== undefined
        || deployment.limitation !== undefined
      ))
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
    ...(record.detectedDeployType === undefined ? {} : {
      detectedDeployType: record.detectedDeployType as ProjectDetectedDeployType,
    }),
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
      runtimeManagement: deployment.runtimeManagement as ProjectRuntimeManagement,
      statusSource: deployment.statusSource as ProjectRuntimeStatusSource,
      supportedLifecycleActions: deployment.supportedLifecycleActions as ProjectLifecycleAction[],
      ...(deploymentBindingStatus === 'invalid' ? {
        bindingStatus: 'invalid' as const,
        configurationCode: 'PROJECT_RUNTIME_BINDING_INVALID' as const,
        limitation: deployment.limitation as string,
      } : {}),
      port: deployment.port as number | null,
      isActive: deployment.isActive as boolean,
    } : null,
    destructiveActions: {
      allowed: destructiveActions.allowed,
      reason: destructiveActions.reason as string | null,
    },
    ...(availability ? {
      availability: {
        available: false as const,
        code: availability.code as ProjectAvailability['code'],
        message: availability.message as string,
        action: availability.action as ProjectAvailability['action'],
        retryable: availability.retryable as boolean,
      },
    } : {}),
  };
}

export function validateProjectListResponse(value: unknown): { projects: ProjectSummary[] } {
  const record = requireRecord(value, 'Project inventory');
  if (!Array.isArray(record.projects)) throw new Error('Project inventory is malformed');
  return { projects: record.projects.map(validateProjectSummary) };
}

export function validateProjectDeploymentProcessState(value: unknown): ProjectDeploymentProcessState {
  const record = requireRecord(value, 'Project deployment process');
  const runtimeManagement = record.runtimeManagement as ProjectRuntimeManagement;
  const statusSource = record.statusSource as ProjectRuntimeStatusSource;
  const recoveryRequired = record.recoveryRequired === true;
  const supportedActions = Array.isArray(record.supportedActions)
    ? record.supportedActions
    : [];
  const logs = Array.isArray(record.logs) ? record.logs : [];
  const restartCount = record.restartCount as number;
  const portalManagerState = runtimeManagement === 'portal-container'
    && statusSource === 'portal-manager';
  const portalRecoveryState = runtimeManagement === 'portal-container'
    && statusSource === 'persisted-app'
    && recoveryRequired;
  const portalSettledState = runtimeManagement === 'portal-container'
    && statusSource === 'persisted-app'
    && !recoveryRequired;
  const actionsAreCoherent = runtimeManagement !== 'portal-container'
    ? supportedActions.length === 0
    : portalManagerState
      ? projectProcessActionsMatch(supportedActions, portalManagerProcessActions)
      : portalRecoveryState
        ? projectProcessActionsMatch(supportedActions, portalRecoveryProcessActions)
        : portalSettledState
          ? projectProcessActionsMatch(supportedActions, portalSettledProcessActions)
          : false;
  const runtimeEvidenceIsCoherent = portalManagerState
    ? record.port !== undefined && !recoveryRequired
    : record.port === undefined
      && logs.length === 0
      && restartCount === 0
      && (portalRecoveryState || !recoveryRequired);
  if (
    typeof record.status !== 'string'
    || !record.status
    || typeof record.deployType !== 'string'
    || !record.deployType
    || !isProjectRuntimeManagement(record.runtimeManagement)
    || !isProjectRuntimeStatusSource(record.statusSource)
    || !projectRuntimeMetadataIsCoherent(runtimeManagement, statusSource)
    || !projectRuntimeDeployTypeIsCoherent(record.deployType, runtimeManagement)
    || !Array.isArray(record.supportedActions)
    || supportedActions.some((action) => (
      typeof action !== 'string'
      || !projectProcessActionValues.has(action as ProjectProcessAction)
    ))
    || new Set(supportedActions).size !== supportedActions.length
    || !Array.isArray(record.logs)
    || logs.some((entry) => typeof entry !== 'string')
    || !Number.isSafeInteger(record.restartCount)
    || (record.restartCount as number) < 0
    || (record.port !== undefined && (
      typeof record.port !== 'number'
      || !Number.isSafeInteger(record.port)
      || (record.port as number) < 1
      || (record.port as number) > 65535
    ))
    || (record.persistedStatus !== undefined
      && record.persistedStatus !== null
      && typeof record.persistedStatus !== 'string')
    || (record.recoveryRequired !== undefined && typeof record.recoveryRequired !== 'boolean')
    || (record.lastError !== undefined && typeof record.lastError !== 'string')
    || (record.limitation !== undefined && typeof record.limitation !== 'string')
    || (record.message !== undefined && typeof record.message !== 'string')
    || !actionsAreCoherent
    || !runtimeEvidenceIsCoherent
  ) {
    throw new Error('Project deployment process response is malformed');
  }

  return record as unknown as ProjectDeploymentProcessState;
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

const projectChatProviderNames = new Set<ProjectChatProviderName>([
  'OPENCLAW',
  'CLAUDE_CODE',
  'CODEX',
  'GROK',
  'AGENT_ZERO',
  'GEMINI',
  'OLLAMA',
]);

function isProjectChatProviderName(value: unknown): value is ProjectChatProviderName {
  return typeof value === 'string'
    && projectChatProviderNames.has(value as ProjectChatProviderName);
}

/**
 * Project Chat history carries the immutable project proof used to bind the
 * rendered transcript. Treat a malformed response as a recoverable panel read
 * failure instead of letting arbitrary records flow into session state.
 */
export function validateProjectChatHistoryPage(value: unknown): ProjectChatHistoryPage {
  const record = requireRecord(value, 'Project Chat history');
  const pagination = requireRecord(record.pagination, 'Project Chat history pagination');
  const session = requireRecord(record.session, 'Project Chat history session');
  const executionContext = requireRecord(
    record.executionContext,
    'Project Chat history execution context',
  );
  const activeBinding = record.activeBinding === null
    ? null
    : requireRecord(record.activeBinding, 'Project Chat history binding');

  if (
    !Array.isArray(record.messages)
    || typeof pagination.hasMore !== 'boolean'
    || (pagination.nextCursor !== null && typeof pagination.nextCursor !== 'string')
    || !Number.isSafeInteger(pagination.limit)
    || Number(pagination.limit) < 1
    || Number(pagination.limit) > 100
    || (pagination.hasMore === true && !(typeof pagination.nextCursor === 'string' && pagination.nextCursor))
    || typeof session.status !== 'string'
    || !isProjectChatProviderName(session.activeProvider)
    || (session.model !== null && typeof session.model !== 'string')
    || (session.runtime !== null && typeof session.runtime !== 'string')
    || (session.lastActivity !== null && typeof session.lastActivity !== 'string')
    || (session.requiresPreparation !== undefined && typeof session.requiresPreparation !== 'boolean')
    || (session.staleReason !== undefined && session.staleReason !== null && typeof session.staleReason !== 'string')
    || executionContext.scope !== 'PROJECT_SANDBOX'
    || typeof executionContext.projectId !== 'string'
    || !executionContext.projectId.trim()
    || typeof executionContext.policyFingerprint !== 'string'
    || !executionContext.policyFingerprint.trim()
    || (activeBinding !== null && (
      !isProjectChatProviderName(activeBinding.provider)
      || typeof activeBinding.runtime !== 'string'
      || !activeBinding.runtime
      || (activeBinding.sessionKey !== undefined && activeBinding.sessionKey !== null && typeof activeBinding.sessionKey !== 'string')
      || (activeBinding.externalSessionId !== undefined && activeBinding.externalSessionId !== null && typeof activeBinding.externalSessionId !== 'string')
      || (activeBinding.model !== null && typeof activeBinding.model !== 'string')
      || (activeBinding.status !== undefined && typeof activeBinding.status !== 'string')
      || (activeBinding.requiresPreparation !== undefined && typeof activeBinding.requiresPreparation !== 'boolean')
      || (activeBinding.staleReason !== undefined && activeBinding.staleReason !== null && typeof activeBinding.staleReason !== 'string')
    ))
  ) {
    throw new Error('Project Chat history response is malformed');
  }

  return record as unknown as ProjectChatHistoryPage;
}

export const projectsAPI = {
  list: async () => {
    const { data } = await client.get('/projects', { _silent: true } as any);
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
  delete: async (name: string, identity?: ProjectIdentityProof) => {
    const { data } = await client.delete(
      `/projects/${projectSegment(name)}`,
      identity ? {
        data: {
          projectIdentityId: identity.id,
          projectGeneration: identity.generation,
        },
      } : undefined,
    );
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
    const { data } = await client.get(`/projects/${projectSegment(name)}/tree`, {
      params: { path },
      _silent: true,
    } as any);
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
  deploy: async (name: string, recoveryReplay?: ProjectRuntimeRecoveryReplayProof) => {
    const { data } = recoveryReplay
      ? await client.post(
          `/projects/${projectSegment(name)}/deploy`,
          { recoveryReplay },
          { _skipNetworkRetry: true } as any,
        )
      : await client.post(
          `/projects/${projectSegment(name)}/deploy`,
          undefined,
          { _skipNetworkRetry: true } as any,
        );
    if (recoveryReplay) {
      const completion = projectRuntimeRecoveryCompletion(data, recoveryReplay);
      if (completion) return completion;
    }
    return validateProjectDeploySuccess(data, recoveryReplay);
  },
  undeploy: async (name: string) => {
    const { data } = await client.delete(`/projects/${projectSegment(name)}/deploy`);
    return data;
  },
  appProcess: async (
    name: string,
    action: ProjectProcessAction,
    recoveryReplay?: ProjectRuntimeRecoveryReplayProof,
  ): Promise<ProjectDeploymentProcessState> => {
    const url = `/projects/${projectSegment(name)}/app-process`;
    const body = {
      action,
      ...(recoveryReplay ? { recoveryReplay } : {}),
    };
    const { data } = action === 'status' || action === 'logs'
      ? await client.post(url, body)
      : await client.post(url, body, { _skipNetworkRetry: true } as any);
    if (recoveryReplay && projectRuntimeRecoveryCompletion(data, recoveryReplay)) {
      const statusResponse = await client.post(url, { action: 'status' });
      return validateProjectDeploymentProcessState(statusResponse.data);
    }
    return validateProjectDeploymentProcessState(data);
  },
  checkDeps: async (name: string) => {
    const { data } = await client.get(`/projects/${projectSegment(name)}/check-deps`);
    return data;
  },
  docUpdate: async (name: string, type: string, description: string, details?: string) => {
    const { data } = await client.post(`/projects/${projectSegment(name)}/doc-update`, { type, description, details });
    return data;
  },
  share: async (name: string, options: ProjectShareCreateOptions = {}): Promise<ProjectShareCreateResponse> => {
    const { data } = await client.post(`/projects/${projectSegment(name)}/share`, options);
    return data;
  },
  listShares: async (name: string): Promise<ProjectShareListResponse> => {
    const { data } = await client.get(`/projects/${projectSegment(name)}/shares`);
    return data;
  },
  updateShare: async (name: string, linkId: string, updates: ProjectShareUpdateOptions) => {
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
    const { data } = await client.get(
      `/projects/${encodeURIComponent(name)}/chat/providers`,
      { _silent: true } as any,
    );
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
      { params: { provider: 'OPENCLAW' }, _silent: true } as any,
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
    // account can fail when the user explicitly reviews that provider, and
    // the provider menu already renders that state inline.
    const { data } = await client.get(
      `/projects/${encodeURIComponent(name)}/chat/providers/agent-zero/models`,
      { _silent: true, _skipNetworkRetry: true } as any,
    );
    return data;
  },
  qualifyOpenClawProject: async (name: string) => {
    const { data } = await client.post(
      `/projects/${encodeURIComponent(name)}/chat/providers/openclaw/qualify`,
      {},
      { _skipNetworkRetry: true, _silent: true } as any,
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
      // Project Chat presents the bounded provider failure and operator
      // diagnostic inline, so do not duplicate it in the global error panel.
      { _skipNetworkRetry: true, _silent: true } as any,
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
    const { data } = await client.post(
      `/projects/${encodeURIComponent(name)}/chat/provider`,
      { provider, stateVersion, model },
      { _silent: true } as any,
    );
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
    const { data } = await client.get(`/projects/${encodeURIComponent(name)}/chat/history`, {
      params,
      // The Project Chat panel owns a durable, local transcript error with an
      // explicit retry. Do not duplicate the same expected read failure in the
      // global Errors badge, sound, and activity feed.
      _silent: true,
    } as any);
    return validateProjectChatHistoryPage(data);
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
    const { data } = await client.post(
      `/projects/${encodeURIComponent(name)}/assistant/abort`,
      { provider, stateVersion },
      { _silent: true } as any,
    );
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
  claudeAskUserSupported?: boolean;
  claudeAskUserPatched?: boolean;
  claudeAskUserBridgeReady?: boolean;
  claudeAskUserTimeoutsReady?: boolean;
  askUserPluginVersionReady?: boolean;
  heartbeatRunner: string | null;
  replyBundle: string | null;
  executeRuntime?: string | null;
  geminiCliBackend?: string | null;
  claudeCliShared?: string | null;
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
  models: async (provider = 'OPENCLAW', options: { silent?: boolean } = {}): Promise<{ provider: string; capabilities?: { supportsModelSelection?: boolean; modelSelectionMode?: string; supportsCustomModelInput?: boolean; canEnumerateModels?: boolean; modelCatalogKind?: string; supportsInTurnSteering?: boolean; supportsQueuedFollowUps?: boolean; followUpMode?: string; adapterFamily?: string; adapterKey?: string }; models: Array<{ id: string; alias: string | null; displayName: string; provider: string; source?: string }>; unavailableModelIds?: string[] }> => {
    const isAgentZero = String(provider || '').trim().toUpperCase() === 'AGENT_ZERO';
    const { data } = await client.get('/gateway/models', {
      params: { provider },
      ...(isAgentZero ? {
        timeout: AGENT_ZERO_MODEL_CATALOG_TIMEOUT_MS,
        _skipNetworkRetry: true,
      } : {}),
      ...(options.silent ? { _silent: true } : {}),
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
    const { data } = await client.post(
      '/gateway/ask-user/answer',
      { id, answers },
      { _silent: true } as any,
    );
    return data;
  },
  dismissQuestion: async (id: string) => {
    const { data } = await client.post(
      '/gateway/ask-user/dismiss',
      { id },
      { _silent: true } as any,
    );
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
