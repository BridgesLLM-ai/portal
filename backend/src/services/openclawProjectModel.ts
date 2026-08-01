import { execFile } from 'child_process';
import {
  getSessionInfo,
  patchSessionModelWithinMutation,
  withOpenClawSessionMutation,
  type OpenClawSessionCreationDefaults,
} from '../utils/openclawGatewayRpc';
import {
  canonicalizeProviderModelId,
  buildOpenClawCliEnv,
  extractJsonFromCliOutput,
  modelForOpenClawSessionPatch,
  normalizePortalModelId,
  resolvePortalModelFromCatalog,
} from '../utils/openclawCli';

export type OpenClawProjectModelVerificationCode =
  | 'MODEL_INVALID'
  | 'MODEL_UNAVAILABLE'
  | 'MODEL_CATALOG_UNAVAILABLE'
  | 'MODEL_RUNTIME_UNSAFE'
  | 'MODEL_REQUALIFICATION_REQUIRED'
  | 'SESSION_INSPECTION_FAILED'
  | 'SESSION_INSPECTION_STALE'
  | 'MODEL_PATCH_REJECTED'
  | 'MODEL_READBACK_FAILED'
  | 'MODEL_READBACK_MISMATCH'
  | 'MODEL_PERSISTENCE_FAILED';

export type OpenClawProjectModelRollbackStatus =
  | 'NOT_REQUIRED'
  | 'NOT_AVAILABLE'
  | 'CONFIRMED'
  | 'FAILED';

export class OpenClawProjectModelVerificationError extends Error {
  constructor(
    public readonly code: OpenClawProjectModelVerificationCode,
    message: string,
    public readonly causeDetail?: string,
    public readonly rollbackStatus: OpenClawProjectModelRollbackStatus = 'NOT_REQUIRED',
  ) {
    super(message);
    this.name = 'OpenClawProjectModelVerificationError';
  }
}

interface SessionInfoResult {
  ok: boolean;
  data?: any;
  error?: string;
}

interface PatchResult {
  ok: boolean;
  resolved?: { modelProvider: string; model: string };
  error?: string;
}

export interface OpenClawProjectModelDependencies {
  getSessionInfo: (sessionKey: string) => Promise<SessionInfoResult>;
  patchSessionModel: (
    sessionKey: string,
    model: string,
    creationDefaults?: OpenClawSessionCreationDefaults,
  ) => Promise<PatchResult>;
  wait: (milliseconds: number) => Promise<void>;
}

const defaultDependencies: OpenClawProjectModelDependencies = {
  getSessionInfo,
  patchSessionModel: patchSessionModelWithinMutation,
  wait: (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)),
};

const READBACK_DELAYS_MS = [0, 100, 250] as const;

/**
 * Project Chat deliberately supports only provider families whose model turns
 * can be forced through OpenClaw's embedded runner. The alias entries cover
 * pre-normalized gateway/session refs; persisted Portal ids remain canonical.
 */
export const OPENCLAW_PROJECT_EMBEDDED_RUNTIME_MODEL_KEYS = Object.freeze([
  'openai/*',
  'openai-codex/*',
  'codex/*',
  'anthropic/*',
  'google/*',
  'google-antigravity/*',
  'xai/*',
]);

const OPENCLAW_PROJECT_CANONICAL_MODEL_PROVIDERS = new Set([
  'openai',
  'anthropic',
  'google',
  'google-antigravity',
  'xai',
]);

const EXTERNAL_CLI_PROVIDER_IDS = new Set([
  'claude-cli',
  'google-gemini-cli',
  'codex-cli',
]);

export const OPENCLAW_PROJECT_EXECUTION_RUNTIME = 'openclaw-embedded' as const;

export interface OpenClawProjectExecutionBinding {
  model: string;
  executionProviderId: string;
  executionRuntimeKind: typeof OPENCLAW_PROJECT_EXECUTION_RUNTIME;
}

export interface OpenClawProjectModelRuntimeEligibility extends OpenClawProjectExecutionBinding {
  sessionKey: string;
  projectIdentityId: string;
  evidenceFingerprint: string;
  revoke: () => void;
}

const projectRuntimeEligibility = new Map<string, OpenClawProjectModelRuntimeEligibility>();

function normalizedProvider(model: string): string {
  return normalizePortalModelId(model).split('/')[0] || '';
}

export function isOpenClawProjectEmbeddedModel(modelInput: string): boolean {
  return OPENCLAW_PROJECT_CANONICAL_MODEL_PROVIDERS.has(normalizedProvider(modelInput));
}

function unsafeRuntime(message: string, detail?: string): never {
  throw new OpenClawProjectModelVerificationError(
    'MODEL_RUNTIME_UNSAFE',
    message,
    detail,
  );
}

/**
 * Reads the provider/runtime that actually completed a gateway turn. A model
 * catalog entry or requested id is not runtime proof: CLI and plugin harnesses
 * are rejected from the authoritative post-turn session row.
 */
