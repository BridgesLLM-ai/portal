import { canonicalizePortalModelId } from '../../utils/modelId';
import type { ModelTier } from './providerConfig';

/**
 * Frontend contract for the OpenClaw-native provider sign-in wizard and the
 * readiness-aware model discovery routes. Every parser here fails loudly on a
 * malformed payload instead of rendering a success the server did not report.
 *
 * Server routes (all under the ai-setup base):
 *   GET  /oauth/providers          → which OAuth/device providers the installed
 *                                    OpenClaw can sign in, with reasons for the rest
 *   POST /oauth/start              → { sessionId, transport: 'native-wizard', status, step? }
 *                                    or, when a credential already exists,
 *                                    { status: 'complete', alreadyAuthenticated: true,
 *                                      credentialState: 'preserved' } with no session
 *   GET  /oauth/status/:sessionId  → { status, finalized, step, error?, recoveryRequired?, code? }
 *   POST /oauth/answer             → { sessionId, stepId, value? }
 *   GET  /models?provider&refresh=1→ canonical refs with readiness + registered
 *   POST /register-models          → { provider, models }
 *   POST /set-default-model        → { model, provider? }
 */

export const NATIVE_WIZARD_TRANSPORT = 'native-wizard';

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function readText(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed || null;
}

// ── /oauth/providers ────────────────────────────────────────────────────────

export interface OAuthProviderSupport {
  id: string;
  supported: boolean;
  transport: string | null;
  methods: string[];
  /** Native auth choice the server will run (for example `openai`, `xai-oauth`). */
  authChoice: string | null;
  /** Native method kind, when reported (`oauth` or `device-code`). */
  mode: string | null;
  code: string | null;
  reason: string | null;
  documentationUrl: string | null;
}

export function parseOAuthProviderSupport(payload: unknown): OAuthProviderSupport[] {
  if (!isRecord(payload) || !Array.isArray(payload.providers)) {
    throw new Error('OAuth provider support response is malformed');
  }
  return payload.providers.map((row) => {
    if (!isRecord(row) || !readText(row.id) || typeof row.supported !== 'boolean') {
      throw new Error('OAuth provider support response contains an invalid provider');
    }
    const mode = readText(row.mode);
    const methods = Array.isArray(row.methods)
      ? row.methods.filter((method): method is string => typeof method === 'string')
      : (mode ? [mode] : []);
    return {
      id: String(row.id).trim(),
      supported: row.supported,
      transport: readText(row.transport),
      methods,
      authChoice: readText(row.authChoice),
      mode,
      code: readText(row.code),
      reason: readText(row.reason),
      documentationUrl: readText(row.documentationUrl),
    };
  });
}

// ── wizard steps and sessions ───────────────────────────────────────────────

export interface WizardStepOption {
  value: string;
  label: string;
  description: string | null;
}

/**
 * Native hosted wizard step kinds. `progress` steps expect no answer (the
 * runner advances them itself); `confirm` expects a boolean; `multiselect`
 * expects a string array. Unknown kinds fall back to a text answer.
 */
export type WizardStepType = 'note' | 'select' | 'multiselect' | 'text' | 'confirm' | 'progress' | 'link' | string;

export interface WizardStep {
  id: string;
  type: WizardStepType;
  title: string;
  message: string | null;
  options: WizardStepOption[];
  sensitive: boolean;
  placeholder: string | null;
  url: string | null;
}

export function readWizardStep(value: unknown): WizardStep | null {
  if (!isRecord(value)) return null;
  const id = readText(value.id);
  const type = readText(value.type);
  if (!id || !type) return null;
  const options: WizardStepOption[] = Array.isArray(value.options)
    ? value.options.flatMap((option) => {
      if (typeof option === 'string') return [{ value: option, label: option, description: null }];
      if (!isRecord(option)) return [];
      const optionValue = readText(option.value) ?? readText(option.id);
      if (!optionValue) return [];
      return [{
        value: optionValue,
        label: readText(option.label) || optionValue,
        // Native select options carry `hint`; older payloads used `description`.
        description: readText(option.description) ?? readText(option.hint),
      }];
    })
    : [];
  return {
    id,
    type,
    title: readText(value.title) || id,
    message: readText(value.message),
    options,
    sensitive: value.sensitive === true,
    placeholder: readText(value.placeholder),
    url: sanitizeHttpsUrl(value.url) ?? sanitizeHttpsUrl(value.externalUrl),
  };
}

