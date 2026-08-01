import { Router, Request, Response } from 'express';
import { exec } from 'child_process';
import { createHash } from 'crypto';
import rateLimit from 'express-rate-limit';
import { authenticateToken } from '../middleware/auth';
import { requireAdmin, requireOwner } from '../middleware/requireAdmin';
import { getOpenClawApiUrl } from '../config/openclaw';
import { TOOL_ADAPTERS } from '../config/toolAdapters';
import {
  AGENT_ZERO_CREDENTIAL_CONFIRMATION,
  AGENT_ZERO_RUNTIME_CONFIRMATION,
  collectAgentZeroSetupStatus,
  provisionAgentZeroCredentials,
  reconcileAgentZeroRuntime,
} from '../agents/providers/agentZero/AgentZeroSetupControl';
import { isTypedConfirmationMatch } from '../utils/privilegedConfirmation';
import {
  isValidAgentZeroDesktopLauncherSecret,
  mintAgentZeroDesktopSession,
} from '../services/agentZeroDesktopLaunch';
import {
  AGENT_ZERO_OAUTH_DISCONNECT_CONFIRMATION,
  AgentZeroOAuthError,
  getDefaultAgentZeroOAuthClient,
  type AgentZeroOAuthStatus,
} from '../agents/providers/agentZero/AgentZeroOAuthControl';
import {
  filterAgentZeroOAuthModelCatalogForHostChat,
  filterAgentZeroOAuthModelsForHostChat,
  invalidateAgentZeroOAuthModelCatalogCache,
} from '../agents/providers/agentZero/AgentZeroOAuthModelCatalog';
import {
  __clearProviderCredentialLifecycleLedgerForTests,
  bindProviderCredentialLifecycle,
  claimProviderCredentialLifecycle,
  claimProviderCredentialRemovalLifecycle,
  DurableCredentialLifecycleConflictError,
  DurableCredentialLifecycleRecoveryRequiredError,
  DurableCredentialLifecycleUnavailableError,
  getProviderCredentialLifecycleRecord,
  markProviderCredentialLifecycle,
  parkProviderCredentialRemovalLifecycle,
  reconcileProviderCredentialLifecycleBeforeAdmission,
  releaseProviderCredentialLifecycle,
  verifyAndReleaseProviderCredentialRemovalLifecycle,
  type ClaimedProviderCredentialLifecycle,
} from '../services/providerCredentialLifecycleLedger';

const router = Router();
const GATEWAY_URL = getOpenClawApiUrl();

const agentZeroOAuthReadLimiter = rateLimit({
  windowMs: 60_000,
  limit: 60,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => req.user?.userId || 'anonymous',
  message: { error: 'Too many Agent Zero OAuth status requests. Try again shortly.' },
});

const agentZeroOAuthMutationLimiter = rateLimit({
  windowMs: 15 * 60_000,
  limit: 10,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => req.user?.userId || 'anonymous',
  message: { error: 'Too many Agent Zero OAuth changes. Try again later.' },
});

const agentZeroOAuthPollLimiter = rateLimit({
  windowMs: 15 * 60_000,
  limit: 180,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => req.user?.userId || 'anonymous',
  message: { error: 'Too many Agent Zero OAuth polling requests. Start a new connection later.' },
});

interface AgentZeroOAuthLifecycleLease {
  providerId: string;
  ownerId: string;
  startFingerprint: string;
  startPromise: Promise<any>;
  attemptId: string | null;
  oauthState: string | null;
  expiresAt: number | null;
  terminalExpired: boolean;
  completionFingerprint: string | null;
  completionPromise: Promise<any> | null;
  committed: boolean;
  durableClaim: ClaimedProviderCredentialLifecycle | null;
}

const agentZeroOAuthLifecycleLeases = new Map<string, AgentZeroOAuthLifecycleLease>();

class AgentZeroOAuthAdmissionError extends Error {}

function agentZeroOAuthOwner(req: Request): string {
  return req.user?.userId ? `user:${req.user.userId}` : 'owner:unknown';
}