export function readVerifiedOpenClawProjectExecutionBinding(
  session: any,
): OpenClawProjectExecutionBinding {
  if (!session || session.stale === true) {
    return unsafeRuntime(
      'OpenClaw did not return current Project execution metadata.',
      String(session?.staleReason || 'Session metadata was absent'),
    );
  }
  const executionProviderId = String(
    session.modelProvider
    || session.currentModel?.provider
    || session.provider
    || '',
  ).trim().toLowerCase();
  const rawModel = String(
    session.model
    || session.currentModel?.model
    || session.currentModel?.id
    || '',
  ).trim();
  const model = readVerifiedOpenClawSessionModel(session);
  if (!executionProviderId || !model || !isOpenClawProjectEmbeddedModel(model)) {
    return unsafeRuntime(
      'The OpenClaw Project execution provider or model is not eligible for the embedded runtime.',
      `provider=${executionProviderId || 'missing'} model=${model || 'missing'}`,
    );
  }
  if (EXTERNAL_CLI_PROVIDER_IDS.has(executionProviderId) || executionProviderId.endsWith('-cli')) {
    return unsafeRuntime(
      'External CLI execution is not eligible for OpenClaw Project Chat.',
      `provider=${executionProviderId}`,
    );
  }
  const providerBoundModel = canonicalizeProviderModelId(executionProviderId, rawModel);
  if (!providerBoundModel || providerBoundModel !== model) {
    return unsafeRuntime(
      'The OpenClaw Project execution provider did not match the canonical model identity.',
      `provider=${executionProviderId} model=${model} providerModel=${providerBoundModel || 'missing'}`,
    );
  }

  const harness = String(session.agentHarnessId || '').trim().toLowerCase();
  const runtimeOverride = String(session.agentRuntimeOverride || '').trim().toLowerCase();
  const traceRunner = String(session.executionTrace?.runner || '').trim().toLowerCase();
  if ((harness && harness !== 'openclaw')
    || (runtimeOverride && runtimeOverride !== 'openclaw')
    || (traceRunner && traceRunner !== 'openclaw' && traceRunner !== 'embedded')) {
    return unsafeRuntime(
      'The OpenClaw Project turn used an external or unknown agent runtime.',
      `harness=${harness || 'default'} override=${runtimeOverride || 'none'} runner=${traceRunner || 'embedded'}`,
    );
  }

  return Object.freeze({
    model,
    executionProviderId,
    executionRuntimeKind: OPENCLAW_PROJECT_EXECUTION_RUNTIME,
  });
}

export function registerOpenClawProjectModelRuntimeEligibility(
  input: OpenClawProjectModelRuntimeEligibility,
): void {
  const sessionKey = String(input.sessionKey || '').trim();
  const model = normalizePortalModelId(input.model);
  if (!sessionKey || !model || !isOpenClawProjectEmbeddedModel(model)
    || !/^[a-f0-9]{64}$/.test(input.evidenceFingerprint)
    || input.executionRuntimeKind !== OPENCLAW_PROJECT_EXECUTION_RUNTIME
    || !input.executionProviderId.trim()) {
    return unsafeRuntime('OpenClaw Project qualification did not produce a complete runtime binding.');
  }
  projectRuntimeEligibility.set(sessionKey, Object.freeze({
    ...input,
    sessionKey,
    model,
    executionProviderId: input.executionProviderId.trim().toLowerCase(),
  }));
}

export function clearOpenClawProjectModelRuntimeEligibility(sessionKeyInput: string): void {
  projectRuntimeEligibility.delete(String(sessionKeyInput || '').trim());
}

export function clearOpenClawProjectModelRuntimeEligibilityForProject(projectIdentityIdInput: string): void {
  const projectIdentityId = String(projectIdentityIdInput || '').trim();
  for (const [sessionKey, eligibility] of projectRuntimeEligibility) {
    if (eligibility.projectIdentityId === projectIdentityId) projectRuntimeEligibility.delete(sessionKey);
  }
}

function requireRuntimeEligibility(sessionKeyInput: string): OpenClawProjectModelRuntimeEligibility {
  const sessionKey = String(sessionKeyInput || '').trim();
  const eligibility = projectRuntimeEligibility.get(sessionKey);
  if (!eligibility) {
    return unsafeRuntime(
      'A current execution-backed OpenClaw Project qualification is required before selecting a model.',
    );
  }
  return eligibility;
}

function revokeRuntimeEligibility(eligibility: OpenClawProjectModelRuntimeEligibility): void {
  const current = projectRuntimeEligibility.get(eligibility.sessionKey);
  if (current?.evidenceFingerprint === eligibility.evidenceFingerprint) {
    projectRuntimeEligibility.delete(eligibility.sessionKey);
  }
  eligibility.revoke();
}

function isSessionMissing(error: unknown): boolean {
  return /session not found/i.test(String(error || ''));
}

/**
 * Converts the authoritative OpenClaw session row into the Portal's canonical
 * provider/model identity. Runtime names and provider aliases never become
 * part of the persisted model id.
 */
export function readVerifiedOpenClawSessionModel(session: any): string {
  const provider = String(
    session?.modelProvider
    || session?.currentModel?.provider
    || session?.provider
    || '',
  ).trim();
  const rawModel = String(
    session?.model
    || session?.currentModel?.model
    || session?.currentModel?.id
    || '',
  ).trim();
  if (!rawModel) return '';
  return rawModel.includes('/')
    ? normalizePortalModelId(rawModel)
    : canonicalizeProviderModelId(provider, rawModel);
}

export interface VerifiedOpenClawProjectModel {
  model: string;
  runtimeModel: string;
  patched: boolean;
  patchResolvedModel: string | null;
}

