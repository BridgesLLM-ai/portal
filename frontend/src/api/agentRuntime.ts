import client from './client';

export type AgentRuntimeStatus = {
  gateway: { connected: boolean; message: string };
  adapters: Array<{ id: string; name: string; available: boolean; version: string | null }>;
  anyAgentAvailable: boolean;
  checkedAt: string;
};

export type AgentZeroSetupStep = {
  code: string;
  label: string;
  complete: boolean;
  detail: string;
};

export type AgentZeroSetupSurface = {
  scope: 'HOST_OPERATOR' | 'PROJECT_SANDBOX';
  available: boolean;
  contractReady: boolean;
  providerEnabled: boolean;
  reason: string;
  steps: AgentZeroSetupStep[];
};

export type AgentZeroSetupStatus = {
  testedVersions: { agentZero: '2.5'; connector: '0.1.0'; hostBridge: '2.5' };
  credentials: { configured: boolean; protected: boolean; reason: string };
  runtime: {
    installed: boolean;
    running: boolean;
    protocolReady: boolean;
    version?: string;
    expectedVersion: '2.5';
    pinnedImage: boolean;
    loopbackOnly: boolean;
    persistentData: boolean;
    protectedAuth: boolean;
    restartPolicy: boolean;
    reason: string;
  };
  authentication: {
    state: 'unchecked' | 'authenticated' | 'needs_login' | 'unconfigured' | 'error';
    authenticated: boolean;
    checkedAt?: string;
    reason: string;
  };
  hostGateway: {
    state: 'stopped' | 'starting' | 'ready' | 'error';
    installed: boolean;
    running: boolean;
    ready: boolean;
    cliVersion?: string;
    expectedCliVersion: '2.5';
    gatewayId: string;
    capabilities: {
      scope: 'HOST_OPERATOR';
      fileRead: true;
      fileWrite: true;
      codeExecution: true;
      browser: false;
      computerUse: false;
    };
    reason: string;
  };
  mainAgentChat: AgentZeroSetupSurface;
  projectSandbox: AgentZeroSetupSurface;
  actions: {
    provisionCredentials: { ownerOnly: true; confirmationPhrase: string };
    reconcileRuntime: { ownerOnly: true; confirmationPhrase: string };
    verifyAuthentication: { ownerOnly: true; available: boolean };
  };
  provider: {
    implemented: boolean;
    usable: boolean;
    supportedExecutionScopes: Array<'HOST_OPERATOR' | 'PROJECT_SANDBOX'>;
  };
  checkedAt: string;
};

export type AgentZeroOAuthProviderId =
  | 'codex_oauth'
  | 'github_copilot_oauth'
  | 'gemini_api_oauth'
  | 'xai_grok_oauth';

export type AgentZeroOAuthProviderStatus = {
  providerId: AgentZeroOAuthProviderId;
  displayName: string;
  shortName: string;
  authFlow: 'device_code' | 'browser_pkce';
  connected: boolean;
  connectionState: 'connected' | 'disconnected' | 'expired' | 'revoked' | 'error';
  reconnectRequired: boolean;
  accountLabel: string;
  warning: string;
  note: string;
  supportsManualCallback: boolean;
  supportsEnterpriseDomain: boolean;
  supportsOAuthClientConfig: boolean;
  supportsQuotaProject: boolean;
  defaultModel: string;
  defaultModels: string[];
  usageWindows: Array<{
    key: string;
    title: string;
    label: string;
    remainingPercent: number;
    resetAt: number;
  }>;
};

export type AgentZeroOAuthStatus = {
  available: boolean;
  routesInstalled: boolean;
  connectedCount: number;
  availableCount: number;
  providers: AgentZeroOAuthProviderStatus[];
  checkedAt: string;
  actions: {
    disconnect: {
      ownerOnly: true;
      confirmationPhrase: string;
    };
  };
};

export type AgentZeroOAuthLoginStart = {
  ok: true;
  providerId: AgentZeroOAuthProviderId;
  flow: 'device_code' | 'browser_pkce';
  attemptId: string;
  verificationUrl: string;
  userCode: string;
  authUrl: string;
  redirectUri: string;
  interval: number;
  expiresAt: number;
  message: string;
};

export type AgentZeroOAuthLoginPoll = {
  ok: true;
  providerId: AgentZeroOAuthProviderId;
  completed: boolean;
  expired: boolean;
  accountLabel: string;
  interval: number;
  expiresAt: number;
  warning: string;
  status?: AgentZeroOAuthStatus;
};

