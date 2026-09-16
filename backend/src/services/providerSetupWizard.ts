import fs from 'fs';
import path from 'path';
import { createHash } from 'crypto';
import { gatewayRpcCall } from '../utils/openclawGatewayRpc';
import { assertOpenClawGatewayAuthorizationFenceReleased } from './openClawGatewayAuthorizationFence';
import {
  bindProviderCredentialLifecycle, claimProviderCredentialLifecycle, markProviderCredentialLifecycle,
  releaseProviderCredentialLifecycle, type ClaimedProviderCredentialLifecycle,
} from './providerCredentialLifecycleLedger';
import {
  getCredentialLifecycleNamespaceForOpenClawProvider, readCredentialLifecycleDomainProofForOpenClawProvider,
} from './oauthFlowManager';
import { invalidateOpenClawAuthStoreProfilesCache } from './openclawConfigManager';
import { ProviderActivationError } from './providerActivation';

const { DatabaseSync } = require('node:sqlite');
const CHOICES: Record<string, string[]> = {
  'openai-codex': ['openai', 'openai-device-code', 'openai-codex'],
  'google-gemini-cli': ['google-gemini-cli'],
  xai: ['xai-oauth'],
  'qwen-portal': ['qwen-portal'],
  'github-copilot': ['github-copilot'],
};
type Operation = {
  id: string; owner: string; provider: string; choice: string; claim: ClaimedProviderCredentialLifecycle;
  baseline: string; phase: 'starting' | 'running' | 'complete' | 'cancelled' | 'recovery';
  answered: string[]; expires: number;
};
type Dependencies = {
  rpc?: typeof gatewayRpcCall;
  journalPath?: () => string;
  proof?: typeof readCredentialLifecycleDomainProofForOpenClawProvider;
  fence?: typeof assertOpenClawGatewayAuthorizationFenceReleased;
};
const digest = (value: string) => createHash('sha256').update(value).digest('hex');
const historicalProviders = Object.keys(CHOICES);
interface SubscriptionCapability { id: string; supported: boolean; transport: string; authChoice?: string; mode?: string; code?: string; reason?: string; }

/**
 * Credential-free restart journal. Native OpenClaw owns the wizard, exchanges,
 * plugin consent, auth-store transaction and config CAS. Portal owns only the
 * authenticated HTTP operation identity; it never replays a dispatched login.
 */