/** The answer shape a step expects. Portal never guesses a value for a step. */
export function wizardStepAnswerKind(step: WizardStep): 'none' | 'select' | 'multiselect' | 'confirm' | 'text' {
  if (step.type === 'progress' || step.type === 'note' || step.type === 'link') return 'none';
  if (step.type === 'confirm') return 'confirm';
  if (step.type === 'multiselect') return 'multiselect';
  if (step.type === 'select' && step.options.length > 0) return 'select';
  if (step.type === 'select') return 'none';
  return 'text';
}

export type WizardStatus = 'pending' | 'processing' | 'awaiting_input' | 'awaiting_callback' | 'complete' | 'error' | 'failed' | 'expired' | 'cancelled' | string;

export interface WizardSession {
  sessionId: string | null;
  transport: string | null;
  status: WizardStatus;
  finalized: boolean | null;
  step: WizardStep | null;
  error: string | null;
  code: string | null;
  finalizationWarning: string | null;
  credentialState: 'absent' | 'committed' | 'preserved' | 'indeterminate' | null;
  /** The server found an existing credential and kept it instead of signing in again. */
  alreadyAuthenticated: boolean;
  /** The server is reconciling a lost native response; the session is retained, not failed. */
  recoveryRequired: boolean;
  cleanupPending: boolean;
}

export function readWizardSession(payload: unknown): WizardSession {
  const record = isRecord(payload) ? payload : {};
  const credentialState = readText(record.credentialState);
  return {
    sessionId: readText(record.sessionId),
    transport: readText(record.transport),
    status: readText(record.status) || 'pending',
    finalized: typeof record.finalized === 'boolean' ? record.finalized : null,
    step: readWizardStep(record.step),
    error: readText(record.error),
    code: readText(record.code),
    finalizationWarning: readText(record.finalizationWarning),
    credentialState: credentialState === 'absent' || credentialState === 'committed' || credentialState === 'preserved' || credentialState === 'indeterminate'
      ? credentialState
      : null,
    alreadyAuthenticated: record.alreadyAuthenticated === true,
    recoveryRequired: record.recoveryRequired === true,
    cleanupPending: record.cleanupPending === true,
  };
}

export const TERMINAL_WIZARD_STATUSES: ReadonlySet<string> = new Set(['complete', 'error', 'failed', 'expired', 'cancelled']);

export function isWizardTerminal(status: WizardStatus): boolean {
  return TERMINAL_WIZARD_STATUSES.has(status);
}

/**
 * Signed in means the server reported a finalized completion and did not say
 * the credential is absent. A preserved existing credential (no new session)
 * counts: the login exists and the next step is model activation.
 */
export function isWizardSignedIn(session: WizardSession): boolean {
  return session.status === 'complete' && session.finalized === true
    && session.credentialState !== 'absent' && session.credentialState !== 'indeterminate'
    && !session.recoveryRequired && !session.cleanupPending;
}

export function sanitizeHttpsUrl(value: unknown): string | null {
  const text = readText(value);
  if (!text) return null;
  try {
    const url = new URL(text);
    return url.protocol === 'https:' && !url.username && !url.password ? url.toString() : null;
  } catch {
    return null;
  }
}