function agentZeroOAuthFingerprint(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

function agentZeroOAuthProviderConnected(status: AgentZeroOAuthStatus, providerId: string): boolean {
  const provider = status.providers.find((entry) => entry.providerId === providerId);
  return Boolean(provider?.connected && provider.connectionState === 'connected');
}

function agentZeroOAuthStatusFingerprint(status: AgentZeroOAuthStatus, providerId: string): string {
  const provider = status.providers.find((entry) => entry.providerId === providerId);
  return agentZeroOAuthFingerprint({
    providerId,
    connected: Boolean(provider?.connected),
    connectionState: provider?.connected ? 'connected' : 'disconnected',
    accountLabel: provider?.connected ? String(provider.accountLabel || '') : '',
  });
}

/**
 * Ask Agent Zero whether a provider account exists right now. Used only to
 * decide whether a start that never bound an attempt may release its claim
 * instead of parking it; any doubt answers false and stays fail-closed.
 */
async function agentZeroOAuthProviderVerifiedAbsent(providerId: string): Promise<boolean> {
  try {
    const status = await getDefaultAgentZeroOAuthClient().status();
    const provider = status.providers.find((entry) => entry.providerId === providerId);
    return Boolean(provider) && !provider?.connected;
  } catch {
    return false;
  }
}

async function startAgentZeroOAuthLifecycle(req: Request): Promise<any> {
  const providerId = String(req.params.provider || '');
  const ownerId = agentZeroOAuthOwner(req);
  const input = {
    providerId,
    enterpriseDomain: req.body?.enterpriseDomain,
    clientId: req.body?.clientId,
    clientSecret: req.body?.clientSecret,
    quotaProjectId: req.body?.quotaProjectId,
  };
  const startFingerprint = agentZeroOAuthFingerprint(input);
  const existing = agentZeroOAuthLifecycleLeases.get(providerId);
  if (existing) {
    if (existing.ownerId === ownerId && existing.startFingerprint === startFingerprint) {
      // Resuming is right while the attempt is still live, but handing back an
      // authorization URL that already expired is not: the panel opens it,
      // immediately sees a past deadline, and reports "the browser
      // authorization window expired" seconds after the click. Say so instead.
      if (typeof existing.expiresAt === 'number' && existing.expiresAt > 0
        && Date.now() >= existing.expiresAt) {
        throw new AgentZeroOAuthAdmissionError(
          'That authorization window has already expired. Disconnect this provider to clear the attempt, then start a new connection.',
        );
      }
      return existing.startPromise;
    }
    throw new AgentZeroOAuthAdmissionError(
      'Another Agent Zero OAuth lifecycle already owns this provider. Finish or disconnect it before starting a different sign-in.',
    );
  }

  const namespace = `agent-zero:${providerId}`;
  const client = getDefaultAgentZeroOAuthClient();
  const lease = {} as AgentZeroOAuthLifecycleLease;
  const startPromise = Promise.resolve().then(async () => {
    if (getProviderCredentialLifecycleRecord(namespace)) {
      // An attempt the Portal forgot — abandoned, or dropped by a restart —
      // used to refuse every future sign-in with no action that could clear
      // it. The ledger already ships the recovery protocol for exactly this,
      // so run it: past its review window it re-attests the provider, and
      // releases the record only after stable proof that no account exists.
      // Anything short of that proof still refuses, and says why.
      await reconcileProviderCredentialLifecycleBeforeAdmission(
        namespace,
        async () => {
          const current = await client.status();
          const provider = current.providers.find((entry) => entry.providerId === providerId);
          return {
            fingerprint: agentZeroOAuthStatusFingerprint(current, providerId),
            absent: Boolean(provider && !provider.connected),
          };
        },
      );
    }
    const statusBefore = await client.status();
    const providerBefore = statusBefore.providers.find((entry) => entry.providerId === providerId);
    const durableClaim = claimProviderCredentialLifecycle(
      namespace,
      ownerId,
      startFingerprint,
      {
        lifecycleKind: 'agent-zero-oauth',
        reviewAfterMs: 20 * 60 * 1000,
        // A pre-existing connected account has no revision/fingerprint contract.
        // Persist no absence baseline so restart recovery remains fail-closed
        // until an explicit, verified disconnect.
        baselineFingerprint: providerBefore?.connected
          ? null
          : agentZeroOAuthStatusFingerprint(statusBefore, providerId),
      },
    );
    lease.durableClaim = durableClaim;
    return client.startLogin(input);
  });
  Object.assign(lease, {
    providerId,
    ownerId,
    startFingerprint,
    startPromise,
    attemptId: null,
    oauthState: null,
    expiresAt: null,
    terminalExpired: false,
    completionFingerprint: null,
    completionPromise: null,
    committed: false,
    durableClaim: null,
  });
  agentZeroOAuthLifecycleLeases.set(providerId, lease);
  try {
    const result = await startPromise;
    const durableClaim = lease.durableClaim;
    if (!durableClaim) throw new Error('Agent Zero OAuth durable ownership was not established.');
    lease.attemptId = typeof result?.attemptId === 'string' && result.attemptId ? result.attemptId : null;
    lease.expiresAt = typeof result?.expiresAt === 'number' && result.expiresAt > 0
      ? result.expiresAt
      : null;
    if (typeof result?.authUrl === 'string' && result.authUrl) {
      try {
        lease.oauthState = new URL(result.authUrl).searchParams.get('state');
      } catch {
        lease.oauthState = null;
      }
    }
    const bindingIdentity = lease.attemptId || (lease.oauthState ? `browser-state:${lease.oauthState}` : null);
    if (bindingIdentity) {
      bindProviderCredentialLifecycle(durableClaim, bindingIdentity, {
        binding: { kind: 'attested-processless' },
        reviewAfterMs: lease.expiresAt
          ? Math.max(60_000, lease.expiresAt - Date.now() + 60_000)
          : 20 * 60 * 1000,
      });
    } else {
      throw new AgentZeroOAuthError(
        'Agent Zero returned no durable attempt identity or browser state.',
        'UPSTREAM_REJECTED',
      );
    }
    return result;
  } catch (error) {
    const durableClaim = lease.durableClaim;
    if (!durableClaim) {
      if (agentZeroOAuthLifecycleLeases.get(providerId) === lease) {
        agentZeroOAuthLifecycleLeases.delete(providerId);
      }
      throw error;
    }
    if (error instanceof AgentZeroOAuthError && error.code === 'INVALID_REQUEST'
      && agentZeroOAuthLifecycleLeases.get(providerId) === lease) {
      releaseProviderCredentialLifecycle(durableClaim);
      agentZeroOAuthLifecycleLeases.delete(providerId);
    } else if (
      !lease.attemptId && !lease.oauthState
      && agentZeroOAuthLifecycleLeases.get(providerId) === lease
      && await agentZeroOAuthProviderVerifiedAbsent(providerId)
    ) {
      // The start failed before any attempt identity came back, so this claim
      // owns nothing that can later be recovered or reconciled, and upstream
      // confirms no account exists. Parking it as indeterminate stranded the
      // provider: sign-in refused because a lifecycle was open, and disconnect
      // refused because that lifecycle was unbound. Nothing could clear it.
      releaseProviderCredentialLifecycle(durableClaim);
      agentZeroOAuthLifecycleLeases.delete(providerId);
    } else {
      markProviderCredentialLifecycle(durableClaim, 'indeterminate');
    }
    throw error;
  }
}

function requireAgentZeroOAuthLease(req: Request): AgentZeroOAuthLifecycleLease {
  const providerId = String(req.params.provider || '');
  const lease = agentZeroOAuthLifecycleLeases.get(providerId);
  if (!lease || lease.ownerId !== agentZeroOAuthOwner(req)) {
    throw new AgentZeroOAuthAdmissionError(
      'This Agent Zero OAuth attempt is not owned by the current Portal authorization lifecycle. Start or resume the provider first.',
    );
  }
  return lease;
}

function completeAgentZeroOAuthLifecycle(req: Request): Promise<any> {
  const lease = requireAgentZeroOAuthLease(req);
  const callback = String(req.body?.callback || '').trim();
  if (!lease.oauthState) {
    throw new AgentZeroOAuthAdmissionError(
      'This browser OAuth attempt has no exact state binding and cannot accept a callback.',
    );
  }
  let callbackState = '';
  let callbackCode = '';
  try {
    const parsed = new URL(callback, 'http://127.0.0.1');
    callbackState = parsed.searchParams.get('state') || '';
    callbackCode = parsed.searchParams.get('code') || '';
  } catch {
    throw new AgentZeroOAuthAdmissionError('Paste the complete OAuth callback URL, including code and state.');
  }
  if (!callbackCode || !callbackState || callbackState !== lease.oauthState) {
    throw new AgentZeroOAuthAdmissionError(
      'The OAuth callback does not contain the exact state owned by this Agent Zero attempt.',
    );
  }
  const fingerprint = agentZeroOAuthFingerprint({ providerId: lease.providerId, callback });
  if (lease.completionPromise) {
    if (lease.completionFingerprint === fingerprint) return lease.completionPromise;
    throw new AgentZeroOAuthAdmissionError(
      'This Agent Zero OAuth attempt is already processing a different callback.',
    );
  }
  const upstream = getDefaultAgentZeroOAuthClient().completeManualCallback({
    providerId: lease.providerId,
    callback,
  });
  lease.completionFingerprint = fingerprint;
  const completion = upstream.then((result) => {
    if (result.expired) {
      lease.terminalExpired = true;
      if (lease.durableClaim) markProviderCredentialLifecycle(lease.durableClaim, 'indeterminate');
    }
    if (!result.completed && lease.completionPromise === completion) {
      lease.completionPromise = null;
      lease.completionFingerprint = null;
    }
    return result;
  }, (error) => {
    if (lease.completionPromise === completion) {
      lease.completionPromise = null;
      lease.completionFingerprint = null;
    }
    throw error;
  });
  lease.completionPromise = completion;
  return completion;
}

function pollAgentZeroOAuthLifecycle(req: Request): Promise<any> {
  const lease = requireAgentZeroOAuthLease(req);
  const attemptId = String(req.body?.attemptId || '');
  if (!lease.attemptId || lease.attemptId !== attemptId) {
    throw new AgentZeroOAuthAdmissionError('The Agent Zero device attempt does not match the admitted authorization lifecycle.');
  }
  const fingerprint = agentZeroOAuthFingerprint({ providerId: lease.providerId, attemptId });
  if (lease.completionPromise) {
    if (lease.completionFingerprint === fingerprint) return lease.completionPromise;
    throw new AgentZeroOAuthAdmissionError('This Agent Zero OAuth lifecycle is already processing another completion operation.');
  }
  const poll = getDefaultAgentZeroOAuthClient().pollLogin({ providerId: lease.providerId, attemptId });
  lease.completionFingerprint = fingerprint;
  const shared = poll.then((result) => {
    if (result.expired) {
      lease.terminalExpired = true;
      if (lease.durableClaim) markProviderCredentialLifecycle(lease.durableClaim, 'indeterminate');
    }
    if (!result.completed && lease.completionPromise === shared) {
      lease.completionPromise = null;
      lease.completionFingerprint = null;
    }
    return result;
  }, (error) => {
    if (lease.completionPromise === shared) {
      lease.completionPromise = null;
      lease.completionFingerprint = null;
    }
    throw error;
  });
  lease.completionPromise = shared;
  return shared;
}

function finalizeAgentZeroOAuthLifecycle(lease: AgentZeroOAuthLifecycleLease): void {
  lease.committed = true;
  if (lease.durableClaim) releaseProviderCredentialLifecycle(lease.durableClaim);
}

export function __resetAgentZeroOAuthLifecycleLeasesForTests(): void {
  agentZeroOAuthLifecycleLeases.clear();
  __clearProviderCredentialLifecycleLedgerForTests();
}

export function __resetAgentZeroOAuthLifecycleMemoryForTests(): void {
  agentZeroOAuthLifecycleLeases.clear();
}

function portalOAuthStatus(status: AgentZeroOAuthStatus) {
  return {
    ...status,
    actions: {
      disconnect: {
        ownerOnly: true as const,
        confirmationPhrase: AGENT_ZERO_OAUTH_DISCONNECT_CONFIRMATION,
      },
    },
  };
}

function sendAgentZeroOAuthError(res: Response, error: unknown): void {
  if (error instanceof AgentZeroOAuthAdmissionError) {
    res.status(409).json({ error: error.message, code: 'AGENT_ZERO_OAUTH_LIFECYCLE_CONFLICT' });
    return;
  }
  if (error instanceof DurableCredentialLifecycleConflictError
    || error instanceof DurableCredentialLifecycleRecoveryRequiredError
    || error instanceof DurableCredentialLifecycleUnavailableError) {
    res.status(error.statusCode).json({ error: error.message, code: error.code });
    return;
  }
  if (!(error instanceof AgentZeroOAuthError)) {
    console.error('[agent-zero-oauth] Unexpected OAuth control failure.');
    res.status(500).json({ error: 'Agent Zero OAuth could not be managed safely.' });
    return;
  }

  let status = 409;
  if (error.code === 'INVALID_REQUEST') status = 400;
  else if (error.code === 'UNAVAILABLE') status = 503;
  else if (error.code === 'UPSTREAM_REJECTED' && error.status === 429) status = 429;
  else if (error.code === 'UPSTREAM_REJECTED' && (error.status || 0) >= 500) status = 502;

  res.status(status).json({
    error: error.message,
    code: `AGENT_ZERO_OAUTH_${error.code}`,
  });
}

type AdapterStatus = {
  id: string;
  name: string;
  available: boolean;
  version: string | null;
};

const DEFAULT_ADAPTER_DETECTION_TIMEOUT_MS = 2_500;

function checkCommand(
  command: string,
  timeoutMs = DEFAULT_ADAPTER_DETECTION_TIMEOUT_MS,
): Promise<{ available: boolean; version: string | null }> {
  return new Promise((resolve) => {
    exec(command, { timeout: timeoutMs, shell: '/bin/bash' }, (error, stdout, stderr) => {
      if (error) {
        resolve({ available: false, version: null });
        return;
      }
      const output = `${stdout || ''}\n${stderr || ''}`.trim();
      const semver = output.match(/\b\d+\.\d+\.\d+(?:[-+][\w.-]+)?\b/);
      resolve({ available: true, version: semver ? semver[0] : output.split(/\r?\n/)[0] || null });
    });
  });
}

router.get('/status', authenticateToken, requireAdmin, async (_req: Request, res: Response) => {
  let gateway = { connected: false, message: 'Gateway unreachable' };

  try {
    const probe = await fetch(`${GATEWAY_URL}/`, { signal: AbortSignal.timeout(2500) });
    gateway = probe.ok
      ? { connected: true, message: 'Gateway reachable' }
      : { connected: false, message: `Gateway responded ${probe.status}` };
  } catch (error: any) {
    gateway = { connected: false, message: error?.message || 'Gateway unreachable' };
  }

  const adapterStatuses: AdapterStatus[] = await Promise.all(
    TOOL_ADAPTERS.map(async (adapter) => {
      if (!adapter.detect?.command) {
        return { id: adapter.id, name: adapter.name, available: true, version: null };
      }
      const status = await checkCommand(
        adapter.detect.command,
        adapter.detect.timeoutMs ?? DEFAULT_ADAPTER_DETECTION_TIMEOUT_MS,
      );
      return {
        id: adapter.id,
        name: adapter.name,
        available: status.available,
        version: status.version,
      };
    }),
  );

  res.json({
    gateway,
    adapters: adapterStatuses,
    anyAgentAvailable: adapterStatuses.some((a) => a.available && a.id !== 'shell'),
    checkedAt: new Date().toISOString(),
  });
});

/** Sanitized Agent Zero readiness. Credentials and session cookies stay server-only. */
router.get('/agent-zero/status', authenticateToken, requireAdmin, async (_req: Request, res: Response) => {
  try {
    res.json(await collectAgentZeroSetupStatus());
  } catch {
    res.status(500).json({ error: 'Agent Zero setup status could not be inspected safely.' });
  }
});

// Loopback-only, capability-secret-gated mint of an authenticated Agent Zero
// web session for the managed Remote Desktop launcher. Not JWT-authenticated:
// the desktop launcher account has no Portal session. Instead it is fenced to
// direct loopback callers (no reverse-proxy headers, so external requests
// arriving via Caddy are refused) and a per-boot secret only the managed
// launcher can read. The response carries Agent Zero session cookies, never
// the Agent Zero password.
router.post('/agent-zero/desktop-session', async (req: Request, res: Response) => {
  const forwarded = req.headers['x-forwarded-for'] || req.headers['x-real-ip'];
  const remote = String(req.socket?.remoteAddress || '');
  const isDirectLoopback = !forwarded
    && (remote === '127.0.0.1' || remote === '::1' || remote === '::ffff:127.0.0.1');
  if (!isDirectLoopback) {
    res.status(403).json({ error: 'Forbidden' });
    return;
  }
  const presentedSecret = req.headers['x-bridgesllm-desktop-launch-secret'];
  if (!isValidAgentZeroDesktopLauncherSecret(
    Array.isArray(presentedSecret) ? presentedSecret[0] : presentedSecret,
  )) {
    res.status(403).json({ error: 'Forbidden' });
    return;
  }
  try {
    const session = await mintAgentZeroDesktopSession();
    res.setHeader('Cache-Control', 'no-store');
    res.json(session);
  } catch (error: any) {
    res.status(503).json({
      error: `Agent Zero web session is unavailable: ${error?.message || 'sign-in failed'}`,
    });
  }
});

router.post('/agent-zero/auth/verify', authenticateToken, requireOwner, async (_req: Request, res: Response) => {
  try {
    const status = await collectAgentZeroSetupStatus(true);
    res.status(status.authentication.authenticated ? 200 : 409).json(status);
  } catch {
    res.status(500).json({ error: 'Agent Zero authentication could not be verified safely.' });
  }
});

router.post('/agent-zero/credentials', authenticateToken, requireOwner, async (req: Request, res: Response) => {
  if (!isTypedConfirmationMatch(AGENT_ZERO_CREDENTIAL_CONFIRMATION, req.body?.confirmation)) {
    res.status(400).json({
      error: `Type ${AGENT_ZERO_CREDENTIAL_CONFIRMATION} to replace the protected server-side Agent Zero login.`,
      confirmationPhrase: AGENT_ZERO_CREDENTIAL_CONFIRMATION,
    });
    return;
  }

  try {
    const status = await provisionAgentZeroCredentials(req.body?.username, req.body?.password);
    res.json({
      ok: true,
      saved: true,
      verified: status.authentication.authenticated,
      status,
    });
  } catch (error: any) {
    const validationError = typeof error?.message === 'string'
      && /^Agent Zero (?:username|password)/.test(error.message);
    res.status(validationError ? 400 : 500).json({
      error: validationError
        ? error.message
        : 'Protected Agent Zero credentials could not be saved and verified; the previous configuration was restored.',
    });
  }
});

router.post('/agent-zero/runtime/reconcile', authenticateToken, requireOwner, async (req: Request, res: Response) => {
  if (!isTypedConfirmationMatch(AGENT_ZERO_RUNTIME_CONFIRMATION, req.body?.confirmation)) {
    res.status(400).json({
      error: `Type ${AGENT_ZERO_RUNTIME_CONFIRMATION} to install or repair the pinned Agent Zero runtime and host bridge.`,
      confirmationPhrase: AGENT_ZERO_RUNTIME_CONFIRMATION,
    });
    return;
  }

  try {
    const status = await reconcileAgentZeroRuntime();
    const localContractReady = status.mainAgentChat.contractReady;
    res.status(localContractReady ? 200 : 409).json({
      ok: localContractReady,
      message: localContractReady
        ? 'Agent Zero host-operator components are ready. Portal exposes the provider only while every live local gate remains verified; Project Chat remains separately qualified.'
        : 'Agent Zero reconciliation finished, but one or more local readiness checks still need attention.',
      status,
    });
  } catch (error) {
    // Log the real failure server-side; the response stays generic so
    // lifecycle internals never leak, but operators are no longer blind.
    console.error('[agent-zero] Managed runtime reconciliation failed:', error);
    res.status(500).json({
      error: 'Managed Agent Zero reconciliation failed. No provider execution scope was enabled. Check the Portal service log for the underlying lifecycle error.',
    });
  }
});

router.get(
  '/agent-zero/oauth/status',
  authenticateToken,
  requireOwner,
  agentZeroOAuthReadLimiter,
  async (_req: Request, res: Response) => {
    // A status refresh is the authoritative account boundary. Clear any
    // selectable-model snapshot even when the upstream status read fails, so
    // an expired or externally revoked account cannot leave a stale catalog.
    invalidateAgentZeroOAuthModelCatalogCache();
    try {
      const status = await getDefaultAgentZeroOAuthClient().status();
      for (const [providerId, lease] of agentZeroOAuthLifecycleLeases) {
        if (lease.committed && !agentZeroOAuthProviderConnected(status, providerId)) {
          agentZeroOAuthLifecycleLeases.delete(providerId);
        }
      }
      res.json(portalOAuthStatus(status));
    } catch (error) {
      sendAgentZeroOAuthError(res, error);
    }
  },
);

router.post(
  '/agent-zero/oauth/:provider/start',
  authenticateToken,
  requireOwner,
  agentZeroOAuthMutationLimiter,
  async (req: Request, res: Response) => {
    try {
      const result = await startAgentZeroOAuthLifecycle(req);
      res.json(result);
    } catch (error) {
      sendAgentZeroOAuthError(res, error);
    }
  },
);

router.post(
  '/agent-zero/oauth/:provider/poll',
  authenticateToken,
  requireOwner,
  agentZeroOAuthPollLimiter,
  async (req: Request, res: Response) => {
    try {
      const client = getDefaultAgentZeroOAuthClient();
      const result = await pollAgentZeroOAuthLifecycle(req);
      if (result.completed) invalidateAgentZeroOAuthModelCatalogCache();
      const status = result.completed ? await client.status() : null;
      if (result.completed) {
        const lease = requireAgentZeroOAuthLease(req);
        if (!status || !agentZeroOAuthProviderConnected(status, lease.providerId)) {
          throw new AgentZeroOAuthError(
            'Agent Zero did not verify the completed OAuth account in its authoritative status.',
            'UPSTREAM_REJECTED',
          );
        }
        finalizeAgentZeroOAuthLifecycle(lease);
      }
      res.json({
        ...result,
        ...(status ? { status: portalOAuthStatus(status) } : {}),
      });
    } catch (error) {
      sendAgentZeroOAuthError(res, error);
    }
  },
);

router.post(
  '/agent-zero/oauth/:provider/manual-callback',
  authenticateToken,
  requireOwner,
  agentZeroOAuthMutationLimiter,
  async (req: Request, res: Response) => {
    try {
      const client = getDefaultAgentZeroOAuthClient();
      const result = await completeAgentZeroOAuthLifecycle(req);
      if (result.completed) invalidateAgentZeroOAuthModelCatalogCache();
      const status = result.completed ? await client.status() : null;
      if (result.completed) {
        const lease = requireAgentZeroOAuthLease(req);
        if (!status || !agentZeroOAuthProviderConnected(status, lease.providerId)) {
          throw new AgentZeroOAuthError(
            'Agent Zero did not verify the completed OAuth account in its authoritative status.',
            'UPSTREAM_REJECTED',
          );
        }
        finalizeAgentZeroOAuthLifecycle(lease);
      }
      res.json({
        ...result,
        ...(status ? { status: portalOAuthStatus(status) } : {}),
      });
    } catch (error) {
      sendAgentZeroOAuthError(res, error);
    }
  },
);

router.get(
  '/agent-zero/oauth/models',
  authenticateToken,
  requireOwner,
  agentZeroOAuthReadLimiter,
  async (_req: Request, res: Response) => {
    try {
      res.json(filterAgentZeroOAuthModelCatalogForHostChat(
        await getDefaultAgentZeroOAuthClient().modelCatalog(),
      ));
    } catch (error) {
      sendAgentZeroOAuthError(res, error);
    }
  },
);

router.get(
  '/agent-zero/oauth/:provider/models',
  authenticateToken,
  requireOwner,
  agentZeroOAuthReadLimiter,
  async (req: Request, res: Response) => {
    try {
      const catalog = await getDefaultAgentZeroOAuthClient().models(req.params.provider);
      res.json({
        ...catalog,
        models: filterAgentZeroOAuthModelsForHostChat(catalog.providerId, catalog.models),
      });
    } catch (error) {
      sendAgentZeroOAuthError(res, error);
    }
  },
);

router.post(
  '/agent-zero/oauth/:provider/disconnect',
  authenticateToken,
  requireOwner,
  agentZeroOAuthMutationLimiter,
  async (req: Request, res: Response) => {
    if (!isTypedConfirmationMatch(
      AGENT_ZERO_OAUTH_DISCONNECT_CONFIRMATION,
      req.body?.confirmation,
    )) {
      res.status(400).json({
        error: `Type ${AGENT_ZERO_OAUTH_DISCONNECT_CONFIRMATION} to remove the Agent Zero OAuth account credentials.`,
        confirmationPhrase: AGENT_ZERO_OAUTH_DISCONNECT_CONFIRMATION,
      });
      return;
    }

    let removalClaim: ClaimedProviderCredentialLifecycle | null = null;
    try {
      const requestedProviderId = String(req.params.provider || '');
      const activeLease = agentZeroOAuthLifecycleLeases.get(requestedProviderId);
      if (activeLease && !activeLease.committed) {
        const authoritativeExpiryElapsed = activeLease.terminalExpired
          && typeof activeLease.expiresAt === 'number'
          && Date.now() >= activeLease.expiresAt + 60_000
          && !activeLease.completionPromise;
        if (!authoritativeExpiryElapsed) {
          throw new DurableCredentialLifecycleConflictError(
            'Agent Zero cannot cancel this upstream OAuth attempt. Wait for authoritative expiry before disconnecting so a late callback cannot recreate credentials.',
          );
        }
      }
      const namespace = `agent-zero:${requestedProviderId}`;
      removalClaim = claimProviderCredentialRemovalLifecycle(
        namespace,
        agentZeroOAuthOwner(req),
        agentZeroOAuthFingerprint({ action: 'disconnect', providerId: requestedProviderId }),
        {
          allowedTargetCredentialScopes: ['agent-zero'],
          operationCredentialScope: 'agent-zero',
        },
      );
      const client = getDefaultAgentZeroOAuthClient();
      const result = await client.disconnect(req.params.provider);
      if (result.providerId !== requestedProviderId) {
        throw new AgentZeroOAuthError(
          'Agent Zero returned a different OAuth provider during disconnect verification.',
          'UPSTREAM_REJECTED',
        );
      }
      let status = await client.status();
      const provider = status.providers.find((entry) => entry.providerId === result.providerId);
      if (!provider || provider.connected) {
        throw new AgentZeroOAuthError(
          'Agent Zero did not verify that the OAuth account was disconnected.',
          'UPSTREAM_REJECTED',
        );
      }
      const verified = await verifyAndReleaseProviderCredentialRemovalLifecycle(
        removalClaim,
        namespace,
        async () => {
          status = await client.status();
          const current = status.providers.find((entry) => entry.providerId === result.providerId);
          return {
            fingerprint: agentZeroOAuthStatusFingerprint(status, result.providerId),
            absent: Boolean(current && !current.connected),
          };
        },
        { proofCredentialScope: 'agent-zero' },
      );
      if (!verified) {
        throw new DurableCredentialLifecycleRecoveryRequiredError(
          'Agent Zero did not provide stable proof that the OAuth account remained disconnected. Provider removal remains locked for review.',
        );
      }
      removalClaim = null;
      invalidateAgentZeroOAuthModelCatalogCache();
      agentZeroOAuthLifecycleLeases.delete(result.providerId);
      res.json({
        ok: true,
        providerId: result.providerId,
        disconnected: result.disconnected,
        alreadyDisconnected: !result.disconnected,
        status: portalOAuthStatus(status),
      });
    } catch (error) {
      if (removalClaim) parkProviderCredentialRemovalLifecycle(removalClaim);
      sendAgentZeroOAuthError(res, error);
    }
  },
);

export default router;