export interface OpenClawProjectModelCatalogDependencies {
  listAgentModels: (agentId: string) => Promise<{
    ok: boolean;
    models?: any[];
    error?: string;
  }>;
}

type OpenClawModelCatalogResult = {
  ok: boolean;
  models?: any[];
  error?: string;
};

const OPENCLAW_PROJECT_MODEL_CATALOG_CACHE_MS = 60_000;
const openClawProjectModelCatalogCache = new Map<string, {
  expiresAt: number;
  result: OpenClawModelCatalogResult;
}>();
const openClawProjectModelCatalogFlights = new Map<string, Promise<OpenClawModelCatalogResult>>();

function runOpenClawModelsJson(args: string[]): Promise<{
  ok: boolean;
  data?: any;
  error?: string;
}> {
  return new Promise((resolve) => {
    execFile('/usr/bin/openclaw', ['models', ...args], {
      encoding: 'utf8',
      timeout: 20_000,
      maxBuffer: 8 * 1024 * 1024,
      env: {
        ...buildOpenClawCliEnv(),
        OPENCLAW_AUTH_STORE_READONLY: '1',
      },
    }, (error, stdout, stderr) => {
      if (error) {
        resolve({
          ok: false,
          error: String(stderr || (error as any)?.message || error).trim(),
        });
        return;
      }
      try {
        resolve({
          ok: true,
          data: JSON.parse(extractJsonFromCliOutput(String(stdout || ''))),
        });
      } catch (parseError) {
        resolve({
          ok: false,
          error: parseError instanceof Error ? parseError.message : 'Invalid OpenClaw model catalog JSON',
        });
      }
    });
  });
}

function listOpenClawProjectAgentModels(agentId: string): Promise<OpenClawModelCatalogResult> {
  const cached = openClawProjectModelCatalogCache.get(agentId);
  if (cached && cached.expiresAt > Date.now()) {
    return Promise.resolve(cached.result);
  }
  const existingFlight = openClawProjectModelCatalogFlights.get(agentId);
  if (existingFlight) return existingFlight;

  const flight = (async (): Promise<OpenClawModelCatalogResult> => {
    const [statusResult, catalogResult] = await Promise.all([
      runOpenClawModelsJson(['status', '--agent', agentId, '--json']),
      // Pinned OpenClaw does not scope `models list` to an agent. It is used
      // only as a bounded real-ID inventory; exact policy and auth come from
      // the separately asserted `models status --agent` response.
      runOpenClawModelsJson(['list', '--json']),
    ]);
    if (!statusResult.ok || !catalogResult.ok) {
      return {
        ok: false,
        error: statusResult.error || catalogResult.error || 'OpenClaw model inventory failed',
      };
    }
    const status = statusResult.data;
    if (String(status?.agentId || '').trim() !== agentId) {
      return {
        ok: false,
        error: 'OpenClaw returned a different agent identity',
      };
    }
    const models = availableModelsFromOpenClawAgentStatus(
      status,
      catalogResult.data,
    ).map((key) => ({ key, available: true, missing: false }));
    const result = { ok: true, models };
    openClawProjectModelCatalogCache.set(agentId, {
      expiresAt: Date.now() + OPENCLAW_PROJECT_MODEL_CATALOG_CACHE_MS,
      result,
    });
    return result;
  })().finally(() => {
    if (openClawProjectModelCatalogFlights.get(agentId) === flight) {
      openClawProjectModelCatalogFlights.delete(agentId);
    }
  });
  openClawProjectModelCatalogFlights.set(agentId, flight);
  return flight;
}

function normalizedCatalogProvider(value: unknown): string {
  return normalizePortalModelId(`${String(value || '').trim()}/placeholder`)
    .split('/')[0] || '';
}

/**
 * `models.list` is default-agent scoped in the pinned OpenClaw 2026.7.1
 * protocol. `models status --agent` is the supported exact-agent read path.
 * Convert its allowed-model and auth-health evidence into a fail-closed list.
 */