/** Extract https URLs from a wizard message so they can be rendered as links. */
export function extractHttpsUrls(text: string | null): string[] {
  if (!text) return [];
  const matches = text.match(/https:\/\/[^\s<>"')\]]+/g) || [];
  return Array.from(new Set(matches.map((match) => sanitizeHttpsUrl(match)).filter((url): url is string => Boolean(url))));
}

// ── model discovery ─────────────────────────────────────────────────────────

export type ModelReadiness = 'ready' | 'unavailable' | 'unknown';

export interface DiscoveredModel {
  id: string;
  name: string;
  description: string | null;
  tier?: ModelTier;
  readiness: ModelReadiness;
  registered: boolean;
  runtime: string | null;
  reason: string | null;
}

export interface ModelDiscovery {
  models: DiscoveredModel[];
  source: string;
  runtime: string | null;
  warnings: string[];
  /** True when readiness came from the server rather than being inferred from the legacy source label. */
  readinessReported: boolean;
}

function readReadiness(value: unknown): ModelReadiness | null {
  if (value === 'ready' || value === 'unavailable' || value === 'unknown') return value;
  if (isRecord(value)) return readReadiness(value.state);
  return null;
}

/**
 * Parse a `/models` response. Newer servers report per-model `readiness` and
 * `registered`. Older servers only report a `source`: live gateway/CLI catalogs
 * are the registered runtime list, while `defaults` are Portal presets and are
 * never treated as proof of credentials or entitlement.
 */
export function parseModelDiscovery(payload: unknown): ModelDiscovery {
  if (!isRecord(payload) || !Array.isArray(payload.models)) {
    throw new Error('Model discovery response is malformed');
  }
  const source = readText(payload.source) || 'unknown';
  const legacyLive = source === 'gateway' || source === 'cli';
  let readinessReported = false;
  const seen = new Set<string>();
  const models: DiscoveredModel[] = [];
  for (const row of payload.models) {
    if (!isRecord(row)) continue;
    const rawId = readText(row.id);
    if (!rawId) continue;
    const id = canonicalizePortalModelId(rawId) || rawId;
    if (!id.includes('/') || seen.has(id)) continue;
    seen.add(id);
    const reportedReadiness = readReadiness(row.readiness);
    if (reportedReadiness) readinessReported = true;
    const readiness: ModelReadiness = reportedReadiness || (legacyLive ? 'ready' : 'unknown');
    const registered = typeof row.registered === 'boolean' ? row.registered : legacyLive;
    const tier = row.tier === 'frontier' || row.tier === 'balanced' || row.tier === 'fast' ? row.tier : undefined;
    models.push({
      id,
      name: readText(row.name) || id,
      description: readText(row.description),
      ...(tier ? { tier } : {}),
      readiness,
      registered,
      runtime: readText(row.runtime),
      reason: readText(row.reason) || (isRecord(row.readiness) ? readText(row.readiness.message) : null),
    });
  }
  return {
    models,
    source,
    runtime: readText(payload.runtime),
    warnings: Array.isArray(payload.warnings) ? payload.warnings.filter((warning): warning is string => typeof warning === 'string') : [],
    readinessReported,
  };
}

export function describeModelSource(discovery: ModelDiscovery): string {
  if (discovery.readinessReported) {
    return 'Readiness reported by the installed OpenClaw runtime. Only ready models can be registered or made the default.';
  }
  if (discovery.source === 'gateway' || discovery.source === 'cli') {
    return 'Live model list reported by the running OpenClaw runtime.';
  }
  return 'Portal\'s curated preset list. OpenClaw did not report live models for this provider, so these are candidates only: they do not prove the login is usable or that your account is entitled to them.';
}

// ── default model readback ──────────────────────────────────────────────────

export function sameModel(left: string | null | undefined, right: string | null | undefined): boolean {
  const a = canonicalizePortalModelId(left || '') || (left || '').trim();
  const b = canonicalizePortalModelId(right || '') || (right || '').trim();
  return Boolean(a) && a === b;
}

// ── model mutation responses ────────────────────────────────────────────────

export interface ModelMutationOutcome {
  /** The server said the change is applied and read back (`success: true`). */
  applied: boolean;
  /** The server could not verify the write yet (HTTP 202 / MODEL_ACTIVATION_PENDING). Never retry automatically. */
  pending: boolean;
  changed: boolean | null;
  verified: boolean | null;
  code: string | null;
  error: string | null;
}

/**
 * Read a `/register-models` or `/set-default-model` response body. A 2xx
 * status alone is not success: the route answers 202 with `success: false`
 * when the gateway disconnected mid-write, and that state must be re-checked,
 * not replayed.
 */
export function readModelMutationOutcome(payload: unknown, httpStatus?: number): ModelMutationOutcome {
  const record = isRecord(payload) ? payload : {};
  const code = readText(record.code);
  const success = record.success === true;
  const pending = !success && (httpStatus === 202 || code === 'MODEL_ACTIVATION_PENDING');
  return {
    applied: success,
    pending,
    changed: typeof record.changed === 'boolean' ? record.changed : null,
    verified: typeof record.verified === 'boolean' ? record.verified : null,
    code,
    error: readText(record.error),
  };
}

export function describeMutationError(error: unknown, fallback: string): string {
  const data = (error as { response?: { data?: unknown; status?: number } })?.response?.data;
  const record = isRecord(data) ? data : {};
  const message = readText(record.error) || readText((error as { message?: unknown })?.message) || fallback;
  const remediation = readText(record.remediation);
  const code = readText(record.code);
  return [message, remediation, code ? `(${code})` : null].filter(Boolean).join(' ');
}