export class ProviderSetupWizard {
  private readonly rpc: typeof gatewayRpcCall;
  private readonly proof: typeof readCredentialLifecycleDomainProofForOpenClawProvider;
  private readonly fence: typeof assertOpenClawGatewayAuthorizationFenceReleased;
  private readonly pending = new Map<string, Promise<any>>();
  private readonly startOwners = new Map<string, string>();
  constructor(private readonly deps: Dependencies = {}) {
    this.rpc = deps.rpc || gatewayRpcCall;
    this.proof = deps.proof || (async provider => {
      invalidateOpenClawAuthStoreProfilesCache();
      return readCredentialLifecycleDomainProofForOpenClawProvider(provider);
    });
    this.fence = deps.fence || assertOpenClawGatewayAuthorizationFenceReleased;
  }
  private filename() {
    return this.deps.journalPath?.() || path.join(
      process.env.PORTAL_DATA_ROOT || process.env.PORTAL_ROOT || (process.env.NODE_ENV === 'test' ? '/tmp/portal-provider-setup-tests-' + process.pid : '/portal'), 'backend', '.data', 'provider-setup-wizards.sqlite3');
  }
  private database() {
    const filename = this.filename();
    fs.mkdirSync(path.dirname(filename), { recursive: true, mode: 0o700 });
    if (fs.existsSync(filename) && fs.lstatSync(filename).isSymbolicLink()) throw new Error('Invalid provider setup journal');
    const db = new DatabaseSync(filename);
    fs.chmodSync(filename, 0o600);
    db.exec('PRAGMA busy_timeout=5000; PRAGMA synchronous=FULL; CREATE TABLE IF NOT EXISTS operations (id TEXT PRIMARY KEY, value TEXT NOT NULL)');
    return db;
  }
  private read(id: string): Operation | undefined {
    if (!fs.existsSync(this.filename())) return undefined;
    const db = this.database();
    try {
      const row = db.prepare('SELECT value FROM operations WHERE id=?').get(id);
      return row ? JSON.parse(row.value) : undefined;
    } finally { db.close(); }
  }
  private save(operation: Operation, insert = false) {
    const db = this.database();
    try {
      db.prepare(insert ? 'INSERT INTO operations(id,value) VALUES (?,?)'
        : 'UPDATE operations SET value=? WHERE id=?').run(...(insert
          ? [operation.id, JSON.stringify(operation)] : [JSON.stringify(operation), operation.id]));
    } finally { db.close(); }
  }
  // UUIDs are the new transport's id space; legacy OAuth ids are unhyphenated.
  // Keep journal I/O inside status/answer's caught error boundary.
  owns(id: string) { return /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(id); }
  private owned(id: string, owner: string) {
    const op = this.read(id);
    if (!op || op.owner !== digest(owner)) throw new ProviderActivationError('OAUTH_NOT_FOUND', 'OAuth session not found.', 404);
    return op;
  }
  private singleFlight(id: string, action: () => Promise<any>) {
    const current = this.pending.get(id);
    if (current) return current;
    const next = action().finally(() => this.pending.delete(id));
    this.pending.set(id, next);
    return next;
  }
  async catalog(): Promise<{ providers: SubscriptionCapability[] }> {
    const result = await this.rpc('openclaw.setup.detect', {}, 30_000);
    if (!result.ok) throw new ProviderActivationError('NATIVE_SETUP_UNAVAILABLE', 'Native provider discovery is unavailable. Retry after reconnecting.', 503);
    const options: any[] = Array.isArray(result.data?.authOptions) ? result.data.authOptions : [];
    return { providers: historicalProviders.map(provider => {
      const option = options.find(item => CHOICES[provider].includes(item.id) && ['oauth', 'device-code'].includes(item.kind));
      return { id: provider, supported: Boolean(option), transport: 'native-wizard',
        ...(option ? { authChoice: option.id, mode: option.kind }
          : { code: 'NATIVE_PROVIDER_AUTH_UNSUPPORTED', reason: 'The installed native provider does not expose a supported OAuth/device method. Existing credentials and models remain available.' }) };
    }) };
  }
  async start(provider: string, id: string, owner: string) {
    if (!CHOICES[provider]) throw new ProviderActivationError('UNKNOWN_PROVIDER', 'Unknown subscription provider.', 400);
    const identity = digest(owner + ':' + provider);
    const starting = this.startOwners.get(id);
    if (starting && starting !== identity) throw new ProviderActivationError('OAUTH_NOT_FOUND', 'OAuth session not found.', 404);
    const existing = this.read(id);
    if (existing) {
      this.owned(id, owner);
      if (existing.provider !== provider) throw new ProviderActivationError('OAUTH_OPERATION_MISMATCH', 'This operation already belongs to another provider.');
      return this.status(id, owner);
    }
    this.startOwners.set(id, identity);
    return this.singleFlight(id, async () => {
      await this.fence();
      const catalog = await this.catalog();
      const supported = catalog.providers.find(item => item.id === provider);
      if (!supported?.supported || !supported.authChoice) {
        throw new ProviderActivationError('NATIVE_PROVIDER_AUTH_UNSUPPORTED', supported?.reason || 'Native sign-in is unavailable.');
      }
      const baseline = await this.proof(provider);
      // Existing auth is never overwritten just to make a setup wizard advance.
      if (!baseline.absent) return { success: true, status: 'complete', alreadyAuthenticated: true,
        credentialState: 'preserved', finalized: true, activationRequired: true, transport: 'native-wizard' };
      const claim = claimProviderCredentialLifecycle(getCredentialLifecycleNamespaceForOpenClawProvider(provider), owner, id,
        { lifecycleKind: 'native-provider-prepare', credentialScope: 'combined-domain', baselineFingerprint: baseline.fingerprint });
      const op: Operation = { id, owner: digest(owner), provider, choice: supported.authChoice, claim,
        baseline: baseline.fingerprint, phase: 'starting', answered: [], expires: Date.now() + 120 * 60_000 };
      this.save(op, true);
      bindProviderCredentialLifecycle(claim, id, { binding: { kind: 'attested-processless' }, baselineFingerprint: baseline.fingerprint });
      const result = await this.rpc('openclaw.setup.prepare.start', { sessionId: id, authChoice: op.choice }, 15_000);
      // The native prepare method uses setDefaultModel:false, preservation and
      // the native transactional config writer. auth.start is NOT auth-only.
      op.phase = result.ok ? 'running' : 'recovery';
      this.save(op);
      if (!result.ok) return { sessionId: id, status: 'processing', finalized: false, recoveryRequired: true,
        transport: 'native-wizard', code: 'NATIVE_START_RESPONSE_LOST' };
      return { sessionId: id, status: 'processing', finalized: false, transport: 'native-wizard' };
    }).finally(() => this.startOwners.delete(id));
  }
  async status(id: string, owner: string) {
    const op = this.owned(id, owner);
    return this.singleFlight(id, () => this.next(op));
  }
  private async next(op: Operation, answer?: { stepId: string; value?: unknown }): Promise<any> {
    if (op.phase === 'complete' || op.phase === 'cancelled') return this.terminal(op);
    const result = await this.rpc('wizard.next', { sessionId: op.id, ...(answer ? { answer } : {}) }, 15_000);
    if (!result.ok) {
      // An authoritative native not-found means no wizard still owns this id.
      // Reconcile actual credential state, never replay the login or its answer.
      const missing = result.errorCode === 'INVALID_REQUEST'
        && String(result.errorMessage || result.error || '').toLowerCase().includes('wizard not found');
      if (missing) {
        const proof = await this.proof(op.provider);
        if (proof.fingerprint === op.baseline || !proof.absent) {
          op.phase = proof.fingerprint === op.baseline ? 'cancelled' : 'complete';
          if (op.phase === 'complete') markProviderCredentialLifecycle(op.claim, 'committed');
          this.save(op);
          return { ...this.terminal(op), reconciled: true, interrupted: true };
        }
      }
      // A transport failure has no such authority. Keep the lifecycle fence.
      op.phase = 'recovery';
      this.save(op);
      return { sessionId: op.id, status: 'processing', finalized: false, recoveryRequired: true,
        code: 'NATIVE_WIZARD_RECOVERY_REQUIRED', transport: 'native-wizard' };
    }
    const data = result.data;
    if (data?.done) {
      const proof = await this.proof(op.provider);
      if (data.status === 'done' && !proof.absent) {
        markProviderCredentialLifecycle(op.claim, 'committed');
        op.phase = 'complete';
        this.save(op);
        releaseProviderCredentialLifecycle(op.claim);
        return this.terminal(op);
      }
      if (proof.fingerprint === op.baseline) {
        op.phase = 'cancelled';
        this.save(op);
        releaseProviderCredentialLifecycle(op.claim);
        return this.terminal(op);
      }
      markProviderCredentialLifecycle(op.claim, 'indeterminate');
      op.phase = 'recovery';
      this.save(op);
      return { sessionId: op.id, status: 'error', finalized: false, recoveryRequired: true,
        code: 'NATIVE_WIZARD_RECOVERY_REQUIRED', transport: 'native-wizard' };
    }
    op.phase = 'running';
    this.save(op);
    return { sessionId: op.id, status: 'awaiting_callback', finalized: false,
      transport: 'native-wizard', step: this.publicStep(data?.step), ...(data?.error ? { error: 'The provider did not accept that answer. Check the current step and retry.' } : {}) };
  }
  private publicStep(step: any) {
    if (!step || typeof step.id !== 'string') return undefined;
    // Native wizard sanitizes secret defaults. Do not relay arbitrary nested
    // config or terminal output, and never return a submitted value.
    return Object.fromEntries(['id', 'type', 'title', 'message', 'options', 'sensitive', 'placeholder', 'externalUrl', 'deviceCode']
      .filter(key => step[key] !== undefined).map(key => [key, step[key]]));
  }
  private terminal(op: Operation) {
    releaseProviderCredentialLifecycle(op.claim);
    return { sessionId: op.id, status: op.phase, finalized: op.phase === 'complete',
      credentialState: op.phase === 'complete' ? 'committed' : 'absent', activationRequired: op.phase === 'complete',
      transport: 'native-wizard' };
  }
  async answer(id: string, owner: string, stepId: string, value?: unknown) {
    const op = this.owned(id, owner);
    // Only step ids are persisted. A submitted code/secret never enters the journal.
    return this.singleFlight(id, async () => {
      if (op.answered.includes(stepId)) return this.next(op);
      const current = await this.next(op);
      if (current.step?.id !== stepId) throw new ProviderActivationError('OAUTH_STEP_CHANGED', 'The authorization step changed. Refresh the current step.');
      op.answered.push(stepId);
      this.save(op);
      const result = await this.next(op, { stepId, ...(value !== undefined ? { value } : {}) });
      if (result.error && result.step?.id === stepId) { op.answered = op.answered.filter(id => id !== stepId); this.save(op); }
      return result;
    });
  }
  async cancel(id: string, owner: string) {
    const op = this.owned(id, owner);
    if (op.phase === 'complete' || op.phase === 'cancelled') return this.terminal(op);
    return this.singleFlight(id, async () => {
      const result = await this.rpc('wizard.cancel', { sessionId: id }, 15_000);
      if (result.ok && result.data?.status === 'cancelled') {
        const proof = await this.proof(op.provider);
        if (proof.fingerprint === op.baseline) {
          op.phase = 'cancelled';
          this.save(op);
          releaseProviderCredentialLifecycle(op.claim);
          return this.terminal(op);
        }
      }
      op.phase = 'recovery';
      this.save(op);
      return { sessionId: id, status: 'processing', finalized: false, recoveryRequired: true,
        transport: 'native-wizard', code: 'NATIVE_CANCELLATION_PENDING' };
    });
  }
}
