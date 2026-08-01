export type ProviderTier = 1 | 2 | 3;
export type ProviderAuthType = 'api_key' | 'token' | 'oauth' | 'setup_token' | 'device_code' | 'native_cli' | 'aws_sdk';
export type ModelTier = 'frontier' | 'balanced' | 'fast';

export interface ProviderAuthOption {
  type: ProviderAuthType;
  label: string;
  description: string;
  recommended?: boolean;
}

export interface ProviderInstruction {
  stepNumber: number;
  title: string;
  detail: string;
  substeps?: string[];
  link?: { url: string; label: string };
  note?: string;
}

export interface ProviderModelPreset {
  id: string;
  name: string;
  tier: ModelTier;
  description: string;
}

export type ProviderGuidedSetup =
  | {
    status: 'available';
    authTypes: ProviderAuthType[];
  }
  | {
    status: 'manual';
    reason: string;
    action: { url: string; label: string };
  };

export interface ProviderUIConfig {
  id: string;
  name: string;
  tier: ProviderTier;
  icon: string;
  primaryAuthType: ProviderAuthType;
  guidedSetup: ProviderGuidedSetup;
  authOptions?: ProviderAuthOption[];
  keyPlaceholder?: string;
  consoleUrl: string;
  signupUrl: string;
  pricingNote: string;
  freeTier: string | null;
  description: string;
  dangerNote?: {
    title: string;
    detail: string;
    compactDetail?: string;
    link?: { url: string; label: string };
  };
  setupInstructions: ProviderInstruction[];
  defaultModels: ProviderModelPreset[];
}

const AUTH_TYPES = new Set<ProviderAuthType>([
  'api_key',
  'token',
  'oauth',
  'setup_token',
  'device_code',
  'native_cli',
  'aws_sdk',
]);
const MODEL_TIERS = new Set<ModelTier>(['frontier', 'balanced', 'fast']);

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function hasText(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

function isProviderModel(value: unknown): value is ProviderModelPreset {
  return isRecord(value)
    && hasText(value.id)
    && value.id.includes('/')
    && hasText(value.name)
    && typeof value.tier === 'string'
    && MODEL_TIERS.has(value.tier as ModelTier)
    && hasText(value.description);
}

function isProviderInstruction(value: unknown): value is ProviderInstruction {
  return isRecord(value)
    && Number.isInteger(value.stepNumber)
    && Number(value.stepNumber) > 0
    && hasText(value.title)
    && hasText(value.detail);
}

function isProviderGuidedSetup(value: unknown): value is ProviderGuidedSetup {
  if (!isRecord(value) || typeof value.status !== 'string') return false;
  if (value.status === 'available') {
    return Array.isArray(value.authTypes)
      && value.authTypes.length > 0
      && new Set(value.authTypes).size === value.authTypes.length
      && value.authTypes.every((authType) => (
        typeof authType === 'string' && AUTH_TYPES.has(authType as ProviderAuthType)
      ));
  }
  return value.status === 'manual'
    && hasText(value.reason)
    && isRecord(value.action)
    && hasText(value.action.url)
    && hasText(value.action.label);
}

function isProvider(value: unknown): value is ProviderUIConfig {
  if (!isRecord(value)) return false;
  if (!hasText(value.id) || !/^[a-z0-9-]+$/.test(value.id)) return false;
  if (!hasText(value.name) || !hasText(value.icon)) return false;
  if (value.tier !== 1 && value.tier !== 2 && value.tier !== 3) return false;
  if (typeof value.primaryAuthType !== 'string' || !AUTH_TYPES.has(value.primaryAuthType as ProviderAuthType)) return false;
  const guidedSetup = value.guidedSetup;
  if (!isProviderGuidedSetup(guidedSetup)) return false;
  if (
    guidedSetup.status === 'available'
    && !guidedSetup.authTypes.includes(value.primaryAuthType as ProviderAuthType)
  ) return false;
  if (!hasText(value.consoleUrl) || !hasText(value.signupUrl)) return false;
  if (!hasText(value.pricingNote) || !hasText(value.description)) return false;
  if (!(value.freeTier === null || typeof value.freeTier === 'string')) return false;
  if (!Array.isArray(value.setupInstructions) || !value.setupInstructions.every(isProviderInstruction)) return false;
  if (!Array.isArray(value.defaultModels) || !value.defaultModels.every(isProviderModel)) return false;
  if (value.authOptions !== undefined) {
    if (!Array.isArray(value.authOptions) || !value.authOptions.every((option) => (
      isRecord(option)
      && typeof option.type === 'string'
      && AUTH_TYPES.has(option.type as ProviderAuthType)
      && hasText(option.label)
      && hasText(option.description)
    ))) return false;
    if (
      guidedSetup.status !== 'available'
      || !value.authOptions.every((option) => guidedSetup.authTypes.includes(option.type as ProviderAuthType))
    ) return false;
  }
  return true;
}

/** Parse the server-owned catalog and fail loudly on drift or malformed rows. */
export function parseProviderCatalog(payload: unknown): ProviderUIConfig[] {
  if (!isRecord(payload) || payload.source !== 'backend' || !Array.isArray(payload.providers)) {
    throw new Error('Provider catalog response is malformed');
  }
  const providers: ProviderUIConfig[] = [];
  const seen = new Set<string>();
  for (const row of payload.providers) {
    if (!isProvider(row)) throw new Error('Provider catalog contains an invalid provider');
    if (seen.has(row.id)) throw new Error(`Provider catalog contains duplicate provider ${row.id}`);
    seen.add(row.id);
    providers.push(row);
  }
  if (providers.length === 0) throw new Error('Provider catalog is empty');
  return providers;
}

export function getProviderConfig(providers: readonly ProviderUIConfig[], providerId: string) {
  return providers.find((provider) => provider.id === providerId) || null;
}
