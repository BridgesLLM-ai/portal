import { getAiProviderMeta } from '../config/aiProviders';
import { canonicalizeProviderModelId } from '../utils/openclawCli';

export interface ValidationResult {
  valid: boolean;
  models?: string[];
  error?: string;
  hint?: string;
}

function extractModelIds(providerId: string, body: any): string[] {
  const rawIds = Array.isArray(body?.data)
    ? body.data
      .map((item: any) => item?.id || item?.name)
      .filter((item: unknown): item is string => typeof item === 'string')
    : Array.isArray(body?.models)
      ? body.models
        .map((item: any) => item?.name || item?.id)
        .filter((item: unknown): item is string => typeof item === 'string')
      : [];

  return Array.from(new Set(rawIds
    .map((modelId) => canonicalizeProviderModelId(providerId, modelId))
    .filter(Boolean)));
}

export function mapProviderError(provider: string, statusCode: number | null, errorMessage: string): { userMessage: string; recovery: string } {
  if (statusCode === 401) {
    const consoleUrl = getAiProviderMeta(provider)?.consoleUrl || 'the provider console';
    return {
      userMessage: 'API key is invalid or has been revoked.',
      recovery: `Generate a new key at ${consoleUrl}`,
    };
  }

  if (statusCode === 402) {
    return {
      userMessage: 'Billing is not set up, or your credit balance is zero.',
      recovery: 'Add a payment method or credits at the provider\'s billing page.',
    };
  }

  if (statusCode === 403) {
    if (provider === 'google') {
      return {
        userMessage: 'The Generative Language API is not enabled for your Google Cloud project.',
        recovery: 'Go to console.cloud.google.com → APIs & Services → Enable "Generative Language API".',
      };
    }
    return {
      userMessage: 'Access denied. Your key may not have sufficient permissions.',
      recovery: 'Check your key\'s permissions at the provider\'s console.',
    };
  }

  if (statusCode === 429) {
    return {
      userMessage: 'Rate limit exceeded — too many requests.',
      recovery: 'Wait 1-2 minutes and try again. If this persists, check your plan\'s rate limits.',
    };
  }

  if (errorMessage.includes('ECONNREFUSED')) {
    return {
      userMessage: provider === 'ollama' ? 'Ollama is not running on this server.' : 'Cannot connect to the provider\'s API.',
      recovery: provider === 'ollama'
        ? 'Start it with: systemctl start ollama'
        : 'Check that this server can access the internet and that no firewall is blocking outbound HTTPS.',
    };
  }

  if (errorMessage.includes('ETIMEDOUT') || errorMessage.toLowerCase().includes('timeout')) {
    return {
      userMessage: 'Connection timed out trying to reach the provider.',
      recovery: 'Check your server\'s internet connection, DNS settings, and firewall rules.',
    };
  }

  if (errorMessage.includes('ENOTFOUND')) {
    return {
      userMessage: 'DNS resolution failed — cannot find the provider\'s server.',
      recovery: 'Check your server\'s DNS settings. Try: nslookup api.anthropic.com',
    };
  }

  return {
    userMessage: `An unexpected error occurred: ${errorMessage}`,
    recovery: 'Try again. If the problem persists, check the server logs.',
  };
}

export async function validateApiKey(providerId: string, apiKey: string): Promise<ValidationResult> {
  const provider = getAiProviderMeta(providerId);
  if (!provider?.validationEndpoint || !provider.validationMethod) {
    return { valid: false, error: 'Validation not supported for this provider', hint: 'Use a different authentication flow for this provider.' };
  }

  try {
    let response: Response;
    if (provider.validationMethod === 'bearer') {
      response = await fetch(provider.validationEndpoint, {
        headers: { Authorization: `Bearer ${apiKey}` },
        signal: AbortSignal.timeout(10000),
      });
    } else if (provider.validationMethod === 'x-api-key') {
      response = await fetch(provider.validationEndpoint, {
        headers: {
          'x-api-key': apiKey,
          'anthropic-version': '2023-06-01',
        },
        signal: AbortSignal.timeout(10000),
      });
    } else {
      response = await fetch(`${provider.validationEndpoint}?key=${encodeURIComponent(apiKey)}`, {
        signal: AbortSignal.timeout(10000),
      });
    }

    if (response.status === 200) {
      const body = await response.json().catch(() => ({}));
      return { valid: true, models: extractModelIds(providerId, body) };
    }

    const mappingByStatus: Record<number, ValidationResult> = {
      401: { valid: false, error: 'Invalid API key', hint: 'Check that your key is correct and hasn\'t been revoked.' },
      402: { valid: false, error: 'Billing not set up', hint: 'Add a payment method at the provider\'s console.' },
      403: { valid: false, error: 'Access denied', hint: 'Your key may not have the right permissions, or the API may not be enabled.' },
      429: { valid: false, error: 'Rate limited', hint: 'Too many requests. Wait a moment and try again.' },
    };

    if (mappingByStatus[response.status]) return mappingByStatus[response.status];

    const rawBody = await response.text().catch(() => '');
    const mapped = mapProviderError(providerId, response.status, rawBody || `HTTP ${response.status}`);
    return { valid: false, error: mapped.userMessage, hint: mapped.recovery };
  } catch (error: any) {
    const mapped = mapProviderError(providerId, null, String(error?.message || error));
    return {
      valid: false,
      error: 'Cannot reach provider',
      hint: mapped.recovery || 'Check that this server can access the internet. DNS or firewall may be blocking the connection.',
    };
  }
}