export type AgentZeroOAuthModel = {
  id: string;
  displayName: string;
  description: string;
};

export type AgentZeroOAuthModelCatalog = {
  available: true;
  providers: Array<{
    providerId: AgentZeroOAuthProviderId;
    displayName: string;
    accountLabel: string;
    connectionState: AgentZeroOAuthProviderStatus['connectionState'];
    models: AgentZeroOAuthModel[];
  }>;
  checkedAt: string;
};

export const agentRuntimeAPI = {
  async status(): Promise<AgentRuntimeStatus> {
    const { data } = await client.get('/agent-runtime/status');
    return data;
  },
  async agentZeroStatus(): Promise<AgentZeroSetupStatus> {
    const { data } = await client.get('/agent-runtime/agent-zero/status');
    return data;
  },
  async verifyAgentZeroAuthentication(): Promise<AgentZeroSetupStatus> {
    const { data } = await client.post('/agent-runtime/agent-zero/auth/verify');
    return data;
  },
  async provisionAgentZeroCredentials(input: {
    username: string;
    password: string;
    confirmation: string;
  }): Promise<{ ok: boolean; saved: boolean; verified: boolean; status: AgentZeroSetupStatus }> {
    const { data } = await client.post('/agent-runtime/agent-zero/credentials', input);
    return data;
  },
  async reconcileAgentZeroRuntime(confirmation: string): Promise<{
    ok: boolean;
    message: string;
    status: AgentZeroSetupStatus;
  }> {
    const { data } = await client.post('/agent-runtime/agent-zero/runtime/reconcile', { confirmation });
    return data;
  },
  async agentZeroOAuthStatus(): Promise<AgentZeroOAuthStatus> {
    const { data } = await client.get('/agent-runtime/agent-zero/oauth/status', { timeout: 20_000 });
    return data;
  },
  async startAgentZeroOAuth(input: {
    providerId: AgentZeroOAuthProviderId;
    enterpriseDomain?: string;
    clientId?: string;
    clientSecret?: string;
    quotaProjectId?: string;
  }): Promise<AgentZeroOAuthLoginStart> {
    const { providerId, ...body } = input;
    const { data } = await client.post(
      `/agent-runtime/agent-zero/oauth/${encodeURIComponent(providerId)}/start`,
      body,
      { timeout: 30_000 },
    );
    return data;
  },
  async pollAgentZeroOAuth(
    providerId: AgentZeroOAuthProviderId,
    attemptId: string,
  ): Promise<AgentZeroOAuthLoginPoll> {
    const { data } = await client.post(
      `/agent-runtime/agent-zero/oauth/${encodeURIComponent(providerId)}/poll`,
      { attemptId },
      { timeout: 30_000 },
    );
    return data;
  },
  async completeAgentZeroOAuthCallback(
    providerId: AgentZeroOAuthProviderId,
    callback: string,
  ): Promise<AgentZeroOAuthLoginPoll> {
    const { data } = await client.post(
      `/agent-runtime/agent-zero/oauth/${encodeURIComponent(providerId)}/manual-callback`,
      { callback },
      { timeout: 30_000 },
    );
    return data;
  },
  async agentZeroOAuthModels(providerId: AgentZeroOAuthProviderId): Promise<{
    providerId: AgentZeroOAuthProviderId;
    models: AgentZeroOAuthModel[];
  }> {
    const { data } = await client.get(
      `/agent-runtime/agent-zero/oauth/${encodeURIComponent(providerId)}/models`,
      { timeout: 30_000 },
    );
    return data;
  },
  async agentZeroOAuthModelCatalog(): Promise<AgentZeroOAuthModelCatalog> {
    const { data } = await client.get('/agent-runtime/agent-zero/oauth/models');
    return data;
  },
  async disconnectAgentZeroOAuth(
    providerId: AgentZeroOAuthProviderId,
    confirmation: string,
  ): Promise<{
    ok: true;
    providerId: AgentZeroOAuthProviderId;
    disconnected: boolean;
    alreadyDisconnected: boolean;
    status: AgentZeroOAuthStatus;
  }> {
    const { data } = await client.post(
      `/agent-runtime/agent-zero/oauth/${encodeURIComponent(providerId)}/disconnect`,
      { confirmation },
      { timeout: 30_000 },
    );
    return data;
  },
};
