import {
  getDefaultAgentZeroOAuthClient,
  type AgentZeroOAuthClient,
} from '../agents/providers/agentZero/AgentZeroOAuthControl';
import {
  isAgentZeroOAuthProjectQualificationCandidate,
} from '../agents/providers/agentZero/AgentZeroOAuthModelCatalog';
import {
  AGENT_ZERO_PROJECT_OAUTH_PROVIDER_IDS,
  normalizeAgentZeroProjectModelSelection,
  type AgentZeroProjectModelSelection,
  type AgentZeroProjectOAuthProviderId,
} from '../agents/providers/agentZero/AgentZeroProjectModelBridgeCredential';

export class AgentZeroProjectModelSelectionError extends Error {
  readonly code = 'AGENT_ZERO_PROJECT_MODEL_INVALID';

  constructor(message: string) {
    super(message);
    this.name = 'AgentZeroProjectModelSelectionError';
  }
}
type AgentZeroOAuthCatalogClient = Pick<AgentZeroOAuthClient, 'modelCatalog'>;

function fail(message: string): never {
  throw new AgentZeroProjectModelSelectionError(message);
}

function normalizeSelection(value: unknown): AgentZeroProjectModelSelection {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return fail('Select a connected Agent Zero OAuth provider and model.');
  }
  try {
    const record = value as Record<string, unknown>;
    return normalizeAgentZeroProjectModelSelection({
      providerId: String(record.providerId || '') as AgentZeroProjectOAuthProviderId,
      model: String(record.model || ''),
    });
  } catch {
    return fail('The Agent Zero OAuth provider/model selection is invalid.');
  }
}

/**
 * Admits one reviewed provider/model candidate from Agent Zero's authenticated,
 * dynamic OAuth catalog into the separate Project live-qualification flow.
 * Candidate admission is not Project qualification. No declared fallback or
 * cross-provider model alias is accepted: a disconnected, expired, revoked,
 * missing, duplicate, or unreviewed entry is rejected before a Project runtime
 * credential can be issued.
 */
export async function resolveAllowedAgentZeroProjectModel(
  value: unknown,
  client: AgentZeroOAuthCatalogClient = getDefaultAgentZeroOAuthClient(),
): Promise<AgentZeroProjectModelSelection> {
  const requested = normalizeSelection(value);
  if (!isAgentZeroOAuthProjectQualificationCandidate(requested.providerId, requested.model)) {
    return fail(
      'The selected Agent Zero model is not an admitted Project Chat qualification candidate. Project Chat requires its own exact live qualification before use.',
    );
  }
  let catalog: Awaited<ReturnType<AgentZeroOAuthCatalogClient['modelCatalog']>>;
  try {
    catalog = await client.modelCatalog();
  } catch {
    return fail('Agent Zero OAuth model catalog is unavailable. Reconnect the account and try again.');
  }
  if (!catalog?.available || !Array.isArray(catalog.providers)) {
    return fail('Agent Zero OAuth model catalog is unavailable.');
  }
  const providers = catalog.providers.filter((entry) => entry.providerId === requested.providerId);
  if (providers.length !== 1) {
    return fail('The selected Agent Zero OAuth provider was not returned uniquely by the live catalog.');
  }
  const provider = providers[0];
  if (provider.connectionState !== 'connected') {
    return fail('The selected Agent Zero OAuth provider is not connected.');
  }
  const exactModels = Array.isArray(provider.models)
    ? provider.models.filter((entry) => entry?.id === requested.model)
    : [];
  if (exactModels.length !== 1) {
    return fail('The selected Agent Zero model is not available for that connected OAuth provider.');
  }
  return requested;
}

export function agentZeroProjectModelBindingValue(
  value: AgentZeroProjectModelSelection,
): string {
  const selection = normalizeSelection(value);
  return `${selection.providerId}/${selection.model}`;
}

export function parseAgentZeroProjectModelBinding(
  value: unknown,
): AgentZeroProjectModelSelection {
  const binding = String(value || '').trim();
  const providerId = AGENT_ZERO_PROJECT_OAUTH_PROVIDER_IDS.find((candidate) => (
    binding.startsWith(`${candidate}/`)
  ));
  if (!providerId) return fail('The Agent Zero Project binding has no exact OAuth provider/model identity.');
  return normalizeSelection({
    providerId,
    model: binding.slice(providerId.length + 1),
  });
}
