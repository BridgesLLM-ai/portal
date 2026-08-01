import { execFile } from 'child_process';
import { buildOpenClawCliEnv, extractJsonFromCliOutput } from '../utils/openclawCli';

const READINESS_CACHE_MS = 60_000;
const READINESS_TIMEOUT_MS = 9_000;

export type ProviderReadinessState =
  | 'missing_plugin'
  | 'plugin_unavailable'
  | 'needs_setup'
  | 'ready'
  | 'probe_error';

export interface ProviderReadiness {
  state: ProviderReadinessState;
  checkedAt: string;
  cached: boolean;
  availableModelCount: number;
  message: string;
}

export interface ReadOnlyOpenClawResult {
  ok: boolean;
  stdout: string;
  stderr: string;
  timedOut: boolean;
}

export type ReadOnlyOpenClawRunner = (
  args: readonly string[],
  timeoutMs: number,
) => Promise<ReadOnlyOpenClawResult>;

let readinessCache: { expiresAt: number; result: ProviderReadiness } | null = null;
let readinessRefresh: Promise<ProviderReadiness> | null = null;

function runReadOnlyOpenClaw(
  args: readonly string[],
  timeoutMs: number,
): Promise<ReadOnlyOpenClawResult> {
  return new Promise((resolve) => {
    execFile('openclaw', [...args], {
      encoding: 'utf8',
      env: buildOpenClawCliEnv(),
      timeout: timeoutMs,
      maxBuffer: 512 * 1024,
    }, (error, stdout, stderr) => {
      const processError = error as (Error & { code?: string | number; killed?: boolean; signal?: string }) | null;
      resolve({
        ok: !error,
        stdout: String(stdout || ''),
        stderr: String(stderr || ''),
        timedOut: Boolean(
          processError
          && (
            processError.code === 'ETIMEDOUT'
            || processError.killed
            || processError.signal === 'SIGTERM'
          )
        ),
      });
    });
  });
}

function parseReadOnlyCliJson(raw: string): any | null {
  try {
    return JSON.parse(extractJsonFromCliOutput(raw));
  } catch {
    return null;
  }
}

export function createAmazonBedrockReadiness(
  state: ProviderReadinessState,
  checkedAtMs: number,
  message: string,
  availableModelCount = 0,
): ProviderReadiness {
  return {
    state,
    checkedAt: new Date(checkedAtMs).toISOString(),
    cached: false,
    availableModelCount,
    message,
  };
}

/**
 * Read-only Bedrock readiness check. The commands and arguments are fixed;
 * credential values are neither read by Portal nor included in the result.
 */
export async function probeAmazonBedrockReadiness(
  runner: ReadOnlyOpenClawRunner = runReadOnlyOpenClaw,
  checkedAtMs = Date.now(),
): Promise<ProviderReadiness> {
  const [pluginResult, modelsResult] = await Promise.all([
    runner(['plugins', 'info', 'amazon-bedrock', '--json'], READINESS_TIMEOUT_MS),
    runner(['models', 'list', '--provider', 'amazon-bedrock', '--json'], READINESS_TIMEOUT_MS),
  ]);

  if (pluginResult.timedOut) {
    return createAmazonBedrockReadiness(
      'probe_error',
      checkedAtMs,
      'The read-only OpenClaw plugin check timed out. No configuration was changed; use Check again.',
    );
  }

  if (!pluginResult.ok) {
    if (/plugin not found:\s*amazon-bedrock/i.test(`${pluginResult.stdout}\n${pluginResult.stderr}`)) {
      return createAmazonBedrockReadiness(
        'missing_plugin',
        checkedAtMs,
        'The official Amazon Bedrock provider plugin is not installed on this OpenClaw host.',
      );
    }
    return createAmazonBedrockReadiness(
      'probe_error',
      checkedAtMs,
      'OpenClaw could not inspect the Amazon Bedrock provider plugin. No configuration was changed; use Check again.',
    );
  }

  const pluginPayload = parseReadOnlyCliJson(pluginResult.stdout);
  const plugin = pluginPayload?.plugin;
  if (!plugin || plugin.id !== 'amazon-bedrock') {
    return createAmazonBedrockReadiness(
      'missing_plugin',
      checkedAtMs,
      'The official Amazon Bedrock provider plugin is not installed on this OpenClaw host.',
    );
  }

  const pluginStatus = String(plugin.status || '').trim().toLowerCase();
  if (plugin.enabled === false || ['blocked', 'disabled', 'error', 'invalid'].includes(pluginStatus)) {
    return createAmazonBedrockReadiness(
      'plugin_unavailable',
      checkedAtMs,
      'The Amazon Bedrock provider plugin is installed but not enabled and loaded. Enable it, then restart the OpenClaw gateway.',
    );
  }

  if (modelsResult.timedOut) {
    return createAmazonBedrockReadiness(
      'probe_error',
      checkedAtMs,
      'Bedrock model discovery timed out. Check AWS network access and region, then use Check again.',
    );
  }

  if (!modelsResult.ok) {
    return createAmazonBedrockReadiness(
      'needs_setup',
      checkedAtMs,
      'The plugin is loaded, but OpenClaw could not discover Bedrock models. Check gateway-service AWS credentials, region, and IAM discovery permissions.',
    );
  }

  const modelsPayload = parseReadOnlyCliJson(modelsResult.stdout);
  if (/\bNo models found\b/i.test(modelsResult.stdout)) {
    return createAmazonBedrockReadiness(
      'needs_setup',
      checkedAtMs,
      'The plugin is loaded, but no usable Bedrock models were discovered. Check gateway-service AWS credentials, region, model access, and IAM discovery permissions.',
    );
  }
  if (!modelsPayload || !Array.isArray(modelsPayload.models)) {
    return createAmazonBedrockReadiness(
      'probe_error',
      checkedAtMs,
      'OpenClaw returned an unreadable Bedrock model catalog. No configuration was changed; use Check again.',
    );
  }

  const availableModelCount = modelsPayload.models.filter((model: any) => (
    typeof model?.key === 'string'
    && model.key.startsWith('amazon-bedrock/')
    && model.available !== false
    && model.missing !== true
  )).length;
  if (availableModelCount === 0) {
    return createAmazonBedrockReadiness(
      'needs_setup',
      checkedAtMs,
      'OpenClaw found no usable Bedrock models. Check gateway-service AWS credentials, region, model access, and IAM discovery permissions.',
    );
  }

  return createAmazonBedrockReadiness(
    'ready',
    checkedAtMs,
    `Read-only discovery found ${availableModelCount} usable Bedrock model${availableModelCount === 1 ? '' : 's'}.`,
    availableModelCount,
  );
}

export function invalidateAmazonBedrockReadinessCache(): void {
  readinessCache = null;
}

export async function getAmazonBedrockReadiness(options: {
  force?: boolean;
  runner?: ReadOnlyOpenClawRunner;
  now?: () => number;
} = {}): Promise<ProviderReadiness> {
  const now = options.now || Date.now;
  const nowMs = now();
  if (!options.force && readinessCache?.expiresAt && readinessCache.expiresAt > nowMs) {
    return { ...readinessCache.result, cached: true };
  }
  if (readinessRefresh) return readinessRefresh;

  const refresh = probeAmazonBedrockReadiness(options.runner || runReadOnlyOpenClaw, nowMs)
    .then((result) => {
      readinessCache = {
        expiresAt: now() + READINESS_CACHE_MS,
        result,
      };
      return result;
    })
    .finally(() => {
      if (readinessRefresh === refresh) readinessRefresh = null;
    });
  readinessRefresh = refresh;
  return refresh;
}