export function availableModelsFromOpenClawAgentStatus(
  statusInput: unknown,
  boundedCatalogInput: unknown = [],
): string[] {
  const status = statusInput && typeof statusInput === 'object' && !Array.isArray(statusInput)
    ? statusInput as Record<string, any>
    : null;
  if (!status || !Array.isArray(status.allowed)) return [];
  const auth = status.auth && typeof status.auth === 'object' && !Array.isArray(status.auth)
    ? status.auth as Record<string, any>
    : {};
  const externalCredentialProviderIds = new Set([
    'claude-cli',
    'codex',
    'codex-cli',
    'google-gemini-cli',
    'openai-codex',
  ]);
  const providerRows = new Map<string, Record<string, any>[]>();
  for (const raw of Array.isArray(auth.providers) ? auth.providers : []) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) continue;
    const provider = normalizedCatalogProvider(raw.provider);
    if (!provider) continue;
    providerRows.set(provider, [...(providerRows.get(provider) || []), raw]);
  }
  const usableDirectProfileProviders = new Set<string>();
  for (const raw of Array.isArray(auth.oauth?.providers) ? auth.oauth.providers : []) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) continue;
    const rawProvider = String(raw.provider || '').trim().toLowerCase();
    if (externalCredentialProviderIds.has(rawProvider)) continue;
    const provider = normalizedCatalogProvider(raw.provider);
    if (!provider) continue;
    for (const profile of Array.isArray(raw.effectiveProfiles) ? raw.effectiveProfiles : []) {
      if (!profile || typeof profile !== 'object' || Array.isArray(profile)) continue;
      const profileId = String(profile.profileId || '').trim();
      const [profileProviderId, ...profileNameParts] = profileId.split(':');
      const profileName = profileNameParts.join(':').trim().toLowerCase();
      if (
        externalCredentialProviderIds.has(profileProviderId.trim().toLowerCase())
        || /(?:^|[-_/])(claude-cli|codex-cli|gemini-cli)(?:$|[-_/])/u.test(profileName)
      ) {
        continue;
      }
      const profileProvider = normalizedCatalogProvider(profileProviderId);
      const statusValue = String(profile.status || '').trim().toLowerCase();
      if (
        profileProvider === provider
        && ['ok', 'expiring', 'static'].includes(statusValue)
      ) {
        usableDirectProfileProviders.add(provider);
      }
    }
  }
  const providerIsUsable = (provider: string): boolean => {
    if (usableDirectProfileProviders.has(provider)) return true;
    return (providerRows.get(provider) || []).some((row) => {
      const rawProvider = String(row.provider || '').trim().toLowerCase();
      if (externalCredentialProviderIds.has(rawProvider)) return false;
      const effectiveKind = String(row.effective?.kind || '').trim().toLowerCase();
      const effectiveDetail = String(row.effective?.detail || '').trim().toLowerCase();
      if (effectiveDetail.startsWith('marker(')) return false;
      return ['env', 'models.json', 'modelsjson', 'synthetic'].includes(effectiveKind);
    });
  };

  const boundedCatalogRows = Array.isArray(boundedCatalogInput)
    ? boundedCatalogInput
    : boundedCatalogInput && typeof boundedCatalogInput === 'object' && !Array.isArray(boundedCatalogInput)
      ? (boundedCatalogInput as Record<string, unknown>).models
      : [];
  if (!Array.isArray(boundedCatalogRows) || boundedCatalogRows.length > 2_048) return [];
  const inventoryModelIds: string[] = [];
  const inventoryModelSet = new Set<string>();
  const addInventoryModel = (rawInput: unknown) => {
    const raw = String(rawInput || '').trim();
    if (!raw || raw.includes('*')) return;
    const rawProvider = raw.split('/')[0]?.trim().toLowerCase() || '';
    if (externalCredentialProviderIds.has(rawProvider)) return;
    const model = normalizePortalModelId(raw);
    if (!model || !isOpenClawProjectEmbeddedModel(model) || inventoryModelSet.has(model)) return;
    inventoryModelSet.add(model);
    inventoryModelIds.push(model);
  };
  for (const raw of boundedCatalogRows) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw) || raw.missing === true) continue;
    addInventoryModel(raw.key || raw.id);
  }

  const boundedModelIds: string[] = [];
  const boundedModelSet = new Set<string>();
  const addBoundedModel = (rawInput: unknown) => {
    const model = normalizePortalModelId(String(rawInput || '').trim());
    if (
      !model
      || !inventoryModelSet.has(model)
      || boundedModelSet.has(model)
    ) {
      return;
    }
    boundedModelSet.add(model);
    boundedModelIds.push(model);
  };
  addBoundedModel(status.resolvedDefault);
  addBoundedModel(status.defaultModel);
  for (const raw of Array.isArray(status.fallbacks) ? status.fallbacks : []) addBoundedModel(raw);
  for (const raw of Object.values(
    status.aliases && typeof status.aliases === 'object' && !Array.isArray(status.aliases)
      ? status.aliases
      : {},
  )) addBoundedModel(raw);
  for (const raw of status.allowed) {
    if (!String(raw || '').includes('*')) addBoundedModel(raw);
  }
  for (const model of inventoryModelIds) addBoundedModel(model);

  const selectedModels: string[] = [];
  const selectedSet = new Set<string>();
  const select = (model: string) => {
    if (selectedSet.has(model) || !providerIsUsable(model.split('/')[0] || '')) return;
    selectedSet.add(model);
    selectedModels.push(model);
  };
  if (status.allowed.length === 0) {
    for (const model of boundedModelIds) select(model);
    return selectedModels;
  }
  for (const rawRule of status.allowed) {
    const rule = String(rawRule || '').trim();
    const wildcard = /^([^/*]+)\/\*$/u.exec(rule);
    if (wildcard) {
      const provider = normalizedCatalogProvider(wildcard[1]);
      for (const model of boundedModelIds) {
        if ((model.split('/')[0] || '') === provider) select(model);
      }
      continue;
    }
    if (rule.includes('*')) continue;
    const model = normalizePortalModelId(rule);
    if (boundedModelSet.has(model)) select(model);
  }
  return selectedModels;
}

const defaultCatalogDependencies: OpenClawProjectModelCatalogDependencies = {
  listAgentModels: listOpenClawProjectAgentModels,
};

function normalizeGatewayModelIds(models: any[] | undefined): string[] {
  const ids = new Set<string>();
  for (const model of Array.isArray(models) ? models : []) {
    if (
      model
      && typeof model === 'object'
      && (model.available === false || model.missing === true)
    ) {
      continue;
    }
    const direct = typeof model === 'string'
      ? model
      : String(model?.key || model?.id || model?.name || '').trim();
    const provider = typeof model?.provider === 'string' ? model.provider.trim() : '';
    const nestedModel = typeof model?.model === 'string'
      ? model.model.trim()
      : typeof model?.id === 'string'
        ? model.id.trim()
        : '';
    const normalizedDirect = normalizePortalModelId(direct);
    if (normalizedDirect) ids.add(normalizedDirect);
    const canonical = canonicalizeProviderModelId(provider, nestedModel || direct);
    if (canonical) ids.add(canonical);
  }
  return Array.from(ids);
}

function normalizeOpenClawProjectAgentId(agentIdInput: string): string {
  const agentId = String(agentIdInput || '').trim();
  if (!/^[a-z0-9][a-z0-9_-]{0,127}$/u.test(agentId)) {
    throw new OpenClawProjectModelVerificationError(
      'MODEL_CATALOG_UNAVAILABLE',
      'The dedicated OpenClaw Project agent identity is unavailable.',
    );
  }
  return agentId;
}

export async function listAvailableOpenClawProjectModels(
  agentIdInput: string,
  dependencies: OpenClawProjectModelCatalogDependencies = defaultCatalogDependencies,
): Promise<string[]> {
  const agentId = normalizeOpenClawProjectAgentId(agentIdInput);
  let listed: Awaited<ReturnType<OpenClawProjectModelCatalogDependencies['listAgentModels']>>;
  try {
    listed = await dependencies.listAgentModels(agentId);
  } catch (error) {
    listed = { ok: false, error: String(error || 'Model catalog request failed') };
  }
  if (!listed.ok) {
    throw new OpenClawProjectModelVerificationError(
      'MODEL_CATALOG_UNAVAILABLE',
      'The dedicated OpenClaw Project agent model catalog is unavailable.',
      String(listed.error || 'No live models were returned'),
    );
  }
  const availableModels = normalizeGatewayModelIds(listed.models)
    .filter(isOpenClawProjectEmbeddedModel);
  if (availableModels.length === 0) {
    throw new OpenClawProjectModelVerificationError(
      'MODEL_UNAVAILABLE',
      'The dedicated OpenClaw Project agent has no available embedded model.',
    );
  }
  return availableModels;
}

/**
 * Resolves a Project model against the live gateway catalog.
 *
 * An explicit choice is never silently replaced. When no explicit choice was
 * supplied, an existing verified binding/default may be used as the seed for
 * the later live session challenge.
 */
export async function resolveAllowedOpenClawProjectModel(
  agentIdInput: string,
  candidates: string[],
  requestedModelInput = '',
  dependencies: OpenClawProjectModelCatalogDependencies = defaultCatalogDependencies,
): Promise<{ model: string; warning?: string }> {
  const normalizedCandidates = candidates
    .map((candidate) => normalizePortalModelId(candidate))
    .filter((candidate) => Boolean(candidate) && isOpenClawProjectEmbeddedModel(candidate));
  const requestedModel = normalizePortalModelId(requestedModelInput);
  if (String(requestedModelInput || '').trim() && !requestedModel) {
    throw new OpenClawProjectModelVerificationError(
      'MODEL_INVALID',
      'The requested Project model identity is invalid.',
    );
  }
  if (requestedModel && !isOpenClawProjectEmbeddedModel(requestedModel)) {
    throw new OpenClawProjectModelVerificationError(
      'MODEL_RUNTIME_UNSAFE',
      'The requested Project model cannot be forced through OpenClaw embedded execution.',
      `model=${requestedModel}`,
    );
  }

  const availableModels = await listAvailableOpenClawProjectModels(agentIdInput, dependencies);

  if (requestedModel) {
    const resolved = resolvePortalModelFromCatalog(requestedModel, availableModels);
    if (!resolved) {
      throw new OpenClawProjectModelVerificationError(
        'MODEL_UNAVAILABLE',
        `The requested Project model ${requestedModel} is not available in the live OpenClaw catalog.`,
      );
    }
    return { model: resolved };
  }

  for (const candidate of normalizedCandidates) {
    const resolved = resolvePortalModelFromCatalog(candidate, availableModels);
    if (resolved) return { model: resolved };
  }
  return { model: availableModels[0] };
}

interface ModelReadback {
  confirmed: boolean;
  model: string;
  error: string;
}

function assertExecutionBindingMatchesEligibility(
  session: any,
  eligibility: OpenClawProjectModelRuntimeEligibility,
): void {
  let observed: OpenClawProjectExecutionBinding;
  try {
    observed = readVerifiedOpenClawProjectExecutionBinding(session);
  } catch (error) {
    revokeRuntimeEligibility(eligibility);
    throw error;
  }
  if (observed.model !== eligibility.model
    || observed.executionProviderId !== eligibility.executionProviderId
    || observed.executionRuntimeKind !== eligibility.executionRuntimeKind) {
    revokeRuntimeEligibility(eligibility);
    throw new OpenClawProjectModelVerificationError(
      'MODEL_REQUALIFICATION_REQUIRED',
      'The active OpenClaw Project model/runtime no longer matches its execution-backed qualification. Qualify it again.',
      `qualified=${eligibility.executionProviderId}/${eligibility.executionRuntimeKind}/${eligibility.model} `
        + `active=${observed.executionProviderId}/${observed.executionRuntimeKind}/${observed.model}`,
    );
  }
}

function assertExecutionProviderMatchesEligibility(
  session: any,
  eligibility: OpenClawProjectModelRuntimeEligibility,
): void {
  let observed: OpenClawProjectExecutionBinding;
  try {
    observed = readVerifiedOpenClawProjectExecutionBinding(session);
  } catch (error) {
    revokeRuntimeEligibility(eligibility);
    throw error;
  }
  if (observed.executionProviderId !== eligibility.executionProviderId
    || observed.executionRuntimeKind !== eligibility.executionRuntimeKind
    || normalizedProvider(observed.model) !== eligibility.executionProviderId) {
    revokeRuntimeEligibility(eligibility);
    throw new OpenClawProjectModelVerificationError(
      'MODEL_REQUALIFICATION_REQUIRED',
      'The active OpenClaw Project execution provider no longer matches its qualification. Qualify it again.',
      `qualified=${eligibility.executionProviderId}/${eligibility.executionRuntimeKind} `
        + `active=${observed.executionProviderId}/${observed.executionRuntimeKind}/${observed.model}`,
    );
  }
}

async function readBackExactModel(
  sessionKey: string,
  expectedModel: string,
  dependencies: OpenClawProjectModelDependencies,
  eligibility?: OpenClawProjectModelRuntimeEligibility,
): Promise<ModelReadback> {
  let lastError = '';
  let lastModel = '';
  for (const delayMs of READBACK_DELAYS_MS) {
    if (delayMs > 0) await dependencies.wait(delayMs);
    const readback = await dependencies.getSessionInfo(sessionKey);
    if (!readback.ok) {
      lastError = String(readback.error || 'Session metadata was unavailable');
      continue;
    }
    if (readback.data?.stale) {
      return {
        confirmed: false,
        model: '',
        error: String(readback.data?.staleReason || 'Gateway returned stale session metadata'),
      };
    }
    if (eligibility) assertExecutionBindingMatchesEligibility(readback.data, eligibility);
    lastModel = readVerifiedOpenClawSessionModel(readback.data);
    if (lastModel === expectedModel) {
      return { confirmed: true, model: lastModel, error: '' };
    }
  }
  return { confirmed: false, model: lastModel, error: lastError };
}

async function rollbackOpenClawProjectModel(
  input: {
    sessionKey: string;
    activeBefore: string;
    rollbackRuntimeModel: string;
  },
  dependencies: OpenClawProjectModelDependencies,
): Promise<{ status: OpenClawProjectModelRollbackStatus; detail: string }> {
  if (!input.activeBefore) {
    return {
      status: 'NOT_AVAILABLE',
      detail: 'No prior live model was available for rollback.',
    };
  }
  const rollback = await dependencies.patchSessionModel(
    input.sessionKey,
    input.rollbackRuntimeModel || input.activeBefore,
  );
  if (!rollback.ok) {
    return {
      status: 'FAILED',
      detail: `Rollback patch was rejected: ${String(rollback.error || 'unknown error')}`,
    };
  }
  const readback = await readBackExactModel(input.sessionKey, input.activeBefore, dependencies);
  if (!readback.confirmed) {
    return {
      status: 'FAILED',
      detail: readback.model
        ? `Rollback readback reported ${readback.model}.`
        : `Rollback readback failed: ${readback.error || 'active model unavailable'}`,
    };
  }
  return {
    status: 'CONFIRMED',
    detail: 'Rollback readback matched the previous verified model.',
  };
}

function rollbackMessage(status: OpenClawProjectModelRollbackStatus): string {
  if (status === 'CONFIRMED') {
    return ' OpenClaw confirmed that the previous verified model was restored.';
  }
  if (status === 'NOT_AVAILABLE') {
    return ' No previous runtime model was available to restore; provider re-verification is required.';
  }
  return ' The previous runtime model could not be restored and verified; provider re-verification is required.';
}

/**
 * Establishes an exact, live model identity for an OpenClaw Project session.
 *
 * A requested model is not considered active because sessions.patch returned
 * success. The gateway session is read back and must report the exact
 * canonical model. Stale local-registry fallbacks are deliberately rejected.
 */
interface OpenClawProjectModelActivation {
  verified: VerifiedOpenClawProjectModel;
  rollback: {
    activeBefore: string;
    rollbackRuntimeModel: string;
  } | null;
}

async function activateVerifiedOpenClawProjectModelWithinMutation(
  input: {
    sessionKey: string;
    desiredModel: string;
  },
  dependencies: OpenClawProjectModelDependencies = defaultDependencies,
  eligibility?: OpenClawProjectModelRuntimeEligibility,
  verifyEligibilityAfterPatch = true,
): Promise<OpenClawProjectModelActivation> {
  const desiredModel = normalizePortalModelId(input.desiredModel);
  if (!desiredModel || !desiredModel.includes('/')) {
    throw new OpenClawProjectModelVerificationError(
      'MODEL_INVALID',
      'The requested Project model identity is invalid.',
    );
  }

  const before = await dependencies.getSessionInfo(input.sessionKey);
  if (before.ok && before.data?.stale) {
    throw new OpenClawProjectModelVerificationError(
      'SESSION_INSPECTION_STALE',
      'OpenClaw returned stale Project session metadata; the model was not changed.',
      String(before.data?.staleReason || ''),
    );
  }
  if (!before.ok && !isSessionMissing(before.error)) {
    throw new OpenClawProjectModelVerificationError(
      'SESSION_INSPECTION_FAILED',
      'OpenClaw could not verify the current Project session; the model was not changed.',
      String(before.error || ''),
    );
  }
  if (before.ok && eligibility) {
    if (verifyEligibilityAfterPatch) {
      assertExecutionBindingMatchesEligibility(before.data, eligibility);
    } else {
      assertExecutionProviderMatchesEligibility(before.data, eligibility);
    }
  }

  const activeBefore = before.ok ? readVerifiedOpenClawSessionModel(before.data) : '';
  const runtimeModel = before.ok
    ? modelForOpenClawSessionPatch(before.data, desiredModel)
    : desiredModel;
  const rollbackRuntimeModel = before.ok && activeBefore
    ? modelForOpenClawSessionPatch(before.data, activeBefore) || activeBefore
    : '';
  if (activeBefore === desiredModel) {
    return {
      verified: {
        model: activeBefore,
        runtimeModel,
        patched: false,
        patchResolvedModel: null,
      },
      rollback: null,
    };
  }

  // A missing Project session is materialized by this single gateway
  // projection. Model + presentation defaults therefore become visible
  // atomically before the first send; an existing session (including an
  // explicit reasoning=off choice) receives no default fields.
  const patch = before.ok
    ? await dependencies.patchSessionModel(input.sessionKey, runtimeModel || desiredModel)
    : await dependencies.patchSessionModel(
      input.sessionKey,
      runtimeModel || desiredModel,
      { thinkingLevel: 'high', reasoningLevel: 'stream' },
    );
  if (!patch.ok) {
    throw new OpenClawProjectModelVerificationError(
      'MODEL_PATCH_REJECTED',
      'OpenClaw rejected the Project model change; the previous verified model remains selected.',
      String(patch.error || ''),
    );
  }
  const patchResolvedModel = patch.resolved
    ? readVerifiedOpenClawSessionModel(patch.resolved)
    : '';

  const readback = await readBackExactModel(
    input.sessionKey,
    desiredModel,
    dependencies,
    verifyEligibilityAfterPatch ? eligibility : undefined,
  );
  if (readback.confirmed) {
    return {
      verified: {
        model: readback.model,
        runtimeModel,
        patched: true,
        patchResolvedModel: patchResolvedModel || null,
      },
      rollback: {
        activeBefore,
        rollbackRuntimeModel,
      },
    };
  }

  const rollback = await rollbackOpenClawProjectModel({
    sessionKey: input.sessionKey,
    activeBefore,
    rollbackRuntimeModel,
  }, dependencies);
  const rollbackDetail = `${rollback.detail} Initial readback: ${readback.error || readback.model || 'unavailable'}`;
  if (!readback.model) {
    throw new OpenClawProjectModelVerificationError(
      'MODEL_READBACK_FAILED',
      `OpenClaw did not confirm the Project model change.${rollbackMessage(rollback.status)}`,
      rollbackDetail,
      rollback.status,
    );
  }
  throw new OpenClawProjectModelVerificationError(
    'MODEL_READBACK_MISMATCH',
    `OpenClaw activated a different Project model than requested; the change was not recorded.${rollbackMessage(rollback.status)}`,
    `requested=${desiredModel} active=${readback.model}; ${rollbackDetail}`,
    rollback.status,
  );
}

async function activateVerifiedOpenClawProjectModel(
  input: {
    sessionKey: string;
    desiredModel: string;
  },
  dependencies: OpenClawProjectModelDependencies = defaultDependencies,
  eligibility?: OpenClawProjectModelRuntimeEligibility,
  verifyEligibilityAfterPatch = true,
): Promise<OpenClawProjectModelActivation> {
  return withOpenClawSessionMutation(input.sessionKey, () => (
    activateVerifiedOpenClawProjectModelWithinMutation(
      input,
      dependencies,
      eligibility,
      verifyEligibilityAfterPatch,
    )
  ));
}

export async function ensureVerifiedOpenClawProjectModel(
  input: {
    sessionKey: string;
    desiredModel: string;
  },
  dependencies: OpenClawProjectModelDependencies = defaultDependencies,
): Promise<VerifiedOpenClawProjectModel> {
  return (await activateVerifiedOpenClawProjectModel(input, dependencies)).verified;
}

/**
 * Keeps Portal persistence behind the live verification boundary. Callers
 * provide the database mutation so a rejected or uncertain runtime change
 * cannot overwrite the last verified binding.
 */
export async function verifyThenPersistOpenClawProjectModel<T>(
  input: {
    sessionKey: string;
    desiredModel: string;
    persistVerifiedModel: (model: string) => Promise<T>;
    failProviderClosed?: (input: {
      rollbackStatus: OpenClawProjectModelRollbackStatus;
      detail: string;
    }) => Promise<void>;
  },
  dependencies: OpenClawProjectModelDependencies = defaultDependencies,
): Promise<{ verified: VerifiedOpenClawProjectModel; persisted: T }> {
  const desiredModel = normalizePortalModelId(input.desiredModel);
  const eligibility = requireRuntimeEligibility(input.sessionKey);
  if (!desiredModel || !isOpenClawProjectEmbeddedModel(desiredModel)) {
    revokeRuntimeEligibility(eligibility);
    throw new OpenClawProjectModelVerificationError(
      'MODEL_RUNTIME_UNSAFE',
      'The requested OpenClaw Project model is not eligible for embedded execution.',
      `model=${desiredModel || 'invalid'}`,
    );
  }
  if (desiredModel !== eligibility.model) {
    if (normalizedProvider(desiredModel) !== eligibility.executionProviderId) {
      throw new OpenClawProjectModelVerificationError(
        'MODEL_RUNTIME_UNSAFE',
        'The selected model uses a different execution provider from this Project qualification.',
        `qualifiedProvider=${eligibility.executionProviderId} requestedModel=${desiredModel}`,
      );
    }
  }
  let activation: OpenClawProjectModelActivation;
  try {
    activation = await activateVerifiedOpenClawProjectModel({
      sessionKey: input.sessionKey,
      desiredModel,
    }, dependencies, eligibility, false);
  } catch (error) {
    if (
      error instanceof OpenClawProjectModelVerificationError
      && ['FAILED', 'NOT_AVAILABLE'].includes(error.rollbackStatus)
    ) {
      revokeRuntimeEligibility(eligibility);
    }
    throw error;
  }

  {
    const postPatch = await dependencies.getSessionInfo(input.sessionKey);
    let postPatchBinding: OpenClawProjectExecutionBinding | null = null;
    let unsafeDetail = '';
    if (!postPatch.ok) {
      unsafeDetail = String(postPatch.error || 'Session metadata was unavailable');
    } else {
      try {
        postPatchBinding = readVerifiedOpenClawProjectExecutionBinding(postPatch.data);
      } catch (error) {
        unsafeDetail = error instanceof OpenClawProjectModelVerificationError
          ? String(error.causeDetail || error.message)
          : String(error || 'Runtime binding was invalid');
      }
    }
    if (
      !postPatchBinding
      || postPatchBinding.model !== desiredModel
      || postPatchBinding.executionProviderId !== eligibility.executionProviderId
      || postPatchBinding.executionRuntimeKind !== eligibility.executionRuntimeKind
    ) {
      const rollback = activation.rollback
        ? await rollbackOpenClawProjectModel({
          sessionKey: input.sessionKey,
          activeBefore: activation.rollback.activeBefore,
          rollbackRuntimeModel: activation.rollback.rollbackRuntimeModel,
        }, dependencies)
        : {
          status: 'NOT_AVAILABLE' as const,
          detail: 'No prior live model was available for rollback.',
        };
      if (rollback.status !== 'CONFIRMED') revokeRuntimeEligibility(eligibility);
      throw new OpenClawProjectModelVerificationError(
        'MODEL_RUNTIME_UNSAFE',
        `OpenClaw did not preserve the qualified embedded execution provider for this model change.${rollbackMessage(rollback.status)}`,
        unsafeDetail
          || `qualified=${eligibility.executionProviderId}/${eligibility.executionRuntimeKind} `
            + `active=${postPatchBinding?.executionProviderId || 'missing'}/`
            + `${postPatchBinding?.executionRuntimeKind || 'missing'}/${postPatchBinding?.model || 'missing'}`,
        rollback.status,
      );
    }
  }

  try {
    const persisted = await input.persistVerifiedModel(activation.verified.model);
    registerOpenClawProjectModelRuntimeEligibility({
      ...eligibility,
      model: activation.verified.model,
    });
    return { verified: activation.verified, persisted };
  } catch (persistenceError) {
    let rollback: { status: OpenClawProjectModelRollbackStatus; detail: string } = {
      status: 'NOT_REQUIRED',
      detail: 'The live model was already active, so no runtime rollback was required.',
    };
    if (activation.verified.patched && activation.rollback) {
      rollback = await rollbackOpenClawProjectModel({
        sessionKey: input.sessionKey,
        activeBefore: activation.rollback.activeBefore,
        rollbackRuntimeModel: activation.rollback.rollbackRuntimeModel,
      }, dependencies);
    }

    let closeFailure = '';
    if (activation.verified.patched && rollback.status !== 'CONFIRMED' && input.failProviderClosed) {
      try {
        await input.failProviderClosed({
          rollbackStatus: rollback.status,
          detail: rollback.detail,
        });
      } catch (error) {
        closeFailure = ` Provider close failed: ${String(error || 'unknown error')}`;
      }
    }
    if (activation.verified.patched && rollback.status !== 'CONFIRMED') {
      revokeRuntimeEligibility(eligibility);
    }

    const persistenceDetail = String(
      persistenceError instanceof Error ? persistenceError.message : persistenceError || 'unknown persistence error',
    );
    throw new OpenClawProjectModelVerificationError(
      'MODEL_PERSISTENCE_FAILED',
      activation.verified.patched
        ? `Portal could not save the verified Project model change.${rollbackMessage(rollback.status)}`
        : 'Portal could not save the verified Project model binding. The live model was not changed.',
      `Persistence failed: ${persistenceDetail}. ${rollback.detail}${closeFailure}`,
      rollback.status,
    );
  }
}
